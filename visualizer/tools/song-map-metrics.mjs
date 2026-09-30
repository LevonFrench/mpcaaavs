// Accuracy metrics for song-map fixtures (mir_eval-style, greedy one-to-one matching).
export function fMeasure(reference, estimate, tolerance) {
  const est = [...estimate].sort((a, b) => a - b), used = new Uint8Array(est.length);
  let hits = 0;
  for (const r of reference) {
    let lo = 0, hi = est.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (est[m] < r - tolerance) lo = m + 1; else hi = m; }
    let best = -1, bestD = Infinity;
    for (let j = lo; j < est.length && est[j] <= r + tolerance; j++) if (!used[j] && Math.abs(est[j] - r) < bestD) { best = j; bestD = Math.abs(est[j] - r); }
    if (best >= 0) { used[best] = 1; hits++; }
  }
  const precision = est.length ? hits / est.length : 0, recall = reference.length ? hits / reference.length : 0;
  return { f: precision + recall ? 2 * precision * recall / (precision + recall) : 0, precision, recall, hits };
}

/** Local tempo from detected beats inside [start, end), trimmed away from edges. */
export function localBpm(beats, start, end, trim = 4) {
  const inside = beats.filter(t => t >= start + trim && t < end - trim);
  const ibi = inside.slice(1).map((t, i) => t - inside[i]).sort((a, b) => a - b);
  if (!ibi.length) return 0;
  return 60 / ibi[Math.floor(ibi.length / 2)];
}

export function sectionMetrics(truth, map) {
  const detected = map.sections.slice(1).map(s => s.start);
  const reference = truth.sections.slice(1).map(s => s.start);
  let hits = 0, worst = 0;
  const errors = [];
  for (const r of reference) {
    const d = detected.length ? Math.min(...detected.map(x => Math.abs(x - r))) : Infinity;
    const bars = d / truth.barLength(r);
    errors.push(bars); worst = Math.max(worst, bars);
    if (bars <= 1 + 1e-6) hits++;
  }
  let matchedDetected = 0;
  for (const d of detected) if (reference.some(r => Math.abs(d - r) / truth.barLength(r) <= 1 + 1e-6)) matchedDetected++;
  // Role accuracy: detected role at each true section's midpoint, and duration-weighted.
  let roleHits = 0, weighted = 0, total = 0;
  const roleAt = t => map.sections.find(s => t >= s.start && t < s.end)?.role ?? null;
  for (const s of truth.sections) {
    if (roleAt((s.start + s.end) / 2) === s.role) roleHits++;
    for (let t = s.start + .05; t < s.end; t += .25) { total++; if (roleAt(t) === s.role) weighted++; }
  }
  return {
    boundaryRecall: reference.length ? hits / reference.length : 1,
    boundaryPrecision: detected.length ? matchedDetected / detected.length : 1,
    worstBars: worst, errors,
    roleAccuracy: truth.sections.length ? roleHits / truth.sections.length : 1,
    roleTimeAccuracy: total ? weighted / total : 1,
  };
}

/** Bass pitch accuracy on note interiors away from kicks. */
export function pitchAccuracy(truth, map) {
  const fps = map.fps, midi = map.bass_midi ?? [];
  let ok = 0, n = 0;
  for (const note of truth.bass) {
    for (let t = note.start + .06; t < note.end - .03; t += 1 / fps) {
      if (truth.onsets.kick.some(k => t - k > -.02 && t - k < .12)) continue;
      const v = midi[Math.round(t * fps)] ?? 0;
      n++; if (Math.abs(v - note.midi) <= .5) ok++;
    }
  }
  return n ? ok / n : 1;
}

export function evaluate(fixture, map) {
  const { truth } = fixture;
  const tempo = truth.regions.map(r => {
    const bpm = truth.regions.length === 1 ? map.bpm : localBpm(map.beats, r.start, r.end);
    return { truth: r.bpm, detected: bpm, error: Math.abs(bpm - r.bpm) / r.bpm };
  });
  return {
    tempo,
    tempoError: Math.max(...tempo.map(t => t.error)),
    beatF: fMeasure(truth.beats, map.beats, .07).f,
    downbeatF: fMeasure(truth.downbeats, map.downbeats, .07).f,
    sections: sectionMetrics(truth, map),
    kick: fMeasure(truth.onsets.kick, map.onsets.kick.map(o => o[0]), .03),
    snare: fMeasure(truth.onsets.snare, map.onsets.snare.map(o => o[0]), .03),
    hat: fMeasure(truth.onsets.hat, map.onsets.hat.map(o => o[0]), .03),
    vocal: fMeasure(truth.onsets.vocal, map.onsets.vocal.map(o => o[0]), .05),
    pitch: pitchAccuracy(truth, map),
  };
}
