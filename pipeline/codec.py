"""Compact lossless-after-quantisation raster encoding shared with the viewer.

A raster is quantised to uint16 as round((value - offset) * scale), delta-coded
along x (wrapping), stored little-endian and gzipped. The viewer reverses this
with DecompressionStream + a running sum (see web/src/data.ts).
"""

import gzip

import numpy as np


def encode_u16(values, offset, scale):
    q = np.clip(np.rint((values - offset) * scale), 0, 65535).astype(np.uint16)
    d = q.copy()
    d[:, 1:] = q[:, 1:] - q[:, :-1]  # uint16 arithmetic wraps
    return gzip.compress(d.astype("<u2").tobytes(), compresslevel=9, mtime=0)


def decode_u16(blob, shape, offset, scale):
    d = np.frombuffer(gzip.decompress(blob), dtype="<u2").reshape(shape)
    q = np.cumsum(d, axis=1, dtype=np.uint16)
    return q.astype(np.float32) / scale + offset
