"""Build static web assets from the Alpine ice sheet simulation NetCDF files.

Usage (from repo root):
    uv run --project pipeline pipeline/build.py --step 1ka
    uv run --project pipeline pipeline/build.py --step 100a

Outputs to web/public/data/:
    manifest.json        grid, encodings, frame list
    bed.bin              present-day model bed elevation (static)
    ice/<age>.bin        extended ice thickness per frame
    timeseries.json      ice volume / area curve for the time slider
    check/*.png          quick-look images for verification
"""

import argparse
import json
from pathlib import Path

import h5py
import numpy as np
from scipy.ndimage import distance_transform_edt

from codec import decode_u16, encode_u16
from grid import Resampler

ROOT = Path(__file__).resolve().parent.parent
RUN = "alpcyc.1km.epic.pp"

# Extended thickness: real thickness on ice, and a negative ramp outside it
# (MARGIN_SLOPE metres per metre of distance to the ice margin). Adding it to
# the bed gives an ice surface that dives below the terrain beyond the margin,
# so that in the viewer the true margin is the intersection with the
# high-resolution terrain rather than the edge of 1 km model cells.
MARGIN_SLOPE = 0.2
THK_MIN = -1000.0
THK_ENC = {"offset": THK_MIN, "scale": 2.0}  # 0.5 m steps
BED_ENC = {"offset": -1000.0, "scale": 4.0}  # 0.25 m steps


def extended_thickness(thk, cell):
    ice = np.isfinite(thk) & (thk >= 1.0)
    h = np.where(ice, thk, 0.0).astype(np.float32)
    if ice.any():
        dist = distance_transform_edt(~ice) * cell
        h = np.where(ice, h, np.maximum(-MARGIN_SLOPE * dist, THK_MIN))
    else:
        h[:] = THK_MIN
    return h, ice


def frame_name(age_ka):
    return f"{int(round(age_ka * 1000)):06d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--step", choices=["1ka", "100a"], default="1ka")
    ap.add_argument("--data", type=Path, default=ROOT / "data")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data")
    ap.add_argument("--width", type=int, default=1280)
    args = ap.parse_args()

    out = args.out
    (out / "ice").mkdir(parents=True, exist_ok=True)
    (out / "check").mkdir(exist_ok=True)

    f = h5py.File(args.data / f"{RUN}.ex.{args.step}.nc", "r")
    x, y, ages = f["x"][:], f["y"][:], f["age"][:]
    cell = float(x[1] - x[0])
    rs = Resampler.build(x, y, f["lon"][:], f["lat"][:], width=args.width)
    print(f"target grid {rs.width}x{rs.height}, {len(ages)} frames")

    bed = np.nan_to_num(f["topg"][len(ages) - 1]).astype(np.float32)
    (out / "bed.bin").write_bytes(encode_u16(rs.scalar(bed, order=1), **BED_ENC))

    ground = rs.pixel_ground_size()
    pixel_area_km2 = (ground**2 / 1e6)[:, None]

    frames, total = [], 0
    block = f["thk"].chunks[0]  # read whole compression chunks at once (much faster for the 100 a file)
    for start in range(0, len(ages), block):
        thk_block = f["thk"][start : start + block]
        for k, thk in enumerate(thk_block):
            i, age = start + k, ages[start + k]
            h, ice = extended_thickness(thk, cell)
            ht = rs.scalar(h, outside=THK_MIN)
            blob = encode_u16(ht, **THK_ENC)
            name = frame_name(age)
            (out / "ice" / f"{name}.bin").write_bytes(blob)
            total += len(blob)
            area = float(((ht > 0) * pixel_area_km2).sum())
            frames.append({"age": round(float(age) + 0.0, 3), "file": f"ice/{name}.bin", "area": round(area)})
            if i % (len(ages) // 6) == 0 or i == len(ages) - 1:
                print(f"  {age:7.1f} ka  src {int(ice.sum()):7d} km2  resampled {area:9.0f} km2  {len(blob) / 1e3:6.0f} kB")

    # round-trip check on the last written frame
    back = decode_u16(blob, ht.shape, **THK_ENC)
    assert np.abs(back - np.clip(ht, THK_MIN, None)).max() <= 0.26, "codec round trip failed"

    # keep entries written by the other pipeline scripts (flow.py, debris.py)
    manifest_path = out / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest = {
        **{k: previous[k] for k in ("flow", "erosion", "debris") if k in previous},
        "run": RUN,
        "source": "Seguinot et al. (2018), doi:10.5281/zenodo.7802275, CC BY 4.0",
        "width": rs.width,
        "height": rs.height,
        "mercatorBounds": list(rs.bounds),
        "lonLatBounds": rs.lonlat_bounds(),
        "bed": {"file": "bed.bin", **BED_ENC},
        "ice": {**THK_ENC, "marginSlope": MARGIN_SLOPE},
        "frames": frames,
    }
    manifest_path.write_text(json.dumps(manifest))
    print(f"ice frames: {total / 1e6:.1f} MB")

    write_timeseries(args.data, out)
    write_checks(out, manifest)


def write_timeseries(data, out):
    t = h5py.File(data / f"{RUN}.ts.10a.nc", "r")
    age = t["age"][:]
    step = 10  # 100 a
    series = {
        "age": [round(float(a), 2) for a in age[::step]],
        "slvol": [round(float(v), 4) for v in t["slvol"][::step]],
        "area": [round(float(v) / 1e6) for v in t["area_glacierized"][::step]],
    }
    (out / "timeseries.json").write_text(json.dumps(series))


def write_checks(out, manifest):
    """Quick-look PNGs: decoded ice surface over bed for a few ages."""
    from PIL import Image

    shape = (manifest["height"], manifest["width"])
    bed = decode_u16((out / "bed.bin").read_bytes(), shape, manifest["bed"]["offset"], manifest["bed"]["scale"])
    frames = manifest["frames"]
    for want in (65.0, 24.0, 15.0, 0.0):
        fr = min(frames, key=lambda fr: abs(fr["age"] - want))
        h = decode_u16((out / fr["file"]).read_bytes(), shape, manifest["ice"]["offset"], manifest["ice"]["scale"])
        shade = np.clip(bed / 3500.0, 0, 1) * 0.6 + 0.2
        rgb = np.stack([shade, shade, shade], -1)
        ice = h > 0
        tint = np.clip(h / 2000.0, 0, 1)[..., None]
        rgb = np.where(ice[..., None], np.array([0.55, 0.75, 1.0]) * (1 - 0.5 * tint) + 0.5 * tint, rgb)
        Image.fromarray((rgb * 255).astype(np.uint8)).save(out / "check" / f"ice_{fr['age']:05.1f}ka.png")


if __name__ == "__main__":
    main()
