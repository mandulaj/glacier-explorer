"""Debris transport: trace rock debris from the high Alps to where the ice drops it.

Particles are seeded on ice next to rock walls in the upper part of the ice
cover, carried by the modelled surface velocity through the whole glacial
cycle, and deposited where they leave the ice (terminal and lateral margins)
or where the ice melts away beneath them.

Usage (from repo root, after build.py):
    uv run --project pipeline pipeline/debris.py

Output web/public/data/debris.bin (gzip, little-endian), registered in manifest.json:
    uint32 trajectory count, then per trajectory
        uint16 n points, uint8 source region, uint8 deposited flag, float32 start age (ka)
        n * (uint16 u, uint16 v)   position every 100 a in the viewer's uv grid
"""

import argparse
import gzip
import json
import struct
from pathlib import Path

import h5py
import numpy as np
from pyproj import Transformer
from scipy.ndimage import binary_dilation, map_coordinates

from build import ROOT, RUN
from grid import lat_to_my, lon_to_mx

FRAME_YEARS = 100.0
SUBSTEPS = 20
SEED_EVERY = 5  # frames (500 a)
SEEDS = 400
MAX_SPEED = 1500.0  # m/a, clip model spikes
MAX_LIFE_FRAMES = 250  # 25 ka
MIN_TRAVEL = 8000.0  # m, drop debris that barely moved

# source regions: debris is labelled by the nearest of these (name, lon, lat, colour)
REGIONS = [
    ("Mont Blanc", 6.87, 45.83, "#e6194b"),
    ("Valais Alps", 7.65, 46.02, "#f58231"),
    ("Bernese Alps", 7.95, 46.52, "#ffe119"),
    ("Gotthard", 8.55, 46.62, "#bfef45"),
    ("Glarus Alps", 9.0, 46.85, "#3cb44b"),
    ("Rhine / Graubünden", 9.45, 46.62, "#42d4f4"),
    ("Bernina / Engadin", 9.95, 46.42, "#4363d8"),
    ("Ticino Alps", 8.75, 46.3, "#911eb4"),
    ("Ortler / Adamello", 10.55, 46.35, "#f032e6"),
    ("Ötztal / Silvretta", 10.75, 46.92, "#a9a9a9"),
    ("Zillertal", 11.9, 47.05, "#9a6324"),
    ("Dolomites", 11.85, 46.4, "#800000"),
    ("Hohe Tauern", 12.75, 47.1, "#469990"),
    ("Julian / Carnic Alps", 13.5, 46.42, "#000075"),
    ("Eastern Alps", 14.2, 47.3, "#808000"),
    ("Gran Paradiso", 7.3, 45.52, "#fabed4"),
    ("Vanoise", 6.8, 45.3, "#ffd8b1"),
    ("Écrins", 6.3, 44.9, "#aaffc3"),
    ("Maritime Alps", 7.2, 44.2, "#dcbeff"),
]


