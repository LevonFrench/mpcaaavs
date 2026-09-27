// The musical clock: tempo tracking and a 240-slot grid.
//
// Plan §3.1 / §4.4. 240 = LCM(16, 12, 5), so 64ths, triplets, sextuplets,
// dotted values AND quintuplets all land on integer slots.
//
// Everything here runs on the AUDIO clock (§4.6). Nothing reads
// performance.now() or a rAF timestamp — that is how schedulers silently drift.

export const SLOTS_PER_BEAT = 240;
export const SLOTS_PER_BAR = SLOTS_PER_BEAT * 4;

const MIN_BPM = 55;
const MAX_BPM = 200;
const MAX_LOOKAHEAD = 8;
const WINDOW = 64;
const MIN_ONSETS = 6;
const MIN_ONSET_GAP = 0.1;
const LOCK_THRESHOLD = 0.44;
const UNLOCK_THRESHOLD = 0.3;

// Tempo-octave rule. An onset-only tracker cannot tell half-time 75 from 150,
// or a dotted/triplet 100 from 150: kick+snare+hat patterns score well at every
// metrical level. Left alone, the winner flips with whichever ghost notes are
// in the recency window, so the grid doubles and halves bar to bar.
//
// Rule, applied every scoring pass:
//   1. The metrical family of the raw winner is {x2, x0.5, x1.5, x2/3}. A family
//      member whose peak score is >= OCTAVE_TIE of the winner's is "tied".
//   2. While locked, a family member scoring >= OCTAVE_HOLD of the winner and
//      within the lock's own tolerance of the current tempo is kept (hysteresis:
//      an established octave is kept until the evidence for another one is
//      clearly better, not merely equal or slightly ahead). It gives way to the
//      reading the prior in 3 picks only when that reading is the raw winner
//      or scores >= OCTAVE_SWITCH of it, so an early lock on the disfavoured
//      octave still migrates on firm evidence, but a tie that merely grazes
//      OCTAVE_TIE (timing jitter moves the ratio by a few hundredths) cannot
//      flip an established grid mid-song.
//   3. Otherwise the prior decides: the SLOWEST tied reading inside the one-
//      octave band centred on 120 BPM in log-tempo (120/sqrt2..120*sqrt2, i.e.
//      ~85-170 BPM) wins; if no tied reading is in the band, the one nearest
//      120 in log-tempo does. Exactly one member of a 2:1 pair lies in the
//      band, so half-time trap/dubstep resolves to the DAW tempo (75|150 ->
//      150, 70|140 -> 140) and slow hip-hop keeps its written tempo (90|180 ->
//      90). For a 3:2 pair inside the band the slower reading wins, because a
//      swung/triplet subdivision of a slow pulse (90 swung reads as 90|135) is
//      far more common in this material than a dotted-quarter pulse.
// Untied material is untouched, so a tight 55 or 200 BPM click still reads as
// 55 or 200 (a clean click's half tempo scores ~0.78 of it, under OCTAVE_TIE).
// A uniform pulse IS metrically ambiguous, though: with >= ~10 ms of timing
// jitter its half tempo can reach the tie, so a loose 172-200 stream may lock
// at 86-100 per the prior (90|180 -> 90). Either octave is acceptable; the
// rule guarantees only that the chosen one is not flipped once locked (2).
// The prior only breaks ties; it never pulls a clear winner. Regression gate:
// tools/audio-music-fixtures-check.ts.
const OCTAVE_RATIOS = [2, 0.5, 1.5, 2 / 3] as const;
const OCTAVE_TIE = 0.8;
const OCTAVE_HOLD = 0.65;
const OCTAVE_SWITCH = 0.9;
const OCTAVE_PEAK_WINDOW = 0.03;
const PREFERRED_BPM = 120;
const PREFERRED_BAND_LO = PREFERRED_BPM / Math.SQRT2;
const PREFERRED_BAND_HI = PREFERRED_BPM * Math.SQRT2;
/** Credit for an onset interval of half a beat (an 8th under a quarter pulse).
 *  Without it a stream of offbeat hats scores zero at the true tempo and never
 *  locks. Above the 0.5 a two-beat interval earns, so an 8th stream reads as
 *  its quarter pulse, and below 1 so a clean click never ties its half tempo. */
const SUBDIVISION_CREDIT = 0.75;
/** Credit for a third/two-thirds-beat interval: triplets and heavy swing. */
const TRIPLET_CREDIT = 0.6;

