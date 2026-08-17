/* ==========================================================================
 * CA School Rating Map — app.js
 * --------------------------------------------------------------------------
 * Renders every CA public school (window.SCHOOL_POINTS) on a Leaflet map,
 * color-coded 1..10.
 *   • Level filter:  Average (all) | Elementary | Middle | High
 *   • Year selector: 2025 (real) | 2026 | 2027 | 2028 (extrapolated)
 *   • Display mode:  Dots (per-school markers) | Gradient (smooth IDW surface)
 *   • Min-rating slider + text search (city / school name)
 * Mobile-friendly: canvas rendering, collapsible controls, touch targets.
 * ========================================================================== */
(function () {
  "use strict";

  var POINTS = window.SCHOOL_POINTS || [];

  var state = {
    level: "ALL",     // ALL | E | M | H
    year: "2025",     // 2025 | 2026 | 2027 | 2028
    display: "dots",  // dots | gradient
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
  function rgbFor(rating) {
    var r = Math.max(1, Math.min(10, rating));
    var lo = Math.floor(r), hi = Math.ceil(r), t = r - lo;
    var a = STOPS[lo - 1], b = STOPS[hi - 1] || a;
    return [
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
      Math.round(a[3] + (b[3] - a[3]) * t)
    ];
  }
  function colorFor(rating) {
    var c = rgbFor(rating);
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }

  /* ---------- map (default: San Jose area) ---------- */
  var map = L.map("map", {
    preferCanvas: true,
    zoomControl: true,
    minZoom: 5,
    maxZoom: 18
  }).setView([37.335, -121.89], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19
  }).addTo(map);

  var canvasRenderer = L.canvas({ padding: 0.5 });
  var dotLayer = L.layerGroup().addTo(map);

  /* ---------- gradient (IDW) canvas layer ---------- */
  var GradientLayer = L.Layer.extend({
    initialize: function () { this._pts = []; },
    setPoints: function (pts) { this._pts = pts; if (this._map) this._draw(); return this; },
    onAdd: function (map) {
      this._map = map;
      var c = this._canvas = L.DomUtil.create("canvas", "leaflet-gradient-layer leaflet-layer");
      c.style.position = "absolute";
      c.style.pointerEvents = "none";
      map.getPanes().overlayPane.appendChild(c);
      map.on("moveend zoomend resize", this._reset, this);
      this._reset();
    },
    onRemove: function (map) {
      map.off("moveend zoomend resize", this._reset, this);
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      this._canvas = null;
    },
    _reset: function () {
      var size = this._map.getSize();
      var topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      this._draw();
    },
    _draw: function () {
      if (!this._canvas) return;
      var map = this._map, w = this._canvas.width, h = this._canvas.height;
      var ctx = this._canvas.getContext("2d");
      ctx.clearRect(0, 0, w, h);
      if (!this._pts.length) return;

      // Project visible points to container pixels (+ margin).
      var margin = 90;
      var pxs = [];
      for (var i = 0; i < this._pts.length; i++) {
        var p = this._pts[i];
        var cp = map.latLngToContainerPoint([p.lat, p.lon]);
        if (cp.x < -margin || cp.x > w + margin || cp.y < -margin || cp.y > h + margin) continue;
        pxs.push({ x: cp.x, y: cp.y, r: p.r });
      }
      if (!pxs.length) return;

      // Spatial buckets to keep IDW fast even statewide.
      var maxR = 85, maxR2 = maxR * maxR, bs = maxR;
      var buckets = {};
      for (var k = 0; k < pxs.length; k++) {
        var bx = Math.floor(pxs[k].x / bs), by = Math.floor(pxs[k].y / bs);
        var key = bx + "_" + by;
        (buckets[key] || (buckets[key] = [])).push(pxs[k]);
      }

      var step = 6;
      var img = ctx.createImageData(w, h);
      var data = img.data;
      for (var y = 0; y < h; y += step) {
        for (var x = 0; x < w; x += step) {
          var gbx = Math.floor(x / bs), gby = Math.floor(y / bs);
          var wsum = 0, vsum = 0;
          for (var ox = -1; ox <= 1; ox++) {
            for (var oy = -1; oy <= 1; oy++) {
              var arr = buckets[(gbx + ox) + "_" + (gby + oy)];
              if (!arr) continue;
              for (var m = 0; m < arr.length; m++) {
                var dx = x - arr[m].x, dy = y - arr[m].y, d2 = dx * dx + dy * dy;
                if (d2 > maxR2) continue;
                var wgt = 1 / (d2 + 25);
                wsum += wgt; vsum += wgt * arr[m].r;
              }
            }
          }
          if (wsum <= 0) continue;
          var col = rgbFor(vsum / wsum);
          // fill the step x step block
          for (var yy = y; yy < y + step && yy < h; yy++) {
            var base = (yy * w + x) * 4;
            for (var xx = 0; xx < step && (x + xx) < w; xx++) {
              var idx = base + xx * 4;
              data[idx] = col[0];
              data[idx + 1] = col[1];
              data[idx + 2] = col[2];
              data[idx + 3] = 165; // ~0.65 opacity
            }
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    }
  });
  var gradientLayer = new GradientLayer();

  /* ---------- helpers ---------- */
  function markerRadius() {
    var z = map.getZoom();
    if (z <= 6) return 4;
    if (z <= 8) return 5;
    if (z <= 10) return 6;
    if (z <= 12) return 7;
    return 9;
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
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

  function filteredPoints() {
    var out = [];
    for (var i = 0; i < POINTS.length; i++) {
      var s = POINTS[i];
      if (!passesFilter(s)) continue;
      out.push({ lat: s.lat, lon: s.lon, r: s.r[state.year], s: s });
    }
    return out;
  }

  /* ---------- rendering ---------- */
  function render() {
    var pts = filteredPoints();
    if (state.display === "gradient") {
      dotLayer.clearLayers();
      if (!map.hasLayer(gradientLayer)) gradientLayer.addTo(map);
      gradientLayer.setPoints(pts);
    } else {
      if (map.hasLayer(gradientLayer)) map.removeLayer(gradientLayer);
      drawDots(pts);
    }
    updateCount(pts.length);
  }

  function drawDots(pts) {
    dotLayer.clearLayers();
    var radius = markerRadius();
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var m = L.circleMarker([p.lat, p.lon], {
        renderer: canvasRenderer,
        radius: radius,
        weight: 1,
        color: "#ffffff",
        opacity: 0.9,
        fillColor: colorFor(p.r),
        fillOpacity: 0.85
      });
      m.bindPopup(popupHtml(p.s), { maxWidth: 260 });
      m.addTo(dotLayer);
    }
  }

  function updateCount(n) {
    var el = document.getElementById("countLabel");
    var lvlTxt = state.level === "ALL" ? "all levels" : LEVEL_NAME[state.level].toLowerCase();
    el.textContent = n.toLocaleString() + " schools · " + lvlTxt + " · " + state.year +
      (state.display === "gradient" ? " · gradient" : "");
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

  document.getElementById("displaySeg").addEventListener("click", function (e) {
    var btn = e.target.closest(".seg-btn");
    if (!btn) return;
    setActive(this, btn);
    state.display = btn.getAttribute("data-display");
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
    if (n > 0 && n < 400) map.setView([sumLat / n, sumLon / n], n < 20 ? 13 : 11);
  }

  // Gradient mode: tap map to reveal the nearest school.
  map.on("click", function (e) {
    if (state.display !== "gradient") return;
    var best = null, bestD = Infinity;
    var cp = map.latLngToContainerPoint(e.latlng);
    for (var i = 0; i < POINTS.length; i++) {
      var s = POINTS[i];
      if (!passesFilter(s)) continue;
      var sp = map.latLngToContainerPoint([s.lat, s.lon]);
      var dx = sp.x - cp.x, dy = sp.y - cp.y, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best && bestD < 60 * 60) {
      L.popup({ maxWidth: 260 })
        .setLatLng([best.lat, best.lon])
        .setContent(popupHtml(best))
        .openOn(map);
    }
  });

  // Mobile: toggle filter panel
  var controls = document.getElementById("controls");
  document.getElementById("toggleControls").addEventListener("click", function () {
    controls.classList.toggle("collapsed");
    setTimeout(function () { map.invalidateSize(); }, 60);
  });

  // Redraw dot marker sizes on zoom (gradient layer self-redraws)
  var zoomTimer = null;
  map.on("zoomend", function () {
    if (state.display !== "dots") return;
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
