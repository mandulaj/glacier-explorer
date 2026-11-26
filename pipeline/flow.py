"""Flow frames and cumulative erosion potential.

Usage (from repo root, after build.py):
    uv run --project pipeline pipeline/flow.py --step 1ka

Outputs to web/public/data/ and registers them in manifest.json:
    flow/<age>.bin     gzip of RGBA8, per pixel:
                         R, G  surface velocity towards east / north, signed log scale
                         B     basal sliding speed, log scale
                         A     pressure-adjusted basal temperature (255 = melting point)
    erosion/<age>.bin  cumulative glacial erosion potential since 120 ka (log scale, uint16)
"""

import argparse
import gzip
import json
from pathlib import Path

import h5py
import numpy as np

from build import RUN, ROOT, frame_name
from codec import encode_u16
from grid import Resampler

VMAX = 3000.0  # m/a, top of the log scale
TEMP_STEP = 0.05  # K per count below the melting point

# Erosion law of Koppes et al. (2015) as used by Seguinot & Delaney (2021):
# erosion rate (m/a) = K_G * sliding speed (m/a) ** L
K_G = 5.2e-11
L_EXP = 2.34
EROSION_ENC = {"offset": -6.0, "scale": 6000.0}  # log10(m), 1e-6 .. ~8e4 m


def signed_log(v):
    f = np.sign(v) * np.log1p(np.minimum(np.abs(v), VMAX)) / np.log1p(VMAX)
    return (128 + np.rint(127 * f)).astype(np.uint8)


def unsigned_log(v):
    return np.rint(255 * np.log1p(np.clip(v, 0, VMAX)) / np.log1p(VMAX)).astype(np.uint8)


def write_flow(f, rs, out):
    ages = f["age"][:]
    (out / "flow").mkdir(exist_ok=True)
    frames, total = [], 0
    for i, age in enumerate(ages):
        thk = f["thk"][i]
        ice = np.isfinite(thk) & (thk >= 1.0)
        clean = lambda name: np.where(ice, np.nan_to_num(f[name][i]), 0.0).astype(np.float32)  # noqa: E731
        east, north = rs.vector(clean("uvelsurf"), clean("vvelsurf"))
        be, bn = rs.vector(clean("uvelbase"), clean("vvelbase"))
        temp = rs.scalar(np.where(ice, np.nan_to_num(f["temppabase"][i]), 0.0).astype(np.float32))
        mask = rs.scalar(ice.astype(np.float32), order=0) > 0.5

        rgba = np.zeros((rs.height, rs.width, 4), np.uint8)
        rgba[..., 0] = np.where(mask, signed_log(east), 128)
        rgba[..., 1] = np.where(mask, signed_log(north), 128)
        rgba[..., 2] = np.where(mask, unsigned_log(np.hypot(be, bn)), 0)
        rgba[..., 3] = np.where(mask, np.clip(255 + np.rint(temp / TEMP_STEP), 0, 255), 255)
        blob = gzip.compress(rgba.tobytes(), compresslevel=9, mtime=0)
        name = frame_name(age)
        (out / "flow" / f"{name}.bin").write_bytes(blob)
        total += len(blob)
        frames.append({"age": round(float(age) + 0.0, 3), "file": f"flow/{name}.bin"})
        if i % 20 == 0:
            print(f"  flow {age:7.1f} ka  {len(blob) / 1e3:6.0f} kB")
    print(f"flow frames: {total / 1e6:.1f} MB")
    return {"vmax": VMAX, "tempStep": TEMP_STEP, "frames": frames}


def write_erosion(data, rs, out):
    """Integrate the erosion law over the 100 a output, save the running total every 1 ka."""
    f = h5py.File(data / f"{RUN}.ex.100a.nc", "r")
    ages = f["age"][:]
    n = len(ages)
    dt = 100.0
    (out / "erosion").mkdir(exist_ok=True)
    total = np.zeros(f["thk"].shape[1:], np.float64)
    frames = []
    block = f["uvelbase"].chunks[0]  # read whole compression chunks at once
    for start in range(0, n, block):
        sl = slice(start, min(start + block, n))
        speed = np.hypot(np.nan_to_num(f["uvelbase"][sl]), np.nan_to_num(f["vvelbase"][sl]))
        rate = K_G * speed**L_EXP
        for k in range(rate.shape[0]):
            total += rate[k] * dt
            age = float(ages[start + k])
            if abs(age - round(age)) < 1e-6:
                field = rs.scalar(np.log10(np.maximum(total, 1e-6)).astype(np.float32), outside=-6.0)
                name = frame_name(age)
                (out / "erosion" / f"{name}.bin").write_bytes(encode_u16(field, **EROSION_ENC))
                frames.append({"age": round(age + 0.0, 3), "file": f"erosion/{name}.bin"})
        print(f"  erosion to {ages[sl][-1]:6.1f} ka, max {total.max():.1f} m, mean over eroded {total[total > 1e-3].mean():.2f} m")
    return {**EROSION_ENC, "law": f"{K_G} * u_b^{L_EXP}", "frames": frames}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", choices=["1ka", "100a"], default="1ka")
    ap.add_argument("--data", type=Path, default=ROOT / "data")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data")
    ap.add_argument("--skip-erosion", action="store_true")
    args = ap.parse_args()

    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    f = h5py.File(args.data / f"{RUN}.ex.{args.step}.nc", "r")
    rs = Resampler.build(f["x"][:], f["y"][:], f["lon"][:], f["lat"][:], width=manifest["width"])

    manifest["flow"] = write_flow(f, rs, args.out)
    manifest_path.write_text(json.dumps(manifest))
    if not args.skip_erosion:
        manifest["erosion"] = write_erosion(args.data, rs, args.out)
        manifest_path.write_text(json.dumps(manifest))


if __name__ == "__main__":
    main()
