/*
 * app.js — self-contained classic script (works from file:// by double-click
 * AND from a web server). Data comes from window.ZONES (loaded via zones.js);
 * if that's missing it falls back to fetch("zones.json") when served over HTTP.
 *
 * Extensibility (kept simple, no build step):
 *   - window.ZoneFinder.registerDetailProvider(fn) : add on-click detail fields
 *   - window.ZoneFinder.weights                    : adjust scoring weights
 *   - scoring lives in scoreZone()/normalizedMetrics() below
 * The modular versions in dataSources.js / scoring.js remain as reference for a
 * future bundler-based setup.
 */
(function () {
  "use strict";

  var DEFAULT_ZIP = "95131";
  var DEFAULT_RADIUS_MI = 8;

  // ---- Public extension surface --------------------------------------------
  var DetailProviders = [];
  window.ZoneFinder = {
    weights: { school: 0.5, safety: 0.5 },
    registerDetailProvider: function (fn) {
      DetailProviders.push(fn);
    },
  };

  // ---- Scoring (edit here to change criteria) ------------------------------
  function clamp01(x) {
    if (isNaN(x)) return 0;
    return Math.max(0, Math.min(1, x));
  }
  function normalizedMetrics(p) {
    return {
      school: clamp01((p.school_score || 0) / 10),
      safety: clamp01(1 - (p.crime_index || 0) / 100),
    };
  }
  function scoreZone(p) {
    var w = window.ZoneFinder.weights;
    var m = normalizedMetrics(p);
    var sum = 0,
      wsum = 0;
    for (var k in w) {
      if (m[k] == null) continue;
      sum += w[k] * m[k];
      wsum += w[k];
    }
    var s = wsum > 0 ? sum / wsum : 0;
    return Math.round(s * 1000) / 10;
  }
  function scoreColor(score) {
    var t = clamp01(score / 100);
    return "hsl(" + t * 120 + ", 70%, 45%)";
  }

  // ---- State ----------------------------------------------------------------
  var state = {
    fc: null,
    byZip: {},
    layer: null,
    selected: null,
  };

  // ---- Map ------------------------------------------------------------------
  var map = L.map("map", { zoomControl: true }).setView([37.35, -121.9], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  // ---- Helpers --------------------------------------------------------------
  function haversineMiles(a, b) {
    var R = 3958.8;
    var dLat = ((b[0] - a[0]) * Math.PI) / 180;
    var dLon = ((b[1] - a[1]) * Math.PI) / 180;
    var lat1 = (a[0] * Math.PI) / 180;
    var lat2 = (b[0] * Math.PI) / 180;
    var h =
      Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtMoney(n) {
    if (n == null) return "—";
    return "$" + Math.round(n).toLocaleString();
  }
  function provBadge(prov) {
    if (prov === "modeled")
      return '<span class="badge modeled" title="Placeholder value, not a real feed yet">modeled</span>';
    return '<span class="badge real" title="Real public dataset">real</span>';
  }

  // ---- Rendering ------------------------------------------------------------
  function styleFor(feature) {
    var s = scoreZone(feature.properties);
    var isSel = state.selected === feature.properties.zip;
    return {
      color: isSel ? "#111" : "#555",
      weight: isSel ? 3 : 1,
      fillColor: scoreColor(s),
      fillOpacity: 0.55,
    };
  }

  function renderZonesNear(center, radiusMi) {
    if (state.layer) {
      map.removeLayer(state.layer);
      state.layer = null;
    }
    var feats = state.fc.features.filter(function (f) {
      var p = f.properties;
      if (p.lat == null || p.lon == null) return false;
      return haversineMiles(center, [p.lat, p.lon]) <= radiusMi;
    });

    state.layer = L.geoJSON(
      { type: "FeatureCollection", features: feats },
      {
        style: styleFor,
        onEachFeature: function (feature, layer) {
          var p = feature.properties;
          var s = scoreZone(p);
          layer.bindTooltip(
            p.zip + " — " + p.city + "<br>Score " + s + " · " + fmtMoney(p.price),
            { sticky: true }
          );
          layer.on("click", function () {
            selectZone(p.zip);
          });
        },
      }
    ).addTo(map);

    updateResultsList(feats);
    return feats.length;
  }

  function updateResultsList(feats) {
    var ranked = feats.slice().sort(function (a, b) {
      return scoreZone(b.properties) - scoreZone(a.properties);
    });
    var el = document.getElementById("results");
    var html =
      '<div class="results-head">' +
      feats.length +
      " zones in view — ranked by score</div>";
    html += ranked
      .slice(0, 50)
      .map(function (f) {
        var p = f.properties;
        var s = scoreZone(p);
        return (
          '<div class="result-row" data-zip="' +
          p.zip +
          '">' +
          '<span class="dot" style="background:' +
          scoreColor(s) +
          '"></span>' +
          '<span class="rz-zip">' +
          p.zip +
          "</span>" +
          '<span class="rz-city">' +
          p.city +
          "</span>" +
          '<span class="rz-score">' +
          s +
          "</span>" +
          "</div>"
        );
      })
      .join("");
    el.innerHTML = html;
    var rows = el.querySelectorAll(".result-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var zip = this.getAttribute("data-zip");
        var f = state.byZip[zip];
        if (f && f.properties.lat != null) {
          map.setView([f.properties.lat, f.properties.lon], 13);
        }
        selectZone(zip);
      });
    }
  }

  function metricRow(label, value, prov) {
    return (
      '<div class="metric"><span class="m-label">' +
      label +
      " " +
      provBadge(prov) +
      '</span><span class="m-value">' +
      value +
      "</span></div>"
    );
  }
  function bar(label, v) {
    var pct = Math.round((v || 0) * 100);
    return (
      '<div class="bar-wrap"><span class="bar-label">' +
      label +
      '</span><div class="bar"><div class="bar-fill" style="width:' +
      pct +
      '%"></div></div><span class="bar-pct">' +
      pct +
      "</span></div>"
    );
  }

  function selectZone(zip) {
    state.selected = zip;
    if (state.layer) state.layer.setStyle(styleFor);
    var f = state.byZip[zip];
    if (!f) return;
    var p = f.properties;
    var s = scoreZone(p);
    var m = normalizedMetrics(p);

    // Run any registered detail providers (sync or promise-returning).
    Promise.all(
      DetailProviders.map(function (fn) {
        try {
          return Promise.resolve(fn(p));
        } catch (e) {
          console.warn(e);
          return Promise.resolve({});
        }
      })
    ).then(function (results) {
      var extra = {};
      results.forEach(function (r) {
        if (r) Object.assign(extra, r);
      });
      renderDetail(p, s, m, extra);
    });
  }

  function renderDetail(p, s, m, extra) {
    var extraRows = Object.keys(extra || {})
      .map(function (k) {
        return metricRow(k, String(extra[k]), "modeled");
      })
      .join("");
    var panel = document.getElementById("detail");
    panel.innerHTML =
      '<div class="detail-head"><h2>' +
      p.zip +
      " <small>" +
      p.city +
      ", " +
      p.county +
      ' County</small></h2><div class="score-pill" style="background:' +
      scoreColor(s) +
      '">' +
      s +
      "</div></div>" +
      '<div class="metrics">' +
      metricRow("School score", p.school_score + " / 10", p.provenance.school_score) +
      metricRow("Crime index", p.crime_index + " (lower is safer)", p.provenance.crime_index) +
      metricRow("Median home value", fmtMoney(p.price), p.provenance.price) +
      metricRow(
        "1-yr price change",
        p.price_change_1yr != null ? p.price_change_1yr + "%" : "—",
        p.provenance.price_change_1yr
      ) +
      metricRow(
        "Median lot size",
        p.median_lot_size_sqft.toLocaleString() + " sqft",
        p.provenance.median_lot_size_sqft
      ) +
      metricRow("ZIP land area", p.land_area_sqmi + " sq mi", p.provenance.land_area_sqmi) +
      extraRows +
      "</div>" +
      '<div class="bars">' +
      bar("Schools", m.school) +
      bar("Safety", m.safety) +
      "</div>" +
      '<p class="note">Fields badged <span class="badge real">real</span> come ' +
      "from Zillow / US Census. <span class=\"badge modeled\">modeled</span> " +
      "fields are placeholders until a live feed is connected.</p>";
    panel.classList.add("visible");
  }

  // ---- Search ---------------------------------------------------------------
  function goToZip(zip) {
    var f = state.byZip[zip];
    var status = document.getElementById("status");
    if (!f || f.properties.lat == null) {
      status.textContent = "ZIP " + zip + " not found in dataset.";
      return;
    }
    status.textContent = "";
    var center = [f.properties.lat, f.properties.lon];
    map.setView(center, 12);
    var radius = Number(document.getElementById("radius").value) || DEFAULT_RADIUS_MI;
    var n = renderZonesNear(center, radius);
    status.textContent = "Showing " + n + " zones within " + radius + " mi of " + zip + ".";
    selectZone(zip);
  }

  // ---- Data loading (global first, fetch fallback) --------------------------
  function withData(fc) {
    state.fc = fc;
    state.byZip = {};
    for (var i = 0; i < fc.features.length; i++) {
      state.byZip[fc.features[i].properties.zip] = fc.features[i];
    }
    document.getElementById("status").textContent =
      "Loaded " + fc.features.length + " CA zones.";

    document.getElementById("zip").value = DEFAULT_ZIP;
    document.getElementById("radius").value = DEFAULT_RADIUS_MI;

    document.getElementById("searchForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var zip = padZip(document.getElementById("zip").value);
      goToZip(zip);
    });
    document.getElementById("radius").addEventListener("change", function () {
      goToZip(padZip(document.getElementById("zip").value));
    });

    goToZip(DEFAULT_ZIP);
  }

  function padZip(v) {
    v = (v || "").trim();
    while (v.length < 5) v = "0" + v;
    return v;
  }

  function init() {
    var status = document.getElementById("status");
    if (window.ZONES && window.ZONES.features) {
      withData(window.ZONES);
      return;
    }
    // Fallback for HTTP serving without zones.js
    status.textContent = "Loading California zone data…";
    fetch("zones.json")
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(withData)
      .catch(function (e) {
        status.textContent =
          "Could not load data (" +
          e.message +
          "). If you opened the file directly, make sure zones.js is present next to index.html.";
      });
  }

  init();
})();
