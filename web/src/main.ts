import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./app.css";
import { ContextIce, type ContextData } from "./context";
import { DEGLACIATION_RANGE, EROSION_RANGE, RAMPS, rampCss, type IceMode } from "./colormaps";
import { fetchBytes, fetchJson, type Manifest, type TimeSeries } from "./data";
import { loadDebris } from "./debris";
import { DrapedLayer } from "./draped";
import { IceLayer } from "./iceLayer";
import { Inspector } from "./inspect";
import { FlyControls } from "./fly";
import { backgroundColor, buildStyle, FIRST_LABEL_LAYER, GROUP_LAYERS, TERRAIN_SOURCE, type LabelGroup } from "./style";
import { FutureGlacier, GONE_COLOR, THICKNESS_RAMP, type FutureManifest } from "./future";
import { END_YEAR, FIRST_YEAR, LAST_YEAR, RecentEra, type Backdrop } from "./recent";
import { installSeabed } from "./seabed";
import { SeaLayer, type SeaLevelCurve } from "./seaLayer";
import { TimeBar } from "./timebar";

const INITIAL_AGE = 24;

/** The time is kept in the URL next to MapLibre's own `map=` entry: #map=9/46.7/8.9/0/60&t=24.5 */
function ageFromUrl(): number | null {
  const entry = location.hash.slice(1).split("&").find((part) => part.startsWith("t="));
  const age = entry ? Number(entry.slice(2)) : NaN;
  return Number.isFinite(age) ? age : null;
}

/** Year of the "since 1850" view in the URL; absent in the ice age view. */
function yearFromUrl(): number | null {
  const entry = location.hash.slice(1).split("&").find((part) => part.startsWith("y="));
  const year = entry ? Number(entry.slice(2)) : NaN;
  return Number.isFinite(year) ? Math.min(Math.max(Math.round(year), FIRST_YEAR), END_YEAR) : null;
}

let yearTimer = 0;
function yearToUrl(year: number | null) {
  clearTimeout(yearTimer);
  yearTimer = window.setTimeout(() => {
    const parts = location.hash.slice(1).split("&").filter((part) => part && !part.startsWith("y="));
    if (year !== null) parts.push(`y=${year}`);
    history.replaceState(history.state, "", `#${parts.join("&")}`);
  }, 250);
}

/** Ice model in the URL: `m=swiss` for the 500 m model, absent for the default. */
function modelFromUrl(): string | null {
  const entry = location.hash.slice(1).split("&").find((part) => part.startsWith("m="));
  return entry ? entry.slice(2) : null;
}

function modelToUrl(model: string) {
  const parts = location.hash.slice(1).split("&").filter((part) => part && !part.startsWith("m="));
  if (model !== "alps") parts.push(`m=${model}`);
  history.replaceState(history.state, "", `#${parts.join("&")}`);
}

/** Raster maps that can replace the shaded relief. */
const BASEMAPS: Record<string, { tiles: string; attribution: string; maxzoom: number; bounds?: [number, number, number, number] }> = {
  swiss: {
    tiles: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
    attribution: '© <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noopener">swisstopo</a>',
    maxzoom: 17,
    bounds: [5.1, 45.3, 11.5, 48.3],
  },
  "swiss-winter": {
    tiles: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe-winter/default/current/3857/{z}/{x}/{y}.jpeg",
    attribution: '© <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noopener">swisstopo</a>',
    maxzoom: 17,
    bounds: [5.1, 45.3, 11.5, 48.3],
  },
  imagery: {
    tiles: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxzoom: 18,
  },
};

/**
 * Map of the base map menu, `b=` in the URL. The historic maps and photographs in the same
 * list belong to RecentEra (see bindRecent), which listens to the same controls.
 */
