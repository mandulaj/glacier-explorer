import { Marker, MercatorCoordinate, Popup, type LngLat, type Map as MlMap } from "maplibre-gl";
import { fetchBytes, type Manifest } from "./data";
import type { IceLayer } from "./iceLayer";
import { EARTH_CIRCUMFERENCE } from "./surface";

/**
 * Click on the map to inspect a place:
 *  - ice thickness there through the whole glacial cycle, and since when it is ice-free;
 *  - "Whose ice is this?": follow the ice flow of the moment upstream to its source
 *    and downstream to the margin;
 *  - start a cross-section; the next click ends it and opens a profile of terrain and ice.
 */

const LOG_VMAX = Math.log(1 + 3000);
const TRACE_STEP = 400; // metres
const UPSTREAM: [number, number, number] = [0.91, 0.35, 0.05];
const DOWNSTREAM: [number, number, number] = [0.04, 0.24, 0.44];
const SECTION_SAMPLES = 260;

interface Trace {
  points: number[]; // u, v, u, v, ...
  metres: number;
  years: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en");

export class Inspector {
  private popup: Popup | null = null;
  private place: { lngLat: LngLat; u: number; v: number; series: Float32Array | null } | null = null;
  private history: Uint8Array | null = null;
  private historyLoading: Promise<void> | null = null;
  private age = 0;

  // popup parts that change with time
  private status = document.createElement("p");
  private chart = document.createElement("canvas");
  private traceText = document.createElement("p");

  // cross-section
  private sectionStart: LngLat | null = null;
  private section: { a: LngLat; b: LngLat; terrain: (number | null)[] } | null = null;
  private markers: Marker[] = [];
  private panel = document.getElementById("section")!;
  private sectionCanvas = document.getElementById("section-canvas") as HTMLCanvasElement;
  private sectionTitle = document.getElementById("section-title")!;
  private hint = document.getElementById("map-hint")!;

