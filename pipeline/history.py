"""Local ice history: thickness through time for every place, and deglaciation age.

Usage (from repo root, after build.py and debris.py):
    uv run --project pipeline pipeline/history.py

Outputs to web/public/data/ and registers them in manifest.json:
    history.bin        gzip of uint8 [row, column, time]: ice thickness / 12 m at 1 ka steps,
                       on a grid half the size of the ice frames (about 1.5 km). Used for
                       the "click anywhere" chart.
    deglaciation.bin   age (ka) at which each place last became ice-free, from the 100 a
                       output; -1 where the model never has ice, 0 where it still has.
"""

import argparse
import gzip
import json
from pathlib import Path

import h5py
import numpy as np

from build import ROOT, RUN
from codec import encode_u16
from debris import REGIONS
from grid import Resampler

THK_STEP = 12.0  # metres per count in history.bin
DEGLACIATION_ENC = {"offset": -1.0, "scale": 400.0}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=ROOT / "data")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data")
    args = ap.parse_args()
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text())

    # --- thickness cube at 1 ka
    f = h5py.File(args.data / f"{RUN}.ex.1ka.nc", "r")
    x, y, ages = f["x"][:], f["y"][:], f["age"][:]
    lon, lat = f["lon"][:], f["lat"][:]
    half = Resampler.build(x, y, lon, lat, width=manifest["width"] // 2)
    cube = np.zeros((half.height, half.width, len(ages)), np.uint8)
    thk_all = np.nan_to_num(f["thk"][:])
    for i in range(len(ages)):
        cube[..., i] = np.clip(np.rint(half.scalar(thk_all[i].astype(np.float32)) / THK_STEP), 0, 255)
    blob = gzip.compress(cube.tobytes(), compresslevel=9, mtime=0)
    (args.out / "history.bin").write_bytes(blob)
    manifest["history"] = {
        "file": "history.bin",
        "width": half.width,
        "height": half.height,
        "ages": [round(float(a) + 0.0, 3) for a in ages],
        "step": THK_STEP,
    }
    print(f"history cube {cube.shape}, {len(blob) / 1e6:.1f} MB")

    # --- deglaciation age from the 100 a output
    g = h5py.File(args.data / f"{RUN}.ex.100a.nc", "r")
    ages100 = g["age"][:]
    n = len(ages100)
    last_ice = np.full(g["thk"].shape[1:], -1.0, np.float32)  # age of the youngest frame with ice
    block = g["thk"].chunks[0]
    for start in range(0, n, block):
        thk = np.nan_to_num(g["thk"][start : start + block])
        for k in range(thk.shape[0]):
            last_ice[thk[k] >= 1.0] = ages100[start + k]
        print(f"  deglaciation to {ages100[min(start + block, n) - 1]:6.1f} ka")
    full = Resampler.build(x, y, lon, lat, width=manifest["width"])
    field = full.scalar(last_ice, outside=-1.0, order=0)
    (args.out / "deglaciation.bin").write_bytes(encode_u16(field, **DEGLACIATION_ENC))
    manifest["deglaciation"] = {**DEGLACIATION_ENC, "frames": [{"age": 0, "file": "deglaciation.bin"}]}

    # source regions need their position in the viewer (for "whose ice is this?")
    if "debris" in manifest:
        manifest["debris"]["regions"] = [{"name": r[0], "lon": r[1], "lat": r[2], "color": r[3]} for r in REGIONS]
    manifest_path.write_text(json.dumps(manifest))


if __name__ == "__main__":
    main()