function bindBasemap(map: maplibregl.Map) {
  const select = document.getElementById("basemap") as HTMLSelectElement;
  const fromUrl = location.hash.slice(1).split("&").find((part) => part.startsWith("b="))?.slice(2);
  const opacity = document.getElementById("basemap-opacity") as HTMLInputElement;
  if (fromUrl && [...select.options].some((o) => o.value === fromUrl)) select.value = fromUrl;
  const apply = () => {
    for (const [key, def] of Object.entries(BASEMAPS)) {
      const id = `basemap-${key}`;
      const on = select.value === key;
      if (on && !map.getLayer(id)) {
        map.addSource(id, { type: "raster", tiles: [def.tiles], tileSize: 256, maxzoom: def.maxzoom, attribution: def.attribution, ...(def.bounds ? { bounds: def.bounds } : {}) });
        // under the historic maps of the view since 1850, if they are there already
        map.addLayer({ id, type: "raster", source: id }, map.getLayer("recent-maps") ? "recent-maps" : "coast");
      }
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
        map.setPaintProperty(id, "raster-opacity", Number(opacity.value));
      }
    }
    document.getElementById("basemap-opacity-menu")!.hidden = select.value === "relief";
  };
  opacity.addEventListener("input", apply);
  select.addEventListener("change", () => {
    const parts = location.hash.slice(1).split("&").filter((part) => part && !part.startsWith("b="));
    if (select.value !== "relief") parts.push(`b=${select.value}`);
    history.replaceState(history.state, "", `#${parts.join("&")}`);
    apply();
  });
  if (map.isStyleLoaded()) apply();
  else map.once("load", apply);
}

let urlTimer = 0;
function ageToUrl(age: number) {
  clearTimeout(urlTimer);
  urlTimer = window.setTimeout(() => {
    const parts = location.hash.slice(1).split("&").filter((part) => part && !part.startsWith("t="));
    parts.push(`t=${age.toFixed(1)}`);
    history.replaceState(history.state, "", `#${parts.join("&")}`);
  }, 250);
}

// under a bundler the worker location cannot be derived automatically
maplibregl.setWorkerUrl(workerUrl);