/**
 * Keep a measured track tempo alive while phase confidence is reacquired.
 * `trackedBpm` is the phase-locked timeline value; `estimatedBpm` is the last
 * evidence-backed TempoTracker estimate. The 120 BPM default is only for the
 * period before the track has produced any usable tempo evidence.
 */
export function resolveTempoBpm(trackedBpm: number, estimatedBpm: number, fallback = 120): number {
  if (Number.isFinite(trackedBpm) && trackedBpm > 0) return trackedBpm;
  if (Number.isFinite(estimatedBpm) && estimatedBpm > 0) return estimatedBpm;
  return fallback;
}

/** Named clock divisions. Value = slots per tick. */
export const DIVISIONS = {
  '1/64':      SLOTS_PER_BEAT / 16,      // 15
  '1/32':      SLOTS_PER_BEAT / 8,       // 30
  '1/16':      SLOTS_PER_BEAT / 4,       // 60
  '1/8':       SLOTS_PER_BEAT / 2,       // 120
  'beat':      SLOTS_PER_BEAT,           // 240
  'half':      SLOTS_PER_BEAT * 2,       // 480
  'bar':       SLOTS_PER_BAR,            // 960
  '2bar':      SLOTS_PER_BAR * 2,
  '4bar':      SLOTS_PER_BAR * 4,
  // Triplets — the reason 16 slots/beat was not enough.
  '1/8T':      SLOTS_PER_BEAT / 3,       // 80
  '1/16T':     SLOTS_PER_BEAT / 6,       // 40
  // Quintuplets — the reason 48 was not enough either.
  '1/4quint':  SLOTS_PER_BEAT / 5,       // 48
  // Dotted.
  '1/8dot':    (SLOTS_PER_BEAT * 3) / 4, // 180
} as const;

export type DivisionName = keyof typeof DIVISIONS;

/** Deterministic onset-driven tempo tracker running entirely on audio time. */
export class TempoTracker {
  constructor(private readonly continuity: { coastBeats?: number; recency?: number; tempoGain?: number; changeEvidence?: number } = {}) {}
  private onsets: number[] = [];
  /** Detector/output delay in audio-clock seconds, never wall-clock time. */
  inputLatency = 0;
  bpm = 0;
  confidence = 0;
  locked = false;
  private lastOnsetTime = Number.NEGATIVE_INFINITY;
  private lockEvidence = 0;
  private unlockEvidence = 0;
  private pendingBpm = 0;
  private pendingCount = 0;

  /** Absolute time of the next grid beat. NEVER an index recomputed from an
   *  anchor — easing a moving anchor makes the index run backwards and the
   *  grid dies silently. Pulse lost an evening to this. */
  private nextBeat = 0;
  beatIndex = 0;
  phase = 0;

  reset(): void {
    this.onsets.length = 0;
    this.bpm = 0;
    this.confidence = 0;
    this.locked = false;
    this.lastOnsetTime = Number.NEGATIVE_INFINITY;
    this.lockEvidence = 0;
    this.unlockEvidence = 0;
    this.pendingBpm = 0;
    this.pendingCount = 0;
    this.nextBeat = 0;
    this.beatIndex = 0;
    this.phase = 0;
  }

  /** Preserve a trusted tempo/phase while the transport jumps by musical beats. */
  seekByBeats(beats: number, targetTime: number): void {
    if (!this.locked || !this.bpm || !Number.isFinite(beats) || !Number.isFinite(targetTime)) return;
    this.beatIndex = Math.max(0, this.beatIndex + beats);
    const period = 60 / this.bpm;
    this.nextBeat = targetTime + (1 - this.phase) * period;
    // Old content onsets describe the region we left, but the tempo estimate is
    // still valid: a whole-bar jump does not change the track's BPM or phase.
    this.onsets.length = 0;
    this.lastOnsetTime = targetTime;
  }

  addOnset(t: number): void {
    if (!Number.isFinite(t)) return;
    const latency = Number.isFinite(this.inputLatency) ? this.inputLatency : 0;
    t -= latency;
    const last = this.onsets[this.onsets.length - 1];
    if (last !== undefined && t <= last) {
      // A backwards audio-clock jump without an explicit transport callback
      // invalidates interval evidence, but not an already trusted tempo.
      this.onsets.length = 0;
    } else if (last !== undefined && t - last < MIN_ONSET_GAP) return;
    this.onsets.push(t);
    this.lastOnsetTime = t;
    if (this.onsets.length > WINDOW) this.onsets.shift();
    if (this.onsets.length >= MIN_ONSETS) this.score();

    if (this.locked && this.nextBeat) {
      const period = 60 / this.bpm;
      const err = wrapSigned(t - this.nextBeat, period);
      // Ignore likely subdivisions; use a bounded PLL correction for true
      // beat onsets, including small errors that otherwise accumulate drift.
      if (Math.abs(err) <= period * 0.24) {
        const bounded = Math.max(-period * 0.1, Math.min(period * 0.1, err));
        this.nextBeat += bounded * (0.18 + (1 - this.confidence) * 0.14);
      }
    }
  }

