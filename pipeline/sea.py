"""Seabed tiles and sea-level curve, so that the viewer can lower the sea.

The terrain tiles used by the viewer (Mapterhorn) are land only: the sea is a
flat floor at 0 m. This script builds low-zoom seabed tiles from the EMODnet
bathymetry; the viewer merges them into the terrain tiles wherever those are
at sea level, leaving the high-resolution land untouched.

Usage (from repo root, after build.py):
    uv run --project pipeline python -I pipeline/sea.py [--sea-level FILE]

Downloads go to data/bathymetry/ (cached). Outputs in web/public/data/:
    sea/{z}/{x}/{y}.png   terrarium-encoded seabed, 512 px, 0 m where there is no sea
    sea/index.json        which tiles exist
    sealevel.json         global mean sea level through time (if --sea-level given)
"""

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script directory

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy.ndimage import map_coordinates  # noqa: E402

from grid import mx_to_lon, my_to_lat  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WCS = (
    "https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage"
    "&coverageId=emodnet__mean&format=image/tiff&scalefactor=0.5"
)
# Adriatic down to the Mid-Adriatic Deep (the LGM coast), Ligurian Sea, Gulf of Lion
LON = (2, 20)
LAT = (40, 50)
CHUNK = 2  # degrees per request
PX_PER_DEG = 480  # EMODnet 1/16 arc-minute grid at scale 0.5 (about 230 m)
MAX_ZOOM = 8  # 512 px tiles: about 215 m per pixel at 45 N, matching the source
MIN_ZOOM = 4
TILE = 512


def download(cache: Path):
    cache.mkdir(parents=True, exist_ok=True)
    for lat in range(LAT[0], LAT[1], CHUNK):
        for lon in range(LON[0], LON[1], CHUNK):
            path = cache / f"emodnet_{lat}_{lon}.tif"
            if path.exists() and path.stat().st_size > 1000:
                continue
            url = f"{WCS}&subset=Lat({lat},{lat + CHUNK})&subset=Long({lon},{lon + CHUNK})"
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "glacier-pipeline"}), timeout=300) as r:
                        data = r.read()
                    if data[:2] not in (b"II", b"MM"):
                        raise RuntimeError(f"not a TIFF: {data[:200]!r}")
                    path.write_bytes(data)
                    print(f"  downloaded {path.name} ({len(data) / 1e6:.1f} MB)")
                    break
                except Exception as e:  # noqa: BLE001
                    print(f"  retry {path.name}: {e}")
                    time.sleep(5 * (attempt + 1))
            else:
                raise SystemExit(f"could not download {path.name}")
            time.sleep(1)  # be gentle with the service


def mosaic(cache: Path) -> np.ndarray:
    """Elevation (m, negative below sea level) on a regular lon/lat grid, row 0 = north."""
    n = CHUNK * PX_PER_DEG
    out = np.zeros(((LAT[1] - LAT[0]) * PX_PER_DEG, (LON[1] - LON[0]) * PX_PER_DEG), np.float32)
    for lat in range(LAT[0], LAT[1], CHUNK):
        for lon in range(LON[0], LON[1], CHUNK):
            a = np.array(Image.open(cache / f"emodnet_{lat}_{lon}.tif"), dtype=np.float32)
            if a.shape != (n, n):
                raise SystemExit(f"unexpected chunk shape {a.shape}")
            row = (LAT[1] - lat - CHUNK) * PX_PER_DEG
            col = (lon - LON[0]) * PX_PER_DEG
            out[row : row + n, col : col + n] = a
    # keep the sea only: land and missing values become 0 m
    out[~np.isfinite(out) | (out > 0) | (out < -12000)] = 0
    return out


def tile_bounds(z, x, y):
    n = 2**z
    return x / n, y / n, (x + 1) / n, (y + 1) / n


def sample_tile(src, z, x, y):
    x0, y0, x1, y1 = tile_bounds(z, x, y)
    mx = x0 + (np.arange(TILE) + 0.5) / TILE * (x1 - x0)
    my = y0 + (np.arange(TILE) + 0.5) / TILE * (y1 - y0)
    lon, lat = np.meshgrid(mx_to_lon(mx), my_to_lat(my))
    col = (lon - LON[0]) * PX_PER_DEG - 0.5
    row = (LAT[1] - lat) * PX_PER_DEG - 0.5
    inside = (col >= 0) & (col <= src.shape[1] - 1) & (row >= 0) & (row <= src.shape[0] - 1)
    out = map_coordinates(src, [row, col], order=1, mode="nearest")
    out[~inside] = 0
    return out


