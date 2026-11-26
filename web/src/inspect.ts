import { Marker, MercatorCoordinate, Popup, type LngLat, type Map as MlMap } from "maplibre-gl";
import { fetchBytes, fetchRaster, type Manifest } from "./data";
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
const TRACE_STEP = 500; // metres
const TRACE_MAX_STEPS = 3000;
/** beyond this travel time, "the flow of this moment" says nothing about the real path */
const TRACE_MAX_YEARS = 20000;
const ENSEMBLE = 60; // paths per "whose ice" query
const UPSTREAM: [number, number, number] = [0.91, 0.35, 0.05];
const DOWNSTREAM: [number, number, number] = [0.04, 0.24, 0.44];
const SECTION_SAMPLES = 260;
const SECTION_COLOR: [number, number, number] = [0.82, 0.2, 0.18];

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
  /** age (ka) of the last ice at every pixel of the frame grid, from the 100-year output */
  private lastIce: Float32Array | null = null;
  private spread = document.createElement("select");
  private age = 0;

  // popup parts that change with time
  private status = document.createElement("p");
  private chart = document.createElement("canvas");
  private traceText = document.createElement("p");

  // cross-section
  private sectionStart: LngLat | null = null;
  /** `iceTop`: highest ice surface along the line at any time, so the vertical scale can stay fixed */
  private section: { a: LngLat; b: LngLat; terrain: (number | null)[]; iceTop: number } | null = null;
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
    // frames for a new time arrive a moment after the slider moves
    ice.onData = () => this.setAge(this.age);
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
    // close the previous popup first: its close handler clears the selected place
    this.popup?.remove();
    const [u, v] = this.toUv(lngLat);
    const place = { lngLat, u, v, series: null as Float32Array | null };
    this.place = place;
    this.ice.setTraces("flow", []);
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
    whose.addEventListener("click", () => this.runTrace());
    const cut = document.createElement("button");
    cut.type = "button";
    cut.textContent = "Cross-section from here";
    cut.addEventListener("click", () => this.startSection(lngLat));
    const buttons = document.createElement("div");
    buttons.className = "inspect-buttons";
    buttons.append(whose, cut);

    // advanced: size of the patch from which the flow paths start
    const options = document.createElement("details");
    options.className = "inspect-options";
    const summary = document.createElement("summary");
    summary.textContent = "Flow path options";
    const label = document.createElement("label");
    if (!this.spread.options.length) {
      for (const [km, text] of [
        [0, "single path from this point"],
        [2, "patch of 2 km radius"],
        [5, "patch of 5 km radius"],
        [15, "patch of 15 km radius"],
      ] as const) {
        this.spread.add(new Option(text, String(km), km === 5, km === 5));
      }
      this.spread.addEventListener("change", () => this.runTrace());
    }
    label.append("Start from ", this.spread);
    options.append(summary, label);
    this.traceText.className = "inspect-trace";
    root.append(title, this.status, this.chart, buttons, this.traceText, options);

    const popup = new Popup({ maxWidth: "290px", closeOnClick: false }).setLngLat(lngLat).setDOMContent(root).addTo(this.map);
    this.popup = popup;
    popup.on("close", () => {
      if (this.place !== place) return; // a newer popup has taken over
      this.ice.setTraces("flow", []);
      this.place = null;
    });
    this.updatePopup();
    void this.loadHistory().then(() => {
      if (this.place === place) {
        place.series = this.seriesAt(u, v);
        this.updatePopup();
      }
    });
  }

  private loadHistory() {
    const { history, deglaciation, width, height } = this.manifest;
    if (!history) return Promise.resolve();
    return (this.historyLoading ??= Promise.all([
      fetchBytes(history.file).then((bytes) => {
        this.history = bytes;
      }),
      deglaciation
        ? fetchRaster(deglaciation.frames[0].file, width, height, deglaciation).then((raster) => {
            this.lastIce = raster;
          })
        : null,
    ]).then(() => undefined));
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
    const place = this.place;
    if (!place) return;
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
      let peak = 0;
      series.forEach((t, i) => {
        if (t > series[peak]) peak = i;
      });
      if (series[peak] > 0) lines.push(`Thickest: ${fmt(series[peak])} m at ${info.ages[peak]} ka`);
      // last ice from the 100-year output (the chart itself has 1 ka steps)
      const { width: W, height: H } = this.manifest;
      const last = this.lastIce
        ? this.lastIce[Math.min(Math.floor(place.v * H), H - 1) * W + Math.min(Math.floor(place.u * W), W - 1)]
        : NaN;
      if (last < 0) lines.push("Never under ice in this model.");
      else if (last < 0.05) lines.push("Still under ice at the end of the model run.");
      else if (Number.isFinite(last)) lines.push(`Ice-free since ${last.toFixed(1)} ka`);
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

  private runTrace() {
    this.trace().catch((e) => {
      console.error(e);
      this.traceText.textContent = "Could not follow the flow here.";
    });
  }

  private async trace() {
    const place = this.place;
    if (!place) return;
    const here = this.ice.sample(place.u, place.v);
    if (!here || here.thickness <= 0) {
      this.ice.setTraces("flow", []);
      this.traceText.textContent = `No ice here at ${this.age.toFixed(1)} ka. Move the time slider to when this place is covered and try again.`;
      return;
    }
    this.traceText.textContent = "Following the flow…";
    const flow = await this.ice.flowNow();
    if (this.place !== place) return;
    if (!flow) {
      this.traceText.textContent = "The flow data could not be loaded. Check the connection and try again.";
      return;
    }

    // start points: the clicked point, plus random points in a patch around it
    const radius = Number(this.spread.value) * 1000;
    const b = this.manifest.mercatorBounds;
    const my = b[1] + place.v * (b[3] - b[1]);
    const metresPerUnit = EARTH_CIRCUMFERENCE / Math.cosh(Math.PI * (1 - 2 * my));
    const starts: [number, number][] = [[place.u, place.v]];
    for (let i = 0; radius > 0 && i < ENSEMBLE * 3 && starts.length < ENSEMBLE; i++) {
      const r = radius * Math.sqrt(Math.random());
      const a = Math.random() * 2 * Math.PI;
      const u = place.u + (r * Math.cos(a)) / metresPerUnit / (b[2] - b[0]);
      const v = place.v + (r * Math.sin(a)) / metresPerUnit / (b[3] - b[1]);
      if ((this.ice.sample(u, v)?.thickness ?? 0) > 0) starts.push([u, v]);
    }
    const up = starts.map(([u, v]) => this.follow(flow, u, v, -1));
    const down = starts.map(([u, v]) => this.follow(flow, u, v, 1));

    // many faint paths add up to a density; the path from the clicked point is drawn solid
    const alpha = starts.length > 1 ? 0.22 : 1;
    this.ice.setTraces("flow", [
      { paths: up.map((t) => t.points), color: UPSTREAM, alpha, width: 2.4 },
      { paths: down.map((t) => t.points), color: DOWNSTREAM, alpha, width: 2.4 },
      ...(starts.length > 1
        ? [
            { paths: [up[0].points], color: UPSTREAM, width: 1.4 },
            { paths: [down[0].points], color: DOWNSTREAM, width: 1.4 },
          ]
        : []),
    ]);

    // where the paths start: share per source massif
    const shares = new Map<string, number>();
    for (const t of up) {
      const n = t.points.length;
      const name = this.nearestRegion(this.toLngLat(t.points[n - 2], t.points[n - 1])) ?? "other areas";
      shares.set(name, (shares.get(name) ?? 0) + 1);
    }
    const sources = [...shares.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([name, n]) => (starts.length > 1 ? `${name} ${Math.round((n / up.length) * 100)} %` : name))
      .join(", ");
    const quantile = (values: number[], q: number) => [...values].sort((x, y) => x - y)[Math.min(Math.floor(values.length * q), values.length - 1)];
    const span = (traces: Trace[], pick: (t: Trace) => number, unit: number, round: number) => {
      const values = traces.map((t) => pick(t) / unit);
      const show = (x: number) => fmt(Math.round(x / round) * round);
      const lo = quantile(values, 0.1);
      const hi = quantile(values, 0.9);
      return traces.length > 1 && show(lo) !== show(hi) ? `${show(lo)} to ${show(hi)}` : show(quantile(values, 0.5));
    };
    const years = (traces: Trace[]) => {
      const median = quantile(traces.map((t) => t.years), 0.5);
      return median >= TRACE_MAX_YEARS ? `more than ${fmt(TRACE_MAX_YEARS)}` : `about ${fmt(Math.round(median / 100) * 100)}`;
    };
    const swatch = (color: [number, number, number]) => {
      const i = document.createElement("i");
      i.style.background = `rgb(${color.map((c) => Math.round(c * 255)).join(",")})`;
      return i;
    };
    const note = document.createElement("em");
    note.textContent = ` ${starts.length > 1 ? `${starts.length} paths. ` : ""}Follows the flow of ${this.age.toFixed(1)} ka as if it stayed unchanged.`;
    this.traceText.replaceChildren(
      swatch(UPSTREAM),
      `Comes from: ${sources}. ${span(up, (t) => t.metres, 1000, 1)} km upstream, ${years(up)} years of travel at these speeds.`,
      document.createElement("br"),
      swatch(DOWNSTREAM),
      `Flows on for ${span(down, (t) => t.metres, 1000, 1)} km (${years(down)} years) to the margin or a stagnant spot.`,
      note,
    );
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
    for (let i = 0; i < TRACE_MAX_STEPS; i++) {
      const first = step(u, v);
      if (!first) break;
      const mid = step(u + first[0] / 2, v + first[1] / 2) ?? first; // midpoint rule
      u += mid[0];
      v += mid[1];
      const ice = this.ice.sample(u, v);
      if (!ice || ice.thickness <= 0) break;
      trace.metres += TRACE_STEP;
      trace.years += TRACE_STEP / mid[2];
      if (trace.years > TRACE_MAX_YEARS) break;
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
    this.section = { a: from, b: to, terrain: [], iceTop: -Infinity };
    this.panel.hidden = false;
    this.updateSection();
  }

  /** Redraw line and profile after the section was created or an end was dragged. */
  private updateSection() {
    const s = this.section;
    if (!s) return;
    const line = { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [s.a.toArray(), s.b.toArray()] } };
    const source = this.map.getSource("section") as { setData(d: unknown): void } | undefined;
    if (source) source.setData(line);
    else {
      this.map.addSource("section", { type: "geojson", data: line });
      this.map.addLayer({ id: "section", type: "line", source: "section", paint: { "line-color": "#d1342f", "line-width": 2.5, "line-dasharray": [2, 1] } }, this.ice.id);
    }
    this.map.setLayoutProperty("section", "visibility", "visible");
    // the draped line disappears under the ice, so draw it on the ice surface as well
    const onIce: number[] = [];
    for (let i = 0; i < SECTION_SAMPLES; i += 4) onIce.push(...this.toUv(this.sectionPoint(i)));
    onIce.push(...this.toUv(s.b));
    this.ice.setTraces("section", [{ paths: [onIce], color: SECTION_COLOR, width: 1.6 }]);
    this.sectionTitle.textContent = `Cross-section A to B · ${(s.a.distanceTo(s.b) / 1000).toFixed(1)} km · drag A or B to move`;
    this.sampleTerrain();
  }

  private closeSection() {
    this.section = null;
    this.panel.hidden = true;
    this.markers.forEach((m) => m.remove());
    this.markers = [];
    this.ice.setTraces("section", []);
    if (this.map.getLayer("section")) this.map.setLayoutProperty("section", "visibility", "none");
  }

  private marker(at: LngLat, label: "A" | "B") {
    const el = document.createElement("div");
    el.className = "section-marker";
    el.textContent = label;
    el.title = "Drag to move this end";
    const marker = new Marker({ element: el, draggable: true }).setLngLat(at).addTo(this.map);
    marker.on("drag", () => {
      if (!this.section) return;
      if (label === "A") this.section.a = marker.getLngLat();
      else this.section.b = marker.getLngLat();
      this.updateSection();
    });
    // a drag must not count as a map click (which would open the place popup)
    el.addEventListener("click", (e) => e.stopPropagation());
    return marker;
  }

  private sectionPoint(i: number): LngLat {
    const { a, b } = this.section!;
    const t = i / (SECTION_SAMPLES - 1);
    return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t } as LngLat;
  }

  private sampleTerrain() {
    const s = this.section!;
    s.terrain = Array.from({ length: SECTION_SAMPLES }, (_, i) => this.terrainAt(this.sectionPoint(i)));
    this.measureIceTop();
    this.drawSection();
    // the history cube gives the thickest ice of the whole cycle; it may still be loading
    if (!this.history) void this.loadHistory().then(() => this.section === s && (this.measureIceTop(), this.drawSection()));
  }

  /** Highest ice surface along the section over the whole glacial cycle. */
  private measureIceTop() {
    const s = this.section!;
    const info = this.manifest.history;
    s.iceTop = -Infinity;
    if (!info || !this.history) return;
    for (let i = 0; i < SECTION_SAMPLES; i++) {
      const [u, v] = this.toUv(this.sectionPoint(i));
      const bed = this.ice.sample(u, v)?.bed;
      const series = this.seriesAt(u, v);
      if (bed === undefined || !series) continue;
      const thickest = Math.max(...series);
      if (thickest > 0) s.iceTop = Math.max(s.iceTop, bed + thickest);
    }
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
    // fixed vertical scale: room for the thickest ice of the whole cycle, so the terrain
    // does not rescale while time runs
    const hi = Math.max(...tops, s.iceTop);
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
