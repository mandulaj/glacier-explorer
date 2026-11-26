import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./app.css";
import { RAMPS, rampCss, type IceMode } from "./colormaps";
import { fetchJson, type Manifest, type TimeSeries } from "./data";
import { loadDebris } from "./debris";
import { ErosionLayer } from "./erosion";
import { IceLayer } from "./iceLayer";
import { FlyControls } from "./fly";
import { backgroundColor, buildStyle, FIRST_LABEL_LAYER, GROUP_LAYERS, TERRAIN_SOURCE, type LabelGroup } from "./style";
import { TimeBar } from "./timebar";

const INITIAL_AGE = 24;

/** The time is kept in the URL next to MapLibre's own `map=` entry: #map=9/46.7/8.9/0/60&t=24.5 */
function ageFromUrl(): number | null {
  const entry = location.hash.slice(1).split("&").find((part) => part.startsWith("t="));
  const age = entry ? Number(entry.slice(2)) : NaN;
  return Number.isFinite(age) ? age : null;
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
  const [manifest, series] = await Promise.all([
    fetchJson<Manifest>("manifest.json"),
    fetchJson<TimeSeries>("timeseries.json"),
  ]);

  const map = new maplibregl.Map({
    container: "map",
    style: buildStyle(),
    center: [8.75, 46.75],
    zoom: 7.7,
    pitch: 58,
    bearing: -12,
    maxPitch: 85,
    minZoom: 5,
    maxZoom: 14.5,
    hash: "map",
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl(), "top-right");

  const ice = new IceLayer(manifest);
  const maxAge = manifest.frames[0].age;
  let erosion: ErosionLayer | null = null;
  let depositStep = NaN;
  const timebar = new TimeBar(maxAge, series, Math.min(Math.max(ageFromUrl() ?? INITIAL_AGE, 0), maxAge), (age) => {
    ageToUrl(age);
    ice.setAge(age);
    erosion?.setAge(age);
    // deposits appear once their time has come; refilter only every 100 years
    const step = Math.round(age * 10) / 10;
    if (step !== depositStep && map.getLayer("deposits")) {
      depositStep = step;
      map.setFilter("deposits", [">=", ["get", "age"], step]);
    }
  });

  map.on("load", () => {
    map.addLayer(ice, FIRST_LABEL_LAYER);
    ice.setAge(timebar.age);
    if (manifest.erosion) {
      erosion = new ErosionLayer(manifest);
      map.addLayer(erosion, "water");
      erosion.setAge(timebar.age);
    }
    bindIceModes(map, ice, () => erosion);
    if (manifest.debris) bindDebris(map, ice, manifest, () => timebar.age);
  });

  bindMenu(map, ice, () => erosion?.invalidate());
  // handy for debugging and automated checks
  Object.assign(window, { map, ice, timebar });
}

function bindMenu(map: maplibregl.Map, ice: IceLayer, redrawTerrain: () => void) {
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

  const shading = document.getElementById("shading") as HTMLInputElement;
  shading.addEventListener("input", () => {
    const value = Number(shading.value);
    map.setPaintProperty("hillshade", "hillshade-exaggeration", value);
    map.setPaintProperty("background", "background-color", backgroundColor(value));
    // paint-only changes do not refresh MapLibre's cached terrain tile textures by themselves
    redrawTerrain();
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
    map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: value });
  });
}

function bindIceModes(map: maplibregl.Map, ice: IceLayer, erosion: () => ErosionLayer | null) {
  const select = document.getElementById("ice-mode") as HTMLSelectElement;
  const particles = document.getElementById("particles") as HTMLInputElement;
  const legend = document.getElementById("legend")!;

  for (const option of Array.from(select.options)) {
    const mode = option.value as IceMode;
    option.disabled = mode === "erosion" ? !erosion() : mode !== "plain" && !ice.hasFlow;
  }
  particles.disabled = !ice.hasFlow;

  const apply = () => {
    const mode = select.value as IceMode;
    ice.mode = mode;
    ice.showParticles = particles.checked;
    erosion()?.setVisible(mode === "erosion");
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
