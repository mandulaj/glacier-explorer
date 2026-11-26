/** Colour ramps for the ice display modes, shared by shaders (as LUT textures), canvas layers and legends. */

export type IceMode = "plain" | "speed" | "sliding" | "temperature" | "erosion" | "deglaciation";

export interface Ramp {
  title: string;
  stops: [number, string][];
  /** legend tick labels at ramp positions 0..1 */
  ticks: [number, string][];
}

export const RAMPS: Record<Exclude<IceMode, "plain">, Ramp> = {
  speed: {
    title: "Surface speed (m / year)",
    stops: [
      [0, "#eef4fa"],
      [0.25, "#a6cbe6"],
      [0.5, "#4f74d1"],
      [0.75, "#b93a9c"],
      [1, "#ffd23f"],
    ],
    ticks: [
      [0, "1"],
      [1 / 3, "10"],
      [2 / 3, "100"],
      [1, "1000"],
    ],
  },
  sliding: {
    title: "Basal sliding (m / year)",
    stops: [
      [0, "#f1eee8"],
      [0.3, "#fdd49e"],
      [0.6, "#ef6548"],
      [1, "#7f0000"],
    ],
    ticks: [
      [0, "1"],
      [1 / 3, "10"],
      [2 / 3, "100"],
      [1, "1000"],
    ],
  },
  temperature: {
    title: "Ice base: frozen (°C below melting) or temperate",
    stops: [
      [0, "#08306b"],
      [0.5, "#4292c6"],
      [0.93, "#d6e6f4"],
      [0.94, "#e6550d"],
      [1, "#e6550d"],
    ],
    ticks: [
      [0, "−8"],
      [0.47, "−4"],
      [0.9, "0"],
      [1, "sliding"],
    ],
  },
  deglaciation: {
    title: "Ice-free since (thousand years ago)",
    stops: [
      [0, "#fde725"],
      [0.35, "#35b779"],
      [0.7, "#31688e"],
      [1, "#440154"],
    ],
    ticks: [
      [0, "8"],
      [0.5, "18"],
      [1, "28+"],
    ],
  },
  erosion: {
    title: "Cumulative erosion potential (m)",
    stops: [
      [0, "#ffffcc"],
      [0.35, "#fd8d3c"],
      [0.7, "#bd0026"],
      [1, "#3f0030"],
    ],
    ticks: [
      [0, "0.1"],
      [1 / 3, "1"],
      [2 / 3, "10"],
      [1, "100"],
    ],
  },
};

/** ka range mapped onto the deglaciation ramp */
export const DEGLACIATION_RANGE: [number, number] = [8, 28];

/** log10(m) range mapped onto the erosion ramp */
export const EROSION_RANGE: [number, number] = [-1, 2];

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 256-entry RGBA lookup table for a ramp. */
export function rampTable(ramp: Ramp): Uint8Array {
  const out = new Uint8Array(256 * 4);
  const stops = ramp.stops;
  for (let i = 0, s = 0; i < 256; i++) {
    const t = i / 255;
    while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
    const [t0, c0] = stops[s];
    const [t1, c1] = stops[s + 1];
    const f = Math.min(Math.max((t - t0) / (t1 - t0 || 1), 0), 1);
    const a = hex(c0);
    const b = hex(c1);
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(a[k] + (b[k] - a[k]) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function rampCss(ramp: Ramp): string {
  return `linear-gradient(to right, ${ramp.stops.map(([t, c]) => `${c} ${t * 100}%`).join(", ")})`;
}
