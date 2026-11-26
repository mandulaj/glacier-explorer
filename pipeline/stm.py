"""Second ice model for Switzerland: the Swiss Time Machine simulation.

Converts the viewer data of swiss-time-machine.org (IGM simulation, doi:10.5281/zenodo.24003777,
CC BY 4.0; built on Leger et al. 2025, doi:10.1038/s41467-025-56168-3) to the same frame format
as build.py, so that the viewer can show it in place of the 1 km simulation where and when it
exists: Switzerland, 35 000 to 5 000 BCE, every 100 years, 500 m grid.

Note that its authors publish it as a visualisation product, not as scientific results.

Input, from the Zenodo record, in data/stm/: meta.json, base.bin.gz, play.bin

Output in web/public/data/stm/:
    manifest.json   grid, encodings, frame list (as build.py)
    bed.bin         bed elevation of the simulation
    ice/<age>.bin   extended ice thickness per frame
    flow/<age>.bin  surface velocity every 500 years, encoded as by flow.py. The data holds the
                    speed only: the direction is taken down the slope of the smoothed ice surface.
    history.bin     ice thickness through time for every place, as by history.py
    hole.bin        on the grid of the main manifest: 255 where this model takes over
"""

import argparse
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script directory

import numpy as np  # noqa: E402
from pyproj import Transformer  # noqa: E402
from scipy.ndimage import gaussian_filter, map_coordinates  # noqa: E402

from build import BED_ENC, MARGIN_SLOPE, THK_ENC, THK_MIN, extended_thickness, frame_name  # noqa: E402
from codec import encode_u16  # noqa: E402
from flow import VMAX, signed_log  # noqa: E402
from grid import EARTH_CIRCUMFERENCE, lat_to_my, lon_to_mx, mx_to_lon, my_to_lat  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CELL = 500.0  # m, grid of the "play" pack
PRESENT = 1950  # ages in the viewer are years before 1950
FLOW_EVERY = 5  # frames between flow frames (500 years)
SMOOTH = 4.0  # cells (2 km): the flow direction follows the surface slope averaged over several ice thicknesses
THK_STEP = 12.0  # metres per count in history.bin (as history.py)


def downslope(surface, ice):
    """Unit vector (east, north) down the smoothed ice surface; zero off the ice."""
    weight = gaussian_filter(ice.astype(np.float32), SMOOTH)
    smooth = gaussian_filter(np.where(ice, surface, 0.0).astype(np.float32), SMOOTH) / np.maximum(weight, 1e-6)
    smooth = np.where(ice, smooth, surface)  # no cliffs into the ice-free ground
    d_row, d_col = np.gradient(smooth)
    east, north = -d_col, d_row  # rows run north to south
    norm = np.hypot(east, north)
    ok = ice & (norm > 1e-6)
    return np.where(ok, east / np.maximum(norm, 1e-6), 0.0), np.where(ok, north / np.maximum(norm, 1e-6), 0.0)


