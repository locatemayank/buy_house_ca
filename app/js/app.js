/*
 * app.js — Wires the map, search, coloring, and detail panel together.
 * Depends only on the pluggable modules (dataSources.js, scoring.js).
 */
import { activeSource } from "./dataSources.js";
import {
  DEFAULT_WEIGHTS,
  scoreZone,
  scoreColor,
  normalizedMetrics,
} from "./scoring.js";

const DEFAULT_ZIP = "95131";
const DEFAULT_RADIUS_MI = 8;

const state = {
  fc: null, // full FeatureCollection
  byZip: new Map(), // zip -> feature
  weights: { ...DEFAULT_WEIGHTS },
  layer: null, // current Leaflet GeoJSON layer
  selected: null,
};

// ---- Map setup --------------------------------------------------------------
const map = L.map("map", { zoomControl: true }).setView([37.35, -121.9], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// ---- Helpers ----------------------------------------------------------------
function haversineMiles(a, b) {
  const R = 3958.8;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
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

// ---- Rendering --------------------------------------------------------------
function styleFor(feature) {
  const s = scoreZone(feature.properties, state.weights);
  const isSel = state.selected === feature.properties.zip;
  return {
    color: isSel ? "#111" : "#555",
    weight: isSel ? 3 : 1,
    fillColor: scoreColor(s),
    fillOpacity: 0.55,
  };
}

function renderZonesNear(centerLatLon, radiusMi) {
  if (state.layer) {
    map.removeLayer(state.layer);
    state.layer = null;
  }
  const feats = state.fc.features.filter((f) => {
    const p = f.properties;
    if (p.lat == null || p.lon == null) return false;
    return haversineMiles(centerLatLon, [p.lat, p.lon]) <= radiusMi;
  });

  state.layer = L.geoJSON(
    { type: "FeatureCollection", features: feats },
    {
      style: styleFor,
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const s = scoreZone(p, state.weights);
        layer.bindTooltip(
          `${p.zip} — ${p.city}<br>Score ${s} · ${fmtMoney(p.price)}`,
          { sticky: true }
        );
        layer.on("click", () => selectZone(p.zip, layer));
      },
    }
  ).addTo(map);

  updateResultsList(feats);
  return feats.length;
}

function updateResultsList(feats) {
  const ranked = [...feats].sort(
    (a, b) =>
      scoreZone(b.properties, state.weights) -
      scoreZone(a.properties, state.weights)
  );
  const el = document.getElementById("results");
  el.innerHTML =
    `<div class="results-head">${feats.length} zones in view — ranked by score</div>` +
    ranked
      .slice(0, 50)
      .map((f) => {
        const p = f.properties;
        const s = scoreZone(p, state.weights);
        return `<div class="result-row" data-zip="${p.zip}">
          <span class="dot" style="background:${scoreColor(s)}"></span>
          <span class="rz-zip">${p.zip}</span>
          <span class="rz-city">${p.city}</span>
          <span class="rz-score">${s}</span>
        </div>`;
      })
      .join("");
  el.querySelectorAll(".result-row").forEach((row) => {
    row.addEventListener("click", () => {
      const zip = row.getAttribute("data-zip");
      const f = state.byZip.get(zip);
      if (f && f.properties.lat != null) {
        map.setView([f.properties.lat, f.properties.lon], 13);
      }
      selectZone(zip);
    });
  });
}

async function selectZone(zip, layer) {
  state.selected = zip;
  if (state.layer) state.layer.setStyle(styleFor);
  const f = state.byZip.get(zip);
  if (!f) return;
  const p = f.properties;
  const s = scoreZone(p, state.weights);
  const m = normalizedMetrics(p);

  // Extension point: async detail from any registered providers / APIs.
  let extra = {};
  try {
    extra = await activeSource.getZoneDetail(p);
  } catch (e) {
    console.warn(e);
  }

  const panel = document.getElementById("detail");
  panel.innerHTML = `
    <div class="detail-head">
      <h2>${p.zip} <small>${p.city}, ${p.county} County</small></h2>
      <div class="score-pill" style="background:${scoreColor(s)}">${s}</div>
    </div>
    <div class="metrics">
      ${metricRow("School score", `${p.school_score} / 10`, p.provenance.school_score)}
      ${metricRow("Crime index", `${p.crime_index} (lower is safer)`, p.provenance.crime_index)}
      ${metricRow("Median home value", fmtMoney(p.price), p.provenance.price)}
      ${metricRow("1-yr price change", p.price_change_1yr != null ? p.price_change_1yr + "%" : "—", p.provenance.price_change_1yr)}
      ${metricRow("Median lot size", p.median_lot_size_sqft.toLocaleString() + " sqft", p.provenance.median_lot_size_sqft)}
      ${metricRow("ZIP land area", p.land_area_sqmi + " sq mi", p.provenance.land_area_sqmi)}
      ${Object.entries(extra)
        .map(([k, v]) => metricRow(k, String(v), "modeled"))
        .join("")}
    </div>
    <div class="bars">
      ${bar("Schools", m.school)}
      ${bar("Safety", m.safety)}
    </div>
    <p class="note">Fields badged <span class="badge real">real</span> come from
    Zillow / US Census. <span class="badge modeled">modeled</span> fields are
    placeholders until a live feed is connected.</p>
  `;
  panel.classList.add("visible");
}

function metricRow(label, value, prov) {
  return `<div class="metric">
    <span class="m-label">${label} ${provBadge(prov)}</span>
    <span class="m-value">${value}</span>
  </div>`;
}

function bar(label, v) {
  const pct = Math.round((v || 0) * 100);
  return `<div class="bar-wrap">
    <span class="bar-label">${label}</span>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    <span class="bar-pct">${pct}</span>
  </div>`;
}

// ---- Search -----------------------------------------------------------------
function goToZip(zip) {
  const f = state.byZip.get(zip);
  const status = document.getElementById("status");
  if (!f || f.properties.lat == null) {
    status.textContent = `ZIP ${zip} not found in dataset.`;
    return;
  }
  status.textContent = "";
  const center = [f.properties.lat, f.properties.lon];
  map.setView(center, 12);
  const radius = Number(document.getElementById("radius").value) || DEFAULT_RADIUS_MI;
  const n = renderZonesNear(center, radius);
  status.textContent = `Showing ${n} zones within ${radius} mi of ${zip}.`;
  selectZone(zip);
}

// ---- Init -------------------------------------------------------------------
async function init() {
  const status = document.getElementById("status");
  status.textContent = "Loading California zone data…";
  try {
    state.fc = await activeSource.loadZones();
  } catch (e) {
    status.textContent = "Failed to load data: " + e.message;
    return;
  }
  for (const f of state.fc.features) state.byZip.set(f.properties.zip, f);
  status.textContent = `Loaded ${state.fc.features.length} CA zones.`;

  document.getElementById("zip").value = DEFAULT_ZIP;
  document.getElementById("radius").value = DEFAULT_RADIUS_MI;

  document.getElementById("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const zip = document.getElementById("zip").value.trim().padStart(5, "0");
    goToZip(zip);
  });

  document.getElementById("radius").addEventListener("change", () => {
    const zip = document.getElementById("zip").value.trim().padStart(5, "0");
    goToZip(zip);
  });

  goToZip(DEFAULT_ZIP);
}

init();
