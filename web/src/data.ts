/** Loading and decoding of pipeline output (see pipeline/codec.py). */

export interface Encoding {
  offset: number;
  scale: number;
}

export interface Frame {
  age: number; // ka before present
  file: string;
  area: number;
}

export interface Manifest {
  run: string;
  source: string;
  width: number;
  height: number;
  /** normalised Web Mercator [x0, y0, x1, y1], y0 = north edge */
  mercatorBounds: [number, number, number, number];
  lonLatBounds: [number, number, number, number];
  bed: Encoding & { file: string };
  ice: Encoding & { marginSlope: number };
  frames: Frame[];
  /** only for a second model: uint8 mask on the main grid of where it replaces the main model */
  hole?: string;
  /** RGBA8 frames: surface velocity east / north (signed log), basal speed (log), basal temperature */
  flow?: { vmax: number; tempStep: number; frames: FrameRef[] };
  /** log10 of cumulative erosion potential in metres */
  erosion?: Encoding & { frames: FrameRef[] };
  /** debris trajectories, see pipeline/debris.py */
  debris?: { file: string; frameYears: number; count: number; regions: Region[] };
  /** uint8 [row, column, time] ice thickness / step, see pipeline/history.py */
  history?: { file: string; width: number; height: number; ages: number[]; step: number };
  /** age (ka) at which each place last became ice-free */
  deglaciation?: Encoding & { frames: FrameRef[] };
}

export interface Region {
  name: string;
  color: string;
  lon?: number;
  lat?: number;
}

export interface FrameRef {
  age: number;
  file: string;
}

export interface TimeSeries {
  age: number[];
  slvol: number[];
  area: number[];
}

export const DATA_URL = `${import.meta.env.BASE_URL}data/`;

export async function fetchJson<T>(name: string): Promise<T> {
  const r = await fetch(DATA_URL + name);
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

async function gunzip(file: string): Promise<ArrayBuffer> {
  const r = await fetch(DATA_URL + file);
  if (!r.ok || !r.body) throw new Error(`${file}: HTTP ${r.status}`);
  return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

/** Fetch a gzipped byte raster (e.g. RGBA8 flow frames). */
export async function fetchBytes(file: string): Promise<Uint8Array> {
  return new Uint8Array(await gunzip(file));
}

/** Fetch a gzipped, x-delta-coded uint16 raster and return physical values. */
export async function fetchRaster(file: string, width: number, height: number, enc: Encoding): Promise<Float32Array> {
  const q = new Uint16Array(await gunzip(file));
  if (q.length !== width * height) throw new Error(`${file}: unexpected size ${q.length}`);
  const out = new Float32Array(q.length);
  const inv = 1 / enc.scale;
  for (let row = 0, i = 0; row < height; row++) {
    let acc = 0;
    for (let col = 0; col < width; col++, i++) {
      acc = (acc + q[i]) & 0xffff;
      out[i] = acc * inv + enc.offset;
    }
  }
  return out;
}
