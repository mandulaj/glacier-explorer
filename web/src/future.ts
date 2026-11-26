import type { Map as MlMap } from "maplibre-gl";
import type { Ramp } from "./colormaps";
import type { Encoding, Manifest } from "./data";
import { DrapedLayer } from "./draped";

/**
 * A glacier's projected future (our own IGM runs, see pipeline/future.py), draped on
 * today's terrain: the remaining ice coloured by its thickness, and the ground it has left.
 *
 * Today's terrain already contains today's glacier, and a glacier that thins sinks below
 * it, so the future cannot be drawn as ice standing on the terrain the way the past is.
 */

export interface FutureManifest {
  glacier: string;
  lon: number;
  lat: number;
  width: number;
  height: number;
  mercatorBounds: [number, number, number, number];
  thickness: Encoding;
  gone: Encoding;
  startYear: number;
  endYear: number;
  scenarios: {
    id: string;
    label: string;
    detail: string;
    frames: { year: number; thk: string; gone: string; volume: number; area: number }[];
  }[];
}

export const THICKNESS_RAMP: Ramp = {
  title: "Remaining ice thickness (m)",
  stops: [
    [0, "#e3f2fb"],
    [0.3, "#8cc3ea"],
    [0.65, "#2f7fc4"],
    [1, "#12306b"],
  ],
  ticks: [
    [0, "0"],
    [0.5, "300"],
    [1, "600"],
  ],
};
const THICKNESS_RANGE: [number, number] = [0, 600];

/** ground the ice has left, in one colour */
export const GONE_COLOR = "#b98a5a";
const GONE_RAMP: Ramp = { title: "", stops: [[0, GONE_COLOR], [1, GONE_COLOR]], ticks: [] };

export class FutureGlacier {
  private layers = new Map<string, [DrapedLayer, DrapedLayer]>();
  private scenario: string;
  private year = 0;
  private on = false;

  /** @param before style layer below which the rasters go */
  constructor(
    private map: MlMap,
    readonly manifest: FutureManifest,
    private before: string,
  ) {
    this.scenario = manifest.scenarios[0].id;
  }

  private get frames() {
    return this.manifest.scenarios.find((s) => s.id === this.scenario)!.frames;
  }

  /** Frames are stored old to young by "age" (years before the end), like all frame sets. */
  private age(year: number) {
    return this.manifest.endYear - year;
  }

  private ensure(): [DrapedLayer, DrapedLayer] {
    let pair = this.layers.get(this.scenario);
    if (!pair) {
      const grid = this.manifest as unknown as Manifest; // the draped layer reads the grid only
      const make = (kind: "gone" | "thk") =>
        new DrapedLayer(grid, {
          id: `future-${this.scenario}-${kind}`,
          frames: this.frames.map((f) => ({ age: this.age(f.year), file: f[kind] })),
          encoding: kind === "thk" ? this.manifest.thickness : this.manifest.gone,
          ramp: kind === "thk" ? THICKNESS_RAMP : GONE_RAMP,
          // transparent below the low end: ice thinner than a few metres, and ground not yet bare
          range: kind === "thk" ? THICKNESS_RANGE : [0.5, 1.5],
        });
      pair = [make("gone"), make("thk")];
      for (const layer of pair) this.map.addLayer(layer, this.before);
      this.layers.set(this.scenario, pair);
    }
    return pair;
  }

  /** Show the projection for a year; it is hidden before its first year. */
  set(on: boolean, scenario: string, year: number) {
    this.on = on && year > this.manifest.startYear;
    this.scenario = scenario;
    this.year = year;
    for (const [id, pair] of this.layers) if (id !== scenario || !this.on) pair.forEach((l) => l.setVisible(false));
    if (!this.on) return;
    for (const layer of this.ensure()) {
      layer.setAge(this.age(year));
      layer.setVisible(true);
    }
  }

  get active() {
    return this.on;
  }

  /** Volume and area at the current year, interpolated between the saved years. */
  describe(): string {
    const frames = this.frames;
    const first = frames[0];
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].year <= this.year) i++;
    const a = frames[i];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    const t = b.year > a.year ? Math.min(Math.max((this.year - a.year) / (b.year - a.year), 0), 1) : 0;
    const volume = a.volume + (b.volume - a.volume) * t;
    const area = a.area + (b.area - a.area) * t;
    return `${this.manifest.glacier}, model: ${volume.toFixed(1)} km³ of ice (${Math.round((volume / first.volume) * 100)} % of ${first.year}), ${Math.round(area)} km²`;
  }
}
