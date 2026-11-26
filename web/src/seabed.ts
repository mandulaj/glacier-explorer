import { addProtocol } from "maplibre-gl";
import { DATA_URL } from "./data";

/**
 * Terrain with a real seabed.
 *
 * Mapterhorn tiles are land only: the sea is a flat floor at 0 m. This
 * registers a `seabed://` tile protocol that fetches the Mapterhorn tile and,
 * only for tiles that touch the sea, replaces the pixels at sea level with
 * depths from a bathymetry source. Land pixels, and all tiles away from the
 * sea, pass through untouched at full resolution.
 *
 * Bathymetry sources, best first:
 *  - our own EMODnet tiles (about 230 m, seas around the Alps; pipeline/sea.py);
 *  - AWS Terrain Tiles (global, ocean depths at about 1 to 2 km).
 */

const LAND_TILES = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const GLOBAL_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const GLOBAL_MAX_ZOOM = 7; // the ocean data in these tiles is no finer than this
const PROTOCOL = "seabed";

interface SeaIndex {
  minZoom: number;
  maxZoom: number;
  tiles: string[];
}

/** Decoded bathymetry tile: elevation in metres, 0 or above where there is no sea. */
interface Bathymetry {
  size: number;
  elevation: Float32Array;
  /**
   * Pixels this deep are open water for certain. Stray "land" pixels there (ships,
   * platforms and noise in the land tiles) would otherwise stand as spikes on the seabed.
   */
  certainDepth: number;
}

const fill = (template: string, z: number, x: number, y: number) =>
  template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));

async function pixels(blob: Blob): Promise<ImageData> {
  // exact bytes are needed: no colour management, no alpha premultiplication
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Returns the tile URL template to use for the terrain sources. */
export async function installSeabed(): Promise<{ tiles: string; hasSeabed: boolean }> {
  let index: SeaIndex | null = null;
  try {
    const r = await fetch(`${DATA_URL}sea/index.json`);
    if (r.ok) index = await r.json();
  } catch {
    // data built without the regional seabed: the global source still works
  }
  const regional = new Set(index?.tiles ?? []);
  const cache = new Map<string, Promise<Bathymetry | null>>();
  const merged = new Map<string, Promise<ArrayBuffer>>();

  const bathymetry = (url: string, certainDepth: number) => {
    let p = cache.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then(pixels)
        .then((img): Bathymetry => {
          const elevation = new Float32Array(img.width * img.height);
          for (let i = 0, o = 0; i < elevation.length; i++, o += 4) {
            elevation[i] = img.data[o] * 256 + img.data[o + 1] + img.data[o + 2] / 256 - 32768;
          }
          return { size: img.width, elevation, certainDepth };
        })
        .catch(() => null); // no bathymetry: the land tile is used as it is
      cache.set(url, p);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
    return p;
  };

  /** Best bathymetry for a tile, and how many zoom levels above the tile it sits. */
  const sourceFor = async (z: number, x: number, y: number): Promise<{ sea: Bathymetry; shift: number } | null> => {
    if (index && z >= index.minZoom) {
      const shift = Math.max(z - index.maxZoom, 0);
      const key = `${z - shift}/${x >> shift}/${y >> shift}`;
      if (regional.has(key)) {
        const sea = await bathymetry(`${DATA_URL}sea/${key}.png`, -15);
        if (sea) return { sea, shift };
      }
    }
    const shift = Math.max(z - GLOBAL_MAX_ZOOM, 0);
    // coarse data: only trust it far from the coast when overriding land pixels
    const sea = await bathymetry(fill(GLOBAL_TILES, z - shift, x >> shift, y >> shift), -200);
    return sea ? { sea, shift } : null;
  };

  const merge = async (land: ArrayBuffer, x: number, y: number, sea: Bathymetry, shift: number) => {
    const size = sea.size;
    // part of the bathymetry tile covered by this tile
    const scale = size / (1 << shift);
    const ox = (x & ((1 << shift) - 1)) * scale;
    const oy = (y & ((1 << shift) - 1)) * scale;
    // most tiles are inland: leave before decoding anything if there is no water around
    let wet = false;
    const x1 = Math.min(Math.ceil(ox + scale) + 1, size);
    const y1 = Math.min(Math.ceil(oy + scale) + 1, size);
    for (let py = Math.max(Math.floor(oy) - 1, 0); py < y1 && !wet; py++) {
      for (let px = Math.max(Math.floor(ox) - 1, 0); px < x1; px++) {
        if (sea.elevation[py * size + px] < -0.5) {
          wet = true;
          break;
        }
      }
    }
    if (!wet) return land;

    const img = await pixels(new Blob([land]));
    const { width, height, data } = img;
    let changed = false;
    for (let py = 0, o = 0; py < height; py++) {
      const fy = Math.min(Math.max(oy + ((py + 0.5) / height) * scale - 0.5, 0), size - 1);
      const y0 = Math.floor(fy);
      const y1b = Math.min(y0 + 1, size - 1);
      const wy = fy - y0;
      for (let px = 0; px < width; px++, o += 4) {
        const elevation = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
        if (elevation > 15) continue; // clearly land: keeps its high-resolution value
        const fx = Math.min(Math.max(ox + ((px + 0.5) / width) * scale - 0.5, 0), size - 1);
        const x0 = Math.floor(fx);
        const x1b = Math.min(x0 + 1, size - 1);
        const wx = fx - x0;
        const e = sea.elevation;
        const depth =
          (e[y0 * size + x0] * (1 - wx) + e[y0 * size + x1b] * wx) * (1 - wy) +
          (e[y1b * size + x0] * (1 - wx) + e[y1b * size + x1b] * wx) * wy;
        let value: number;
        if (elevation > 0.5) {
          // low ground: land on the coast, unless the bathymetry puts it in open water
          if (depth > sea.certainDepth) continue;
          value = depth;
        } else {
          // At sea level. Without depth data (lagoons, river mouths) keep the ground just
          // above the water. Land below sea level that does have depth data gets flooded.
          value = depth > -0.5 ? 0.5 : depth;
        }
        const v = value + 32768;
        data[o] = Math.floor(v / 256);
        data[o + 1] = Math.floor(v) % 256;
        data[o + 2] = Math.floor((v - Math.floor(v)) * 256);
        changed = true;
      }
    }
    if (!changed) return land;
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")!.putImageData(img, 0, 0);
    return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
  };

  addProtocol(PROTOCOL, async (params, abort) => {
    const [z, x, y] = params.url.slice(PROTOCOL.length + 3).split("/").map(Number);
    const key = `${z}/${x}/${y}`;
    let result = merged.get(key);
    if (!result) {
      result = (async () => {
        const [r, source] = await Promise.all([fetch(fill(LAND_TILES, z, x, y), { signal: abort.signal }), sourceFor(z, x, y)]);
        if (!r.ok) throw new Error(`Tile fetch error: ${r.status}`);
        const land = await r.arrayBuffer();
        return source ? merge(land, x, y, source.sea, source.shift) : land;
      })();
      merged.set(key, result);
      result.catch(() => merged.delete(key));
      if (merged.size > 96) merged.delete(merged.keys().next().value!);
    }
    // terrain and hillshade sources request the same tiles; each needs its own copy
    return { data: (await result).slice(0) };
  });

  return { tiles: `${PROTOCOL}://{z}/{x}/{y}`, hasSeabed: true };
}
