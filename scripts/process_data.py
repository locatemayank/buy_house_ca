#!/usr/bin/env python3
"""
Process raw public datasets into a single app-ready GeoJSON (zones.json)
for the California Zone Finder.

Inputs (downloaded from public sources into ../data):
  - zhvi_zip_raw.csv        Zillow Home Value Index by ZIP (real, monthly)
                            Source: https://www.zillow.com/research/data/
  - ca_zcta_raw.geojson     California ZIP-code (ZCTA) polygon boundaries (real)
                            Source: US Census TIGER via OpenDataDE

Outputs:
  - ../app/zones.json       One FeatureCollection, one feature per CA ZIP that
                            has both a boundary and a Zillow price.

Metric provenance (IMPORTANT / honest labeling):
  price, price_change_1yr    -> "zillow"  (REAL)
  land_area_sqmi             -> "census"  (REAL, from ZCTA land area)
  city, county               -> "zillow"  (REAL)
  school_score               -> "caaspp"  (REAL, from ca_school_finder ratings)
                                fallback "modeled" only where no rated schools
  crime_index                -> "modeled" (PLACEHOLDER, deterministic)
  median_lot_size_sqft       -> "modeled" (PLACEHOLDER, deterministic)

The "modeled" fields are stable per-ZIP stand-ins so the UI is fully
functional today. Replace them with a real feed by editing this script
(see build_modeled_metrics) or by swapping the data-source module in the
front-end (app/js/dataSources.js). Each field carries its provenance in
feature.properties.provenance so the UI can badge real vs modeled values.
"""

import csv
import json
import os
import hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
# Web app now lives at the repo root (so GitHub Pages serves index.html directly)
APP = os.path.join(HERE, "..")

ZHVI_CSV = os.path.join(DATA, "zhvi_zip_raw.csv")
ZCTA_GEO = os.path.join(DATA, "ca_zcta_raw.geojson")
# REAL per-ZIP school scores derived from the CA School Finder's CAASPP ratings
# (see scripts/build_school_scores.py). {zip: {score, n, year}}
SCHOOL_SCORES = os.path.join(DATA, "zip_school_scores.json")
OUT = os.path.join(APP, "zones.json")

COORD_PRECISION = 4  # ~11 m; keeps file small enough for the browser


