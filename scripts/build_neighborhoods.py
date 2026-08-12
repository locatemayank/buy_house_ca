#!/usr/bin/env python3
"""
Build a sub-city NEIGHBORHOOD dataset (app/neighborhoods.json + .js) so users
see named areas like "Berryessa", "Evergreen", "Willow Glen" instead of just
"San Jose".

Inputs (public):
  - data/hoods/*.geojson       Neighborhood polygons per CA city
                               Source: codeforamerica/click_that_hood (public)
  - data/neigh_zhvi_raw.csv    Zillow Home Value Index by NEIGHBORHOOD (real)
                               Source: https://www.zillow.com/research/data/
  - app/zones.json             Our ZIP dataset (for nearest-ZIP fallback)

Metric provenance:
  price -> "zillow_neighborhood" when matched to Zillow neighborhood ZHVI,
        -> "zillow_zip_nearest"  when falling back to the nearest ZIP's price.
  price_change_1yr, county      -> from nearest ZIP (zillow)  [real]
  school_score                  -> "caaspp" (REAL) taken from the nearest ZIP's
                                   CAASPP-derived score; "modeled" only where the
                                   nearest ZIP has no rated schools.
  crime_index/lot               -> "modeled" (same deterministic model as ZIPs)

Outputs:
  - app/neighborhoods.json
  - app/neighborhoods.js   (window.NEIGHBORHOODS = ...; for file:// use)
"""

import csv
import glob
import hashlib
import json
import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
# Web app now lives at the repo root (so GitHub Pages serves index.html directly)
APP = os.path.join(HERE, "..")
HOODS_DIR = os.path.join(DATA, "hoods")
NEIGH_ZHVI = os.path.join(DATA, "neigh_zhvi_raw.csv")
ZONES = os.path.join(APP, "zones.json")
# REAL per-ZIP CAASPP-derived school scores (see build_school_scores.py)
SCHOOL_SCORES = os.path.join(DATA, "zip_school_scores.json")

OUT_JSON = os.path.join(APP, "neighborhoods.json")
OUT_JS = os.path.join(APP, "neighborhoods.js")

COORD_PRECISION = 4

# filename (without .geojson) -> city name used for Zillow matching (None = skip)
CITY_FROM_FILE = {
    "san-jose": "san jose",
    "san-francisco": "san francisco",
    "oakland": "oakland",
    "san-diego": "san diego",
    "sacramento": "sacramento",
    "long-beach": "long beach",
    "los-angeles-county": None,   # county file, city varies
    "silicon-valley": None,       # region file, city varies
}

# Pretty display label per file (used when we don't have a precise city)
DISPLAY_REGION = {
    "los-angeles-county": "Los Angeles County",
    "silicon-valley": "Silicon Valley",
}


