# Alpine Ice Age Explorer

Full-screen 3D viewer of the Alps through the last glacial cycle, from 120 000 years ago to today.
Drag the time slider and the valleys fill with ice; further views show how the ice flowed, where it
ground against its bed, and where it carried and dropped rock debris.

## Features

- **3D terrain** of the whole Alps at up to sub-metre resolution, with adjustable relief shading
  (turn it down to zero for a plain black-and-white map).
- **Time slider** in 100-year steps with play / pause and the modelled ice volume as backdrop.
  Named periods (marine isotope stages) and events such as the Last Glacial Maximum, the Younger
  Dryas or Ötzi mark the way. View and time are kept in the URL, so any state can be shared as a link.
- **Ice infill**: a semi-transparent ice surface cut against the real terrain, so valleys fill from
  wall to wall and peaks stand out as nunataks. Contour lines every 100 m with elevation numbers.
- **Colour the ice by** surface speed, basal sliding (grinding), or frozen versus sliding bed.
- **Cumulative erosion** draped on the bedrock; it stays visible after the ice has gone.
- **Flow particles** streaming over the ice surface.
- **Debris transport**: paths of rock debris from 19 source massifs and the places where the ice
  dropped it (erratic boulders, moraines).
- **Click any place** for its ice history: thickness through the whole cycle and since when it is
  ice-free. From there, *Whose ice is this?* follows the flow upstream to its source massif and
  downstream to the margin, and *Cross-section* draws terrain and ice along a line of your choice,
  animated with the time slider.
- **Ice-free since**: the ground coloured by its deglaciation age.
- **Sea level**: the sea follows global mean sea level through time over a real 3D seabed, so the
  shallow northern Adriatic dries out during the glacial maximum (about 130 m lower).
- **Second ice model for Switzerland**: the finer Swiss Time Machine simulation (500 m, 37–7 ka)
  can be shown in place of the whole-Alps model where it exists (marked on the time bar). Flow
  particles, speed colouring and the click tools work on it too; its flow direction is derived
  from the slope of the ice surface, as the data holds the speed only.
- **Since 1850**: a second time bar in calendar years for Switzerland, with glacier extents from the
  Swiss Glacier Inventories over swisstopo's historic maps or aerial photographs of the chosen year,
  draped on the 3D terrain. The ice lost since about 1850 stands on today's terrain in 3D.
- **Northern ice sheet**: zoom out and the ice sheet over the British Isles, Scandinavia and the
  Barents Sea grows and shrinks with the time slider (flat outlines from geological reconstructions).
- **Labels**: borders, towns, summits with elevation, lakes and rivers.

### Controls

| Input | Action |
|---|---|
| drag / scroll / right-drag | pan, zoom, rotate and tilt |
| `W` `A` `S` `D` | fly forward, left, back, right |
| `E` (or `Space`) / `Q` | fly up / down |
| `F` | mouse look on / off (`Esc` also releases the mouse) |
| `P` | play / pause time |
| `1850 – today ›` / `‹ Ice age` | switch between the ice age and the last two centuries |

## Data and credits

