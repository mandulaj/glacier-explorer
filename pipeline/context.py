"""Outlines of the Eurasian ice sheet through the last glacial cycle, for context around the Alps.

The Alpine simulation stops at the edge of the Alps. This writes `context.json`: one set of
polygons per time slice of the ice sheet over the British Isles, Scandinavia and the Barents and
Kara seas, from two published reconstructions:

- 38 to 10 ka: DATED-1 (Hughes et al. 2016, doi:10.1111/bor.12142; data
  doi:10.1594/PANGAEA.848117, CC BY 3.0), most-credible margins;
- before that: best estimates of Batchelor et al. (2019, doi:10.1038/s41467-019-11601-2; data
  https://osf.io/7jen3/), one outline per marine isotope stage.

Input (see README):
  data/context/dated/shp/**/TS*.shp
  data/context/batchelor/<slice>/*best_estimate.shp
"""

from __future__ import annotations

import argparse
import glob
import json
import logging
from pathlib import Path

import numpy as np
import shapefile
from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent

# Both sources use this projection (no EPSG code): Lambert azimuthal equal area on the North Pole.
LAEA = "+proj=laea +lat_0=90 +lon_0=0 +datum=WGS84 +units=m"

TOLERANCE = 2500.0  # m, simplification of the outlines
MIN_AREA = 400e6  # m2, smaller pieces are dropped

# DATED-1: file stem -> age in ka. The pre-25 ka slices cover a time span each.
DATED = {
    **{f"TS{age}_mc": float(age) for age in range(10, 26)},
    "TS_27_poly": 27.0,
    "TS_2829_poly": 28.5,
    "TS_3230_poly": 31.0,
    # no most-credible margin for 38-35 ka; the minimum is a few ice caps on the mountains
    "TS_3835max_poly": 36.5,
}

# Batchelor et al.: folder -> age in ka taken to stand for the stage
# (45 ka, MIS 5a and 5c show the peak warmth of the stage, the others its largest extent).
BATCHELOR = {
    "45 ka": 45.0,
    "MIS 4": 65.0,  # 58-72 ka
    "MIS 5a": 79.0,  # 72-86 ka
    "MIS 5b": 89.0,  # 86-92 ka
    "MIS 5c": 100.0,  # 92-108 ka
    "MIS 5d": 112.0,  # 108-117 ka
}

# Ice-free ends of the record, so that the outlines fade in and out.
EMPTY = {9.0: "DATED-1", 118.0: "Batchelor et al. 2019"}

# The hemisphere-wide outlines are cut to the Eurasian ice sheet.
SECTOR = (-30.0, 110.0, 40.0, 88.0)  # lon west, east, lat south, north
ALPS = (3.0, 18.0, 43.0, 49.5)  # shown by the simulation itself


def read(path: str):
    """All polygons of a shapefile as one valid geometry (projected metres)."""
    logging.getLogger("shapefile").setLevel(logging.ERROR)  # hole-only shapes are repaired below
    reader = shapefile.Reader(path)
    parts = []
    for s in reader.shapes():
        if not s.points:
            continue
        g = make_valid(shape(s.__geo_interface__))
        if not g.is_empty:
            parts.append(g)
    return unary_union(parts)


def polygons(geometry) -> list[Polygon]:
    if geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    return [p for g in getattr(geometry, "geoms", []) for p in polygons(g)]


def sector(to_laea: Transformer) -> Polygon:
    w, e, s, n = SECTOR
    lon = np.concatenate([np.linspace(w, e, 400), np.full(100, e), np.linspace(e, w, 400), np.full(100, w)])
    lat = np.concatenate([np.full(400, s), np.linspace(s, n, 100), np.full(400, n), np.linspace(n, s, 100)])
    return Polygon(np.column_stack(to_laea.transform(lon, lat)))


def to_lonlat(poly: Polygon, to_ll: Transformer) -> list[list[list[float]]]:
    rings = []
    for ring in [poly.exterior, *poly.interiors]:
        x, y = np.asarray(ring.coords).T
        lon, lat = to_ll.transform(x, y)
        rings.append([[round(float(a), 3), round(float(b), 3)] for a, b in zip(lon, lat)])
    return rings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "context")
    parser.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data")
    args = parser.parse_args()

    to_ll = Transformer.from_crs(LAEA, "EPSG:4326", always_xy=True)
    to_laea = Transformer.from_crs("EPSG:4326", LAEA, always_xy=True)
    window = sector(to_laea)

    def keep(p: Polygon) -> bool:
        if p.area < MIN_AREA:
            return False
        lon, lat = to_ll.transform(*p.representative_point().coords[0])
        if ALPS[0] < lon < ALPS[1] and ALPS[2] < lat < ALPS[3]:
            return False
        # Iceland and Greenland are other ice sheets
        return not (lon < -12.5 and lat > 61.0)

    slices = []
    for stem, age in DATED.items():
        found = glob.glob(str(args.data / "dated" / "shp" / "**" / f"{stem}.shp"), recursive=True)
        if not found:
            raise SystemExit(f"missing DATED-1 file {stem}.shp under {args.data / 'dated'}")
        slices.append((age, "DATED-1", read(found[0])))
    for folder, age in BATCHELOR.items():
        found = glob.glob(str(args.data / "batchelor" / folder / "*best_estimate.shp"))
        if not found:
            raise SystemExit(f"missing Batchelor et al. file in {args.data / 'batchelor' / folder}")
        slices.append((age, "Batchelor et al. 2019", read(found[0]).intersection(window)))
    for age, source in EMPTY.items():
        slices.append((age, source, MultiPolygon()))

    out = []
    for age, source, geometry in sorted(slices, key=lambda s: s[0]):
        parts = [p for p in polygons(geometry.simplify(TOLERANCE)) if keep(p)]
        # holes smaller than the smallest piece of ice are noise at this scale
        parts = [Polygon(p.exterior, [h for h in p.interiors if Polygon(h).area >= MIN_AREA]) for p in parts]
        area = sum(p.area for p in parts) / 1e12
        points = sum(len(p.exterior.coords) + sum(len(h.coords) for h in p.interiors) for p in parts)
        print(f"{age:6.1f} ka  {source:22s} {len(parts):3d} polygons  {area:5.2f} million km2  {points} points")
        out.append({"age": age, "source": source, "area": round(area, 3), "polygons": [to_lonlat(p, to_ll) for p in parts]})

    args.out.mkdir(parents=True, exist_ok=True)
    target = args.out / "context.json"
    target.write_text(json.dumps({"slices": out}, separators=(",", ":")))
    print(f"wrote {target} ({target.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