  /** Accept a tempo measured over a rolling audio window, rather than an onset
   * interval. Require repeated agreement before acquiring or replacing a grid. */
  observeTempo(t: number, bpm: number, confidence: number, anchor: number): void {
    if (![t,bpm,confidence,anchor].every(Number.isFinite) || bpm < MIN_BPM || bpm > MAX_BPM || confidence < .3) return;
    if (Math.abs(bpm - this.pendingBpm) <= 2) this.pendingCount++;
    else { this.pendingBpm = bpm; this.pendingCount = 1; }
    const change = this.bpm && Math.abs(bpm - this.bpm) > Math.max(3,this.bpm*.04);
    if (this.locked && change && this.pendingCount < (this.continuity.changeEvidence ?? 8)) return;
    if (!this.locked && this.pendingCount < 3) { this.bpm=bpm; return; }
    this.bpm = !this.locked || change ? bpm : this.bpm + (bpm-this.bpm)*(this.continuity.tempoGain ?? .12);
    this.confidence = confidence; this.lastOnsetTime=t;
    const period=60/this.bpm;
    const next=anchor+(Math.floor((t-anchor)/period)+1)*period;
    if (!this.locked) { this.locked=true; this.nextBeat=next; }
    else {
      const error=wrapSigned(next-this.nextBeat,period);
      if (Math.abs(error)<period*.25) this.nextBeat += Math.max(-.02,Math.min(.02,error))*.2;
    }
  }

