/*
 * scoring.js — Ranking / color logic, kept separate so criteria can evolve.
 *
 * Add a new criterion by:
 *   1. adding a weight to DEFAULT_WEIGHTS,
 *   2. returning its 0..1 normalized value from normalizedMetrics().
 * The composite score and map coloring update automatically.
 */

export const DEFAULT_WEIGHTS = {
  school: 0.5, // good schools
  safety: 0.5, // low crime
  // affordability: 0.0,  // example: uncomment + implement below to add later
};

// Return each criterion normalized to 0..1 (1 = best).
export function normalizedMetrics(props) {
  return {
    school: clamp01((props.school_score || 0) / 10),
    safety: clamp01(1 - (props.crime_index || 0) / 100),
    // affordability: clamp01(1 - (props.price - 300000) / 2000000),
  };
}

export function scoreZone(props, weights = DEFAULT_WEIGHTS) {
  const m = normalizedMetrics(props);
  let sum = 0;
  let wsum = 0;
  for (const k of Object.keys(weights)) {
    if (m[k] == null) continue;
    sum += weights[k] * m[k];
    wsum += weights[k];
  }
  const s = wsum > 0 ? sum / wsum : 0;
  return Math.round(s * 1000) / 10; // 0..100 one decimal
}

// Green (good) -> yellow -> red (poor) based on 0..100 score.
export function scoreColor(score) {
  const t = clamp01(score / 100);
  const hue = t * 120; // 0=red, 120=green
  return `hsl(${hue}, 70%, 45%)`;
}

function clamp01(x) {
  if (isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
