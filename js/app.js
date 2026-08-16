/* ==========================================================================
 * CA School Rating Map — app.js
 * --------------------------------------------------------------------------
 * Renders every CA public school (window.SCHOOL_POINTS) as a color-coded
 * circle on a Leaflet map.
 *   • Level filter:  Average (all) | Elementary | Middle | High
 *   • Year selector: 2025 (real) | 2026 | 2027 | 2028 (extrapolated)
 *   • Min-rating slider + text search (city / school name)
 * Mobile-friendly: canvas rendering, collapsible controls, touch targets.
 * ========================================================================== */
(function () {
  "use strict";

  var POINTS = window.SCHOOL_POINTS || [];

  var state = {
    level: "ALL",   // ALL | E | M | H
    year: "2025",   // 2025 | 2026 | 2027 | 2028
    minRate: 1,
    query: ""
  };

  var LEVEL_NAME = { E: "Elementary", M: "Middle", H: "High" };

  /* ---------- color scale (RdYlGn, 1..10) ---------- */
  var STOPS = [
    [1,  0xd7, 0x30, 0x27],
    [2,  0xf4, 0x6d, 0x43],
    [3,  0xfd, 0xae, 0x61],
    [4,  0xfe, 0xe0, 0x8b],
    [5,  0xf7, 0xf7, 0x7a],
    [6,  0xd9, 0xef, 0x8b],
    [7,  0xa6, 0xd9, 0x6a],
    [8,  0x66, 0xbd, 0x63],
    [9,  0x2d, 0xa8, 0x54],
    [10, 0x1a, 0x98, 0x50]
  ];
  function colorFor(rating) {
    var r = Math.max(1, Math.min(10, rating));
    var lo = Math.floor(r), hi = Math.ceil(r), t = r - lo;
    var a = STOPS[lo - 1], b = STOPS[hi - 1] || a;
    var cr = Math.round(a[1] + (b[1] - a[1]) * t);
    var cg = Math.round(a[2] + (b[2] - a[2]) * t);
    var cb = Math.round(a[3] + (b[3] - a[3]) * t);
    return "rgb(" + cr + "," + cg + "," + cb + ")";
  }

  /* ---------- map ---------- */
  var map = L.map("map", {
    preferCanvas: true,
    zoomControl: true,
    minZoom: 5,
    maxZoom: 18
  }).setView([37.3, -119.4], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19
  }).addTo(map);

  var canvasRenderer = L.canvas({ padding: 0.5 });
  var layer = L.layerGroup().addTo(map);

  /* ---------- rendering ---------- */
  function markerRadius() {
    var z = map.getZoom();
    if (z <= 6) return 4;
    if (z <= 8) return 5;
    if (z <= 10) return 6;
    if (z <= 12) return 7;
    return 9;
  }

  function popupHtml(s) {
    var r = s.r || {};
    var cur = r[state.year];
    var col = colorFor(cur);
    var lvl = LEVEL_NAME[s.lv] || s.lv;
    function row(y) {
      var est = (y !== "2025") ? ' <span class="est">(est.)</span>' : "";
      return "<tr><td>" + y + est + "</td><td><b>" + (r[y] != null ? r[y].toFixed(1) : "—") + "</b></td></tr>";
    }
    return '<div class="school-popup">' +
      "<h3>" + esc(s.n) + "</h3>" +
      '<p class="sub">' + lvl + " &middot; " + esc(s.city || "") +
        (s.d ? " &middot; " + esc(s.d) : "") + "</p>" +
      '<div class="rate-row"><span class="big-rate" style="background:' + col + '">' +
        (cur != null ? cur.toFixed(1) : "—") + "</span>" +
        "<span>Rating in <b>" + state.year + "</b>" +
        (state.year !== "2025" ? " (extrapolated)" : "") + "</span></div>" +
      "<table><tbody>" +
        row("2025") + row("2026") + row("2027") + row("2028") +
      "</tbody></table>" +
      "</div>";
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function passesFilter(s) {
    if (state.level !== "ALL" && s.lv !== state.level) return false;
    var rating = s.r ? s.r[state.year] : null;
    if (rating == null || rating < state.minRate) return false;
    if (state.query) {
      var q = state.query;
      if ((s.n || "").toLowerCase().indexOf(q) === -1 &&
          (s.city || "").toLowerCase().indexOf(q) === -1 &&
          (s.d || "").toLowerCase().indexOf(q) === -1) return false;
    }
    return true;
  }

  function render() {
    layer.clearLayers();
    var radius = markerRadius();
    var count = 0;
    for (var i = 0; i < POINTS.length; i++) {
      var s = POINTS[i];
      if (!passesFilter(s)) continue;
      var rating = s.r[state.year];
      var m = L.circleMarker([s.lat, s.lon], {
        renderer: canvasRenderer,
        radius: radius,
        weight: 1,
        color: "#ffffff",
        opacity: 0.9,
        fillColor: colorFor(rating),
        fillOpacity: 0.85
      });
      m.bindPopup(popupHtml(s), { maxWidth: 260 });
      m.addTo(layer);
      count++;
    }
    updateCount(count);
  }

  function updateCount(n) {
    var el = document.getElementById("countLabel");
    var lvlTxt = state.level === "ALL" ? "all levels" : LEVEL_NAME[state.level].toLowerCase();
    el.textContent = n.toLocaleString() + " schools · " + lvlTxt + " · " + state.year;
  }

  /* ---------- controls wiring ---------- */
  function setActive(container, btn) {
    var kids = container.querySelectorAll(".seg-btn");
    for (var i = 0; i < kids.length; i++) kids[i].classList.remove("active");
    btn.classList.add("active");
  }

  document.getElementById("levelSeg").addEventListener("click", function (e) {
    var btn = e.target.closest(".seg-btn");
    if (!btn) return;
    setActive(this, btn);
    state.level = btn.getAttribute("data-level");
    render();
  });

  document.getElementById("yearSeg").addEventListener("click", function (e) {
    var btn = e.target.closest(".seg-btn");
    if (!btn) return;
    setActive(this, btn);
    state.year = btn.getAttribute("data-year");
    render();
  });

  var minRate = document.getElementById("minRate");
  var minRateVal = document.getElementById("minRateVal");
  minRate.addEventListener("input", function () {
    state.minRate = parseInt(this.value, 10);
    minRateVal.textContent = this.value;
    render();
  });

  var searchEl = document.getElementById("search");
  var searchTimer = null;
  searchEl.addEventListener("input", function () {
    var val = this.value.trim().toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.query = val;
      render();
      maybeZoomToQuery(val);
    }, 220);
  });

  function maybeZoomToQuery(q) {
    if (!q) return;
    var sumLat = 0, sumLon = 0, n = 0;
    for (var i = 0; i < POINTS.length; i++) {
      var s = POINTS[i];
      if ((s.city || "").toLowerCase().indexOf(q) !== -1 ||
          (s.n || "").toLowerCase().indexOf(q) !== -1) {
        sumLat += s.lat; sumLon += s.lon; n++;
      }
    }
    if (n > 0 && n < 400) map.setView([sumLat / n, sumLon / n], n < 20 ? 12 : 10);
  }

  // Mobile: toggle filter panel
  var controls = document.getElementById("controls");
  document.getElementById("toggleControls").addEventListener("click", function () {
    controls.classList.toggle("collapsed");
    setTimeout(function () { map.invalidateSize(); }, 60);
  });

  // Redraw marker sizes on zoom
  var zoomTimer = null;
  map.on("zoomend", function () {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(render, 30);
  });

  // Collapse controls by default on small screens
  if (window.matchMedia("(max-width: 720px)").matches) {
    controls.classList.add("collapsed");
  }

  /* ---------- boot ---------- */
  function boot() {
    var loading = document.getElementById("loading");
    if (!POINTS.length) {
      loading.textContent = "No school data found.";
      return;
    }
    render();
    loading.classList.add("hidden");
    setTimeout(function () { map.invalidateSize(); }, 100);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  }

  boot();
})();
