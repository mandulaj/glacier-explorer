"""Target Web Mercator grid and resampling from the model's UTM 32N grid.

The viewer maps every frame onto one axis-aligned rectangle in normalised
Web Mercator coordinates (x, y in [0, 1], y growing southwards), which is the
coordinate system MapLibre custom layers work in.
"""

from dataclasses import dataclass

import numpy as np
from pyproj import Transformer
from scipy.ndimage import map_coordinates

EARTH_CIRCUMFERENCE = 2 * np.pi * 6378137.0


def lon_to_mx(lon):
    return (np.asarray(lon) + 180.0) / 360.0


def lat_to_my(lat):
    s = np.sin(np.radians(lat))
    return 0.5 - np.log((1 + s) / (1 - s)) / (4 * np.pi)


def mx_to_lon(mx):
    return np.asarray(mx) * 360.0 - 180.0


def my_to_lat(my):
    return np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * np.asarray(my)))))


@dataclass
class Resampler:
    """Bilinear resampling from the source UTM grid to the mercator grid."""

    width: int
    height: int
    bounds: tuple  # mercator (x0, y0, x1, y1), y0 = north edge
    rows: np.ndarray  # fractional source row for each target pixel
    cols: np.ndarray  # fractional source column for each target pixel
    inside: np.ndarray  # target pixels that fall inside the source domain
    east: np.ndarray  # unit vector of mercator east in source (x, y) components
    north: np.ndarray

    @classmethod
    def build(cls, x, y, lon, lat, width=1280):
        """x, y: source grid coordinates (m, UTM 32N); lon, lat: 2D cell coordinates."""
        x0, x1 = float(lon_to_mx(lon.min())), float(lon_to_mx(lon.max()))
        y0, y1 = float(lat_to_my(lat.max())), float(lat_to_my(lat.min()))
        height = int(round(width * (y1 - y0) / (x1 - x0)))

        # pixel centres
        mx = x0 + (np.arange(width) + 0.5) / width * (x1 - x0)
        my = y0 + (np.arange(height) + 0.5) / height * (y1 - y0)
        mxx, myy = np.meshgrid(mx, my)
        lon_t, lat_t = mx_to_lon(mxx), my_to_lat(myy)

        tr = Transformer.from_crs("EPSG:4326", "EPSG:32632", always_xy=True)
        ux, uy = tr.transform(lon_t, lat_t)
        dx, dy = x[1] - x[0], y[1] - y[0]
        cols = (ux - x[0]) / dx
        rows = (uy - y[0]) / dy
        inside = (cols >= 0) & (cols <= len(x) - 1) & (rows >= 0) & (rows <= len(y) - 1)

        # local direction of geographic east / north expressed in the UTM frame,
        # needed to rotate velocity vectors (grid convergence is up to ~5 degrees)
        eps = 1e-4
        ex, ey = tr.transform(lon_t + eps, lat_t)
        nx, ny = tr.transform(lon_t, lat_t + eps)
        east = np.stack([ex - ux, ey - uy])
        north = np.stack([nx - ux, ny - uy])
        east /= np.hypot(*east)
        north /= np.hypot(*north)
        return cls(width, height, (x0, y0, x1, y1), rows, cols, inside, east, north)

    def scalar(self, field, outside=0.0, order=1):
        """Resample a 2D source field (already free of NaN)."""
        out = map_coordinates(field, [self.rows, self.cols], order=order, mode="nearest")
        out[~self.inside] = outside
        return out.astype(np.float32)

    def vector(self, u, v):
        """Resample a source-grid vector field, return (east, north) components."""
        us, vs = self.scalar(u), self.scalar(v)
        return (us * self.east[0] + vs * self.east[1], us * self.north[0] + vs * self.north[1])

    def lonlat_bounds(self):
        x0, y0, x1, y1 = self.bounds
        return [float(mx_to_lon(x0)), float(my_to_lat(y1)), float(mx_to_lon(x1)), float(my_to_lat(y0))]

    def pixel_ground_size(self):
        """Approximate ground size of one pixel (m) at each row."""
        x0, y0, x1, y1 = self.bounds
        my = y0 + (np.arange(self.height) + 0.5) / self.height * (y1 - y0)
        return (x1 - x0) / self.width * EARTH_CIRCUMFERENCE * np.cos(np.radians(my_to_lat(my)))
