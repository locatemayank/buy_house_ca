# California Zone Finder

Interactive map that highlights California ZIP-code zones scored on
**school quality** and **safety (low crime)**, with per-zone detail
(home prices, price trend, lot size, area). Enter a ZIP (default `95131`)
to center the map and rank nearby zones.

## Quick start

```bash
cd ca_zone_finder/app
python3 -m http.server 8000
# open http://localhost:8000
```

The app is a static site (HTML + Leaflet + vanilla JS modules). No build step.

## What data is real vs modeled

Each metric is badged in the UI and carries a `provenance` tag in the data.

| Metric | Source | Status |
|---|---|---|
| Median home value | Zillow ZHVI (public research CSV) | **real** |
| 1-yr price change | Zillow ZHVI (12-mo delta) | **real** |
| City / County | Zillow ZHVI | **real** |
| ZIP boundaries + land area | US Census TIGER ZCTA | **real** |
| School score | placeholder (deterministic) | modeled |
| Crime index | placeholder (deterministic) | modeled |
| Median lot size | placeholder (deterministic) | modeled |

The `modeled` fields are stable per-ZIP stand-ins so the whole UI works
today. Swap them for real feeds without touching the front-end (see below).

## Project layout

```
ca_zone_finder/
  data/                    raw downloads (gitignore-able, large)
    zhvi_zip_raw.csv       Zillow home values by ZIP
    ca_zcta_raw.geojson    Census ZIP boundaries (CA)
  scripts/
    process_data.py        builds app/zones.json from the raw data
  app/
    index.html
    css/style.css
    js/
      dataSources.js       PLUGGABLE data layer (swap backends here)
      scoring.js           PLUGGABLE scoring/weights + map coloring
      app.js               map + search + detail wiring
    zones.json             generated combined dataset (1,536 CA ZIPs)
```

## Re-generating the data

```bash
# (only if you want to refresh the raw public files)
curl -o data/zhvi_zip_raw.csv \
  https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv
curl -o data/ca_zcta_raw.geojson \
  https://raw.githubusercontent.com/OpenDataDE/State-zip-code-GeoJSON/master/ca_california_zip_codes_geo.min.json

python3 scripts/process_data.py   # writes app/zones.json
```

## Built to extend

The app was structured so new features/data can drop in with minimal changes:

1. **Replace a modeled metric with a real feed (offline join):**
   edit `build_modeled_metrics()` in `scripts/process_data.py` to join a real
   dataset (e.g. CA DOE test scores, DOJ crime, ATTOM parcels) and set the
   corresponding `provenance` to the real source. Re-run the script.

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
- School/crime/lot values are placeholders — do not use for real decisions
  until real feeds are connected.
