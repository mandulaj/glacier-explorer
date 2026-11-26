"""Glacier extents in Switzerland since the Little Ice Age, for the "since 1850" view.

Reads the Swiss Glacier Inventories published by GLAMOS (CC BY 4.0) and writes
`recent/glaciers.json`: the glacier outlines of each inventory in longitude / latitude.

Input: the unzipped inventories from https://doi.glamos.ch (see README) in data/recent/sgi/:
    sgi1850_r1992, sgi1931_r2022, sgi1973_r1976, sgi2010_r2010, sgi2016_r2020
"""

import argparse
import json
import logging
from pathlib import Path

import numpy as np
import shapefile
from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import Polygon, shape

ROOT = Path(__file__).resolve().parent.parent

# year, shapefile, coordinate system, citation
INVENTORIES = [
    (1850, "sgi1850_r1992/SGI_1850.shp", "EPSG:2056", "SGI 1850 (Maisch et al. 2000)"),
    (1931, "sgi1931_r2022/SGI_1931.shp", "EPSG:21781", "SGI 1931 (Mannerfelt et al. 2022)"),
    (1973, "sgi1973_r1976/SGI_1973.shp", "EPSG:2056", "SGI 1973 (Müller et al. 1976)"),
    (2010, "sgi2010_r2010/SGI_2010.shp", "EPSG:2056", "SGI 2010 (Fischer et al. 2014)"),
    (2016, "sgi2016_r2020/SGI_2016_glaciers.shp", "EPSG:2056", "SGI 2016 (Linsbauer et al. 2021)"),
]

TOLERANCE = 12.0  # m, simplification of the outlines
MIN_AREA = 20e3  # m2, smaller glaciers and holes are dropped


def polygons(geometry):
    if geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    return [p for g in getattr(geometry, "geoms", []) for p in polygons(g)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=ROOT / "data" / "recent" / "sgi")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data" / "recent")
    args = ap.parse_args()
    logging.getLogger("shapefile").setLevel(logging.ERROR)

    out = []
    for year, file, crs, name in INVENTORIES:
        to_ll = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        parts, area, points = [], 0.0, 0
        for s in shapefile.Reader(str(args.data / file)).shapes():
            if not s.points:
                continue
            for p in polygons(make_valid(shape(s.__geo_interface__)).simplify(TOLERANCE)):
                if p.area < MIN_AREA:
                    continue
                area += p.area
                rings = []
                for ring in [p.exterior, *[h for h in p.interiors if Polygon(h).area >= MIN_AREA]]:
                    x, y = np.asarray(ring.coords)[:, :2].T
                    lon, lat = to_ll.transform(x, y)
                    rings.append([[round(float(a), 5), round(float(b), 5)] for a, b in zip(lon, lat)])
                    points += len(lon)
                parts.append(rings)
        print(f"{year}  {len(parts):5d} glaciers  {area / 1e6:7.0f} km2  {points} points  {name}")
        out.append({"year": year, "name": name, "area": round(area / 1e6), "polygons": parts})

    args.out.mkdir(parents=True, exist_ok=True)
    target = args.out / "glaciers.json"
    target.write_text(json.dumps({"inventories": out}, separators=(",", ":")))
    print(f"wrote {target} ({target.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