async function main() {
  const [manifest, series, terrain, seaLevel, contextData, swissManifest] = await Promise.all([
    fetchJson<Manifest>("manifest.json"),
    fetchJson<TimeSeries>("timeseries.json"),
    installSeabed(),
    fetchJson<SeaLevelCurve>("sealevel.json").catch(() => null),
    fetchJson<ContextData>("context.json").catch(() => null),
    fetchJson<Manifest>("stm/manifest.json").catch(() => null),
  ]);

  const map = new maplibregl.Map({
    container: "map",
    style: buildStyle(terrain.tiles, terrain.hasSeabed),
    center: [8.75, 46.75],
    zoom: 7.7,
    pitch: 58,
    bearing: -12,
    maxPitch: 85,
    minZoom: contextData ? 2.5 : 5,
    maxZoom: 14.5,
    hash: "map",
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl(), "top-right");

  const ice = new IceLayer(manifest);
  const sea = terrain.hasSeabed ? new SeaLayer(seaLevel) : null;
  const seaReadout = document.getElementById("sea-level")!;
  const maxAge = manifest.frames[0].age;
  /** ground overlays by ice mode */
  const ground: Partial<Record<IceMode, DrapedLayer>> = {};
  let inspector: Inspector | null = null;
  let context: ContextIce | null = null;

  // Second ice model: finer, but only for Switzerland and part of the time. Where and when it
  // exists it is drawn in place of the main model, which gets a hole there.
  const swiss = swissManifest ? new IceLayer(swissManifest, "ice-swiss") : null;
  const modelSelect = document.getElementById("ice-model") as HTMLSelectElement;
  const modelNote = document.getElementById("ice-model-note")!;
  modelSelect.closest("label")!.hidden = !swiss;
  if (swiss && modelFromUrl() === "swiss") modelSelect.value = "swiss";
  modelSelect.addEventListener("change", () => modelToUrl(modelSelect.value));
  let swissHole: Uint8Array | null = null;
  let swissActive = false;
  const updateModel = (age: number) => {
    if (!swiss || !swissManifest) return;
    const frames = swissManifest.frames;
    const [oldest, youngest] = [frames[0].age, frames[frames.length - 1].age];
    const chosen = modelSelect.value === "swiss";
    const active = chosen && age <= oldest && age >= youngest;
    swiss.visible = active && ice.visible;
    swiss.opacity = ice.opacity;
    swiss.exaggeration = ice.exaggeration;
    swiss.showContourLabels = ice.showContourLabels;
    // the 500 m model has surface velocity only: speed colouring and particles, nothing basal
    swiss.mode = ice.mode === "erosion" || ice.mode === "deglaciation" || ice.mode === "speed" ? ice.mode : "plain";
    swiss.showParticles = ice.showParticles;
    if (active !== swissActive) {
      swissActive = active;
      inspector?.reset(); // popup, trace and section belong to the model that was on screen
    }
    ice.setHole(active ? swissHole : null);
    modelNote.hidden = !chosen || active;
    modelNote.textContent = `Covers ${oldest.toFixed(0)} to ${youngest.toFixed(0)} ka only: showing the whole-Alps model.`;
    if (chosen && !swissHole && swissManifest.hole) {
      fetchBytes(swissManifest.hole).then((mask) => {
        swissHole = mask;
        updateModel(timebar.age);
      });
    }
    map.triggerRepaint();
  };
  const contextBox = document.getElementById("context-ice") as HTMLInputElement;
  const contextReadout = document.getElementById("context-info")!;
  contextBox.closest("label")!.hidden = !contextData;
  const updateContext = (age: number) => {
    if (!context) return;
    context.setAge(age, sea ? sea.levelAt(age) : 0);
    contextReadout.textContent = context.visible ? context.describe() : "";
  };
  let depositStep = NaN;
  let recent: RecentEra | null = null;
  const timebar = new TimeBar(maxAge, series, Math.min(Math.max(ageFromUrl() ?? INITIAL_AGE, 0), maxAge), (age) => {
    if (recent?.active) return; // the ice age is off screen
    ageToUrl(age);
    ice.setAge(age);
    if (swiss && modelSelect.value === "swiss") swiss.setAge(age);
    updateModel(age);
    ground.erosion?.setAge(age);
    inspector?.setAge(age);
    updateContext(age);
    if (sea) {
      sea.setAge(age);
      const level = Math.round(sea.levelAt(age));
      seaReadout.textContent = level === 0 ? "as today" : `${level > 0 ? "+" : "−"}${Math.abs(level)} m`;
    }
    // deposits appear once their time has come; refilter only every 100 years
    const step = Math.round(age * 10) / 10;
    if (step !== depositStep && map.getLayer("deposits")) {
      depositStep = step;
      map.setFilter("deposits", [">=", ["get", "age"], step]);
    }
  });

  map.on("load", () => {
    if (sea) {
      map.addLayer(sea, FIRST_LABEL_LAYER);
      sea.setAge(timebar.age);
    }
    map.addLayer(ice, FIRST_LABEL_LAYER);
    ice.setAge(timebar.age);
    if (swiss) {
      map.addLayer(swiss, FIRST_LABEL_LAYER);
      swiss.visible = false;
      // every menu control that changes the ice applies to both models
      const sync = () => {
        const frames = swissManifest!.frames;
        timebar.setHighlight(modelSelect.value === "swiss" ? { from: frames[0].age, to: frames[frames.length - 1].age, label: "500 m model" } : null);
        if (modelSelect.value === "swiss") swiss.setAge(timebar.age);
        updateModel(timebar.age);
      };
      document.getElementById("menu")!.addEventListener("input", sync);
      document.getElementById("menu")!.addEventListener("change", sync);
      sync();
    }
    if (contextData) {
      // draped outlines above lakes and rivers, the sheet on the water above the sea but below the Alpine ice
      context = new ContextIce(map, contextData, "coast", ice.id);
      const seaBox = document.getElementById("sea-visible") as HTMLInputElement;
      const exaggeration = document.getElementById("exaggeration") as HTMLInputElement;
      const apply = () => {
        context!.visible = contextBox.checked;
        context!.seaVisible = !!sea && seaBox.checked;
        context!.exaggeration = Number(exaggeration.value);
        updateContext(timebar.age);
      };
      for (const input of [contextBox, seaBox, exaggeration]) input.addEventListener("input", apply);
      apply();
    }
    if (manifest.erosion) {
      ground.erosion = new DrapedLayer(manifest, { id: "erosion", frames: manifest.erosion.frames, encoding: manifest.erosion, ramp: RAMPS.erosion, range: EROSION_RANGE });
    }
    if (manifest.deglaciation) {
      ground.deglaciation = new DrapedLayer(manifest, {
        id: "deglaciation",
        frames: manifest.deglaciation.frames,
        encoding: manifest.deglaciation,
        ramp: RAMPS.deglaciation,
        range: DEGLACIATION_RANGE,
      });
    }
    for (const layer of Object.values(ground)) {
      map.addLayer(layer, "water");
      layer.setAge(timebar.age);
    }
    bindIceModes(map, ice, ground);
    const mainModel = { ice, manifest };
    const swissModel = swiss && swissManifest ? { ice: swiss, manifest: swissManifest, label: "500 m model (Swiss Time Machine)" } : null;
    inspector = new Inspector(map, mainModel, (at) => {
      // the model drawn at the clicked place: the Swiss one inside the hole it leaves in the main model
      if (!swissModel || !swissActive || !swissHole) return mainModel;
      const [x0, y0, x1, y1] = manifest.mercatorBounds;
      const m = maplibregl.MercatorCoordinate.fromLngLat(at);
      const col = Math.floor(((m.x - x0) / (x1 - x0)) * manifest.width);
      const row = Math.floor(((m.y - y0) / (y1 - y0)) * manifest.height);
      const inside = col >= 0 && col < manifest.width && row >= 0 && row < manifest.height && swissHole[row * manifest.width + col] > 0;
      return inside ? swissModel : mainModel;
    });
    inspector.setAge(timebar.age);
    if (manifest.debris) bindDebris(map, ice, manifest, () => timebar.age);
    recent = bindRecent(map, (on) => {
      // the ice age layers make way, and come back as the menu and the time bar say
      timebar.pause();
      inspector!.enabled = !on;
      if (on) {
        ice.visible = false;
        if (swiss) swiss.visible = false;
        if (context) context.visible = false;
        contextReadout.textContent = "";
        sea?.setAge(0);
        seaReadout.textContent = "as today";
      } else {
        ice.visible = (document.getElementById("ice-visible") as HTMLInputElement).checked;
        if (context) context.visible = contextBox.checked;
        timebar.age = timebar.age;
      }
      map.triggerRepaint();
    });
  });

  bindMenu(map, ice, sea, () => Object.values(ground)[0]?.invalidate());
  // handy for debugging and automated checks
  Object.assign(window, { map, ice, timebar });
}

/** The "since 1850" view: its time bar, menu section and URL parameter. */
function bindRecent(map: maplibregl.Map, onSwitch: (on: boolean) => void): RecentEra {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const slider = el<HTMLInputElement>("recent-time");
  const play = el<HTMLButtonElement>("recent-play");
  const speed = el<HTMLSelectElement>("recent-speed");
  const backdrop = el<HTMLSelectElement>("basemap");
  const opacity = el<HTMLInputElement>("basemap-opacity");
  const glaciers = el<HTMLInputElement>("recent-glaciers");
  slider.min = String(FIRST_YEAR);
  slider.max = String(END_YEAR); // cut back to today if there is no projection data

  let future: FutureGlacier | null = null;
  const recent = new RecentEra(map, "coast", () => {
    const text = recent.describe();
    el("recent-sub").textContent = future?.active ? future.describe() : text.glaciers;
    el("recent-backdrop-note").textContent = text.backdrop;
  });
  /** end of the bar: 2100, or today when there is no projection */
  const lastYear = () => Number(slider.max);
  const left = (year: number) => ((year - FIRST_YEAR) / (lastYear() - FIRST_YEAR)) * 100;
  const setYear = (year: number) => {
    slider.value = String(year);
    el("recent-year").textContent = slider.value;
    recent.setYear(Number(slider.value));
    if (recent.active) yearToUrl(Number(slider.value));
    applyLia();
    applyFuture();
  };
  slider.addEventListener("input", () => setYear(Number(slider.value)));

  const marks = el("recent-marks");
  /** Year labels and inventory marks; drawn again when the bar grows to 2100. */
  const drawMarks = () => {
    marks.replaceChildren();
    for (let year = FIRST_YEAR; year <= lastYear(); year += 25) {
      const span = document.createElement("span");
      span.style.left = `${left(year)}%`;
      span.textContent = String(year);
      if (year === FIRST_YEAR) span.style.transform = "none";
      if (year === lastYear()) span.style.transform = "translateX(-100%)";
      marks.append(span);
    }
    const band = el("recent-future");
    band.hidden = lastYear() <= LAST_YEAR;
    band.style.left = `${left(LAST_YEAR)}%`;
    // neighbouring inventory years (2010, 2016) run into each other on a short bar
    const track = marks.clientWidth || 600;
    let previous = -Infinity;
    for (const inv of recent.inventories) {
      const button = document.createElement("button");
      button.type = "button";
      button.style.left = `${left(inv.year)}%`;
      const x = (left(inv.year) / 100) * track;
      button.textContent = x - previous < 34 ? `’${String(inv.year).slice(2)}` : String(inv.year);
      if (x - previous < 34) button.style.transform = "none"; // starts at its year instead of being centred on it
      previous = x;
      button.title = `${inv.name}: ${inv.area} km² of glaciers`;
      button.addEventListener("click", () => setYear(inv.year));
      marks.append(button);
    }
  };
  drawMarks();
  new ResizeObserver(drawMarks).observe(marks);

  let playing = false;
  let last = 0;
  let position = 0; // fractional year while playing
  const stop = () => {
    playing = false;
    play.textContent = "▶";
    play.setAttribute("aria-label", "Play");
  };
  const tick = (now: number) => {
    if (!playing) return;
    position += Math.min((now - last) / 1000, 0.1) * Number(speed.value);
    last = now;
    if (position >= lastYear()) {
      setYear(lastYear());
      stop();
      return;
    }
    if (Math.floor(position) !== Number(slider.value)) setYear(Math.floor(position));
    requestAnimationFrame(tick);
  };
  const toggle = () => {
    if (playing) return stop();
    playing = true;
    play.textContent = "❚❚";
    play.setAttribute("aria-label", "Pause");
    position = Number(slider.value) >= lastYear() ? FIRST_YEAR : Number(slider.value);
    last = performance.now();
    requestAnimationFrame(tick);
  };
  play.addEventListener("click", toggle);
  window.addEventListener(
    "keydown",
    (e) => {
      // P plays whichever time bar is on screen
      if (e.code !== "KeyP" || e.ctrlKey || e.metaKey || e.altKey || !recent.active) return;
      e.stopImmediatePropagation();
      toggle();
    },
    true,
  );

  // the ice that stood above today's terrain, as a 3D layer like the ice age ice
  const solid = el<HTMLInputElement>("recent-3d");
  const exaggeration = el<HTMLInputElement>("exaggeration");
  let lia: IceLayer | null = null;
  let liaLoading: Promise<void> | null = null;
  const applyLia = () => {
    if (!lia) return;
    lia.visible = recent.active && solid.checked;
    lia.exaggeration = Number(exaggeration.value);
    lia.setAge(Math.max(LAST_YEAR - Number(slider.value), 0)); // frames are stored old to young by age, like the ice age
  };
  const loadLia = () =>
    (liaLoading ??= fetchJson<Manifest>("recent/lia/manifest.json")
      .then((manifest) => {
        lia = new IceLayer(manifest, "ice-lia");
        lia.showContourLabels = false;
        lia.opacity = 0.85;
        map.addLayer(lia, FIRST_LABEL_LAYER);
      })
      .catch(() => {
        solid.closest("label")!.hidden = true; // data built without the Little Ice Age surface
      }));
  exaggeration.addEventListener("input", applyLia);

  // after today: a model projection, draped on the terrain (see future.ts)
  const scenario = el<HTMLSelectElement>("future-scenario");
  let futureLoading: Promise<void> | null = null;
  const applyFuture = () => {
    if (!future) return;
    const year = Number(slider.value);
    future.set(recent.active, scenario.value, year);
    const chosen = future.manifest.scenarios.find((s) => s.id === scenario.value)!;
    el("future-note").textContent = `${future.manifest.glacier} only (Aletsch and connected glaciers): ${chosen.detail}.`;
    el("future-legend").hidden = !future.active;
    if (future.active) el("recent-sub").textContent = future.describe();
  };
  const loadFuture = () =>
    (futureLoading ??= fetchJson<FutureManifest>("recent/future/manifest.json")
      .then((manifest) => {
        future = new FutureGlacier(map, manifest, "coast");
        for (const s of manifest.scenarios) scenario.add(new Option(s.label, s.id));
        el("future-menu").hidden = false;
        el("future-bar").style.background = rampCss(THICKNESS_RAMP);
        el("future-gone").style.background = GONE_COLOR;
        el("future-fly").addEventListener("click", () => {
          map.flyTo({ center: [manifest.lon + 0.03, manifest.lat - 0.04], zoom: 11.3, pitch: 58, bearing: 25 });
          if (Number(slider.value) <= LAST_YEAR) setYear(LAST_YEAR + 1);
        });
        slider.max = String(Math.max(manifest.endYear, LAST_YEAR));
        drawMarks();
      })
      .catch(() => {
        // data built without projections: the bar ends today
        slider.max = String(LAST_YEAR);
        drawMarks();
        setYear(Math.min(Number(slider.value), LAST_YEAR));
      }));
  scenario.addEventListener("input", () => {
    applyFuture();
    recent.setYear(Number(slider.value)); // refreshes the readout
  });

  const applyMenu = () => {
    applyFuture();
    const historic: Backdrop = backdrop.value === "maps" || backdrop.value === "photos" ? backdrop.value : "none";
    recent.setBackdrop(historic, Number(opacity.value), backdrop.value === "relief");
    recent.setGlaciers(glaciers.checked, solid.checked && !solid.closest("label")!.hidden);
    applyLia();
  };
  for (const input of [backdrop, opacity, glaciers, solid]) input.addEventListener("input", applyMenu);

  const setEra = async (on: boolean, year?: number) => {
    stop();
    el("timebar").hidden = on;
    el("recentbar").hidden = !on;
    el("recent-menu").hidden = !on;
    el("ice-menu").hidden = on;
    // ice colouring and its legend belong to the ice age: set aside, and restored on the way back
    const mode = el<HTMLSelectElement>("ice-mode");
    if (on && !mode.dataset.kept) {
      mode.dataset.kept = mode.value;
      mode.value = "plain";
    } else if (!on && mode.dataset.kept) {
      mode.value = mode.dataset.kept;
      delete mode.dataset.kept;
    }
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    const ready = recent.setActive(on); // takes effect at once; the glacier data may still be loading
    onSwitch(on);
    if (year !== undefined) setYear(year);
    yearToUrl(on ? Number(slider.value) : null);
    applyMenu();
    await ready;
    if (on) await Promise.all([loadLia(), loadFuture()]);
    drawMarks(); // the inventories have arrived
    applyMenu();
    if (on) setYear(Number(slider.value));
  };
  el("era-recent").addEventListener("click", () => setEra(true));
  el("era-iceage").addEventListener("click", () => setEra(false));
  const initial = yearFromUrl();
  if (initial !== null) setEra(true, initial);
  else applyMenu(); // a historic map chosen in the URL shows in the ice age view too
  return recent;
}

function bindMenu(map: maplibregl.Map, ice: IceLayer, sea: SeaLayer | null, redrawTerrain: () => void) {
  const menu = document.getElementById("menu")!;
  const toggle = document.getElementById("menu-toggle")!;
  toggle.addEventListener("click", () => {
    const collapsed = menu.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  });

  document.querySelectorAll<HTMLButtonElement>("button.info").forEach((button) =>
    button.addEventListener("click", () => {
      const text = document.getElementById(button.getAttribute("aria-controls")!)!;
      text.hidden = !text.hidden;
      button.setAttribute("aria-expanded", String(!text.hidden));
    }),
  );

  const whenReady = (fn: () => void) => (map.isStyleLoaded() ? fn() : map.once("load", fn));

  bindBasemap(map);

  const shading = document.getElementById("shading") as HTMLInputElement;
  shading.addEventListener("input", () => {
    const value = Number(shading.value);
    map.setPaintProperty("hillshade", "hillshade-exaggeration", value);
    map.setPaintProperty("background", "background-color", backgroundColor(value));
    // paint-only changes do not refresh MapLibre's cached terrain tile textures by themselves
    redrawTerrain();
  });

  const seaBox = document.getElementById("sea-visible") as HTMLInputElement;
  seaBox.closest("label")!.hidden = !sea;
  seaBox.addEventListener("change", () => {
    if (sea) sea.visible = seaBox.checked;
    map.triggerRepaint();
  });

  const contours = document.getElementById("contour-labels") as HTMLInputElement;
  contours.addEventListener("change", () => {
    ice.showContourLabels = contours.checked;
    map.triggerRepaint();
  });

  const look = document.getElementById("look")!;
  const fly = new FlyControls(map, (active) => {
    look.classList.toggle("active", active);
    look.textContent = active ? "Mouse look on (Esc to release)" : "Mouse look";
  });
  look.addEventListener("click", () => fly.toggleLook());

  document.querySelectorAll<HTMLInputElement>("input[data-group]").forEach((box) => {
    const apply = () =>
      GROUP_LAYERS[box.dataset.group as LabelGroup].forEach((id) =>
        map.setLayoutProperty(id, "visibility", box.checked ? "visible" : "none"),
      );
    box.addEventListener("change", apply);
    whenReady(apply);
  });

  const visible = document.getElementById("ice-visible") as HTMLInputElement;
  visible.addEventListener("change", () => {
    ice.visible = visible.checked;
    map.triggerRepaint();
  });

  const opacity = document.getElementById("ice-opacity") as HTMLInputElement;
  opacity.addEventListener("input", () => {
    ice.opacity = Number(opacity.value);
    map.triggerRepaint();
  });

  const exaggeration = document.getElementById("exaggeration") as HTMLInputElement;
  const exagOut = document.getElementById("exag-out")!;
  exaggeration.addEventListener("input", () => {
    const value = Number(exaggeration.value);
    exagOut.textContent = value.toFixed(1);
    ice.exaggeration = value;
    if (sea) sea.exaggeration = value;
    map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: value });
  });
}

