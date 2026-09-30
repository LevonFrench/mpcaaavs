// Ported from bizarro/evangelion app/src/engine/scale.ts (MIT, Copyright (c) 2026 Giacomo Magnanini, Luis Bizarro; see THIRD-PARTY-NERV.txt).
// Output resolution multiplier, read once when the engine modules are evaluated.
// Scenes keep laying out in logical 1920x1080 px; the engine renders at SCALE x that.
// Kept in its own module so glsl/common.ts can use it without an import cycle through gl.ts.
//
// AAAVS: the show worker sets globalThis.__SHOW_SCALE before it imports the engine (a scale change
// restarts the worker); `?scale=` on the page or worker URL still works as upstream.
function readScale() {
  const g = (globalThis as { __SHOW_SCALE?: unknown }).__SHOW_SCALE;
  let s = typeof g === 'number' ? Math.round(g) : NaN;
  if (!Number.isFinite(s) && typeof location !== 'undefined') s = Math.round(Number(new URLSearchParams(location.search).get('scale') ?? '1'));
  return Number.isFinite(s) && s >= 1 ? Math.min(s, 4) : 1;
}

/** Physical pixels per logical pixel of the output (integer 1..4, default 1). A live binding: the preset worker
 *  changes it (gl.ts setShowScale) between engines when the host's resolution governor settles on another size. */
export let SCALE = readScale();
/** AAAVS: set the scale for engines built from now on (use gl.ts setShowScale, which also rebuilds what depends on it). */
export function setScaleValue(s: number) { SCALE = Number.isFinite(s) && s >= 1 ? Math.min(Math.round(s), 4) : 1; }