def mercator_grid(bounds, width, height):
    """UTM 32N coordinates of the pixel centres of a mercator rectangle."""
    x0, y0, x1, y1 = bounds
    mx = x0 + (np.arange(width) + 0.5) / width * (x1 - x0)
    my = y0 + (np.arange(height) + 0.5) / height * (y1 - y0)
    mxx, myy = np.meshgrid(mx, my)
    tr = Transformer.from_crs("EPSG:4326", "EPSG:32632", always_xy=True)
    return tr.transform(mx_to_lon(mxx), my_to_lat(myy))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=ROOT / "data" / "stm")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data")
    args = ap.parse_args()

    meta = json.loads((args.data / "meta.json").read_text())
    west, south, east, north = meta["bounds"]
    nx, ny = meta["nx1"], meta["ny1"]
    pack = meta["packs"]["play"]
    assert pack["parts"][0] == "h1" and len(pack["files"]) == 1

    # bed on the 250 m grid; the 500 m grid is every second node
    base = np.frombuffer(gzip.decompress((args.data / "base.bin.gz").read_bytes()), dtype="<i2")
    base = base.reshape(meta["ny"], meta["nx"])[::2, ::2].astype(np.float32)
    assert base.shape == (ny, nx), base.shape

    # target: mercator rectangle around the domain, at about the source resolution
    tr = Transformer.from_crs("EPSG:32632", "EPSG:4326", always_xy=True)
    lon, lat = tr.transform([west, east, west, east], [south, south, north, north])
    bounds = (float(lon_to_mx(min(lon))), float(lat_to_my(max(lat))), float(lon_to_mx(max(lon))), float(lat_to_my(min(lat))))
    width = nx
    height = int(round(width * (bounds[3] - bounds[1]) / (bounds[2] - bounds[0])))
    x, y = mercator_grid(bounds, width, height)
    cols, rows = (x - west) / CELL, (north - y) / CELL  # rows run north to south
    inside = (cols >= 0) & (cols <= nx - 1) & (rows >= 0) & (rows <= ny - 1)

    def resample(field, outside):
        out = map_coordinates(field, [rows, cols], order=1, mode="nearest")
        return np.where(inside, out, outside).astype(np.float32)

    # direction of geographic east / north in the UTM frame, to rotate velocities (as grid.Resampler)
    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32632", always_xy=True)
    mx = bounds[0] + (np.arange(width) + 0.5) / width * (bounds[2] - bounds[0])
    my = bounds[1] + (np.arange(height) + 0.5) / height * (bounds[3] - bounds[1])
    lon_t, lat_t = np.meshgrid(mx_to_lon(mx), my_to_lat(my))
    ex, ey = to_utm.transform(lon_t + 1e-4, lat_t)
    nx_, ny_ = to_utm.transform(lon_t, lat_t + 1e-4)
    east_x, east_y = (ex - x) / np.hypot(ex - x, ey - y), (ey - y) / np.hypot(ex - x, ey - y)
    north_x, north_y = (nx_ - x) / np.hypot(nx_ - x, ny_ - y), (ny_ - y) / np.hypot(nx_ - x, ny_ - y)

    # history cube at half the frame size
    hw, hh = width // 2, height // 2
    hx, hy = mercator_grid(bounds, hw, hh)
    h_cols, h_rows = (hx - west) / CELL, (north - hy) / CELL
    h_inside = (h_cols >= 0) & (h_cols <= nx - 1) & (h_rows >= 0) & (h_rows <= ny - 1)
    cube = np.zeros((hh, hw, len(meta["times"])), np.uint8)

    out = args.out / "stm"
    (out / "ice").mkdir(parents=True, exist_ok=True)
    (out / "flow").mkdir(exist_ok=True)
    flow_frames, flow_total = [], 0
    (out / "bed.bin").write_bytes(encode_u16(resample(base, 0.0), **BED_ENC))

    pixel_km2 = ((bounds[2] - bounds[0]) / width * EARTH_CIRCUMFERENCE * np.cos(np.radians(46.8)) / 1000) ** 2
    frames, total = [], 0
    with open(args.data / pack["files"][0], "rb") as f:
        for k, (year, (_, offset, length, *_rest)) in enumerate(zip(meta["times"], pack["frames"])):
            f.seek(offset)
            raw = gzip.decompress(f.read(length))
            n = nx * ny
            rise = np.frombuffer(raw, dtype="<i2", count=n).reshape(ny, nx)  # ice surface above the bed
            thk = np.frombuffer(raw, dtype="<u2", count=n, offset=2 * n).reshape(ny, nx)
            # the surface is what gets drawn: use its height above the bed wherever there is ice
            h, _ = extended_thickness(np.where(thk >= 1, np.maximum(rise, 1), 0).astype(np.float32), CELL)
            ht = resample(h, THK_MIN)
            blob = encode_u16(ht, **THK_ENC)
            age = (PRESENT - year) / 1000
            name = frame_name(age)
            (out / "ice" / f"{name}.bin").write_bytes(blob)
            total += len(blob)
            area = float((ht > 0).sum() * pixel_km2)
            frames.append({"age": round(age, 3), "file": f"stm/ice/{name}.bin", "area": round(area)})
            thick = map_coordinates(thk.astype(np.float32), [h_rows, h_cols], order=1, mode="nearest")
            cube[..., k] = np.clip(np.rint(np.where(h_inside, thick, 0) / THK_STEP), 0, 255)

            if k % FLOW_EVERY == 0:
                speed = np.frombuffer(raw, dtype="<u2", count=n, offset=4 * n).reshape(ny, nx).astype(np.float32)
                ice = thk >= 1
                de, dn = downslope(base + rise, ice)
                vx, vy = resample(de * speed, 0.0), resample(dn * speed, 0.0)  # UTM x, y components
                v_east, v_north = vx * east_x + vy * east_y, vx * north_x + vy * north_y
                mask = ht > 0
                rgba = np.zeros((height, width, 4), np.uint8)
                rgba[..., 0] = np.where(mask, signed_log(v_east), 128)
                rgba[..., 1] = np.where(mask, signed_log(v_north), 128)
                rgba[..., 3] = 255  # basal speed (B) and bed temperature (A) are not known
                fblob = gzip.compress(rgba.tobytes(), compresslevel=9, mtime=0)
                (out / "flow" / f"{name}.bin").write_bytes(fblob)
                flow_total += len(fblob)
                flow_frames.append({"age": round(age, 3), "file": f"stm/flow/{name}.bin"})
                if k % 50 == 0:
                    got = np.hypot(v_east, v_north)[mask]
                    print(f"         flow: speed median {np.median(speed[ice]):5.1f} m/a in the data, {np.median(got):5.1f} m/a encoded")

            if k % 50 == 0 or k == len(meta["times"]) - 1:
                print(f"  {age:6.2f} ka  model {meta['stats'][k]['area']:7.0f} km2  resampled {area:7.0f} km2  {len(blob) / 1e3:5.0f} kB")

    manifest = {
        "run": "swiss-time-machine",
        "source": "Swiss Time Machine (IGM), doi:10.5281/zenodo.24003777, CC BY 4.0",
        "width": width,
        "height": height,
        "mercatorBounds": list(bounds),
        "lonLatBounds": [min(lon), min(lat), max(lon), max(lat)],
        "bed": {"file": "stm/bed.bin", **BED_ENC},
        "ice": {**THK_ENC, "marginSlope": MARGIN_SLOPE},
        "frames": frames,
        "flow": {"vmax": VMAX, "tempStep": 0.05, "frames": flow_frames},
    }
    blob = gzip.compress(cube.tobytes(), compresslevel=9, mtime=0)
    (out / "history.bin").write_bytes(blob)
    manifest["history"] = {"file": "stm/history.bin", "width": hw, "height": hh, "ages": [f["age"] for f in frames], "step": THK_STEP}
    print(f"flow frames: {len(flow_frames)}, {flow_total / 1e6:.1f} MB; history cube {cube.shape}, {len(blob) / 1e6:.1f} MB")

    # where this model takes over from the main one: its domain, on the main grid
    main_manifest = json.loads((args.out / "manifest.json").read_text())
    mx_, my_ = mercator_grid(main_manifest["mercatorBounds"], main_manifest["width"], main_manifest["height"])
    hole = (mx_ >= west) & (mx_ <= east) & (my_ >= south) & (my_ <= north)
    (out / "hole.bin").write_bytes(gzip.compress((hole * 255).astype(np.uint8).tobytes(), compresslevel=9, mtime=0))
    manifest["hole"] = "stm/hole.bin"

    (out / "manifest.json").write_text(json.dumps(manifest))
    print(f"{len(frames)} frames, grid {width}x{height}, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
