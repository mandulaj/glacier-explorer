import type { Map as MlMap, RasterTileSource } from "maplibre-gl";
import { fetchJson } from "./data";

/**
 * The last two centuries in Switzerland: glacier extents from the Swiss Glacier
 * Inventories (pipeline/recent.py) on top of swisstopo's historic maps or aerial
 * photographs of the chosen year, on a time bar of its own in calendar years.
 */

interface Inventories {
  inventories: {
    year: number;
    name: string;
    area: number; // km2
    /** polygons of rings of [lon, lat] */
    polygons: number[][][][];
  }[];
}

export type Backdrop = "none" | "maps" | "photos";

export const FIRST_YEAR = 1850;
/** today: the last year with maps, photographs and inventories */
export const LAST_YEAR = 2025;
/** end of the time bar; beyond today there are model projections only */
export const END_YEAR = 2100;

const WMTS = "https://wmts.geo.admin.ch/1.0.0";
/** Historic national maps: one composite per year, 1844 to 2021. */
const MAP_YEARS: [number, number] = [1844, 2021];
/**
 * Aerial photographs: for every year a mosaic of the latest flights up to then, which covers
 * only part of the country before about 1960.
 */
const PHOTO_FIRST = 1926;
const PHOTO_MISSING = [1928];

const GLACIERS = "recent-glaciers";
const FILLS = ["recent-glaciers-a", "recent-glaciers-b"] as const;
const LINES = ["recent-glaciers-a-line", "recent-glaciers-b-line"] as const;
const MAPS = "recent-maps";
const PHOTOS = "recent-photos";
const ATTRIBUTION = '© <a href="https://www.swisstopo.admin.ch" target="_blank" rel="noopener">swisstopo</a>';

const mapTiles = (year: number) => `${WMTS}/ch.swisstopo.zeitreihen/default/${Math.min(Math.max(year, MAP_YEARS[0]), MAP_YEARS[1])}1231/3857/{z}/{x}/{y}.png`;
/** The mosaic of a year, or null before the first flights. PNG keeps the areas not flown yet transparent. */
function photoTiles(year: number): string | null {
  let y = Math.min(year, LAST_YEAR);
  while (PHOTO_MISSING.includes(y)) y--;
  // the mosaics of recent decades cover the whole country, and are much smaller as JPEG
  return y < PHOTO_FIRST ? null : `${WMTS}/ch.swisstopo.swissimage-product/default/${y}/3857/{z}/{x}/{y}.${y < 1990 ? "png" : "jpeg"}`;
}

export class RecentEra {
  private data: Inventories | null = null;
  private loading: Promise<void> | null = null;
  private on = false;
  private year = LAST_YEAR;
  private backdrop: Backdrop = "maps";
  private backdropOpacity = 1;
  private showGlaciers = true;
  private solid = false;
  private shown: [number, number] = [-1, -1];
  private tileKey = "";
  private tileTimer = 0;

  /** @param before style layer below which everything goes */
  constructor(
    private map: MlMap,
    private before: string,
    private onChange: () => void,
  ) {}

  get active() {
    return this.on;
  }

  get inventories() {
    return this.data?.inventories ?? [];
  }

  async setActive(on: boolean) {
    this.on = on;
    if (on && !this.data) {
      this.loading ??= fetchJson<Inventories>("recent/glaciers.json").then((data) => {
        this.data = data;
        this.addLayers();
      });
      await this.loading;
    }
    this.apply();
  }

  setYear(year: number) {
    this.year = year;
    if (this.on && this.data) this.apply();
  }

  setBackdrop(kind: Backdrop, opacity: number) {
    this.backdrop = kind;
    this.backdropOpacity = opacity;
    if (this.data) this.apply();
  }

  /** @param solid whether the lost ice is drawn in 3D as well: the flat fill then steps back */
  setGlaciers(show: boolean, solid: boolean) {
    this.solid = solid;
    this.showGlaciers = show;
    if (this.data) this.apply();
  }

  /** What is on screen, for the readout. */
  describe(): { glaciers: string; backdrop: string } {
    const inv = this.inventories;
    if (!inv.length) return { glaciers: "", backdrop: "" };
    const [a, b, t] = this.bracket();
    const area = Math.round((inv[a].area + (inv[b].area - inv[a].area) * t) / 10) * 10;
    const exact = t < 0.02 ? inv[a] : t > 0.98 ? inv[b] : null;
    const glaciers = exact
      ? `${exact.name}: ${exact.area} km² of glaciers`
      : this.year > inv[inv.length - 1].year
        ? `latest inventory, ${inv[inv.length - 1].year}: ${inv[inv.length - 1].area} km²`
        : `between the ${inv[a].year} and ${inv[b].year} inventories, about ${area} km²`;
    let backdrop = "";
    if (this.backdrop === "maps") backdrop = `national maps as of ${Math.min(this.year, MAP_YEARS[1])}`;
    if (this.backdrop === "photos") {
      backdrop =
        this.year < PHOTO_FIRST
          ? `no aerial photographs before ${PHOTO_FIRST}`
          : `latest aerial photographs as of ${Math.min(this.year, LAST_YEAR)}${this.year < 1960 ? " (few areas were flown yet)" : ""}`;
    }
    return { glaciers, backdrop };
  }

