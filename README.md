# California Zone Finder

Interactive map that highlights California zones scored on **school quality**
and **safety (low crime)**, with per-zone detail (home prices, price trend,
lot size, area). Enter a ZIP (default `95131`) to center the map and rank
nearby zones.

Two granularity **levels** (toggle in the header):
- **ZIP** — every CA ZIP code (statewide, real Census boundaries).
- **Neighborhood** — sub-city named areas (e.g. *Berryessa*, *Willow Glen*,
  *Alum Rock*) for major CA cities, so you can go finer than "San Jose".

Two **views**: an interactive Map and a sortable Table (no map needed).

## "Should I buy here?" report

Select any ZIP (click a zone or search) and press **🏡 Should I buy here? —
Full report** in the detail panel. A slide-in report card answers seven buyer
questions, each with a 0–100 sub-score, letter grade, plain-English summary,
supporting facts, and a data-provenance badge, then a weighted **Final Verdict**
(BUY / CONSIDER / AVOID):

1. Good place to raise a kid? (schools + safety + space)
2. How safe is it really? (crime vs the rest of CA)
3. Are we getting good housing value? (price vs county median + momentum)
4. What environment / geographic risks exist? (wildfire/flood/seismic proxies)
5. How desirable over 10–20 years? (momentum + schools + price tier)
6. Commute, restaurants, parks, shopping, airport? (real nearest-airport
   distance + urbanization proxy)
7. Why should we NOT buy here? (auto-generated caveats from weakest scores +
   red flags)

The engine (`js/report.js`) is pure and data-driven. In this first version it
uses only fields already in `zones.json` plus runtime-derived signals
(statewide/county percentiles) and one genuinely-real computation (distance to
the nearest major CA airport). Each section is honestly badged
`real` / `mixed` / `modeled`. To upgrade a section to a real feed later
(schools, crime, FEMA flood, CalFire fire-hazard), add the field(s) to
`zones.json` and adjust that one section's scorer — the UI does not change.
Default verdict weights live in `DEFAULT_WEIGHTS` in `js/report.js`.

## Quick start

Open `index.html` directly (double-click), or serve it:

```bash
cd ca_zone_finder
python3 -m http.server 8000
# open http://localhost:8000
```

The app is a static site (HTML + Leaflet + vanilla JS) at the repo root, so
**GitHub Pages** works out of the box (Settings → Pages → deploy from branch
`main`, folder `/root`). No build step.

## What data is real vs modeled

Each metric is badged in the UI and carries a `provenance` tag in the data.

| Metric | Source | Status |
|---|---|---|
| Median home value | Zillow ZHVI (public research CSV) | **real** |
| 1-yr price change | Zillow ZHVI (12-mo delta) | **real** |
| City / County | Zillow ZHVI | **real** |
| ZIP boundaries + land area | US Census TIGER ZCTA | **real** |
| Neighborhood boundaries/names | codeforamerica/click_that_hood | **real** |
| Neighborhood home value | Zillow Neighborhood ZHVI (nearest-ZIP fallback) | **real** |
| School score | CAASPP (ELA+Math % met/above → statewide 1–10 decile), aggregated per ZIP from `../ca_school_finder` | **real** (`caaspp`) |
| Crime index | placeholder (deterministic) | modeled |
| Median lot size | placeholder (deterministic) | modeled |