def norm(s):
    s = (s or "").lower().strip()
    s = re.sub(r"[^a-z0-9 ]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s


def stable_unit(key, salt):
    h = hashlib.md5(f"{key}:{salt}".encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def build_modeled(key, price):
    r_school = stable_unit(key, "school")
    r_crime = stable_unit(key, "crime")
    r_lot = stable_unit(key, "lot")
    price_factor = min(max(((price or 500000) - 300000) / 2_000_000, 0.0), 1.0)
    school = round(min(2.0 + 8.0 * (0.55 * r_school + 0.45 * price_factor), 10.0), 1)
    crime = round(80.0 * (0.6 * r_crime + 0.4 * (1 - price_factor)) + 5.0, 1)
    lot = int(3000 + 12000 * (0.7 * r_lot + 0.3 * price_factor))
    return school, crime, lot


def composite(school, crime):
    return round(100.0 * (0.5 * (school / 10.0) + 0.5 * (1 - crime / 100.0)), 1)


def haversine(a, b):
    R = 3958.8
    dlat = math.radians(b[0] - a[0])
    dlon = math.radians(b[1] - a[1])
    la1 = math.radians(a[0])
    la2 = math.radians(b[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlon / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def centroid_of(geom):
    xs = []
    ys = []

    def walk(c):
        if isinstance(c[0], (float, int)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for x in c:
                walk(x)

    walk(geom["coordinates"])
    if not xs:
        return None, None
    return sum(ys) / len(ys), sum(xs) / len(xs)  # lat, lon


def round_coords(geom):
    def r(x):
        return round(x, COORD_PRECISION)

    def walk(c):
        if isinstance(c[0], (float, int)):
            return [r(c[0]), r(c[1])]
        return [walk(x) for x in c]

    return {"type": geom["type"], "coordinates": walk(geom["coordinates"])}


def load_neigh_zhvi():
    """key (norm city, norm name) -> price ; also (norm name) -> price (secondary)."""
    by_city_name = {}
    by_name = {}
    with open(NEIGH_ZHVI, newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        idx = {n: i for i, n in enumerate(header)}
        month_cols = [i for i, n in enumerate(header) if n[:2] == "20" and "-" in n]
        last = month_cols[-1]
        for row in reader:
            if row[idx["State"]] != "CA":
                continue
            name = norm(row[idx["RegionName"]])
            city = norm(row[idx["City"]])
            try:
                price = float(row[last])
            except (ValueError, IndexError):
                continue
            by_city_name[(city, name)] = round(price)
            by_name.setdefault(name, round(price))
    return by_city_name, by_name


def load_zips():
    with open(ZONES) as f:
        fc = json.load(f)
    zips = []
    for feat in fc["features"]:
        p = feat["properties"]
        if p.get("lat") is None or p.get("lon") is None:
            continue
        zips.append(p)
    return zips


def load_school_scores():
    """Return {zip: {score(1-10), n, year}} of REAL CAASPP-derived scores."""
    if not os.path.exists(SCHOOL_SCORES):
        print(f"  WARNING: {SCHOOL_SCORES} missing — run build_school_scores.py "
              f"first. Neighborhood school scores fall back to modeled.")
        return {}
    with open(SCHOOL_SCORES) as f:
        return json.load(f)


def nearest_zip(lat, lon, zips):
    best = None
    best_d = 1e18
    for p in zips:
        d = haversine([lat, lon], [p["lat"], p["lon"]])
        if d < best_d:
            best_d = d
            best = p
    return best


def main():
    by_city_name, by_name = load_neigh_zhvi()
    print(f"Zillow neighborhood prices: {len(by_city_name)} (city,name) keys")
    zips = load_zips()
    print(f"ZIP zones for fallback: {len(zips)}")
    school_scores = load_school_scores()
    print(f"ZIPs with REAL school scores: {len(school_scores)}")

    features = []
    matched_zillow = 0
    real_school = 0
    for path in sorted(glob.glob(os.path.join(HOODS_DIR, "*.geojson"))):
        fname = os.path.splitext(os.path.basename(path))[0]
        file_city = CITY_FROM_FILE.get(fname, fname.replace("-", " "))
        region_label = DISPLAY_REGION.get(fname)
        with open(path) as f:
            gj = json.load(f)
        for feat in gj.get("features", []):
            props = feat.get("properties", {})
            name = props.get("name") or props.get("Name") or props.get("label")
            if not name or not feat.get("geometry"):
                continue
            lat, lon = centroid_of(feat["geometry"])
            if lat is None:
                continue

            nz = nearest_zip(lat, lon, zips)
            county = nz["county"] if nz else None
            price_change = nz["price_change_1yr"] if nz else None
            nz_zip = nz["zip"] if nz else None

            # price: prefer real Zillow neighborhood match
            price = None
            price_prov = None
            nname = norm(name)
            if file_city and (file_city, nname) in by_city_name:
                price = by_city_name[(file_city, nname)]
                price_prov = "zillow_neighborhood"
            elif nname in by_name:
                price = by_name[nname]
                price_prov = "zillow_neighborhood"
            elif nz:
                price = nz["price"]
                price_prov = "zillow_zip_nearest"

            key = (file_city or region_label or fname) + ":" + nname
            m_school, crime, lot = build_modeled(key, price)

            # Prefer the REAL CAASPP-derived score from the nearest ZIP.
            real = school_scores.get(nz_zip) if nz_zip else None
            if real and real.get("score") is not None:
                school = real["score"]
                school_prov = "caaspp"
                real_school += 1
            else:
                school = m_school
                school_prov = "modeled"

            score = composite(school, crime)

            display_city = (
                region_label
                if region_label
                else (file_city.title() if file_city else fname.replace("-", " ").title())
            )

            new_props = {
                "id": "N:" + key,
                "name": name,
                "city": display_city,
                "county": county,
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "price": price,
                "price_change_1yr": price_change,
                "land_area_sqmi": None,
                "school_score": school,
                "crime_index": crime,
                "median_lot_size_sqft": lot,
                "score": score,
                "provenance": {
                    "price": price_prov or "modeled",
                    "price_change_1yr": "zillow" if price_change is not None else "modeled",
                    "city": "click_that_hood",
                    "county": "zillow" if county else "modeled",
                    "land_area_sqmi": "modeled",
                    "school_score": school_prov,
                    "crime_index": "modeled",
                    "median_lot_size_sqft": "modeled",
                },
            }
            if price_prov == "zillow_neighborhood":
                matched_zillow += 1

            features.append({
                "type": "Feature",
                "properties": new_props,
                "geometry": round_coords(feat["geometry"]),
            })

    out = {"type": "FeatureCollection", "features": features}
    with open(OUT_JSON, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    with open(OUT_JS, "w") as f:
        f.write("window.NEIGHBORHOODS = ")
        json.dump(out, f, separators=(",", ":"))
        f.write(";\n")

    print(
        f"Wrote {len(features)} neighborhoods "
        f"({matched_zillow} priced from Zillow neighborhood, rest nearest-ZIP)"
    )
    print(f"  school_score: {real_school} REAL (caaspp via nearest ZIP), "
          f"{len(features) - real_school} modeled fallback")
    print(f"  {OUT_JSON} ({os.path.getsize(OUT_JSON)/1e6:.1f} MB)")
    print(f"  {OUT_JS} ({os.path.getsize(OUT_JS)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
