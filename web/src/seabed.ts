import { addProtocol } from "maplibre-gl";
import { DATA_URL } from "./data";

/**
 * Terrain with a real seabed.
 *
 * Mapterhorn tiles are land only: the sea is a flat floor at 0 m. This
 * registers a `seabed://` tile protocol that fetches the Mapterhorn tile and,
 * only for tiles that touch the sea, replaces the pixels at sea level with
 * depths from our low-zoom bathymetry tiles (pipeline/sea.py). Land pixels,
 * and all tiles away from the sea, pass through untouched at full resolution.
 */

const LAND_TILES = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const PROTOCOL = "seabed";
const SIZE = 512;

interface SeaIndex {
  minZoom: number;
  maxZoom: number;
  tiles: string[];
}

/** Returns the tile URL template to use for the terrain sources. */
export async function installSeabed(): Promise<{ tiles: string; hasSeabed: boolean }> {
  let index: SeaIndex;
  try {
    const r = await fetch(`${DATA_URL}sea/index.json`);
    if (!r.ok) throw new Error(String(r.status));
    index = await r.json();
  } catch {
    return { tiles: LAND_TILES, hasSeabed: false }; // data built without seabed
  }
  const available = new Set(index.tiles);
  const seaCache = new Map<string, Promise<Float32Array>>();
  const merged = new Map<string, Promise<ArrayBuffer>>();

  const pixels = async (blob: Blob): Promise<ImageData> => {
    // exact bytes are needed: no colour management, no alpha premultiplication
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  };

  /** Seabed elevation (m, 0 where there is no sea) of one bathymetry tile. */
  const seaTile = (key: string) => {
    let p = seaCache.get(key);
    if (!p) {
      p = fetch(`${DATA_URL}sea/${key}.png`)
        .then((r) => r.blob())
        .then(pixels)
        .then((img) => {
          const out = new Float32Array(img.width * img.height);
          for (let i = 0, o = 0; i < out.length; i++, o += 4) out[i] = img.data[o] * 256 + img.data[o + 1] - 32768;
          return out;
        });
      seaCache.set(key, p);
      if (seaCache.size > 24) seaCache.delete(seaCache.keys().next().value!);
    }
    return p;
  };

  const merge = async (land: ArrayBuffer, z: number, x: number, y: number, seaKey: string, shift: number) => {
    const [img, sea] = await Promise.all([pixels(new Blob([land])), seaTile(seaKey)]);
    const { width, height, data } = img;
    // position of this tile inside its bathymetry ancestor
    const scale = SIZE / (1 << shift);
    const ox = (x & ((1 << shift) - 1)) * scale;
    const oy = (y & ((1 << shift) - 1)) * scale;
    let changed = false;
    for (let py = 0, o = 0; py < height; py++) {
      const fy = Math.min(Math.max(oy + ((py + 0.5) / height) * scale - 0.5, 0), SIZE - 1);
      const y0 = Math.floor(fy);
      const y1 = Math.min(y0 + 1, SIZE - 1);
      const wy = fy - y0;
      for (let px = 0; px < width; px++, o += 4) {
        const elevation = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
        if (elevation > 0.5) continue; // land keeps its high-resolution value
        const fx = Math.min(Math.max(ox + ((px + 0.5) / width) * scale - 0.5, 0), SIZE - 1);
        const x0 = Math.floor(fx);
        const x1 = Math.min(x0 + 1, SIZE - 1);
        const wx = fx - x0;
        const depth =
          (sea[y0 * SIZE + x0] * (1 - wx) + sea[y0 * SIZE + x1] * wx) * (1 - wy) +
          (sea[y1 * SIZE + x0] * (1 - wx) + sea[y1 * SIZE + x1] * wx) * wy;
        // No seabed data here (some lagoons and river mouths): keep the ground just above the
        // water. Land below sea level with seabed data (Po delta polders) does get flooded.
        const value = depth > -0.5 ? 0.5 : depth;
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
        const r = await fetch(LAND_TILES.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)), { signal: abort.signal });
        if (!r.ok) throw new Error(`Tile fetch error: ${r.status}`);
        const land = await r.arrayBuffer();
        if (z < index.minZoom) return land;
        const shift = Math.max(z - index.maxZoom, 0);
        const seaKey = `${z - shift}/${x >> shift}/${y >> shift}`;
        return available.has(seaKey) ? merge(land, z, x, y, seaKey, shift) : land;
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