def stable_unit(zip_code: str, salt: str) -> float:
    """Deterministic pseudo-random float in [0,1) from zip+salt."""
    h = hashlib.md5(f"{zip_code}:{salt}".encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def load_school_scores():
    """Return {zip: {score(1-10), n, year}} of REAL CAASPP-derived scores."""
    if not os.path.exists(SCHOOL_SCORES):
        print(f"  WARNING: {SCHOOL_SCORES} missing — run build_school_scores.py "
              f"first. School scores will fall back to modeled placeholders.")
        return {}
    with open(SCHOOL_SCORES) as f:
        return json.load(f)


def load_zhvi():
    """Return {zip: {price, price_change_1yr, city, county}} for CA only."""
    out = {}
    with open(ZHVI_CSV, newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        # locate columns
        idx = {name: i for i, name in enumerate(header)}
        # month columns are the trailing date-formatted headers
        month_cols = [i for i, name in enumerate(header) if name[:2] == "20" and "-" in name]
        last = month_cols[-1]
        # ~12 months back for YoY change
        prior = month_cols[-13] if len(month_cols) >= 13 else month_cols[0]
        for row in reader:
            if row[idx["State"]] != "CA":
                continue
            zip_code = row[idx["RegionName"]].zfill(5)

            def val(i):
                try:
                    return float(row[i])
                except (ValueError, IndexError):
                    return None

            price = val(last)
            if price is None:
                continue
            p_prior = val(prior)
            change = None
            if p_prior and p_prior > 0:
                change = (price - p_prior) / p_prior * 100.0
            out[zip_code] = {
                "price": round(price),
                "price_change_1yr": round(change, 1) if change is not None else None,
                "city": row[idx["City"]],
                "county": row[idx["CountyName"]],
            }
    return out


def round_coords(geom):
    def r(x):
        return round(x, COORD_PRECISION)

    def walk(c):
        if isinstance(c[0], (float, int)):
            return [r(c[0]), r(c[1])]
        return [walk(x) for x in c]

    geom["coordinates"] = walk(geom["coordinates"])
    return geom


def build_modeled_metrics(zip_code, price):
    """
    Deterministic PLACEHOLDER metrics. Replace this function body with a real
    join (GreatSchools / CA DOE / DOJ crime / parcel data) when available.
    Kept mildly correlated with price so the demo looks plausible, but flagged
    as 'modeled' everywhere so it is never mistaken for ground truth.
    """
    r_school = stable_unit(zip_code, "school")
    r_crime = stable_unit(zip_code, "crime")
    r_lot = stable_unit(zip_code, "lot")

    # price percentile-ish nudge (higher price -> slightly better school/lower crime)
    price_factor = min(max((price - 300_000) / 2_000_000, 0.0), 1.0)

    school_score = round(2.0 + 8.0 * (0.55 * r_school + 0.45 * price_factor), 1)
    school_score = min(school_score, 10.0)

    # crime index: 0 (safest) .. 100 (worst)
    crime_index = round(80.0 * (0.6 * r_crime + 0.4 * (1 - price_factor)) + 5.0, 1)

    # median lot size sqft
    median_lot = int(3000 + 12000 * (0.7 * r_lot + 0.3 * price_factor))

    return school_score, crime_index, median_lot


def composite_score(school_score, crime_index):
    """0..100 higher = better (good schools + low crime)."""
    school_norm = school_score / 10.0  # 0..1
    safety_norm = 1.0 - (crime_index / 100.0)  # 0..1
    return round(100.0 * (0.5 * school_norm + 0.5 * safety_norm), 1)


def main():
    os.makedirs(APP, exist_ok=True)
    print("Loading Zillow ZHVI (CA)...")
    zhvi = load_zhvi()
    print(f"  {len(zhvi)} CA ZIPs with prices")

    print("Loading REAL school scores (CAASPP via ca_school_finder)...")
    school_scores = load_school_scores()
    print(f"  {len(school_scores)} ZIPs with real school scores")

    print("Loading ZCTA boundaries...")
    with open(ZCTA_GEO) as f:
        gj = json.load(f)

    features = []
    matched = 0
    real_school = 0
    for feat in gj["features"]:
        props = feat.get("properties", {})
        zip_code = str(props.get("ZCTA5CE10", "")).zfill(5)
        if zip_code not in zhvi:
            continue
        matched += 1
        z = zhvi[zip_code]
        land_sqmi = round(props.get("ALAND10", 0) / 2_589_988.0, 2)  # m^2 -> mi^2

        m_school, crime_index, median_lot = build_modeled_metrics(zip_code, z["price"])

        # Prefer the REAL CAASPP-derived school score when we have rated
        # schools in this ZIP; otherwise fall back to the modeled placeholder.
        real = school_scores.get(zip_code)
        if real and real.get("score") is not None:
            school_score = real["score"]
            school_prov = "caaspp"
            real_school += 1
        else:
            school_score = m_school
            school_prov = "modeled"

        score = composite_score(school_score, crime_index)

        try:
            lat = float(props.get("INTPTLAT10"))
            lon = float(props.get("INTPTLON10"))
        except (TypeError, ValueError):
            lat = lon = None

        new_props = {
            "zip": zip_code,
            "city": z["city"],
            "county": z["county"],
            "lat": lat,
            "lon": lon,
            "price": z["price"],
            "price_change_1yr": z["price_change_1yr"],
            "land_area_sqmi": land_sqmi,
            "school_score": school_score,
            "crime_index": crime_index,
            "median_lot_size_sqft": median_lot,
            "score": score,
            "provenance": {
                "price": "zillow",
                "price_change_1yr": "zillow",
                "city": "zillow",
                "county": "zillow",
                "land_area_sqmi": "census",
                "school_score": school_prov,
                "crime_index": "modeled",
                "median_lot_size_sqft": "modeled",
            },
        }

        features.append({
            "type": "Feature",
            "properties": new_props,
            "geometry": round_coords(feat["geometry"]),
        })

    out = {"type": "FeatureCollection", "features": features}
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    size_mb = os.path.getsize(OUT) / 1e6
    print(f"Wrote {matched} zones to {OUT} ({size_mb:.1f} MB)")
    print(f"  school_score: {real_school} REAL (caaspp), "
          f"{matched - real_school} modeled fallback")

    # Also emit a JS global so the page works by double-clicking index.html
    # (file:// blocks fetch of zones.json). index.html loads zones.js.
    out_js = os.path.join(APP, "zones.js")
    with open(out_js, "w") as f:
        f.write("window.ZONES = ")
        json.dump(out, f, separators=(",", ":"))
        f.write(";\n")
    print(f"Wrote {out_js} ({os.path.getsize(out_js) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
