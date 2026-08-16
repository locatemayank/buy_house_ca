# CA School Rating Map (buy_house_ca)

An interactive, mobile-friendly map of **California public-school ratings (1–10)**.
Live site: https://locatemayank.github.io/buy_house_ca/

Every public school in California is plotted and color-coded by its rating. Use the
controls to slice the data:

- **School level** — `Average` (all schools), `Elementary`, `Middle`, or `High`.
- **Data year** — `2025` (real, default) or extrapolated **2026 / 2027 / 2028**.
- **Min rating** — hide schools below a chosen rating.
- **Search** — jump to a city or school by name.

Tap any school marker for its details and full 2025–2028 rating trajectory.

## Ratings & data provenance

The ratings come from the companion dataset repo
[`ca_schoool_rating`](https://github.com/locatemayank/ca_schoool_rating):

- **School directory / locations** — CA Dept. of Education public-school directory
  (real name, level, latitude/longitude).
- **Historical ratings** — CAASPP Smarter Balanced statewide **1–10 deciles**
  (combined ELA + Math % Met/Above) for past years.
- **2025 rating** — CA School Dashboard current-year decile
  (ELA + Math Distance-from-Standard rank).

### How 2026–2028 are computed

For each school we fit a simple **linear least-squares trend** through its available
historical deciles (including the real 2025 point) and project it forward, clamped to
the 1–10 range. These are **estimates**, clearly badged `(est.)` in the UI — not
official ratings.

## Data pipeline

```
scripts/build_school_ratings.py
  reads   ../ca_school_finder/data/{schools,ratings,accountability}.js
  writes  data/school_ratings.js   ->  window.SCHOOL_POINTS = [
            { n, lv, city, d, lat, lon, r:{2025,2026,2027,2028} }, ... ]
```

Regenerate the dataset:

```bash
python3 scripts/build_school_ratings.py
```

## Tech

- Plain HTML/CSS/JS — no build step, GitHub-Pages ready.
- [Leaflet](https://leafletjs.com/) with canvas rendering for ~7,000 markers.
- Installable PWA (`manifest.webmanifest`, `sw.js`) with offline caching.
- Mobile-first layout: collapsible filter panel, large touch targets, responsive map.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000/
