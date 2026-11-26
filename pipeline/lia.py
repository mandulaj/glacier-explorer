"""Swiss glaciers of the Little Ice Age in 3D, for the "since 1850" view.

The viewer's terrain is today's. This writes ice frames that stand above it: the reconstructed
ice surface of about 1850 (Reinthaler & Paul 2025, doi:10.5281/zenodo.14336827, CC BY 4.0) minus
today's terrain, and its decline to nothing through the outlines of the Swiss Glacier Inventories.
Only 1850 is data. The later frames are an interpolation: the 1850 thickness above today's terrain,
scaled down by the share of the area loss still to come, inside the glacier outline of that year.

Input:
    data/recent/lia/LIA_glacier_surface_Alps.tif   from the Zenodo record
    data/recent/sgi/...                            as for recent.py
Today's terrain is downloaded from Mapterhorn into data/recent/dem/.

Output in web/public/data/recent/lia/: manifest.json, bed.bin, ice/<year>.bin, check.png
"""

import argparse
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script directory

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
import shapefile  # noqa: E402
from affine import Affine  # noqa: E402
from PIL import Image  # noqa: E402
from pyproj import Transformer  # noqa: E402
from rasterio.features import rasterize  # noqa: E402
from rasterio.windows import from_bounds  # noqa: E402
from scipy.ndimage import binary_dilation, map_coordinates  # noqa: E402

from build import BED_ENC, MARGIN_SLOPE, THK_ENC, extended_thickness  # noqa: E402
from codec import encode_u16  # noqa: E402
from grid import EARTH_CIRCUMFERENCE, lat_to_my, lon_to_mx, mx_to_lon, my_to_lat  # noqa: E402
from recent import INVENTORIES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CELL = 100.0  # m, target grid
BOUNDS = (6.75, 45.8, 10.55, 47.05)  # lon west, lat south, lon east, lat north: the Swiss glaciers
DEM_TILES = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
DEM_ZOOM = 10  # 512 px tiles, about 50 m per pixel
LAST_YEAR = 2025  # frames are stored with age = LAST_YEAR - year, old to young like the ice age frames
MIN_ICE = 5.0  # m above today's terrain; less than that is the noise between the two elevation models
GONE = -80.0  # "thickness" of ground the ice has left: just under the viewer's cut-off, so ice fades out evenly


