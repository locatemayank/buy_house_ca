#!/usr/bin/env python3
"""
build_school_scores.py — derive REAL per-ZIP (and per-neighborhood-usable)
school scores for the CA Zone Finder from the CA School Finder's REAL data.

Source of truth (REAL, not modeled):
  ../../ca_school_finder/data/schools.js   window.SCHOOLS = [{id(CDS), zip, lat, lon, ...}]
  ../../ca_school_finder/data/ratings.js   window.SCHOOL_RATINGS = {
                                             CDS: { r:{year:1..10}, p:{year:pct}, enr:int } }

The ratings are statewide 1-10 CAASPP deciles (ELA+Math % met/above) — the same
kind of number GreatSchools publishes. We take each school's most-recent year
rating, then aggregate to the ZIP level (enrollment-weighted mean, falling back
to a simple mean) so the Zone Finder can show a REAL school_score per ZIP.

Output:
  ../data/zip_school_scores.json  ->  {
    "<zip>": { "score": <1..10 float>, "n": <#schools>, "year": <latest year used> },
    ...
  }

This file is consumed by process_data.py (ZIP zones) and build_neighborhoods.py
(nearest-ZIP fallback) to replace the previously MODELED school_score with a
REAL, provenance-tagged value ("caaspp").
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SCHOOL_FINDER = os.path.join(HERE, "..", "..", "ca_school_finder", "data")
SCHOOLS_JS = os.path.join(SCHOOL_FINDER, "schools.js")
RATINGS_JS = os.path.join(SCHOOL_FINDER, "ratings.js")
OUT = os.path.join(HERE, "..", "data", "zip_school_scores.json")


def load_js_global(path, marker):
    """Load a `window.X = <json>;` payload from a JS data file."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    i = text.index(marker) + len(marker)
    # skip up to the first '=' after the marker, then take the JSON payload
    eq = text.index("=", i)
    payload = text[eq + 1:].strip()
    if payload.endswith(";"):
        payload = payload[:-1].strip()
    return json.loads(payload)


def latest_rating(rec):
    """Most-recent-year 1-10 rating for one school record, or None."""
    r = rec.get("r") or {}
    if not r:
        return None
    year = max(int(y) for y in r.keys())
    return year, r[str(year)]


def main():
    schools = load_js_global(SCHOOLS_JS, "window.SCHOOLS")
    ratings = load_js_global(RATINGS_JS, "window.SCHOOL_RATINGS")
    print(f"Loaded {len(schools)} schools, {len(ratings)} rated CDS records")

    # zip -> [weighted_sum, weight_sum, simple_sum, count, latest_year]
    agg = {}
    matched = 0
    for s in schools:
        zc = (s.get("zip") or "").strip()[:5]
        cds = (s.get("id") or "").strip()
        if not zc or not cds:
            continue
        rec = ratings.get(cds)
        if not rec:
            continue
        lr = latest_rating(rec)
        if lr is None:
            continue
        year, rating = lr
        enr = rec.get("enr") or 0
        w = enr if enr > 0 else 1  # enrollment weight, fallback to 1
        a = agg.get(zc)
        if a is None:
            a = [0.0, 0.0, 0.0, 0, 0]
            agg[zc] = a
        a[0] += rating * w
        a[1] += w
        a[2] += rating
        a[3] += 1
        if year > a[4]:
            a[4] = year
        matched += 1

    out = {}
    for zc, (wsum, wtot, ssum, n, year) in agg.items():
        if wtot > 0:
            score = wsum / wtot
        elif n > 0:
            score = ssum / n
        else:
            continue
        out[zc] = {"score": round(score, 1), "n": n, "year": year}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=True)

    print(f"Matched {matched} schools to ratings across {len(out)} ZIPs")
    print(f"Wrote {OUT} ({os.path.getsize(OUT)/1000:.1f} KB)")


if __name__ == "__main__":
    main()
