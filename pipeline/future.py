"""Glacier projections to 2100 for the "since 1850" view, from our own IGM runs.

Reads the output of pipeline/igm/run.sh (the glaciers around the Great Aletsch Glacier, one
connected "complex" in the RGI 7 inventory, under idealised warming scenarios, see pipeline/igm/*.yaml) and writes, per scenario and saved year, two rasters that
the viewer drapes on today's terrain:

    recent/future/<scenario>/thk_<year>.bin    remaining ice thickness (m)
    recent/future/<scenario>/gone_<year>.bin   1 where the ice of the first year has melted away
    recent/future/manifest.json
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script directory

import h5py  # noqa: E402
import numpy as np  # noqa: E402
from pyproj import Transformer  # noqa: E402
from scipy.ndimage import map_coordinates  # noqa: E402

from codec import encode_u16  # noqa: E402
from grid import lat_to_my, lon_to_mx, mx_to_lon, my_to_lat  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CRS = "EPSG:32632"  # OGGM glacier grids for the Alps, as written by IGM's oggm_shop
THK_ENC = {"offset": 0.0, "scale": 16.0}
GONE_ENC = {"offset": 0.0, "scale": 1000.0}

# id (as in pipeline/igm/aletsch_<id>.yaml), label, description
SCENARIOS = [
    ("steady", "Climate stays as today", "temperature stays 1.8 °C above 1960–1990, as around 2020"),
    ("warm", "Strong warming", "temperature rises to 4 °C above 1960–1990 by 2100"),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=ROOT / "data" / "igm" / "aletsch")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data" / "recent" / "future")
    args = ap.parse_args()

    manifest = None
    for scenario, label, detail in SCENARIOS:
        f = h5py.File(args.data / scenario / "output.nc", "r")
        x, y, years = f["x"][:], f["y"][:], f["time"][:]
        thk = np.nan_to_num(f["thk"][:]).astype(np.float32)
        cell = float(x[1] - x[0])

        if manifest is None:
            # target: mercator rectangle around the model domain, at about its resolution
            lon, lat = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True).transform(
                [x[0], x[-1], x[0], x[-1]], [y[0], y[0], y[-1], y[-1]]
            )
            bounds = (float(lon_to_mx(min(lon))), float(lat_to_my(max(lat))), float(lon_to_mx(max(lon))), float(lat_to_my(min(lat))))
            width = len(x)
            height = int(round(width * (bounds[3] - bounds[1]) / (bounds[2] - bounds[0])))
            mx = bounds[0] + (np.arange(width) + 0.5) / width * (bounds[2] - bounds[0])
            my = bounds[1] + (np.arange(height) + 0.5) / height * (bounds[3] - bounds[1])
            lon_t, lat_t = np.meshgrid(mx_to_lon(mx), my_to_lat(my))
            ux, uy = Transformer.from_crs("EPSG:4326", CRS, always_xy=True).transform(lon_t, lat_t)
            cols, rows = (ux - x[0]) / cell, (uy - y[0]) / (y[1] - y[0])
            inside = (cols >= 0) & (cols <= len(x) - 1) & (rows >= 0) & (rows <= len(y) - 1)
            manifest = {
                "glacier": "Aletsch glacier complex",
                "source": "Own runs with IGM 3.3 (instructed-glacier-model/igm), glacier data from OGGM; idealised scenarios",
                "lon": float(np.mean(lon)),
                "lat": float(np.mean(lat)),
                "width": width,
                "height": height,
                "mercatorBounds": list(bounds),
                "thickness": THK_ENC,
                "gone": GONE_ENC,
                "startYear": int(years[0]),
                "endYear": int(years[-1]),
                "scenarios": [],
            }

        def resample(field):
            return np.where(inside, map_coordinates(field, [rows, cols], order=1, mode="nearest"), 0.0).astype(np.float32)

        out = args.out / scenario
        out.mkdir(parents=True, exist_ok=True)
        start_ice = thk[0] > 1.0
        frames = []
        for k, year in enumerate(years):
            year = int(round(float(year)))
            ice = thk[k] > 1.0
            (out / f"thk_{year}.bin").write_bytes(encode_u16(resample(np.where(ice, thk[k], 0.0)), **THK_ENC))
            (out / f"gone_{year}.bin").write_bytes(encode_u16(resample((start_ice & ~ice).astype(np.float32)), **GONE_ENC))
            frames.append(
                {
                    "year": year,
                    "thk": f"recent/future/{scenario}/thk_{year}.bin",
                    "gone": f"recent/future/{scenario}/gone_{year}.bin",
                    "volume": round(float(thk[k][ice].sum() * cell * cell / 1e9), 2),  # km3
                    "area": round(float(ice.sum() * cell * cell / 1e6), 1),  # km2
                }
            )
        manifest["scenarios"].append({"id": scenario, "label": label, "detail": detail, "frames": frames})
        first, last = frames[0], frames[-1]
        print(f"{scenario:7s} {first['year']}: {first['volume']} km3, {first['area']} km2 -> {last['year']}: {last['volume']} km3, {last['area']} km2")

    (args.out / "manifest.json").write_text(json.dumps(manifest))
    size = sum(p.stat().st_size for p in args.out.rglob("*.bin"))
    print(f"grid {manifest['width']}x{manifest['height']}, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