def sample(field, col, row):
    return map_coordinates(field, [row, col], order=1, mode="nearest")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=ROOT / "data")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text())

    f = h5py.File(args.data / f"{RUN}.ex.100a.nc", "r")
    x, y, ages = f["x"][:], f["y"][:], f["age"][:]
    cell = float(x[1] - x[0])
    nrow, ncol = len(y), len(x)
    n = len(ages)
    bed = np.nan_to_num(f["topg"][n - 1])

    to_utm = Transformer.from_crs("EPSG:4326", "EPSG:32632", always_xy=True)
    rx, ry = to_utm.transform([r[1] for r in REGIONS], [r[2] for r in REGIONS])
    region_xy = np.stack([rx, ry], 1)

    # active particles (positions in fractional grid indices)
    col = np.empty(0)
    row = np.empty(0)
    ident = np.empty(0, int)
    tracks = []  # per particle: dict(start, region, points [(col, row)], deposited)

    block = f["thk"].chunks[0]
    for start in range(0, n, block):
        sl = slice(start, min(start + block, n))
        thk_b = np.nan_to_num(f["thk"][sl])
        u_b = np.nan_to_num(f["uvelsurf"][sl])
        v_b = np.nan_to_num(f["vvelsurf"][sl])
        for k in range(thk_b.shape[0]):
            i = start + k
            thk = thk_b[k]
            ice = thk >= 1.0
            # velocity in cells per year; zero outside ice
            uc = np.where(ice, np.clip(u_b[k], -MAX_SPEED, MAX_SPEED), 0.0) / cell
            vc = np.where(ice, np.clip(v_b[k], -MAX_SPEED, MAX_SPEED), 0.0) / cell

            # --- seed on ice cells touching rock, in the upper half of the ice cover
            if i % SEED_EVERY == 0 and ice.sum() > 500:
                edge = ice & binary_dilation(~ice) & (thk > 20)
                surface = bed + thk
                edge &= surface > np.median(surface[ice])
                rr, cc = np.nonzero(edge)
                if len(rr):
                    pick = rng.choice(len(rr), size=min(SEEDS, len(rr)), replace=False)
                    c0 = cc[pick] + rng.uniform(-0.4, 0.4, len(pick))
                    r0 = rr[pick] + rng.uniform(-0.4, 0.4, len(pick))
                    px, py = x[0] + c0 * cell, y[0] + r0 * cell
                    region = np.argmin((px[:, None] - region_xy[:, 0]) ** 2 + (py[:, None] - region_xy[:, 1]) ** 2, axis=1)
                    new_ids = np.arange(len(tracks), len(tracks) + len(pick))
                    for j in range(len(pick)):
                        tracks.append({"start": float(ages[i]), "region": int(region[j]), "points": [], "deposited": False})
                    col, row, ident = np.concatenate([col, c0]), np.concatenate([row, r0]), np.concatenate([ident, new_ids])

            # --- record position at this frame, then advect over the next 100 a (midpoint rule)
            for j, c, r in zip(ident, col, row):
                tracks[j]["points"].append((c, r))
            dt = FRAME_YEARS / SUBSTEPS
            for _ in range(SUBSTEPS):
                cm = col + 0.5 * dt * sample(uc, col, row)
                rm = row + 0.5 * dt * sample(vc, col, row)
                col = col + dt * sample(uc, cm, rm)
                row = row + dt * sample(vc, cm, rm)

            # --- deposit where the particle is no longer on ice, retire the too old
            if len(col):
                inside = (col > 0) & (col < ncol - 1) & (row > 0) & (row < nrow - 1)
                on_ice = inside & (sample(thk, col, row) >= 1.0)
                life = np.array([len(tracks[j]["points"]) for j in ident])
                for j, c, r in zip(ident[~on_ice], col[~on_ice], row[~on_ice]):
                    tracks[j]["points"].append((c, r))
                    tracks[j]["deposited"] = True
                keep = on_ice & (life < MAX_LIFE_FRAMES)
                col, row, ident = col[keep], row[keep], ident[keep]
        print(f"  to {ages[sl][-1]:6.1f} ka: {len(tracks)} seeded, {len(col)} in transit")

    # --- convert to the viewer's uv grid and write
    x0, y0, x1, y1 = manifest["mercatorBounds"]
    to_ll = Transformer.from_crs("EPSG:32632", "EPSG:4326", always_xy=True)
    chunks, kept, points = [], 0, 0
    for t in tracks:
        p = np.array(t["points"])
        if len(p) < 2 or not t["deposited"]:
            continue
        px, py = x[0] + p[:, 0] * cell, y[0] + p[:, 1] * cell
        if np.hypot(px[-1] - px[0], py[-1] - py[0]) < MIN_TRAVEL:
            continue
        lon, lat = to_ll.transform(px, py)
        u = np.clip((lon_to_mx(lon) - x0) / (x1 - x0), 0, 1)
        v = np.clip((lat_to_my(lat) - y0) / (y1 - y0), 0, 1)
        uv = np.rint(np.stack([u, v], 1) * 65535).astype("<u2")
        chunks.append(struct.pack("<HBBf", len(uv), t["region"], 1, t["start"]) + uv.tobytes())
        kept += 1
        points += len(uv)
    blob = gzip.compress(struct.pack("<I", kept) + b"".join(chunks), compresslevel=9, mtime=0)
    (args.out / "debris.bin").write_bytes(blob)
    manifest["debris"] = {
        "file": "debris.bin",
        "frameYears": FRAME_YEARS,
        "regions": [{"name": r[0], "color": r[3]} for r in REGIONS],
        "count": kept,
    }
    manifest_path.write_text(json.dumps(manifest))
    print(f"debris: {kept} trajectories, {points} points, {len(blob) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