function bindIceModes(map: maplibregl.Map, ice: IceLayer, ground: Partial<Record<IceMode, DrapedLayer>>) {
  const select = document.getElementById("ice-mode") as HTMLSelectElement;
  const particles = document.getElementById("particles") as HTMLInputElement;
  const legend = document.getElementById("legend")!;

  for (const option of Array.from(select.options)) {
    const mode = option.value as IceMode;
    option.disabled = mode === "erosion" || mode === "deglaciation" ? !ground[mode] : mode !== "plain" && !ice.hasFlow;
  }
  particles.disabled = !ice.hasFlow;

  const apply = () => {
    const mode = select.value as IceMode;
    ice.mode = mode;
    ice.showParticles = particles.checked;
    for (const [key, layer] of Object.entries(ground)) layer.setVisible(key === mode);
    ice.setAge(ice.currentAge);

    legend.hidden = mode === "plain";
    if (mode !== "plain") {
      const ramp = RAMPS[mode];
      document.getElementById("legend-title")!.textContent = ramp.title;
      document.getElementById("legend-bar")!.style.background = rampCss(ramp);
      document.getElementById("legend-ticks")!.replaceChildren(
        ...ramp.ticks.map(([t, label]) => {
          const span = document.createElement("span");
          span.style.left = `${t * 100}%`;
          span.textContent = label;
          return span;
        }),
      );
    }
    map.triggerRepaint();
  };
  select.addEventListener("change", apply);
  particles.addEventListener("change", apply);
  apply();
}

