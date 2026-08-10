/*
 * dataSources.js — Pluggable data layer for the CA Zone Finder.
 *
 * The rest of the app only talks to `DataSource` (an interface), never to a
 * specific file or API. To add a real feed later (GreatSchools, DOJ crime,
 * ATTOM parcels, a backend API, etc.), implement a new class with the same
 * methods and register it as the active source. Nothing else needs to change.
 *
 * Interface:
 *   async loadZones()          -> GeoJSON FeatureCollection (all zones)
 *   async getZoneDetail(props) -> extra detail object for one zone
 *
 * Detail providers: getZoneDetail merges results from any registered
 * DetailProvider, so new "features" (e.g. live listings, walkability, flood
 * risk) can be bolted on without touching existing code.
 */

// ---- Detail provider registry (extension point) -----------------------------
const DetailProviders = [];

// Register an async fn (props) => ({...extraFields}) run on zone click.
export function registerDetailProvider(fn) {
  DetailProviders.push(fn);
}

async function runDetailProviders(props) {
  const merged = {};
  for (const fn of DetailProviders) {
    try {
      Object.assign(merged, await fn(props));
    } catch (e) {
      console.warn("DetailProvider failed:", e);
    }
  }
  return merged;
}

// ---- Base interface ---------------------------------------------------------
export class DataSource {
  async loadZones() {
    throw new Error("not implemented");
  }
  async getZoneDetail(props) {
    return runDetailProviders(props);
  }
}

// ---- Default implementation: local pre-processed GeoJSON --------------------
export class LocalGeoJsonSource extends DataSource {
  constructor(url) {
    super();
    this.url = url || "zones.json";
    this._cache = null;
  }

  async loadZones() {
    if (this._cache) return this._cache;
    const res = await fetch(this.url);
    if (!res.ok) throw new Error("Failed to load " + this.url + ": " + res.status);
    this._cache = await res.json();
    return this._cache;
  }

  async getZoneDetail(props) {
    const extra = await runDetailProviders(props);
    return Object.assign({}, extra);
  }
}

// ---- Active source (swap this line to change backends) ----------------------
export const activeSource = new LocalGeoJsonSource("zones.json");