  constructor(
    private map: MlMap,
    private ice: IceLayer,
    private manifest: Manifest,
  ) {
    map.on("click", (e) => {
      if (document.pointerLockElement) return; // flying with mouse look
      if (this.sectionStart) this.finishSection(e.lngLat);
      else this.open(e.lngLat);
    });
    // terrain tiles keep arriving after a move; refresh the profile's ground line
    map.on("idle", () => {
      if (this.section && this.section.terrain.includes(null)) this.sampleTerrain();
    });
    document.getElementById("section-close")!.addEventListener("click", () => this.closeSection());
    new ResizeObserver(() => this.drawSection()).observe(this.sectionCanvas);
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this.sectionStart) this.cancelSectionStart();
    });
  }

  setAge(age: number) {
    this.age = age;
    if (this.place && this.popup?.isOpen()) this.updatePopup();
    if (this.section) this.drawSection();
  }

  // ---------------------------------------------------------------- coordinates

  private toUv(lngLat: LngLat): [number, number] {
    const [x0, y0, x1, y1] = this.manifest.mercatorBounds;
    const m = MercatorCoordinate.fromLngLat(lngLat);
    return [(m.x - x0) / (x1 - x0), (m.y - y0) / (y1 - y0)];
  }

  private toLngLat(u: number, v: number): LngLat {
    const [x0, y0, x1, y1] = this.manifest.mercatorBounds;
    return new MercatorCoordinate(x0 + u * (x1 - x0), y0 + v * (y1 - y0)).toLngLat();
  }

  /** Real terrain elevation in metres (MapLibre returns it scaled by the exaggeration). */
  private terrainAt(lngLat: LngLat): number | null {
    const e = this.map.queryTerrainElevation(lngLat);
    return e === null ? null : e / (this.map.getTerrain()?.exaggeration ?? 1);
  }

  // ---------------------------------------------------------------- popup

  private open(lngLat: LngLat) {
    const [u, v] = this.toUv(lngLat);
    this.place = { lngLat, u, v, series: null };
    this.ice.setTraces([]);
    this.traceText.textContent = "";

    const root = document.createElement("div");
    root.className = "inspect";
    const title = document.createElement("strong");
    const ground = this.terrainAt(lngLat);
    title.textContent = `${lngLat.lat.toFixed(3)}° N, ${lngLat.lng.toFixed(3)}° E${ground === null ? "" : ` · ${fmt(ground)} m`}`;
    this.chart.width = 480;
    this.chart.height = 150;
    this.chart.className = "inspect-chart";

    const whose = document.createElement("button");
    whose.type = "button";
    whose.textContent = "Whose ice is this?";
    whose.addEventListener("click", () => void this.trace());
    const cut = document.createElement("button");
    cut.type = "button";
    cut.textContent = "Cross-section from here";
    cut.addEventListener("click", () => this.startSection(lngLat));
    const buttons = document.createElement("div");
    buttons.className = "inspect-buttons";
    buttons.append(whose, cut);
    this.traceText.className = "inspect-trace";
    root.append(title, this.status, this.chart, buttons, this.traceText);

    this.popup?.remove();
    this.popup = new Popup({ maxWidth: "290px", closeOnClick: false }).setLngLat(lngLat).setDOMContent(root).addTo(this.map);
    this.popup.on("close", () => {
      this.ice.setTraces([]);
      this.place = null;
    });
    this.updatePopup();
    void this.loadHistory().then(() => {
      if (this.place?.lngLat === lngLat) {
        this.place.series = this.seriesAt(u, v);
        this.updatePopup();
      }
    });
  }

  private loadHistory() {
    const info = this.manifest.history;
    if (!info) return Promise.resolve();
    return (this.historyLoading ??= fetchBytes(info.file).then((bytes) => {
      this.history = bytes;
    }));
  }

  /** Ice thickness (m) at every history step, old to young. */
  private seriesAt(u: number, v: number): Float32Array | null {
    const info = this.manifest.history;
    if (!info || !this.history || u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    const n = info.ages.length;
    const start = (Math.floor(v * info.height) * info.width + Math.floor(u * info.width)) * n;
    return Float32Array.from(this.history.subarray(start, start + n), (b) => b * info.step);
  }

  private updatePopup() {
    const place = this.place!;
    const now = this.ice.sample(place.u, place.v);
    const ground = this.terrainAt(place.lngLat);
    const lines: string[] = [];
    if (!now) {
      lines.push("Outside the modelled area.");
    } else {
      // thickness against the real ground where known, otherwise against the 1 km model bed
      const thickness = now.thickness > 0 ? Math.max(now.surface - (ground ?? now.bed), 0) : 0;
      lines.push(
        thickness > 1
          ? `At ${this.age.toFixed(1)} ka: ${fmt(thickness)} m of ice, surface at ${fmt(now.surface)} m`
          : `At ${this.age.toFixed(1)} ka: no ice here`,
      );
    }
    const info = this.manifest.history;
    const series = place.series;
    if (info && series) {
      let last = -1;
      let peak = 0;
      series.forEach((t, i) => {
        if (t > 0) last = i;
        if (t > series[peak]) peak = i;
      });
      if (last < 0) lines.push("Never under ice in this model.");
      else {
        lines.push(`Thickest: ${fmt(series[peak])} m at ${info.ages[peak]} ka`);
        lines.push(last === series.length - 1 ? "Still under ice at the end of the model run." : `Ice-free since about ${info.ages[last + 1]} ka`);
      }
      this.drawChart(series, info.ages);
    }
    this.status.replaceChildren(...lines.flatMap((l, i) => (i ? [document.createElement("br"), l] : [l])));
  }

  private drawChart(series: Float32Array, ages: number[]) {
    const c = this.chart;
    const ctx = c.getContext("2d")!;
    const w = c.width;
    const h = c.height;
    const pad = { l: 86, r: 8, t: 12, b: 30 };
    const maxAge = ages[0];
    const top = Math.max(500, Math.ceil(Math.max(...series) / 500) * 500);
    const x = (age: number) => pad.l + (1 - age / maxAge) * (w - pad.l - pad.r);
    const y = (t: number) => h - pad.b - (t / top) * (h - pad.t - pad.b);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "20px system-ui, sans-serif";
    ctx.fillStyle = "#5f6b72";
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of [0, top / 2, top]) {
      ctx.beginPath();
      ctx.moveTo(pad.l, y(t));
      ctx.lineTo(w - pad.r, y(t));
      ctx.stroke();
      ctx.fillText(`${t} m`, pad.l - 6, y(t));
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const age of [100, 50, 0]) ctx.fillText(age ? `${age} ka` : "today", Math.min(x(age), w - 30), h - pad.b + 5);

    ctx.beginPath();
    ctx.moveTo(x(ages[0]), y(0));
    series.forEach((t, i) => ctx.lineTo(x(ages[i]), y(t)));
    ctx.lineTo(x(ages[ages.length - 1]), y(0));
    ctx.closePath();
    ctx.fillStyle = "rgba(96, 160, 214, 0.55)";
    ctx.fill();
    ctx.strokeStyle = "#1f6fb2";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.strokeStyle = "#d1342f";
    ctx.beginPath();
    ctx.moveTo(x(this.age), pad.t);
    ctx.lineTo(x(this.age), h - pad.b);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- whose ice is this?

  private async trace() {
    const place = this.place;
    if (!place) return;
    const here = this.ice.sample(place.u, place.v);
    if (!here || here.thickness <= 0) {
      this.traceText.textContent = `No ice here at ${this.age.toFixed(1)} ka. Move the time slider to when this place is covered and try again.`;
      return;
    }
    this.traceText.textContent = "Following the flow…";
    const flow = await this.ice.flowNow();
    if (!flow || this.place !== place) return;

    const up = this.follow(flow, place.u, place.v, -1);
    const down = this.follow(flow, place.u, place.v, 1);
    this.ice.setTraces([
      { points: up.points, color: UPSTREAM },
      { points: down.points, color: DOWNSTREAM },
    ]);

    const n = up.points.length;
    const source = this.toLngLat(up.points[n - 2], up.points[n - 1]);
    const region = this.nearestRegion(source);
    const years = (t: Trace) => (t.years > 100000 ? "more than 100 000" : `about ${fmt(Math.round(t.years / 100) * 100)}`);
    const parts: (Node | string)[] = [];
    const swatch = (color: [number, number, number]) => {
      const i = document.createElement("i");
      i.style.background = `rgb(${color.map((c) => Math.round(c * 255)).join(",")})`;
      return i;
    };
    parts.push(swatch(UPSTREAM), `Comes from ${region ? `the ${region} area` : "nearby"}, ${fmt(up.metres / 1000)} km upstream: ${years(up)} years of travel at these speeds.`);
    parts.push(document.createElement("br"), swatch(DOWNSTREAM), `Flows on for ${fmt(down.metres / 1000)} km to where the trace ends (${years(down)} years).`);
    const note = document.createElement("em");
    note.textContent = ` Follows the flow of ${this.age.toFixed(1)} ka as if it stayed unchanged.`;
    parts.push(note);
    this.traceText.replaceChildren(...parts);
  }

  /** Streamline through the present flow field, upstream (-1) or downstream (+1). */
  private follow(flow: { a: Uint8Array; b: Uint8Array; mix: number }, u: number, v: number, direction: 1 | -1): Trace {
    const { width: W, height: H, mercatorBounds: b } = this.manifest;
    const velocity = (pu: number, pv: number): [number, number] => {
      const fx = Math.min(Math.max(pu * W - 0.5, 0), W - 1.001);
      const fy = Math.min(Math.max(pv * H - 0.5, 0), H - 1.001);
      const x = Math.floor(fx);
      const y = Math.floor(fy);
      const wx = fx - x;
      const wy = fy - y;
      const out: [number, number] = [0, 0];
      for (let c = 0; c < 2; c++) {
        const at = (k: number) => flow.a[k * 4 + c] + (flow.b[k * 4 + c] - flow.a[k * 4 + c]) * flow.mix;
        const i = y * W + x;
        const byte = (at(i) * (1 - wx) + at(i + 1) * wx) * (1 - wy) + (at(i + W) * (1 - wx) + at(i + W + 1) * wx) * wy;
        const f = (byte - 128) / 127;
        out[c] = Math.sign(f) * (Math.exp(Math.abs(f) * LOG_VMAX) - 1);
      }
      return out;
    };
    /** uv displacement of a step of TRACE_STEP metres along the flow, and the speed there */
    const step = (pu: number, pv: number): [number, number, number] | null => {
      const [east, north] = velocity(pu, pv);
      const speed = Math.hypot(east, north);
      if (speed < 0.5) return null; // ice divide or stagnant ice
      const my = b[1] + pv * (b[3] - b[1]);
      const metresPerUnit = EARTH_CIRCUMFERENCE / Math.cosh(Math.PI * (1 - 2 * my));
      const k = (direction * TRACE_STEP) / speed / metresPerUnit;
      return [(east * k) / (b[2] - b[0]), (-north * k) / (b[3] - b[1]), speed];
    };

    const trace: Trace = { points: [u, v], metres: 0, years: 0 };
    for (let i = 0; i < 5000; i++) {
      const first = step(u, v);
      if (!first) break;
      const mid = step(u + first[0] / 2, v + first[1] / 2) ?? first; // midpoint rule
      u += mid[0];
      v += mid[1];
      const ice = this.ice.sample(u, v);
      if (!ice || ice.thickness <= 0) break;
      trace.metres += TRACE_STEP;
      trace.years += TRACE_STEP / mid[2];
      if (i % 2 === 1) trace.points.push(u, v);
    }
    trace.points.push(u, v);
    return trace;
  }

  private nearestRegion(at: LngLat): string | null {
    let best: string | null = null;
    let bestDistance = 70000; // metres; further away than this it is just "nearby" ice
    for (const r of this.manifest.debris?.regions ?? []) {
      if (r.lon === undefined || r.lat === undefined) continue;
      const d = at.distanceTo({ lng: r.lon, lat: r.lat } as LngLat);
      if (d < bestDistance) {
        bestDistance = d;
        best = r.name;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- cross-section

  private startSection(from: LngLat) {
    this.closeSection();
    this.popup?.remove();
    this.sectionStart = from;
    this.markers = [this.marker(from, "A")];
    this.hint.textContent = "Click the other end of the cross-section (Esc to cancel)";
    this.hint.hidden = false;
    this.map.getCanvas().style.cursor = "crosshair";
  }

  private cancelSectionStart() {
    this.sectionStart = null;
    this.hint.hidden = true;
    this.map.getCanvas().style.cursor = "";
    this.markers.forEach((m) => m.remove());
    this.markers = [];
  }

  private finishSection(to: LngLat) {
    const from = this.sectionStart!;
    this.sectionStart = null;
    this.hint.hidden = true;
    this.map.getCanvas().style.cursor = "";
    this.markers.push(this.marker(to, "B"));
    this.section = { a: from, b: to, terrain: [] };
    const line = { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [from.toArray(), to.toArray()] } };
    const source = this.map.getSource("section") as { setData(d: unknown): void } | undefined;
    if (source) source.setData(line);
    else {
      this.map.addSource("section", { type: "geojson", data: line });
      this.map.addLayer({ id: "section", type: "line", source: "section", paint: { "line-color": "#d1342f", "line-width": 2.5, "line-dasharray": [2, 1] } }, this.ice.id);
    }
    this.map.setLayoutProperty("section", "visibility", "visible");
    this.panel.hidden = false;
    this.sectionTitle.textContent = `Cross-section A to B · ${(from.distanceTo(to) / 1000).toFixed(1)} km`;
    this.sampleTerrain();
  }

  private closeSection() {
    this.section = null;
    this.panel.hidden = true;
    this.markers.forEach((m) => m.remove());
    this.markers = [];
    if (this.map.getLayer("section")) this.map.setLayoutProperty("section", "visibility", "none");
  }

  private marker(at: LngLat, label: string) {
    const el = document.createElement("div");
    el.className = "section-marker";
    el.textContent = label;
    return new Marker({ element: el }).setLngLat(at).addTo(this.map);
  }

  private sectionPoint(i: number): LngLat {
    const { a, b } = this.section!;
    const t = i / (SECTION_SAMPLES - 1);
    return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t } as LngLat;
  }

  private sampleTerrain() {
    const s = this.section!;
    s.terrain = Array.from({ length: SECTION_SAMPLES }, (_, i) => this.terrainAt(this.sectionPoint(i)));
    this.drawSection();
  }

  private drawSection() {
    const s = this.section;
    if (!s || this.panel.hidden) return;
    const c = this.sectionCanvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // ground: the real terrain where loaded, the 1 km model bed as fallback
    const ground: number[] = [];
    const surface: (number | null)[] = [];
    for (let i = 0; i < SECTION_SAMPLES; i++) {
      const p = this.sectionPoint(i);
      const [u, v] = this.toUv(p);
      const ice = this.ice.sample(u, v);
      const g = s.terrain[i] ?? ice?.bed ?? 0;
      ground.push(g);
      surface.push(ice && ice.thickness > 0 && ice.surface > g + 1 ? ice.surface : null);
    }
    const tops = surface.map((t, i) => t ?? ground[i]);
    const lo = Math.min(...ground);
    const hi = Math.max(...tops);
    const span = Math.max(hi - lo, 200);
    const pad = { l: 52, r: 12, t: 10, b: 22 };
    const x = (i: number) => pad.l + (i / (SECTION_SAMPLES - 1)) * (w - pad.l - pad.r);
    const y = (e: number) => pad.t + (1 - (e - (lo - span * 0.05)) / (span * 1.12)) * (h - pad.t - pad.b);
    const base = h - pad.b;

    // elevation grid
    const tick = [100, 200, 500, 1000, 2000].find((t) => span / t <= 5) ?? 2000;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    ctx.lineWidth = 1;
    for (let e = Math.ceil(lo / tick) * tick; e <= hi + span * 0.05; e += tick) {
      ctx.strokeStyle = "rgba(0,0,0,0.1)";
      ctx.beginPath();
      ctx.moveTo(pad.l, y(e));
      ctx.lineTo(w - pad.r, y(e));
      ctx.stroke();
      ctx.fillStyle = "#5f6b72";
      ctx.fillText(`${e} m`, pad.l - 6, y(e));
    }

    // ice: between its surface and the ground
    ctx.fillStyle = "rgba(150, 200, 240, 0.85)";
    ctx.strokeStyle = "#2d7fc1";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < SECTION_SAMPLES; ) {
      if (surface[i] === null) {
        i++;
        continue;
      }
      let j = i;
      while (j < SECTION_SAMPLES && surface[j] !== null) j++;
      ctx.beginPath();
      ctx.moveTo(x(Math.max(i - 1, 0)), y(ground[Math.max(i - 1, 0)]));
      for (let k = i; k < j; k++) ctx.lineTo(x(k), y(surface[k]!));
      const end = Math.min(j, SECTION_SAMPLES - 1);
      ctx.lineTo(x(end), y(ground[end]));
      ctx.stroke();
      for (let k = end; k >= Math.max(i - 1, 0); k--) ctx.lineTo(x(k), y(ground[k]));
      ctx.closePath();
      ctx.fill();
      i = j;
    }

    // ground on top
    ctx.beginPath();
    ctx.moveTo(x(0), base);
    ground.forEach((g, i) => ctx.lineTo(x(i), y(g)));
    ctx.lineTo(x(SECTION_SAMPLES - 1), base);
    ctx.closePath();
    ctx.fillStyle = "#8d8478";
    ctx.fill();

    // labels
    const km = s.a.distanceTo(s.b) / 1000;
    ctx.fillStyle = "#1d2428";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("A", pad.l, base + 5);
    ctx.textAlign = "right";
    ctx.fillText(`B · ${km.toFixed(1)} km`, w - pad.r, base + 5);
    const exaggeration = (km * 1000) / (w - pad.l - pad.r) / ((span * 1.12) / (h - pad.t - pad.b));
    ctx.textAlign = "center";
    ctx.fillStyle = "#5f6b72";
    const thickest = Math.max(0, ...surface.map((t, i) => (t === null ? 0 : t - ground[i])));
    ctx.fillText(`${this.age.toFixed(1)} ka · ${thickest > 0 ? `ice up to ${fmt(thickest)} m thick` : "no ice"} · heights ×${exaggeration.toFixed(1)}`, (pad.l + w - pad.r) / 2, base + 5);
  }
}