School scores are **real** — they are derived from the sibling
`ca_school_finder` project's CAASPP ratings (`data/ratings.js`) joined to the
CA DOE school directory (`data/schools.js`) by CDS code, then aggregated to the
ZIP level (enrollment-weighted mean of each school's most-recent 1–10 rating).
Neighborhoods inherit the nearest ZIP's real score. A small number of ZIPs with
no rated schools fall back to a `modeled` placeholder (still badged honestly).
The remaining `modeled` fields (crime, lot size) are stable per-ZIP stand-ins so
the whole UI works today; swap them for real feeds without touching the
front-end (see below).

## Project layout

The web app is at the repo **root** (GitHub Pages friendly):

```
ca_zone_finder/
  index.html                       app entry (top level)
  css/style.css
  js/
    dataSources.js                 PLUGGABLE data layer (swap backends here)
    scoring.js                     PLUGGABLE scoring/weights + map coloring
    app.js                         map + table + search + level/detail wiring
  zones.json / zones.js            ZIP dataset (1,536 CA ZIPs)
  neighborhoods.json / neighborhoods.js   neighborhood dataset (763 areas)
  scripts/
    process_data.py                builds zones.json (ZIP level)
    build_neighborhoods.py         builds neighborhoods.json (neighborhood level)
  data/                            raw downloads (gitignored, large)
    zhvi_zip_raw.csv               Zillow home values by ZIP
    ca_zcta_raw.geojson            Census ZIP boundaries (CA)
    hoods/                         neighborhood polygons per CA city
    neigh_zhvi_raw.csv             Zillow neighborhood home values
```

## Re-generating the data

```bash
# REAL school scores: first build the sibling ca_school_finder data
# (schools.js + ratings.js), then aggregate it to per-ZIP scores here.
python3 scripts/build_school_scores.py   # writes data/zip_school_scores.json

```

```bash
# (only if you want to refresh the raw public files)
curl -o data/zhvi_zip_raw.csv \
  https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv
curl -o data/ca_zcta_raw.geojson \
  https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/ca_california_zip_codes_geo.min.json

python3 scripts/process_data.py   # writes zones.json (+ zones.js); uses real
                                   # school scores from zip_school_scores.json

# Neighborhood level (sub-city areas)
curl -o data/neigh_zhvi_raw.csv \
  https://files.zillowstatic.com/research/public_csvs/zhvi/Neighborhood_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv
# neighborhood polygons per city, e.g.:
mkdir -p data/hoods && for c in san-jose san-francisco oakland san-diego sacramento long-beach los-angeles-county silicon-valley; do \
  curl -o data/hoods/$c.geojson \
  https://raw.githubusercontent.com/codeforamerica/click_that_hood/master/public/data/$c.geojson; done
python3 scripts/build_neighborhoods.py   # writes app/neighborhoods.json (+ .js)
```

To add more neighborhoods, drop additional `*.geojson` files into
`data/hoods/` (any city available in click_that_hood) and re-run
`build_neighborhoods.py`.

## Built to extend

The app was structured so new features/data can drop in with minimal changes:

1. **Replace a modeled metric with a real feed (offline join):**
   edit `build_modeled_metrics()` in `scripts/process_data.py` to join a real
   dataset (e.g. DOJ crime, ATTOM parcels) and set the corresponding
   `provenance` to the real source. Re-run the script. (The **school score** is
   already wired this way — see `scripts/build_school_scores.py`, which joins the
   `ca_school_finder` CAASPP ratings by CDS and aggregates them per ZIP.)

2. **Add a live data backend (API):**
   implement a new class in `app/js/dataSources.js` with the same
   `loadZones()` / `getZoneDetail()` methods and point `activeSource` at it.
   Nothing else changes.

3. **Add on-click detail (e.g. live listings, walk score, flood risk):**
   ```js
   import { registerDetailProvider } from "./dataSources.js";
   registerDetailProvider(async (props) => {
     const r = await fetch(`/api/listings/${props.zip}`);
     const j = await r.json();
     return { "Active listings": j.count };
   });
   ```
   The returned fields render automatically in the detail panel.

4. **Add a new ranking criterion (e.g. affordability):**
   add a weight in `DEFAULT_WEIGHTS` and return its normalized 0..1 value in
   `normalizedMetrics()` in `app/js/scoring.js`. Scores and colors update
   automatically.

## Notes / limitations

- Rendering is limited to zones within the search radius for performance
  (the full CA GeoJSON is ~51 MB).
- ZCTA boundaries approximate USPS ZIP delivery areas.
- School scores are **real** (CAASPP-derived, per-ZIP); crime/lot values are
  still placeholders — do not use those for real decisions until real feeds are
  connected.
