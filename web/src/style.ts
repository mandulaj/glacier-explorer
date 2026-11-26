import type { StyleSpecification } from "maplibre-gl";

export const TERRAIN_SOURCE = "terrain";
/** Layer in front of which the ice custom layer is inserted (first label layer). */
export const FIRST_LABEL_LAYER = "towns-small";

export type LabelGroup = "borders" | "towns" | "summits" | "water";

export const GROUP_LAYERS: Record<LabelGroup, string[]> = {
  borders: ["borders"],
  towns: ["towns-small", "towns-large"],
  summits: ["summits"],
  water: ["water", "rivers"],
};

const DEM_ATTRIBUTION =
  '<a href="https://mapterhorn.com/attribution/" target="_blank">© Mapterhorn</a> (swisstopo, BEV, IGN, LDBV and others)';
const SEA_ATTRIBUTION = '<a href="https://emodnet.ec.europa.eu/en/bathymetry" target="_blank">Seabed: EMODnet Bathymetry</a>';

const PAINT = { shadow: "#3d3a36", highlight: "#ffffff", water: "#a9bfd0" };

/** Background gets lighter as the relief shading is turned down, ending in a plain black-and-white map. */
export function backgroundColor(shading: number): string {
  const t = Math.min(shading / 0.55, 1);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(0xf4, 0xd9)}, ${mix(0xf4, 0xd5)}, ${mix(0xf2, 0xcb)})`;
}

/**
 * @param demTiles tile URL template for the elevation tiles (Mapterhorn, or our seabed-merging protocol)
 * @param hasSeabed whether those tiles include the seabed
 */
export function buildStyle(demTiles: string, hasSeabed: boolean): StyleSpecification {
  const dem = { type: "raster-dem" as const, tiles: [demTiles], tileSize: 512, encoding: "terrarium" as const };
  const p = { ...PAINT, background: backgroundColor(0.55) };
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      // separate sources for terrain mesh and hillshade, as recommended by MapLibre
      [TERRAIN_SOURCE]: { ...dem, attribution: hasSeabed ? `${DEM_ATTRIBUTION} | ${SEA_ATTRIBUTION}` : DEM_ATTRIBUTION },
      hillshade: dem,
      osm: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution:
          '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap</a>',
      },
    },
    terrain: { source: TERRAIN_SOURCE, exaggeration: 1 },
    sky: {
      "sky-color": "#8fb4d9",
      "horizon-color": "#e6eef5",
      "fog-color": "#e6eef5",
      "sky-horizon-blend": 0.6,
      "horizon-fog-blend": 0.6,
      "fog-ground-blend": 0.85,
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": p.background } },
      {
        id: "hillshade",
        type: "hillshade",
        source: "hillshade",
        paint: {
          "hillshade-exaggeration": 0.55,
          "hillshade-shadow-color": p.shadow,
          "hillshade-highlight-color": p.highlight,
          "hillshade-accent-color": p.shadow,
          "hillshade-illumination-direction": 315,
        },
      },
      {
        id: "water",
        type: "fill",
        source: "osm",
        "source-layer": "water",
        filter: ["!=", ["get", "class"], "ocean"],
        paint: { "fill-color": p.water, "fill-opacity": 0.85 },
      },
      {
        id: "rivers",
        type: "line",
        source: "osm",
        "source-layer": "waterway",
        filter: ["==", ["get", "class"], "river"],
        paint: { "line-color": p.water, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 12, 2] },
      },
      {
        id: "borders",
        type: "line",
        source: "osm",
        "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        paint: {
          "line-color": "#1a1a1a",
          "line-opacity": 0.75,
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.8, 10, 1.8],
          "line-dasharray": [4, 2],
        },
      },
      {
        id: "towns-small",
        type: "symbol",
        source: "osm",
        "source-layer": "place",
        minzoom: 8,
        filter: ["==", ["get", "class"], "town"],
        layout: {
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": "#1a1a1a", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.4 },
      },
      {
        id: "towns-large",
        type: "symbol",
        source: "osm",
        "source-layer": "place",
        filter: ["==", ["get", "class"], "city"],
        layout: {
          "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 5, 11, 10, 16],
          "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": "#111", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.6 },
      },
      {
        id: "summits",
        type: "symbol",
        source: "osm",
        "source-layer": "mountain_peak",
        minzoom: 7,
        filter: ["has", "name"],
        layout: {
          "text-field": ["concat", "▲ ", ["coalesce", ["get", "name:latin"], ["get", "name"]], "\n", ["to-string", ["get", "ele"]], " m"],
          "text-font": ["Noto Sans Italic"],
          "text-size": 11,
          "symbol-sort-key": ["get", "rank"],
        },
        paint: { "text-color": "#3a2c1c", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.3 },
      },
    ],
  };
}
