/*
 * app.js — self-contained classic script (works from file:// AND over HTTP).
 *
 * Two granularity levels:
 *   - ZIP zones            (window.ZONES / zones.js)
 *   - Neighborhood zones   (window.NEIGHBORHOODS / neighborhoods.js)
 * Toggle with the Level buttons. Search always centers by ZIP centroid, then
 * filters the chosen level by radius.
 *
 * Extensibility:
 *   - window.ZoneFinder.registerDetailProvider(fn)  add on-click detail fields
 *   - window.ZoneFinder.weights                     adjust scoring weights
 */
(function () {
  "use strict";

  var DEFAULT_ZIP = "95131";
  var DEFAULT_RADIUS_MI = 8;

  var DetailProviders = [];
  window.ZoneFinder = {
    weights: { school: 0.5, safety: 0.5 },
    registerDetailProvider: function (fn) {
      DetailProviders.push(fn);
    },
  };

  // ---- Scoring --------------------------------------------------------------
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
    var sum = 0, wsum = 0;
    for (var k in w) {
      if (m[k] == null) continue;
      sum += w[k] * m[k];
      wsum += w[k];
    }
    var s = wsum > 0 ? sum / wsum : 0;
    return Math.round(s * 1000) / 10;
  }
  function scoreColor(score) {
    return "hsl(" + clamp01(score / 100) * 120 + ", 70%, 45%)";
  }

  // ---- Generic id/label -----------------------------------------------------
  function getId(p) {
    return p.id ? p.id : "Z:" + p.zip;
  }
  function getLabel(p) {
    return p.zip ? p.zip : p.name;
  }

  // ---- State ----------------------------------------------------------------
  var state = {
    datasets: { zip: null, hood: null },
    level: "zip",
    fc: null, // current dataset
    reportCtx: null, // precomputed statewide stats for the buyer report
    zipByZip: {}, // ZIP -> feature (for centering, always from ZIP set)
    byId: {}, // id -> feature (current dataset)
    layer: null,
    selected: null,
    lastFeats: [],
    lastCenter: null,
    view: "map",
    sortKey: "score",
    sortDir: -1,
  };

  // ---- Map ------------------------------------------------------------------
  var map = L.map("map", { zoomControl: true }).setView([37.35, -121.9], 11);
  var baseLayer = null;
  function addBasemap() {
    if (baseLayer) return;
    baseLayer = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      { maxZoom: 19, subdomains: "abcd", attribution: "&copy; OpenStreetMap contributors &copy; CARTO" }
    );
    baseLayer.addTo(map);
  }
  function removeBasemap() {
    if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
  }
  addBasemap();

  // ---- Helpers --------------------------------------------------------------
  function haversineMiles(a, b) {
    var R = 3958.8;
    var dLat = ((b[0] - a[0]) * Math.PI) / 180;
    var dLon = ((b[1] - a[1]) * Math.PI) / 180;
    var lat1 = (a[0] * Math.PI) / 180;
    var lat2 = (b[0] * Math.PI) / 180;
    var h = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtMoney(n) {
    if (n == null) return "—";
    return "$" + Math.round(n).toLocaleString();
  }
  function provBadge(prov) {
    if (!prov || prov === "modeled")
      return '<span class="badge modeled" title="Placeholder value">modeled</span>';
    return '<span class="badge real" title="' + prov + '">real</span>';
  }

  // ---- Rendering ------------------------------------------------------------
  function styleFor(feature) {
    var s = scoreZone(feature.properties);
    var isSel = state.selected === getId(feature.properties);
    return {
      color: isSel ? "#111" : "#555",
      weight: isSel ? 3 : 1,
      fillColor: scoreColor(s),
      fillOpacity: 0.55,
    };
  }

  function renderZonesNear(center, radiusMi) {
    if (state.layer) { map.removeLayer(state.layer); state.layer = null; }
    var feats = state.fc.features.filter(function (f) {
      var p = f.properties;
      if (p.lat == null || p.lon == null) return false;
      return haversineMiles(center, [p.lat, p.lon]) <= radiusMi;
    });
    state.byId = {};
    feats.forEach(function (f) { state.byId[getId(f.properties)] = f; });

    state.layer = L.geoJSON(
      { type: "FeatureCollection", features: feats },
      {
        style: styleFor,
        onEachFeature: function (feature, layer) {
          var p = feature.properties;
          var s = scoreZone(p);
          layer.bindTooltip(
            getLabel(p) + " — " + (p.city || "") + "<br>Score " + s + " · " + fmtMoney(p.price),
            { sticky: true }
          );
          layer.on("click", function () { selectZone(getId(p)); });
        },
      }
    ).addTo(map);

    state.lastFeats = feats;
    updateResultsList(feats);
    renderTable(feats);
    return feats.length;
  }

  // ---- Table view -----------------------------------------------------------
  var COLUMNS = [
    { key: "label", label: "Zone", num: false, get: getLabel },
    { key: "city", label: "City", num: false },
    { key: "county", label: "County", num: false },
    { key: "score", label: "Score", num: true, get: scoreZone },
    { key: "school_score", label: "School", num: true },
    { key: "crime_index", label: "Crime", num: true },
    { key: "price", label: "Home value", num: true },
    { key: "price_change_1yr", label: "1-yr %", num: true },
    { key: "median_lot_size_sqft", label: "Lot (sqft)", num: true },
  ];

  function cellVal(p, col) {
    if (col.get) return col.get(p);
    return p[col.key];
  }

  function renderTable(feats) {
    var thead = document.querySelector("#zoneTable thead");
    var tbody = document.querySelector("#zoneTable tbody");
    var firstLabel = state.level === "hood" ? "Neighborhood" : "ZIP";

    thead.innerHTML = "<tr>" + COLUMNS.map(function (c) {
      var lbl = c.key === "label" ? firstLabel : c.label;
      var arrow = state.sortKey === c.key ? (state.sortDir === -1 ? " ▼" : " ▲") : "";
      return '<th data-key="' + c.key + '">' + lbl + arrow + "</th>";
    }).join("") + "</tr>";

    var ths = thead.querySelectorAll("th");
    for (var i = 0; i < ths.length; i++) {
      ths[i].addEventListener("click", function () {
        var k = this.getAttribute("data-key");
        if (state.sortKey === k) state.sortDir *= -1;
        else { state.sortKey = k; state.sortDir = -1; }
        renderTable(state.lastFeats);
      });
    }

    var col = COLUMNS.filter(function (c) { return c.key === state.sortKey; })[0] || COLUMNS[3];
    var rows = feats.slice().sort(function (a, b) {
      var va = cellVal(a.properties, col), vb = cellVal(b.properties, col);
      if (col.num) {
        va = va == null ? -Infinity : va;
        vb = vb == null ? -Infinity : vb;
        return (va - vb) * state.sortDir;
      }
      va = (va || "").toString().toLowerCase();
      vb = (vb || "").toString().toLowerCase();
      return va < vb ? -state.sortDir : va > vb ? state.sortDir : 0;
    });

    tbody.innerHTML = rows.map(function (f) {
      var p = f.properties;
      var s = scoreZone(p);
      var sel = state.selected === getId(p) ? ' class="selected"' : "";
      return "<tr data-id=\"" + getId(p) + "\"" + sel + ">" +
        "<td><span class=\"cell-dot\" style=\"background:" + scoreColor(s) + "\"></span>" + getLabel(p) + "</td>" +
        "<td>" + (p.city || "") + "</td>" +
        "<td>" + (p.county || "") + "</td>" +
        "<td class=\"td-score\">" + s + "</td>" +
        "<td>" + p.school_score + "</td>" +
        "<td>" + p.crime_index + "</td>" +
        "<td>" + fmtMoney(p.price) + "</td>" +
        "<td>" + (p.price_change_1yr != null ? p.price_change_1yr + "%" : "—") + "</td>" +
        "<td>" + (p.median_lot_size_sqft != null ? p.median_lot_size_sqft.toLocaleString() : "—") + "</td>" +
        "</tr>";
    }).join("");

    var trs = tbody.querySelectorAll("tr");
    for (var j = 0; j < trs.length; j++) {
      trs[j].addEventListener("click", function () {
        selectZone(this.getAttribute("data-id"));
      });
    }
  }

  function updateResultsList(feats) {
    var ranked = feats.slice().sort(function (a, b) {
      return scoreZone(b.properties) - scoreZone(a.properties);
    });
    var el = document.getElementById("results");
    var html = '<div class="results-head">' + feats.length + " zones in view — ranked by score</div>";
    html += ranked.slice(0, 60).map(function (f) {
      var p = f.properties;
      var s = scoreZone(p);
      return '<div class="result-row" data-id="' + getId(p) + '">' +
        '<span class="dot" style="background:' + scoreColor(s) + '"></span>' +
        '<span class="rz-zip">' + getLabel(p) + "</span>" +
        '<span class="rz-city">' + (p.city || "") + "</span>" +
        '<span class="rz-score">' + s + "</span>" +
        "</div>";
    }).join("");
    el.innerHTML = html;
    var rows = el.querySelectorAll(".result-row");
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener("click", function () {
        var id = this.getAttribute("data-id");
        var f = state.byId[id];
        if (f && f.properties.lat != null) map.setView([f.properties.lat, f.properties.lon], 13);
        selectZone(id);
      });
    }
  }

  function metricRow(label, value, prov) {
    return '<div class="metric"><span class="m-label">' + label + " " + provBadge(prov) +
      '</span><span class="m-value">' + value + "</span></div>";
  }
  function bar(label, v) {
    var pct = Math.round((v || 0) * 100);
    return '<div class="bar-wrap"><span class="bar-label">' + label +
      '</span><div class="bar"><div class="bar-fill" style="width:' + pct +
      '%"></div></div><span class="bar-pct">' + pct + "</span></div>";
  }

  function setView(view) {
    state.view = view;
    var mapEl = document.getElementById("map");
    var tableEl = document.getElementById("tableWrap");
    var btnMap = document.getElementById("btnMap");
    var btnTable = document.getElementById("btnTable");
    if (view === "table") {
      mapEl.classList.add("hidden");
      tableEl.classList.remove("hidden");
      btnTable.classList.add("active");
      btnMap.classList.remove("active");
      renderTable(state.lastFeats);
    } else {
      tableEl.classList.add("hidden");
      mapEl.classList.remove("hidden");
      btnMap.classList.add("active");
      btnTable.classList.remove("active");
      setTimeout(function () { map.invalidateSize(); }, 0);
    }
  }

  function setLevel(level) {
    state.level = level;
    state.fc = state.datasets[level];
    document.getElementById("btnZip").classList.toggle("active", level === "zip");
    document.getElementById("btnHood").classList.toggle("active", level === "hood");
    // Re-render around the last center (or default ZIP).
    var zip = padZip(document.getElementById("zip").value);
    goToZip(zip);
  }

  function selectZone(id) {
    state.selected = id;
    if (state.layer) state.layer.setStyle(styleFor);
    if (state.view === "table") renderTable(state.lastFeats);
    var f = state.byId[id];
    if (!f) return;
    var p = f.properties;
    var s = scoreZone(p);
    var m = normalizedMetrics(p);
    Promise.all(DetailProviders.map(function (fn) {
      try { return Promise.resolve(fn(p)); } catch (e) { console.warn(e); return Promise.resolve({}); }
    })).then(function (results) {
      var extra = {};
      results.forEach(function (r) { if (r) Object.assign(extra, r); });
      renderDetail(p, s, m, extra);
    });
  }

  function renderDetail(p, s, m, extra) {
    var extraRows = Object.keys(extra || {}).map(function (k) {
      return metricRow(k, String(extra[k]), "modeled");
    }).join("");
    var prov = p.provenance || {};
    var sub = (p.city || "") + (p.county ? ", " + p.county + " County" : "");
    var landRow = p.land_area_sqmi != null
      ? metricRow("ZIP land area", p.land_area_sqmi + " sq mi", prov.land_area_sqmi)
      : "";
    var panel = document.getElementById("detail");
    panel.innerHTML =
      '<div class="detail-head"><h2>' + getLabel(p) + " <small>" + sub +
      '</small></h2><div class="score-pill" style="background:' + scoreColor(s) + '">' + s + "</div></div>" +
      '<div class="metrics">' +
      metricRow("School score", p.school_score + " / 10", prov.school_score) +
      metricRow("Crime index", p.crime_index + " (lower is safer)", prov.crime_index) +
      metricRow("Median home value", fmtMoney(p.price), prov.price) +
      metricRow("1-yr price change", p.price_change_1yr != null ? p.price_change_1yr + "%" : "—", prov.price_change_1yr) +
      metricRow("Median lot size", p.median_lot_size_sqft != null ? p.median_lot_size_sqft.toLocaleString() + " sqft" : "—", prov.median_lot_size_sqft) +
      landRow +
      extraRows +
      "</div>" +
      '<div class="bars">' + bar("Schools", m.school) + bar("Safety", m.safety) + "</div>" +
      (p.zip
        ? '<button type="button" id="btnReport" class="report-btn">🏡 Should I buy here? — Full report</button>'
        : "") +
      '<p class="note">Badged <span class="badge real">real</span> = Zillow / Census / ' +
      "public boundaries / CAASPP school ratings. <span class=\"badge modeled\">modeled</span> = " +
      "placeholder (crime, lot size) until a live feed is connected.</p>";
    panel.classList.add("visible");
    var rb = document.getElementById("btnReport");
    if (rb) rb.addEventListener("click", function () { openReport(p); });
  }

  // ---- Buyer report (slide-in) ----------------------------------------------
  function reportProvBadge(prov) {
    if (prov === "real")
      return '<span class="badge real" title="Backed by real data">real</span>';
    if (prov === "mixed")
      return '<span class="badge mixed" title="Mix of real and placeholder">mixed</span>';
    return '<span class="badge modeled" title="Placeholder value">modeled</span>';
  }

  function openReport(p) {
    if (!window.ZoneReport) return;
    if (!state.reportCtx) state.reportCtx = window.ZoneReport.buildContext(state.datasets.zip);
    var rep = window.ZoneReport.buildReport(p, state.reportCtx, window.ZoneFinder.reportWeights);
    renderReport(rep);
    document.getElementById("reportOverlay").classList.remove("hidden");
    var panel = document.getElementById("reportPanel");
    panel.classList.remove("hidden");
    panel.setAttribute("aria-hidden", "false");
    setTimeout(function () { panel.classList.add("open"); }, 10);
  }

  function closeReport() {
    var panel = document.getElementById("reportPanel");
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    setTimeout(function () {
      panel.classList.add("hidden");
      document.getElementById("reportOverlay").classList.add("hidden");
    }, 250);
  }

  function renderReport(rep) {
    var v = rep.verdict;
    var sub = (rep.city || "") + (rep.county ? ", " + rep.county + " County" : "");
    var html =
      '<div class="report-top">' +
        '<button type="button" id="btnReportClose" class="report-close" aria-label="Close">✕</button>' +
        '<div class="report-title">🏡 ' + rep.zip + ' <small>' + sub + '</small></div>' +
        '<div class="verdict verdict-' + v.tone + '">' +
          '<div class="verdict-label">' + v.label + '</div>' +
          '<div class="verdict-score">' + v.overall + '<span>/100 · ' + v.grade + '</span></div>' +
        '</div>' +
      '</div>';

    html += '<div class="report-sections">';
    rep.sections.forEach(function (sec) {
      var isWhy = sec.id === "whynot";
      html += '<section class="rep-sec' + (isWhy ? " rep-why" : "") + '">';
      html += '<div class="rep-sec-head">';
      html += '<h3>' + sec.title + " " + reportProvBadge(sec.provenance) + "</h3>";
      if (sec.score != null) {
        html += '<span class="rep-grade" style="background:' + scoreColor(sec.score) + '">' +
          sec.score + " · " + sec.grade + "</span>";
      }
      html += "</div>";
      html += '<p class="rep-summary">' + sec.summary + "</p>";
      if (sec.facts && sec.facts.length) {
        html += '<div class="rep-facts">';
        sec.facts.forEach(function (fct) {
          html += '<div class="rep-fact"><span class="rf-label">' + fct.label + "</span>" +
            '<span class="rf-value">' + fct.value +
            (fct.note ? ' <em>' + fct.note + "</em>" : "") + "</span></div>";
        });
        html += "</div>";
      }
      html += "</section>";
    });
    html += "</div>";

    html += '<p class="report-foot">Scores blend real data (Zillow prices, Census ' +
      "boundaries, airport distances, CAASPP school ratings) with modeled placeholders " +
      "(crime, hazards) until live feeds are connected. Verify crime, FEMA flood " +
      "maps, and CalFire fire-hazard zones before buying.</p>";

    document.getElementById("reportBody").innerHTML = html;
    var c = document.getElementById("btnReportClose");
    if (c) c.addEventListener("click", closeReport);
  }

  function selectNearest(center) {
    var best = null, bestId = null, bestD = 1e18;
    state.lastFeats.forEach(function (f) {
      var p = f.properties;
      var d = haversineMiles(center, [p.lat, p.lon]);
      if (d < bestD) { bestD = d; best = f; bestId = getId(p); }
    });
    if (bestId) selectZone(bestId);
  }

  // ---- Search ---------------------------------------------------------------
  function goToZip(zip) {
    var zf = state.zipByZip[zip];
    var status = document.getElementById("status");
    if (!zf || zf.properties.lat == null) {
      status.textContent = "ZIP " + zip + " not found in dataset.";
      return;
    }
    var center = [zf.properties.lat, zf.properties.lon];
    state.lastCenter = center;
    map.setView(center, state.level === "hood" ? 12 : 12);
    var radius = Number(document.getElementById("radius").value) || DEFAULT_RADIUS_MI;
    var n = renderZonesNear(center, radius);
    var lvl = state.level === "hood" ? "neighborhoods" : "ZIP zones";
    status.textContent = "Showing " + n + " " + lvl + " within " + radius + " mi of " + zip + ".";
    if (state.level === "zip") selectZone("Z:" + zip);
    else selectNearest(center);
  }

  function padZip(v) {
    v = (v || "").trim();
    while (v.length < 5) v = "0" + v;
    return v;
  }

  // ---- Data loading ---------------------------------------------------------
  function indexZips(fc) {
    state.zipByZip = {};
    for (var i = 0; i < fc.features.length; i++) {
      state.zipByZip[fc.features[i].properties.zip] = fc.features[i];
    }
  }

  function boot() {
    state.datasets.zip = window.ZONES || { type: "FeatureCollection", features: [] };
    state.datasets.hood = window.NEIGHBORHOODS || { type: "FeatureCollection", features: [] };
    indexZips(state.datasets.zip);
    state.fc = state.datasets.zip;

    document.getElementById("status").textContent =
      "Loaded " + state.datasets.zip.features.length + " ZIP zones, " +
      state.datasets.hood.features.length + " neighborhoods.";

    document.getElementById("zip").value = DEFAULT_ZIP;
    document.getElementById("radius").value = DEFAULT_RADIUS_MI;

    document.getElementById("searchForm").addEventListener("submit", function (e) {
      e.preventDefault();
      goToZip(padZip(document.getElementById("zip").value));
    });
    document.getElementById("radius").addEventListener("change", function () {
      goToZip(padZip(document.getElementById("zip").value));
    });
    document.getElementById("btnZip").addEventListener("click", function () { setLevel("zip"); });
    document.getElementById("btnHood").addEventListener("click", function () { setLevel("hood"); });
    document.getElementById("btnMap").addEventListener("click", function () { setView("map"); });
    document.getElementById("btnTable").addEventListener("click", function () { setView("table"); });
    document.getElementById("basemap").addEventListener("change", function () {
      if (this.checked) addBasemap(); else removeBasemap();
    });
    document.getElementById("reportOverlay").addEventListener("click", closeReport);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeReport();
    });

    goToZip(DEFAULT_ZIP);
  }

  function init() {
    var status = document.getElementById("status");
    if (window.ZONES && window.ZONES.features) { boot(); return; }
    // HTTP fallback if globals not present
    status.textContent = "Loading data…";
    Promise.all([
      fetch("zones.json").then(function (r) { return r.json(); }),
      fetch("neighborhoods.json").then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]).then(function (arr) {
      window.ZONES = arr[0];
      if (arr[1]) window.NEIGHBORHOODS = arr[1];
      boot();
    }).catch(function (e) {
      status.textContent = "Could not load data (" + e.message + ").";
    });
  }

  init();
})();
