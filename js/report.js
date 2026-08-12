/*
 * report.js — "Should I buy here?" report engine (P1, classic script).
 *
 * Pure, data-driven. Answers 7 buyer questions for one ZIP zone, each as a
 * 0..100 sub-score + letter grade + plain-English summary + supporting facts,
 * then rolls them up into a weighted Final Verdict (Buy / Consider / Avoid)
 * and an explicit "Why you should NOT buy here" section.
 *
 * P1 uses ONLY data already present in zones.json:
 *   zip, city, county, lat, lon, price, price_change_1yr, land_area_sqmi,
 *   school_score, crime_index, median_lot_size_sqft, provenance
 * plus signals derived at runtime (statewide/county percentiles) and one
 * genuinely-real computation: distance to the nearest major CA airport.
 *
 * Every section carries `provenance: "real" | "modeled" | "mixed"` so the UI
 * never passes off a placeholder as ground truth. To upgrade a section to real
 * data later, feed the new field(s) into zones.json and adjust that section's
 * scorer — nothing else changes.
 *
 * Public API (attached to window.ZoneReport):
 *   buildContext(featureCollection) -> ctx   (compute once, reuse per ZIP)
 *   buildReport(props, ctx)         -> { zip, city, county, sections[], verdict }
 */
(function () {
  "use strict";

  // ---- Tunables -------------------------------------------------------------

  // Default weights for the Final Verdict roll-up. Sum need not be 1.
  var DEFAULT_WEIGHTS = {
    kids: 0.20,
    safety: 0.20,
    value: 0.18,
    risk: 0.14,
    desirability: 0.16,
    lifestyle: 0.12,
  };

  // Major CA airports (name, lat, lon) for a genuinely-real distance signal.
  var AIRPORTS = [
    ["LAX (Los Angeles Intl)", 33.9416, -118.4085],
    ["SFO (San Francisco Intl)", 37.6213, -122.379],
    ["SAN (San Diego Intl)", 32.7338, -117.1933],
    ["SJC (San Jose Mineta)", 37.3639, -121.9289],
    ["OAK (Oakland Intl)", 37.7126, -122.2197],
    ["SMF (Sacramento Intl)", 38.6954, -121.5908],
    ["SNA (John Wayne / Orange County)", 33.6757, -117.8682],
    ["ONT (Ontario Intl)", 34.056, -117.6012],
    ["BUR (Hollywood Burbank)", 34.2007, -118.3585],
    ["FAT (Fresno Yosemite)", 36.7762, -119.7181],
    ["PSP (Palm Springs Intl)", 33.8297, -116.5067],
    ["SBA (Santa Barbara)", 34.4262, -119.8404],
    ["LGB (Long Beach)", 33.8177, -118.1516],
  ];

  // ---- Math helpers ---------------------------------------------------------

  function clamp01(x) {
    if (isNaN(x) || x == null) return 0;
    return Math.max(0, Math.min(1, x));
  }
  function clamp100(x) {
    return Math.max(0, Math.min(100, x));
  }
  function round1(x) {
    return Math.round(x * 10) / 10;
  }
  function haversineMiles(aLat, aLon, bLat, bLon) {
    var R = 3958.8;
    var dLat = ((bLat - aLat) * Math.PI) / 180;
    var dLon = ((bLon - aLon) * Math.PI) / 180;
    var lat1 = (aLat * Math.PI) / 180;
    var lat2 = (bLat * Math.PI) / 180;
    var h = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Percentile rank (0..1) of value v within a *sorted ascending* array.
  function pctRank(sortedArr, v) {
    if (!sortedArr || !sortedArr.length || v == null || isNaN(v)) return 0.5;
    var lo = 0, hi = sortedArr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (sortedArr[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo / sortedArr.length;
  }

  function grade(score) {
    if (score >= 90) return "A";
    if (score >= 80) return "A-";
    if (score >= 73) return "B+";
    if (score >= 66) return "B";
    if (score >= 60) return "B-";
    if (score >= 53) return "C+";
    if (score >= 46) return "C";
    if (score >= 40) return "C-";
    if (score >= 33) return "D+";
    if (score >= 25) return "D";
    return "F";
  }

  // ---- Context (compute once for the whole dataset) -------------------------

  function buildContext(fc) {
    var feats = (fc && fc.features) || [];
    var prices = [], appr = [], lots = [], crime = [], school = [], land = [];
    var byCounty = {}; // county -> array of prices

    feats.forEach(function (f) {
      var p = f.properties || {};
      if (p.price != null) prices.push(p.price);
      if (p.price_change_1yr != null) appr.push(p.price_change_1yr);
      if (p.median_lot_size_sqft != null) lots.push(p.median_lot_size_sqft);
      if (p.crime_index != null) crime.push(p.crime_index);
      if (p.school_score != null) school.push(p.school_score);
      if (p.land_area_sqmi != null && p.land_area_sqmi > 0) land.push(p.land_area_sqmi);
      if (p.county) {
        (byCounty[p.county] = byCounty[p.county] || []).push(p.price);
      }
    });

    function sortNum(a) { return a.slice().sort(function (x, y) { return x - y; }); }
    function median(a) {
      if (!a.length) return null;
      var s = sortNum(a);
      var m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    var countyMedian = {};
    Object.keys(byCounty).forEach(function (c) {
      countyMedian[c] = median(byCounty[c]);
    });

    return {
      n: feats.length,
      prices: sortNum(prices),
      appr: sortNum(appr),
      lots: sortNum(lots),
      crime: sortNum(crime),
      school: sortNum(school),
      land: sortNum(land),
      countyMedian: countyMedian,
      stateMedianPrice: median(prices),
    };
  }

  // ---- Section builders -----------------------------------------------------
  // Each returns: { id, title, score, grade, summary, facts[], provenance }

  function fact(label, value, note) {
    return { label: label, value: value, note: note || "" };
  }
  function money(n) {
    if (n == null) return "—";
    return "$" + Math.round(n).toLocaleString();
  }

  // 1. Good place to raise a kid?
  function sectionKids(p, ctx) {
    var schoolNorm = clamp01((p.school_score || 0) / 10);        // 0..1
    var safetyNorm = clamp01(1 - (p.crime_index || 0) / 100);    // 0..1
    var spaceNorm = pctRank(ctx.lots, p.median_lot_size_sqft);   // room to grow
    // Blend: schools & safety dominate, space is a modest bonus.
    var s = 100 * (0.45 * schoolNorm + 0.40 * safetyNorm + 0.15 * spaceNorm);
    s = clamp100(s);
    var summary;
    if (s >= 75) summary = "Strong for families — good schools and a safe feel with room to grow.";
    else if (s >= 55) summary = "Reasonable for families, with some trade-offs between schools, safety, or space.";
    else summary = "Below-average for raising kids here on schools/safety/space signals.";
    // Schools are now REAL (CAASPP via ca_school_finder); crime/space still modeled.
    var schoolReal = (p.provenance && p.provenance.school_score === "caaspp");
    var schoolNote = schoolReal ? "CAASPP (real)" : "modeled";
    return {
      id: "kids",
      title: "1. Good place to raise a kid?",
      score: round1(s),
      grade: grade(s),
      summary: summary,
      provenance: schoolReal ? "mixed" : "modeled", // schools real, crime/space modeled
      facts: [
        fact("School score", (p.school_score != null ? p.school_score + " / 10" : "—"), schoolNote),
        fact("Safety (from crime index)", Math.round(safetyNorm * 100) + " / 100"),
        fact("Lot size vs CA", Math.round(spaceNorm * 100) + "th percentile",
          (p.median_lot_size_sqft != null ? p.median_lot_size_sqft.toLocaleString() + " sqft" : "")),
      ],
    };
  }

  // 2. How safe really?
  function sectionSafety(p, ctx) {
    var safetyNorm = clamp01(1 - (p.crime_index || 0) / 100);
    // Relative: safer than what % of CA ZIPs? (lower crime_index = safer)
    var saferThan = 1 - pctRank(ctx.crime, p.crime_index);
    var s = clamp100(100 * (0.6 * safetyNorm + 0.4 * saferThan));
    var summary;
    if (s >= 75) summary = "Feels safe — low crime relative to the rest of California.";
    else if (s >= 55) summary = "About average safety for California.";
    else summary = "Safety is a concern — crime signals are worse than most CA ZIPs.";
    return {
      id: "safety",
      title: "2. How safe is it really?",
      score: round1(s),
      grade: grade(s),
      summary: summary,
      provenance: "modeled",
      facts: [
        fact("Crime index", (p.crime_index != null ? p.crime_index + " (lower is safer)" : "—")),
        fact("Safer than", Math.round(saferThan * 100) + "% of CA ZIPs"),
      ],
    };
  }

  // 3. Are we getting good housing value?
  function sectionValue(p, ctx) {
    var countyMed = ctx.countyMedian[p.county];
    var ratio = countyMed && p.price ? p.price / countyMed : null; // <1 = cheaper than county
    // Cheaper-than-county => better *value*. Map ratio 0.6..1.4 -> 100..0.
    var valueFromRatio = ratio != null ? clamp01((1.4 - ratio) / 0.8) : 0.5;
    // Healthy appreciation is good, but runaway (overheated) or negative is not.
    var apprPct = pctRank(ctx.appr, p.price_change_1yr); // where it sits statewide
    // Reward moderate-to-strong, mild penalty for extreme top (bubble risk).
    var apprScore = apprPct <= 0.85 ? apprPct / 0.85 : 1 - (apprPct - 0.85) / 0.15 * 0.4;
    var s = clamp100(100 * (0.7 * valueFromRatio + 0.3 * clamp01(apprScore)));
    var summary;
    if (ratio == null) summary = "Not enough county context to judge value.";
    else if (ratio < 0.9) summary = "Good value — priced below the county median.";
    else if (ratio <= 1.1) summary = "Fairly priced relative to the county.";
    else summary = "Pricey — a premium over the county median; make sure it's justified.";
    return {
      id: "value",
      title: "3. Are we getting good housing value?",
      score: round1(s),
      grade: grade(s),
      summary: summary,
      provenance: "real", // price + appreciation are Zillow (real)
      facts: [
        fact("Median home value", money(p.price)),
        fact("County median", money(countyMed), p.county ? p.county + " County" : ""),
        fact("Vs county", ratio != null ? Math.round(ratio * 100) + "% of county median" : "—"),
        fact("1-yr price change", (p.price_change_1yr != null ? p.price_change_1yr + "%" : "—")),
      ],
    };
  }

  // 4. What environment / geographic risks exist?
  // P1 heuristic (badged modeled): coastal proximity -> flood/sea-level;
  // low-density / large-area ZIPs -> wildfire (WUI) proxy. Real feeds (FEMA,
  // CalFire FHSZ, USGS faults) slot in later without UI changes.
  function sectionRisk(p, ctx) {
    // Coastal proxy: CA coastline runs roughly along lon >= -124.5; a ZIP is
    // "coastal-ish" when far west for its latitude. Very rough.
    var coastal = p.lon != null && p.lon > -122.6 && p.lat != null && p.lat < 38.5 ? 0.5 : 0.2;
    if (p.lon != null && p.lon > -118.2 && p.lat != null && p.lat < 34.2) coastal = 0.6; // LA/OC coast
    // Wildfire proxy: bigger, lower-density ZIPs (more WUI) => higher risk.
    var areaPct = pctRank(ctx.land, p.land_area_sqmi); // large area => rural
    var wildfire = clamp01(0.2 + 0.7 * areaPct);
    // Earthquake: essentially all of CA has some risk; flat baseline.
    var quake = 0.5;
    // Combine into a risk level 0..1 (higher = more risk), then invert to score.
    var risk = clamp01(0.4 * wildfire + 0.35 * coastal + 0.25 * quake);
    var s = clamp100(100 * (1 - risk));
    var flags = [];
    if (wildfire > 0.6) flags.push("elevated wildfire (rural/WUI) exposure");
    if (coastal > 0.5) flags.push("coastal flood / sea-level exposure");
    flags.push("California seismic (earthquake) baseline");
    var summary = "Estimated geographic risk is " +
      (risk < 0.35 ? "relatively low" : risk < 0.6 ? "moderate" : "high") +
      ". Verify with FEMA flood maps and CalFire fire-hazard zones before buying.";
    return {
      id: "risk",
      title: "4. What environment / geographic risks exist?",
      score: round1(s),
      grade: grade(s),
      summary: summary,
      provenance: "modeled",
      facts: [
        fact("Wildfire proxy", Math.round(wildfire * 100) + " / 100", "from ZIP size/density"),
        fact("Coastal/flood proxy", Math.round(coastal * 100) + " / 100"),
        fact("Seismic", "statewide baseline"),
        fact("Key risks", flags.join("; ")),
      ],
    };
  }

  // 5. How desirable over 10–20 years?
  function sectionDesirability(p, ctx) {
    var apprPct = pctRank(ctx.appr, p.price_change_1yr);   // momentum
    var schoolNorm = clamp01((p.school_score || 0) / 10);  // school trajectory proxy
    var safetyNorm = clamp01(1 - (p.crime_index || 0) / 100);
    var pricePct = pctRank(ctx.prices, p.price);           // desirable areas hold value
    var s = clamp100(100 * (0.35 * apprPct + 0.25 * schoolNorm + 0.20 * safetyNorm + 0.20 * pricePct));
    var summary;
    if (s >= 72) summary = "Looks durable — momentum, schools, and price signals suggest lasting demand.";
    else if (s >= 52) summary = "Mixed long-term outlook; depends on schools/jobs trends holding up.";
    else summary = "Weaker long-term signals; upside over 10–20 yrs is less clear.";
    return {
      id: "desirability",
      title: "5. How desirable over 10–20 years?",
      score: round1(s),
      grade: grade(s),
      summary: summary,
      provenance: "mixed",
      facts: [
        fact("Price momentum", Math.round(apprPct * 100) + "th percentile (CA)"),
        fact("Price level", Math.round(pricePct * 100) + "th percentile (CA)"),
        fact("Schools", (p.school_score != null ? p.school_score + " / 10" : "—"),
          (p.provenance && p.provenance.school_score === "caaspp") ? "CAASPP (real)" : "modeled"),
      ],
    };
  }

  // 6. Commute, restaurants, parks, shopping, airport?
  // P1: real nearest-airport distance; urbanization/amenity proxy from price +
  // density (POIs/Walk Score come later).
  function sectionLifestyle(p, ctx) {
    // Nearest major airport (real).
    var nearestAir = null, nearestD = Infinity;
    if (p.lat != null && p.lon != null) {
      for (var i = 0; i < AIRPORTS.length; i++) {
        var d = haversineMiles(p.lat, p.lon, AIRPORTS[i][1], AIRPORTS[i][2]);
        if (d < nearestD) { nearestD = d; nearestAir = AIRPORTS[i][0]; }
      }
    }
    // Airport convenience: <=10mi great .. >=60mi poor.
    var airScore = isFinite(nearestD) ? clamp01((60 - nearestD) / 50) : 0.5;
    // Urbanization/amenity proxy: pricier + denser (small land area) ZIPs tend
    // to have more restaurants/shopping/transit. (Badged modeled.)
    var pricePct = pctRank(ctx.prices, p.price);
    var densityPct = 1 - pctRank(ctx.land, p.land_area_sqmi); // small area => urban
    var amenityProxy = clamp01(0.5 * pricePct + 0.5 * densityPct);
    var s = clamp100(100 * (0.4 * airScore + 0.6 * amenityProxy));
    var summary = (isFinite(nearestD)
      ? "Nearest major airport ~" + Math.round(nearestD) + " mi. "
      : "") +
      (amenityProxy > 0.66 ? "Urban feel — likely rich in dining, shopping, and transit."
        : amenityProxy > 0.4 ? "Suburban amenity level — a car helps."
          : "More rural/remote — fewer walkable amenities.");
    return {
      id: "lifestyle",
      title: "6. Commute, restaurants, parks, shopping, airport?",
      score: round1(s),
      grade: grade(s),
      summary: summary,
      provenance: "mixed", // airport real; amenities modeled
      facts: [
        fact("Nearest major airport", nearestAir || "—",
          isFinite(nearestD) ? "~" + Math.round(nearestD) + " mi" : ""),
        fact("Urbanization/amenity proxy", Math.round(amenityProxy * 100) + " / 100"),
      ],
    };
  }

  // 7. Why should we NOT buy here? (derived from weakest sections + red flags)
  function sectionWhyNot(p, sections) {
    var reasons = [];
    // Weakest sub-scores.
    var ranked = sections.slice().sort(function (a, b) { return a.score - b.score; });
    ranked.slice(0, 3).forEach(function (sec) {
      if (sec.score < 60) {
        reasons.push(sec.title.replace(/^\d+\.\s*/, "").replace(/\?$/, "") +
          " scores only " + sec.score + " (" + sec.grade + ").");
      }
    });
    // Hard red flags.
    if (p.crime_index != null && p.crime_index >= 55) reasons.push("Crime index is high (" + p.crime_index + ").");
    if (p.school_score != null && p.school_score < 5) reasons.push("Schools are below average (" + p.school_score + "/10).");
    if (p.price_change_1yr != null && p.price_change_1yr < 0) reasons.push("Home values fell " + Math.abs(p.price_change_1yr) + "% over the last year.");
    var riskSec = sections.filter(function (s) { return s.id === "risk"; })[0];
    if (riskSec && riskSec.score < 50) reasons.push("Elevated environmental/geographic risk.");
    if (!reasons.length) reasons.push("No major red flags surfaced from available signals — still verify schools, crime, and hazard maps in person.");
    return {
      id: "whynot",
      title: "7. Why should we NOT buy here?",
      score: null,
      grade: null,
      summary: "Honest caveats before you commit:",
      provenance: "mixed",
      facts: reasons.map(function (r) { return fact("⚠", r); }),
    };
  }

  // ---- Verdict roll-up ------------------------------------------------------

  function buildVerdict(sections, weights) {
    weights = weights || DEFAULT_WEIGHTS;
    var sum = 0, wsum = 0;
    sections.forEach(function (sec) {
      if (sec.score == null) return;
      var w = weights[sec.id];
      if (w == null) return;
      sum += w * sec.score;
      wsum += w;
    });
    var overall = wsum > 0 ? sum / wsum : 0;
    var label, tone;
    if (overall >= 70) { label = "BUY"; tone = "buy"; }
    else if (overall >= 50) { label = "CONSIDER"; tone = "consider"; }
    else { label = "AVOID"; tone = "avoid"; }
    return { overall: round1(overall), grade: grade(overall), label: label, tone: tone };
  }

  // ---- Public entry ---------------------------------------------------------

  function buildReport(p, ctx, weights) {
    var sections = [
      sectionKids(p, ctx),
      sectionSafety(p, ctx),
      sectionValue(p, ctx),
      sectionRisk(p, ctx),
      sectionDesirability(p, ctx),
      sectionLifestyle(p, ctx),
    ];
    var whyNot = sectionWhyNot(p, sections);
    var verdict = buildVerdict(sections, weights);
    return {
      zip: p.zip,
      city: p.city || "",
      county: p.county || "",
      sections: sections.concat([whyNot]),
      verdict: verdict,
    };
  }

  window.ZoneReport = {
    buildContext: buildContext,
    buildReport: buildReport,
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    _grade: grade,
  };
})();