function bindDebris(map: maplibregl.Map, ice: IceLayer, manifest: Manifest, age: () => number) {
  const box = document.getElementById("debris") as HTMLInputElement;
  const legend = document.getElementById("debris-legend")!;
  const regions = manifest.debris!.regions;
  legend.replaceChildren(
    ...regions.map((r) => {
      const span = document.createElement("span");
      const dot = document.createElement("i");
      dot.style.background = r.color;
      span.append(dot, r.name);
      return span;
    }),
  );

  let loading: Promise<void> | null = null;
  const load = () =>
    (loading ??= loadDebris(manifest).then((data) => {
      ice.setDebris(data);
      map.addSource("deposits", { type: "geojson", data: data.deposits });
      map.addLayer(
        {
          id: "deposits",
          type: "circle",
          source: "deposits",
          filter: [">=", ["get", "age"], Math.round(age() * 10) / 10],
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 1.6, 10, 3.2, 13, 5.5],
            "circle-color": ["match", ["get", "region"], ...regions.flatMap((r, i) => [i, r.color]), "#888"] as never,
            "circle-opacity": 0.9,
            "circle-stroke-color": "rgba(0,0,0,0.45)",
            "circle-stroke-width": 0.5,
          },
        },
        ice.id,
      );
    }));

  box.addEventListener("change", async () => {
    legend.hidden = !box.checked;
    ice.showDebris = box.checked;
    if (box.checked) await load();
    if (map.getLayer("deposits")) map.setLayoutProperty("deposits", "visibility", box.checked ? "visible" : "none");
    map.triggerRepaint();
  });
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend", `<pre style="position:absolute;top:40%;left:0;right:0;text-align:center">Failed to start: ${String(e)}</pre>`);
});