  private addLayers() {
    const map = this.map;
    map.addSource(MAPS, { type: "raster", tiles: [mapTiles(this.year)], tileSize: 256, maxzoom: 17, attribution: ATTRIBUTION });
    map.addLayer({ id: MAPS, type: "raster", source: MAPS, layout: { visibility: "none" }, paint: { "raster-fade-duration": 0 } }, this.before);
    map.addSource(PHOTOS, { type: "raster", tiles: [photoTiles(Math.max(this.year, PHOTO_FIRST))!], tileSize: 256, maxzoom: 18, attribution: ATTRIBUTION });
    map.addLayer({ id: PHOTOS, type: "raster", source: PHOTOS, layout: { visibility: "none" }, paint: { "raster-fade-duration": 0 } }, this.before);
    map.addSource(GLACIERS, {
      type: "geojson",
      attribution: 'Glaciers: <a href="https://www.glamos.ch" target="_blank" rel="noopener">GLAMOS</a>',
      data: {
        type: "FeatureCollection",
        features: this.data!.inventories.map((inv, i) => ({
          type: "Feature" as const,
          properties: { i },
          geometry: { type: "MultiPolygon" as const, coordinates: inv.polygons },
        })),
      },
    });
    for (const [k, id] of FILLS.entries()) {
      const none = ["==", ["get", "i"], -1] as ["==", ["get", string], number];
      map.addLayer({ id, type: "fill", source: GLACIERS, filter: none, layout: { visibility: "none" }, paint: { "fill-color": "#dff0fb", "fill-opacity": 0 } }, this.before);
      map.addLayer(
        { id: LINES[k], type: "line", source: GLACIERS, filter: none, layout: { visibility: "none" }, paint: { "line-color": "#1f6fb2", "line-width": 1.4, "line-opacity": 0 } },
        this.before,
      );
    }
  }

  /** Inventories before and after the year, and the share of the later one. */
  private bracket(): [number, number, number] {
    const inv = this.inventories;
    let a = 0;
    while (a < inv.length - 2 && inv[a + 1].year <= this.year) a++;
    const b = Math.min(a + 1, inv.length - 1);
    const span = inv[b].year - inv[a].year;
    return [a, b, span > 0 ? Math.min(Math.max((this.year - inv[a].year) / span, 0), 1) : 0];
  }

  private apply() {
    const map = this.map;
    if (!this.data) return;
    const show = (id: string, on: boolean) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");

    // glaciers: the earlier inventory fades into the later one
    const glaciers = this.on && this.showGlaciers;
    const [a, b, t] = this.bracket();
    // maps, photographs and the 3D ice show the ice themselves; beyond today only the outline stays, as a reference
    const fill = this.year > LAST_YEAR ? 0 : this.backdrop === "none" && !this.solid ? 0.85 : 0.3;
    [
      [a, 1 - t],
      [b, t],
    ].forEach(([i, weight], k) => {
      show(FILLS[k], glaciers);
      show(LINES[k], glaciers);
      if (!glaciers) return;
      if (this.shown[k] !== i) {
        this.shown[k] = i;
        map.setFilter(FILLS[k], ["==", ["get", "i"], i]);
        map.setFilter(LINES[k], ["==", ["get", "i"], i]);
      }
      map.setPaintProperty(FILLS[k], "fill-opacity", fill * weight);
      map.setPaintProperty(LINES[k], "line-opacity", 0.9 * weight);
    });

    // backdrop: swapping tiles on every step of a drag would flood the tile server
    const maps = this.on && this.backdrop === "maps";
    const photos = this.on && this.backdrop === "photos" && photoTiles(this.year) !== null;
    show(MAPS, maps);
    map.setPaintProperty(MAPS, "raster-opacity", this.backdropOpacity);
    show(PHOTOS, photos);
    map.setPaintProperty(PHOTOS, "raster-opacity", this.backdropOpacity);
    if ((maps || photos) && this.tileKey !== `${this.backdrop}:${this.year}`) {
      clearTimeout(this.tileTimer);
      this.tileTimer = window.setTimeout(() => this.retile(), 250);
    }
    this.onChange();
    map.triggerRepaint();
  }

  private retile() {
    if (!this.on) return;
    const source = (id: string) => this.map.getSource(id) as RasterTileSource | undefined;
    if (this.backdrop === "maps") source(MAPS)?.setTiles([mapTiles(this.year)]);
    const photos = photoTiles(this.year);
    if (this.backdrop === "photos" && photos) source(PHOTOS)?.setTiles([photos]);
    this.tileKey = `${this.backdrop}:${this.year}`;
  }
}