- **Ice**: PISM simulation at 1 km resolution by Seguinot et al. (2018),
  [The Cryosphere 12, 3265–3285](https://doi.org/10.5194/tc-12-3265-2018); data
  [doi:10.5281/zenodo.7802275](https://doi.org/10.5281/zenodo.7802275) (CC BY 4.0), run `alpcyc.1km.epic.pp`.
- **Erosion law**: Koppes et al. (2015), as applied by
  [Seguinot & Delaney (2021)](https://doi.org/10.5194/esurf-9-923-2021).
- **Swiss Time Machine**: IGM simulation of the Swiss Alps by Jouvet, Leger and others,
  [doi:10.5281/zenodo.24003777](https://doi.org/10.5281/zenodo.24003777) (CC BY 4.0), built on
  Leger et al. (2025), [Nature Communications 16, 848](https://doi.org/10.1038/s41467-025-56168-3).
  Published as a visualisation product, not as scientific results.
- **Glaciers since 1850**: Swiss Glacier Inventories 1850, 1931, 1973, 2010 and 2016,
  [GLAMOS](https://www.glamos.ch/en/downloads#inventories) (CC BY 4.0).
- **Little Ice Age ice surface**: Reinthaler & Paul (2025),
  [doi:10.5281/zenodo.14336827](https://doi.org/10.5281/zenodo.14336827) (CC BY 4.0). Only the
  1850 surface is data; its decline to today is interpolated with the inventory outlines.
- **Historic maps and aerial photographs**: [swisstopo](https://www.swisstopo.admin.ch/en/timetravel)
  "Zeitreise" map series and SWISSIMAGE time travel, loaded from the swisstopo tile service.
- **Ice sheet outside the Alps**: DATED-1 time slices, 38–10 ka, Hughes et al. (2016),
  [Boreas 45, 1–45](https://doi.org/10.1111/bor.12142); data
  [doi:10.1594/PANGAEA.848117](https://doi.org/10.1594/PANGAEA.848117) (CC BY 3.0). Before that, one
  outline per climate stage from Batchelor et al. (2019),
  [Nature Communications 10, 3713](https://doi.org/10.1038/s41467-019-11601-2); data
  [osf.io/7jen3](https://osf.io/7jen3/). Outlines only, no thickness, blended between time slices.
- **Terrain**: [Mapterhorn](https://mapterhorn.com/attribution/) tiles built from open data of
  swisstopo, BEV, IGN, LDBV and others.
- **Seabed**: [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) around the Alps and
  the global [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen) elsewhere, merged
  into the terrain tiles in the browser only where those are at sea level (land keeps full resolution).
- **Sea level**: Spratt & Lisiecki (2016), [doi:10.5194/cp-12-1079-2016](https://doi.org/10.5194/cp-12-1079-2016).
  A global mean: local land movement is not included, so past shorelines are indicative.
- **Labels and borders**: [OpenFreeMap](https://openfreemap.org), © OpenStreetMap contributors.
- **Map engine**: [MapLibre GL JS](https://maplibre.org).

**Read the ice with care.** It is a model result, not a reconstruction. The modelled ice is likely
too thick (the paper reports the surface some 860 m above mapped trimlines in the upper Rhône
valley), the present-day model state is not today's glaciers, the erosion values are a relative
potential rather than real depths, and debris sources are assigned by nearest massif.

## Repository layout

```
data/        raw NetCDF from Zenodo                         (not in git)
pipeline/    Python: NetCDF -> static assets in web/public/data/
web/         Vite + TypeScript + MapLibre GL JS viewer (static site)
scripts/     deployment to GitHub Pages
```

`web/public/data/` (about 580 MB of compressed frames) is not in git either; it is generated by
the pipeline and published only as part of the built site.

## Build the data

Requires [uv](https://docs.astral.sh/uv/). Download the three `alpcyc.1km.epic.pp.*` files from the
Zenodo record into `data/`, then from the repository root:

```sh
uv run --project pipeline pipeline/build.py --step 100a   # ice frames (--step 1ka for a quick start)
uv run --project pipeline pipeline/flow.py --step 1ka     # velocity, basal sliding / temperature, erosion
uv run --project pipeline pipeline/debris.py              # debris transport paths and deposits
uv run --project pipeline pipeline/history.py             # per-place ice history, deglaciation age

# optional: seabed tiles (downloads EMODnet bathymetry) and sea-level curve
curl -o data/sealevel/spratt2016.txt --create-dirs \
  https://www.ncei.noaa.gov/pub/data/paleo/contributions_by_author/spratt2016/spratt2016.txt
uv run --project pipeline python -I pipeline/sea.py --sea-level data/sealevel/spratt2016.txt

# optional: outlines of the Eurasian ice sheet around the Alps.
# Unzip "TimeSlices shapefiles" of doi:10.1594/PANGAEA.848117 into data/context/dated/shp/ and copy
# the "best_estimate" shapefiles of 45 ka, MIS 4, 5a, 5b, 5c and 5d from https://osf.io/7jen3/
# into data/context/batchelor/<slice name>/
uv run --project pipeline python -I pipeline/context.py

# optional: second ice model for Switzerland. Put meta.json, base.bin.gz and play.bin of
# doi:10.5281/zenodo.24003777 into data/stm/ (run after build.py)
uv run --project pipeline python -I pipeline/stm.py

# optional: glacier outlines since 1850. Unzip the five Swiss Glacier Inventories from
# https://doi.glamos.ch/data/inventory/inventory_<name>.zip into data/recent/sgi/<name>/, with
# <name> = sgi1850_r1992, sgi1931_r2022, sgi1973_r1976, sgi2010_r2010, sgi2016_r2020
uv run --project pipeline python -I pipeline/recent.py

# optional: the ice lost since 1850 in 3D. Put LIA_glacier_surface_Alps.tif of
# doi:10.5281/zenodo.14336827 into data/recent/lia/ (needs the inventories above; downloads
# today's terrain from Mapterhorn)
uv run --project pipeline python -I pipeline/lia.py
```

What the pipeline does:

- resamples the UTM 32N model grid to a Web Mercator rectangle (`grid.py`);
- stores ice as *extended thickness*: real thickness on the ice and a negative ramp beyond the
  margin. Added to the present-day model bed, this gives a surface that dives below ground outside
  the ice, so the viewer's depth test against the high-resolution terrain draws the margin along
  the real valley walls. Using the present-day bed also removes the isostatic depression of the
  model bed (up to 160 m), so the ice sits on today's terrain;
- integrates the erosion law over the 100-year output (`flow.py`);
- traces debris, seeded next to rock walls, through the time-varying surface velocity until the
  ice drops it (`debris.py`).

## Run the viewer

Requires Node.js 20 or newer.

```sh
cd web
npm install
npm run dev      # development server
npm run build    # static site in web/dist/
```

## Deploy to GitHub Pages

```sh
scripts/deploy.sh
```

This builds the site and force-pushes it, data frames included, as a single commit to the
`gh-pages` branch. The `main` branch stays small, and rebuilding the data does not grow the
repository. In the repository settings, set *Pages → Source* to *Deploy from a branch*, branch
`gh-pages`, folder `/ (root)`.

## Licence

Code: [GPL-3.0](LICENSE). The ice simulation data, terrain tiles and map data keep the licences of
their sources listed above.

## Ideas for later

- Aggregated variables (maximum extent, deglaciation age): [zenodo.3604174](https://doi.org/10.5281/zenodo.3604174)
- Published erosion potential for comparison: [zenodo.5084579](https://doi.org/10.5281/zenodo.5084579)
- 2 km run with modelled climate, Jouvet et al. (2023): [zenodo.8270674](https://doi.org/10.5281/zenodo.8270674)
- Little Ice Age surfaces, glacier inventories (GLAMOS) and projections to 2050 for the recent end
  of the slider.