  private score(): void {
    let best = 0, bestScore = -1, runnerUp = 0;
    const scores: Array<{ bpm: number; score: number }> = [];
    // A fixed quarter-BPM bank is deterministic, cheap at this window size,
    // and avoids histogram-bin instability near a tempo boundary.
    for (let candidate = MIN_BPM; candidate <= MAX_BPM; candidate += 0.25) {
      const score = this.candidateScore(candidate);
      scores.push({ bpm: candidate, score });
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    if (!best || bestScore <= 0) return;
    // Octave rule (see OCTAVE_RATIOS). `bestScore` stays the raw winner's: the
    // pulse evidence is identical at every metrical level, only the reading
    // reported for it changes.
    const rawBest = best;
    const related: number[] = [rawBest];
    const tied: number[] = [], holdable: number[] = [rawBest];
    for (const ratio of OCTAVE_RATIOS) {
      const peak = peakNear(scores, rawBest * ratio);
      if (!peak) continue;
      related.push(peak.bpm);
      if (peak.score >= bestScore * OCTAVE_TIE) tied.push(peak.bpm);
      if (peak.score >= bestScore * OCTAVE_HOLD) holdable.push(peak.bpm);
    }
    const preferred = tied.length ? preferredReading([rawBest, ...tied]) : rawBest;
    const held = this.locked && this.bpm
      ? holdable.find(bpm => Math.abs(bpm - this.bpm) <= Math.max(3, this.bpm * 0.04))
      : undefined;
    // A lock that landed on the disfavoured octave early (few onsets, an
    // unlucky intro) migrates to the documented octave, but only on firm
    // evidence: a tie hovering at OCTAVE_TIE must not flip a locked grid.
    const switchScore = preferred === rawBest ? bestScore : (peakNear(scores, preferred)?.score ?? 0);
    const keepHeld = held !== undefined
      && (preferredReading([held, preferred]) === held || switchScore < bestScore * OCTAVE_SWITCH);
    best = keepHeld ? held : preferred;
    if (best !== rawBest) {
      for (const ratio of OCTAVE_RATIOS) {
        const peak = peakNear(scores, best * ratio);
        if (peak) related.push(peak.bpm);
      }
    }
    for (const candidate of scores) {
      // Metrical relatives are the same pulse at another level, not a rival
      // tempo, so they must not count against separation/confidence.
      if (related.some(bpm => Math.abs(candidate.bpm - bpm) < Math.max(3, bpm * 0.04))) continue;
      if (Math.abs(candidate.bpm - best) < Math.max(3, best * 0.04)) continue;
      if (candidate.score > runnerUp) runnerUp = candidate.score;
    }
    const separation = Math.max(0, (bestScore - runnerUp) / Math.max(bestScore, 1e-9));
    const maturity = Math.min(1, Math.max(0, (this.onsets.length - 4) / 4));
    const rawConfidence = Math.min(1, (bestScore * 0.72 + separation * 0.28) * maturity);
    this.confidence += (rawConfidence - this.confidence) * (this.locked ? 0.28 : 0.55);

    if (!this.bpm) this.bpm = best;
    else {
      const largeChange = Math.abs(best - this.bpm) > Math.max(8, this.bpm * 0.12);
      if (largeChange) {
        if (Math.abs(best - this.pendingBpm) <= 2) this.pendingCount++;
        else { this.pendingBpm = best; this.pendingCount = 1; }
        if (!this.locked || this.pendingCount >= (this.continuity.changeEvidence ?? 3)) {
          this.bpm = best; this.pendingBpm = 0; this.pendingCount = 0;
        }
      } else {
        this.pendingBpm = 0; this.pendingCount = 0;
        const gain = this.locked ? (this.continuity.tempoGain ?? 0.42) : 0.52;
        this.bpm += (best - this.bpm) * gain;
      }
    }

    if (this.confidence >= LOCK_THRESHOLD) { this.lockEvidence++; this.unlockEvidence = 0; }
    else if (this.confidence < UNLOCK_THRESHOLD) { this.unlockEvidence++; this.lockEvidence = 0; }
    else { this.lockEvidence = Math.max(0, this.lockEvidence - 1); this.unlockEvidence = 0; }
    if (!this.locked && this.lockEvidence >= 2) {
      this.locked = true;
      const period = 60 / this.bpm;
      this.nextBeat = this.onsets[this.onsets.length - 1]! + period;
    } else if (this.locked && this.unlockEvidence >= 3) {
      this.locked = false; this.nextBeat = 0; this.phase = 0;
    }
  }

  private candidateScore(candidateBpm: number): number {
    const period = 60 / candidateBpm;
    let adjacent = 0, adjacentWeight = 0, context = 0, contextWeight = 0;
    const count = this.onsets.length;
    for (let index = 1; index < count; index++) {
      const age = count - 1 - index;
      const recency = Math.pow(this.continuity.recency ?? 0.75, age);
      const dt = this.onsets[index]! - this.onsets[index - 1]!;
      const beats = Math.max(1, Math.round(dt / period));
      const residual = Math.abs(dt - beats * period) / period;
      let fit = gaussian(residual, 0.105) / beats;
      if (dt < period * 0.75) {
        // Sub-beat interval (half, third, two-thirds): residuals stay in
        // whole-beat units so the tolerance is the same absolute phase error
        // as for a full beat.
        fit = Math.max(
          fit,
          SUBDIVISION_CREDIT * gaussian(Math.abs(dt - period / 2) / period, 0.105),
          TRIPLET_CREDIT * gaussian(Math.abs(dt - period / 3) / period, 0.105),
          TRIPLET_CREDIT * gaussian(Math.abs(dt - period * 2 / 3) / period, 0.105),
        );
      }
      adjacent += recency * fit;
      adjacentWeight += recency;
    }
    for (let index = 0; index < count; index++) for (let distance = 2; distance <= MAX_LOOKAHEAD; distance++) {
      const next = index + distance; if (next >= count) break;
      const age = count - 1 - next, pairWeight = Math.pow(this.continuity.recency ?? 0.75, age) / distance;
      const dt = this.onsets[next]! - this.onsets[index]!;
      const beats = Math.max(1, Math.round(dt / period));
      const residual = Math.abs(dt - beats * period) / period;
      context += pairWeight * gaussian(residual, 0.08) / Math.sqrt(beats);
      contextWeight += pairWeight;
    }
    const adjacentFit = adjacentWeight ? adjacent / adjacentWeight : 0;
    const contextFit = contextWeight ? context / contextWeight : adjacentFit;
    return adjacentFit * 0.72 + contextFit * 0.28;
  }

  /** Advance the predicted grid. `now` is audio-clock seconds. */
  update(now: number): void {
    if (!Number.isFinite(now)) return;
    if (this.locked && this.bpm && Number.isFinite(this.lastOnsetTime)) {
      const period = 60 / this.bpm;
      const timeout = Math.max(2.5, period * (this.continuity.coastBeats ?? 4));
      const silentFor = now - this.lastOnsetTime;
      if (silentFor > timeout) {
        this.confidence = Math.min(this.confidence, Math.max(0, 1 - (silentFor - timeout) / timeout));
        if (silentFor > timeout * 1.5 || this.confidence < UNLOCK_THRESHOLD) {
          this.locked = false; this.nextBeat = 0; this.phase = 0; this.unlockEvidence = 0;
          return;
        }
      }
    }
    if (!this.locked || !this.bpm) { this.phase = 0; return; }
    const period = 60 / this.bpm;
    if (!this.nextBeat) this.nextBeat = now + period;

    let guard = 4;
    while (now >= this.nextBeat && guard-- > 0) {
      this.nextBeat += period;
      this.beatIndex++;
    }
    if (now >= this.nextBeat) this.nextBeat = now + period;

    this.phase = 1 - Math.max(0, Math.min(1, (this.nextBeat - now) / period));
  }

  /** Continuous position in slots. Fractional; monotonic while locked. */
  slotAt(now: number): number {
    if (!this.locked || !this.bpm) return 0;
    const period = 60 / this.bpm;
    const beats = this.beatIndex + this.phase;
    void period; void now;
    return beats * SLOTS_PER_BEAT;
  }
}

/**
 * Look-ahead scheduler (plan §4.3).
 *
 * The whole point: firing on a division at `t_event − anchorOffset` makes the
 * visual PEAK on the transient instead of starting there. Reacting is always
 * ~250 ms late and no detection tuning fixes it.
 */
export interface ScheduledEvent {
  /** Audio-clock time the musical event lands. */
  time: number;
  /** Slot index of that event. */
  slot: number;
  division: DivisionName;
}

export class Scheduler {
  private lastSlot = new Map<DivisionName, number>();
  /** Extra seconds of look-ahead beyond the attack, for output latency. */
  outputLatency = 0;