def dem(args, lon, lat):
    """Today's terrain (m) at the given positions, from Mapterhorn terrarium tiles."""
    n = 2**DEM_ZOOM
    fx = (lon + 180.0) / 360.0 * n
    fy = lat_to_my(lat) * n
    out = np.zeros(lon.shape, np.float32)
    tiles = sorted({(int(x), int(y)) for x, y in zip(np.floor(fx).ravel(), np.floor(fy).ravel())})
    for k, (tx, ty) in enumerate(tiles):
        path = args.dem / str(DEM_ZOOM) / str(tx) / f"{ty}.webp"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            url = DEM_TILES.format(z=DEM_ZOOM, x=tx, y=ty)
            request = urllib.request.Request(url, headers={"User-Agent": "glacier-explorer-pipeline"})
            path.write_bytes(urllib.request.urlopen(request, timeout=60).read())
            time.sleep(0.05)
        rgb = np.asarray(Image.open(io.BytesIO(path.read_bytes())).convert("RGB")).astype(np.float32)
        tile = rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0
        size = tile.shape[0]
        sel = (np.floor(fx) == tx) & (np.floor(fy) == ty)
        # pixel centres; neighbouring tiles are not consulted, the half-pixel at the edge is clamped
        cols = np.clip((fx[sel] - tx) * size - 0.5, 0, size - 1)
        rows = np.clip((fy[sel] - ty) * size - 0.5, 0, size - 1)
        out[sel] = map_coordinates(tile, [rows, cols], order=1, mode="nearest")
        if k % 20 == 0:
            print(f"  terrain tile {k + 1}/{len(tiles)}")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lia", type=Path, default=ROOT / "data" / "recent" / "lia" / "LIA_glacier_surface_Alps.tif")
    ap.add_argument("--sgi", type=Path, default=ROOT / "data" / "recent" / "sgi")
    ap.add_argument("--dem", type=Path, default=ROOT / "data" / "recent" / "dem")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data" / "recent" / "lia")
    args = ap.parse_args()

    # target grid: a mercator rectangle
    west, south, east, north = BOUNDS
    bounds = (float(lon_to_mx(west)), float(lat_to_my(north)), float(lon_to_mx(east)), float(lat_to_my(south)))
    metres = (bounds[2] - bounds[0]) * EARTH_CIRCUMFERENCE * np.cos(np.radians((south + north) / 2))
    width = int(round(metres / CELL))
    height = int(round(width * (bounds[3] - bounds[1]) / (bounds[2] - bounds[0])))
    mx = bounds[0] + (np.arange(width) + 0.5) / width * (bounds[2] - bounds[0])
    my = bounds[1] + (np.arange(height) + 0.5) / height * (bounds[3] - bounds[1])
    lon, lat = np.meshgrid(mx_to_lon(mx), my_to_lat(my))
    print(f"grid {width}x{height}")

    bed = dem(args, lon, lat)

    # ice surface of the Little Ice Age, 0 where the reconstruction has no glacier
    with rasterio.open(args.lia) as src:
        x, y = Transformer.from_crs("EPSG:4326", src.crs, always_xy=True).transform(lon, lat)
        window = from_bounds(x.min() - 100, y.min() - 100, x.max() + 100, y.max() + 100, src.transform).round_offsets().round_lengths()
        raster = src.read(1, window=window).astype(np.float32)
        transform = src.window_transform(window)
    cols, rows = ~transform * (x, y)
    cols, rows = cols - 0.5, rows - 0.5
    covered = map_coordinates((raster > 0).astype(np.float32), [rows, cols], order=1, mode="constant") > 0.99
    surface = map_coordinates(raster, [rows, cols], order=1, mode="nearest")
    rise = np.where(covered, surface - bed, 0.0)
    footprint = rise >= MIN_ICE
    rise = np.where(footprint, rise, 0.0).astype(np.float32)
    pixel_km2 = (CELL / 1000) ** 2
    print(f"whole area, 1850: {footprint.sum() * pixel_km2:.0f} km2 stand above today's terrain, {rise.sum() * CELL * CELL / 1e9:.1f} km3, up to {rise.max():.0f} m")

    # glacier outlines of the inventories, rasterised on the grid
    to_pixel = Affine.identity()

    def outline(file, crs):
        to_ll = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        shapes = []
        for s in shapefile.Reader(str(args.sgi / file)).shapes():
            if not s.points:
                continue
            points = np.asarray(s.points)[:, :2]
            plon, plat = to_ll.transform(points[:, 0], points[:, 1])
            px = (lon_to_mx(plon) - bounds[0]) / (bounds[2] - bounds[0]) * width
            py = (lat_to_my(plat) - bounds[1]) / (bounds[3] - bounds[1]) * height
            starts = [*s.parts, len(points)]
            rings = [np.column_stack([px[a:b], py[a:b]]).tolist() for a, b in zip(starts[:-1], starts[1:]) if b - a >= 4]
            # rings as separate polygons with even-odd filling would need care; holes (nunataks) are
            # cut by the terrain itself in the viewer, so the outer rings are enough
            shapes.extend({"type": "Polygon", "coordinates": [r]} for r in rings)
        return rasterize(shapes, out_shape=(height, width), transform=to_pixel, fill=0, default_value=1, dtype="uint8").astype(bool)

    import logging

    logging.getLogger("shapefile").setLevel(logging.ERROR)
    masks = {year: outline(file, crs) for year, file, crs, _ in INVENTORIES}
    areas = {year: float(m.sum() * pixel_km2) for year, m in masks.items()}
    first, last = INVENTORIES[0][0], INVENTORIES[-1][0]
    # the later outlines exist for Switzerland only: keep the glaciers of the Swiss 1850 inventory
    swiss = binary_dilation(masks[first], iterations=3)
    footprint &= swiss
    rise = np.where(footprint, rise, 0.0).astype(np.float32)
    print(f"Swiss part: {footprint.sum() * pixel_km2:.0f} km2, {rise.sum() * CELL * CELL / 1e9:.1f} km3")

    (args.out / "ice").mkdir(parents=True, exist_ok=True)
    (args.out / "bed.bin").write_bytes(encode_u16(bed, **BED_ENC))
    frames, total = [], 0
    for year, *_ in INVENTORIES:
        # share of the thickness above today's terrain that is still there
        share = float(np.clip((areas[year] - areas[last]) / (areas[first] - areas[last]), 0, 1))
        inside = footprint if year == first else footprint & masks[year]
        thk = np.where(inside, np.maximum(rise * share, 1.0 if share > 0 else 0.0), 0.0).astype(np.float32)
        h, ice = extended_thickness(thk, CELL)
        h = np.where(footprint & ~ice, np.maximum(h, GONE), h)
        blob = encode_u16(h, **THK_ENC)
        (args.out / "ice" / f"{year}.bin").write_bytes(blob)
        total += len(blob)
        frames.append({"age": LAST_YEAR - year, "year": year, "file": f"recent/lia/ice/{year}.bin", "area": round(float(ice.sum() * pixel_km2))})
        print(f"{year}: inventory {areas[year]:5.0f} km2, share {share:4.2f}, 3D ice on {ice.sum() * pixel_km2:5.0f} km2, {len(blob) / 1e3:.0f} kB")

    manifest = {
        "run": "lia",
        "source": "Reinthaler & Paul (2025), doi:10.5281/zenodo.14336827; Swiss Glacier Inventories (GLAMOS); terrain Mapterhorn",
        "width": width,
        "height": height,
        "mercatorBounds": list(bounds),
        "lonLatBounds": [west, south, east, north],
        "bed": {"file": "recent/lia/bed.bin", **BED_ENC},
        "ice": {**THK_ENC, "marginSlope": MARGIN_SLOPE},
        "frames": frames,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest))
    print(f"{len(frames)} frames, {total / 1e6:.1f} MB")

    # quick look: thickness above today's terrain in 1850
    shade = np.clip((bed - 300) / 4000, 0, 1) * 0.7 + 0.2
    rgb = np.stack([shade, shade, shade], -1)
    tint = np.clip(rise / 300, 0, 1)[..., None]
    rgb = np.where(footprint[..., None], (1 - tint) * np.array([0.7, 0.85, 1.0]) + tint * np.array([0.1, 0.2, 0.8]), rgb)
    Image.fromarray((rgb * 255).astype(np.uint8)).save(args.out / "check.png")


if __name__ == "__main__":
    main()