def write_tile(out: Path, z, x, y, elev):
    v = np.clip(np.rint(elev), -32768, 0).astype(np.int32) + 32768
    rgb = np.zeros((TILE, TILE, 3), np.uint8)
    rgb[..., 0] = v // 256
    rgb[..., 1] = v % 256
    path = out / str(z) / str(x)
    path.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb).save(path / f"{y}.png", optimize=True)
    return (path / f"{y}.png").stat().st_size


def lon_to_tile(lon, z):
    return int((lon + 180) / 360 * 2**z)


def lat_to_tile(lat, z):
    s = np.sin(np.radians(lat))
    return int((0.5 - np.log((1 + s) / (1 - s)) / (4 * np.pi)) * 2**z)


def sea_level(path: Path, out: Path):
    """Global mean sea level from the Spratt & Lisiecki (2016) stack.

    Tab-separated text, 1 ka steps: age (ka), then the 0-430 ka stack (m relative
    to present). The stack is a scaled principal component and does not pass
    through zero today (+8.5 m at 0 ka), so values are capped at the present level.
    """
    ages, levels = [], []
    for line in path.read_text(errors="replace").splitlines():
        parts = line.split("\t")
        if line.startswith("#") or len(parts) < 2:
            continue
        try:
            age, level = float(parts[0]), float(parts[1])
        except ValueError:
            continue  # column header
        if age <= 125 and np.isfinite(level):
            ages.append(age)
            levels.append(round(min(level, 0.0), 1))
    if len(ages) < 100 or ages[0] != 0:
        raise SystemExit("sea-level file not understood")
    (out / "sealevel.json").write_text(json.dumps({"age": ages, "level": levels, "source": "Spratt & Lisiecki (2016), doi:10.5194/cp-12-1079-2016"}))
    print(f"sea level: {len(ages)} points, minimum {min(levels)} m at {ages[int(np.argmin(levels))]} ka")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=ROOT / "data")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data")
    ap.add_argument("--sea-level", type=Path, help="Spratt & Lisiecki (2016) text file")
    args = ap.parse_args()

    cache = args.data / "bathymetry"
    download(cache)
    src = mosaic(cache)
    print(f"mosaic {src.shape}, sea fraction {np.mean(src < 0):.2f}, deepest {src.min():.0f} m")

    out = args.out / "sea"
    index, total = [], 0
    tiles = {}
    z = MAX_ZOOM
    for x in range(lon_to_tile(LON[0], z), lon_to_tile(LON[1] - 1e-9, z) + 1):
        for y in range(lat_to_tile(LAT[1] - 1e-9, z), lat_to_tile(LAT[0], z) + 1):
            tiles[(x, y)] = sample_tile(src, z, x, y)
    while z >= MIN_ZOOM:
        for (x, y), elev in tiles.items():
            if (elev < -0.5).any():
                total += write_tile(out, z, x, y, elev)
                index.append(f"{z}/{x}/{y}")
        # parents: 2x2 mean of the four children
        parents = {}
        for (x, y), elev in tiles.items():
            p = parents.setdefault((x // 2, y // 2), np.zeros((TILE, TILE), np.float32))
            half = elev.reshape(TILE // 2, 2, TILE // 2, 2).mean(axis=(1, 3))
            oy, ox = (y % 2) * TILE // 2, (x % 2) * TILE // 2
            p[oy : oy + TILE // 2, ox : ox + TILE // 2] = half
        tiles = parents
        z -= 1
    (out / "index.json").write_text(json.dumps({"minZoom": MIN_ZOOM, "maxZoom": MAX_ZOOM, "tiles": sorted(index)}))
    print(f"sea tiles: {len(index)}, {total / 1e6:.1f} MB")

    if args.sea_level:
        sea_level(args.sea_level, args.out)


if __name__ == "__main__":
    main()