  reset(): void { this.lastSlot.clear(); }

  /**
   * Events for `division` that should FIRE between now and now+horizon,
   * already compensated so the effect peaks on the beat.
   */
  due(
    tempo: TempoTracker,
    now: number,
    division: DivisionName,
    attack: number,
  ): ScheduledEvent[] {
    if (!tempo.locked || !tempo.bpm) return [];
    const period = 60 / tempo.bpm;
    const secPerSlot = period / SLOTS_PER_BEAT;
    const stride = DIVISIONS[division];

    // Fire early by attack + output latency so the peak lands on the event.
    const lead = attack + this.outputLatency;
    const fireHorizon = now + lead;

    const slotNow = (tempo.beatIndex + tempo.phase) * SLOTS_PER_BEAT;
    const slotHorizon = slotNow + lead / secPerSlot;

    const out: ScheduledEvent[] = [];
    const first = Math.ceil(slotNow / stride) * stride;
    const prev = this.lastSlot.get(division) ?? first - stride;

    for (let s = first; s <= slotHorizon; s += stride) {
      if (s <= prev) continue;
      this.lastSlot.set(division, s);
      out.push({
        time: now + (s - slotNow) * secPerSlot,
        slot: s,
        division,
      });
      if (out.length > 16) break; // backstop against a bad tempo estimate
    }
    void fireHorizon;
    return out;
  }
}

function wrapSigned(v: number, period: number): number {
  const m = ((v % period) + period) % period;
  return m > period / 2 ? m - period : m;
}

/** Tie resolution for metrically related readings; see the octave rule above. */
export function preferredReading(options: readonly number[]): number {
  let inBand = 0;
  for (const bpm of options) {
    if (bpm >= PREFERRED_BAND_LO && bpm < PREFERRED_BAND_HI && (!inBand || bpm < inBand)) inBand = bpm;
  }
  if (inBand) return inBand;
  return options.reduce((a, b) =>
    Math.abs(Math.log2(b / PREFERRED_BPM)) < Math.abs(Math.log2(a / PREFERRED_BPM)) ? b : a);
}

/** Highest bank score within ±OCTAVE_PEAK_WINDOW of `target`, if in range. */
function peakNear(scores: ReadonlyArray<{ bpm: number; score: number }>, target: number): { bpm: number; score: number } | null {
  if (target < MIN_BPM || target > MAX_BPM) return null;
  let peak: { bpm: number; score: number } | null = null;
  for (const candidate of scores) {
    if (Math.abs(candidate.bpm - target) > target * OCTAVE_PEAK_WINDOW) continue;
    if (!peak || candidate.score > peak.score) peak = candidate;
  }
  return peak;
}

function gaussian(value: number, sigma: number): number {
  const normalized = value / sigma;
  return Math.exp(-0.5 * normalized * normalized);
}
