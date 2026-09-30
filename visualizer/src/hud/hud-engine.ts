/** Original procedural HUD engine. Timing constants are authored defaults, not measurements of a commercial interface.
 * DOM-free: compile once, evaluate all values from media time, then draw. Live audio is decoration only.
 * No accumulated authoritative state: counters, trails, cues and locks reconstruct directly after a seek. */
import { HUD_KINDS, HUD_STATIC_SIGNALS, KIND_SPECS, HUD_BUDGET, HUD_DEFAULTS, parseHudManifest, parseHudSignal, resolvePalette, isAuthoritative,
  type HudManifest, type HudInstrument, type HudKind, type HudSignalRef, type HudSignalInfo, type HudPaletteKey } from './hud-manifest.ts';
import { deriveHudTiming, evalHudEvents, hudEventField, hudTimingValue, resolveHudTimeRef, hudCountdown,
  HUD_SWEEP_SECONDS, HUD_EVENT_TAU, HUD_EVENT_FAR, HUD_FREE_BARS, HUD_FALLBACK_BPM,
  type HudTiming, type HudTimingInput, type HudEventValues } from './hud-clock.ts';
import { emptyHudSignals, unpackHudSignals, type HudSignalsV2 } from './hud-signals.ts';
import { Painter, clamp01, clamp, lerp, smooth01, hash01, hashText, mixHex, noise1, type PaintContext, type HudRenderStats, type HudTrace } from './hud-painter.ts';
import { drawGauges } from './hud-instruments-gauges.ts';
import { drawReadouts } from './hud-instruments-readouts.ts';
import { drawSpatial } from './hud-instruments-spatial.ts';
import { drawSignal } from './hud-instruments-signal.ts';

export const HUD_TIMING = Object.freeze({ trailHold: 0.45, trailDecay: 0.35, refill: 0.6, flickerPeriod: 0.25, flickerHold: 3 / 60,
  dangerHz: 2, tickHold: 0.08, tickHz: 8, urgentHz: 2, urgentScale: 1.08, zeroHoldBeats: 1.5, gazeOn: 0.35, gazeOff: 0.2,
  hurtThreshold: 0.8, hurtHold: 0.25, grinThreshold: 0.9, grinHold: 0.5, blinkMin: 3, blinkMax: 5, blinkHold: 0.1,
  lockEvery: 4, lockHold: 1, peakDecay: 0.6, comboWindow: 0.75, popHold: 6 / 60, popScale: 1.8, pulseHz: 2.5, strictHz: 2,
  flashPeriod: 1, flashHold: 0.08, flashAmount: 0.25, accentArea: 0.079, shakePx: 3, shakeHz: 4, reducedRain: 0.3,
  attentionCapacity: HUD_DEFAULTS.attentionCapacity, attentionRefill: HUD_DEFAULTS.attentionRefill, cueHold: HUD_DEFAULTS.cueHold, sampleAttack: 0.04, sampleRelease: 0.2,
  sweepSeconds: HUD_SWEEP_SECONDS, eventTau: HUD_EVENT_TAU, eventFar: HUD_EVENT_FAR, freeBars: HUD_FREE_BARS, fallbackBpm: HUD_FALLBACK_BPM,
  inertiaTaps: 8, inertiaSpan: 3,
});
export interface HudPolicy { readonly motion: 'full' | 'reduced'; readonly flash: 'off' | 'limit' | 'strict' }
export const DEFAULT_HUD_POLICY: HudPolicy = Object.freeze({ motion: 'full', flash: 'strict' });
export interface HudFrameInput extends HudTimingInput { readonly signals?: HudSignalsV2 | ArrayLike<number> | null; readonly revision?: number }
type Samples = { timing: HudTiming; events: Record<string, HudEventValues>; audio: HudSignalsV2; seed: number; values?: Float32Array; at?: (secondsAgo: number) => Samples };
type Reader = (s: Samples) => number;
interface CompiledLayer { layer: HudInstrument; rect: readonly [number, number, number, number]; index: number; seed: number; read: Reader; authoritative: boolean }
export interface HudDrawState {
  layer: HudInstrument; x: number; y: number; w: number; h: number; value: number; trail: number; number: number; text: string;
  color: string; secondary: string; palette: Readonly<Record<HudPaletteKey, string>>; timing: HudTiming; audio: HudSignalsV2;
  seed: number; policy: HudPolicy; alpha: number; accent: boolean; cueAge: number; cueStyle: string; lock: number; reduced: boolean; phase: number;
}
export interface HudEvaluation { timing: HudTiming; states: HudDrawState[]; reserved: number; flashes: number }

function signalReader(info: HudSignalInfo | null): Reader {
  if (!info) return () => 0;
  if (info.group === 'const') return () => Number(info.field);
  if (info.group === 'seed') return s => noise1(s.seed ^ Number(info.field), s.timing.localTime / HUD_TIMING.sweepSeconds);
  if (info.group === 'ev') return s => Object.hasOwn(s.events, info.id!) ? hudEventField(s.events[info.id!]!, info.field) ?? 0 : NaN;
  if (info.group !== 'audio') return s => hudTimingValue(s.timing, info.group as 'clock' | 'interval' | 'iv' | 'track', info.field, info.id) ?? NaN;
  const keys = info.field.split('.');
  return s => {
    // Live sources hold their rest values during a pause/reset; AVS legacy and beat retain the ABI pass-through.
    if (!s.audio.live && keys[0] !== 'legacy' && keys[0] !== 'beat') return 0;
    const source = keys[0] === 'tension' || keys[0] === 'slope' ? s.audio.contour : s.audio;
    let out: unknown = source;
    for (const k of keys) out = out && typeof out === 'object' ? (out as Record<string, unknown>)[k] : undefined;
    return typeof out === 'boolean' ? Number(out) : typeof out === 'number' && Number.isFinite(out) ? out : 0;
  };
}
const curve = (x: number, name = 'lin'): number => {
  const t = clamp01(x), [mode, arg] = name.split(':');
  return mode === 'smooth' ? smooth01(t) : mode === 'pow' || mode === 'exp' ? t ** Math.max(0.001, Number(arg) || 1) : mode === 'steps' ? Math.floor(t * (Number(arg) || 1)) / (Number(arg) || 1) : t;
};
/** Binding transforms are compiled once. Authoritative consumers ignore live audio even if passed an unvalidated manifest. */
function bindingReader(ref: HudSignalRef | undefined, fallback: number, authoritative: boolean, slot?: number): Reader {
  const spec = typeof ref === 'string' ? { src: ref } : ref;
  const info = parseHudSignal(spec?.src ?? `const.${fallback}`);
  const raw = signalReader(authoritative && info?.group === 'audio' ? null : info);
  const read: Reader = slot === undefined ? raw : s => s.values?.[slot] ?? raw(s);
  return s => {
    let v = read(s);
    if (!authoritative && info && spec && ((spec.atk ?? 0) > 0 || (spec.rel ?? 0) > 0)) {
      if (info.group === 'audio') {
        const [family, group, field] = info.field.split('.');
        if (family === 'onset' && (field === 'env' || field === 'strength') && s.audio.live && group && Object.hasOwn(s.audio.onset, group)) {
          const onset = s.audio.onset[group as keyof HudSignalsV2['onset']], age = Math.max(0, onset.ageSec);
          const attack = (spec.atk ?? 0) / 1000, release = (spec.rel ?? HUD_TIMING.sampleRelease * 1000) / 1000;
          v = onset.strength * (attack > 0 ? 1 - Math.exp(-age / attack) : 1) * (release > 0 ? Math.exp(-age / release) : age === 0 ? 1 : 0);
        }
        // Other live signals already carry bus-smoothed snapshot values. Per-binding inertia needs source history and is explicitly deferred.
      } else if (info.group !== 'const' && s.at) {
        const before = raw(s.at(Math.max(spec.atk ?? 0, spec.rel ?? 0) / 1000)), tau = (raw(s) >= before ? spec.atk ?? 0 : spec.rel ?? 0) / 1000;
        if (tau > 0 && Number.isFinite(v)) {
          // Authored causal finite impulse kernel, a closed-form weighted sum (no accumulated frame state).
          let sum = 0, weight = 0;
          for (let i = 0; i < HUD_TIMING.inertiaTaps; i++) {
            const offset = tau * HUD_TIMING.inertiaSpan * i / (HUD_TIMING.inertiaTaps - 1), k = Math.exp(-offset / tau), sample = i === 0 ? v : raw(s.at(offset));
            if (Number.isFinite(sample)) { sum += sample * k; weight += k; }
          }
          if (weight > 0) v = sum / weight;
        }
      }
    }
    if (!Number.isFinite(v)) v = spec?.fb ?? fallback;
    if (spec?.in) v = (v - spec.in[0]) / (spec.in[1] - spec.in[0] || 1);
    if (spec?.curve) v = curve(v, spec.curve);
    if (spec?.gate !== undefined) v = v >= spec.gate ? v : 0;
    if (spec?.steps) v = Math.floor(v * spec.steps) / spec.steps;
    if (spec?.out) v = lerp(spec.out[0], spec.out[1], v);
    return Number.isFinite(v) ? v : fallback;
  };
}

export class HudScene {
  readonly manifest: HudManifest;
  readonly palette: Readonly<Record<HudPaletteKey, string>>;
  readonly layers: readonly CompiledLayer[];
  readonly seed: number;
  /** Stable registry indices, useful for worker diagnostics. Dynamic interval/event names are appended at compile time. */
  readonly signalNames: readonly string[];
  readonly sampleReaders: readonly Reader[];
  private constructor(manifest: HudManifest) {
    this.manifest = manifest; this.palette = resolvePalette(manifest.palette); this.seed = hashText(manifest.id);
    const names = [...HUD_STATIC_SIGNALS], slots = new Map(names.map((name, i) => [name, i]));
    this.layers = manifest.layers.map((layer, index) => {
      const authoritative = isAuthoritative(layer), fallback = layer.k === 'pips' || layer.k === 'slots' ? 1 : 0.5;
      const defaultRef = layer.k === 'warning' ? 'interval.progress' : layer.k === 'counter' && layer.mode === 'static' ? `const.${layer.min ?? 0}` : layer.k === 'counter' && layer.mode === 'live' ? 'audio.onset.any.count' : KIND_SPECS[layer.k].bind ?? `const.${fallback}`;
      const ref = layer.v ?? defaultRef;
      const name = typeof ref === 'string' ? ref : ref.src;
      let slot = slots.get(name);
      if (slot === undefined) { slot = names.length; slots.set(name, slot); names.push(name); }
      const rect = layer.r.map((n, i) => n * (i % 2 === 0 ? manifest.canvas.w : manifest.canvas.h)) as [number, number, number, number];
      if (manifest.canvas.style === 'pixel') for (let i = 0; i < 4; i++) rect[i] = Math.round(rect[i]!);
      // Keep authoritative clock/event arithmetic in double precision: float32 progress can move an integer counter tick.
      return { layer, index, rect, seed: hashText(layer.id) ^ this.seed, read: bindingReader(ref, fallback, authoritative, authoritative ? undefined : slot), authoritative };
    }).sort((a, b) => (a.layer.z ?? 0) - (b.layer.z ?? 0) || a.index - b.index);
    this.signalNames = Object.freeze(names);
    this.sampleReaders = Object.freeze(names.map(name => signalReader(parseHudSignal(name))));
  }
  static compile(value: unknown): HudScene { return new HudScene(parseHudManifest(value)); }
}

/** Reusable painter and decoration slab. Revision changes clear all transient values; no timer depends on this state. */
export class HudRuntime {
  readonly painter = new Painter();
  readonly decoration = new Float32Array(96 * 72);
  readonly samples = new Float32Array(256);
  revision: number | undefined;
  constructor(readonly scene?: HudScene) {}
  reset(): void { this.decoration.fill(0); this.samples.fill(0); this.revision = undefined; }
}
function audioOf(input: HudFrameInput): HudSignalsV2 {
  const s = input.signals;
  return s && 'version' in s ? s as HudSignalsV2 : unpackHudSignals(s as ArrayLike<number> | undefined) ?? emptyHudSignals(input.time);
}
function cueAt(layer: HudInstrument, timing: HudTiming): { text: string; age: number; style?: string } | null {
  if (layer.k !== 'banner') return null;
  let chosen: { text: string; age: number; style?: string } | null = null;
  for (const cue of layer.cues) {
    const at = resolveHudTimeRef(cue.at, timing);
    if (at !== null) {
      const age = timing.time - at;
      if (age >= 0 && age < (cue.hold ?? HUD_TIMING.cueHold) && (!chosen || age < chosen.age)) chosen = { text: cue.text, age, style: cue.style };
    }
  }
  return chosen;
}
function activeWindow(layer: HudInstrument, timing: HudTiming): boolean {
  if (layer.k !== 'warning') return true;
  const from = layer.when ? resolveHudTimeRef(layer.when, timing) : null, to = layer.until ? resolveHudTimeRef(layer.until, timing) : null;
  if (layer.when && from === null || layer.until && to === null) return false;
  return (from === null || timing.time >= from) && (to === null || timing.time < to);
}
function timerNumber(layer: Extract<HudInstrument, { k: 'timer' }>, timing: HudTiming, value: number): number {
  const up = layer.dir === 'up', span = timing.scene;
  const bound = layer.v !== undefined;
  if (layer.unit === 'norm') return (bound ? clamp01(value) : up ? span.progress : 1 - span.progress) * (layer.total ?? 100);
  if (layer.unit === 'bars') return bound ? Math.max(0, value) : up ? span.elapsedBars : span.remainingBars;
  if (layer.unit === 'beats') return bound ? Math.max(0, value) : up ? span.elapsedBars * timing.beat.beatsPerBar : Math.max(0, timing.sceneBeats - timing.beat.scenePos);
  if (layer.total !== undefined && !bound) return (up ? span.progress : 1 - span.progress) * layer.total;
  return bound ? Math.max(0, value) : up ? span.elapsed : span.remaining;
}
function numberText(n: number, fmt: string, digits: number): string {
  const v = Math.floor(Math.max(-1e9, Math.min(1e9, n)));
  if (fmt === 'time') return `${Math.floor(Math.max(0, v) / 60).toString().padStart(2, '0')}:${(Math.max(0, v) % 60).toString().padStart(2, '0')}`;
  if (fmt === 'percent') return `${v}%`;
  if (fmt === 'money') return `$${v}`;
  if (String(Math.abs(v)).length > digits) return 'MAX';
  return fmt === 'pad0' || fmt === 'score' ? String(v).padStart(digits, '0') : String(v);
}

export function evaluateHudScene(scene: HudScene, input: HudFrameInput, policy: HudPolicy = DEFAULT_HUD_POLICY): HudEvaluation {
  const m = scene.manifest, timing = deriveHudTiming(input, m.timing?.freeBars ?? HUD_TIMING.freeBars, { declared: m.intervals });
  const audio = audioOf(input), events = evalHudEvents(m.events, timing), samples: Samples = { timing, audio, events, seed: scene.seed };
  const history = (anchor: HudTiming) => (secondsAgo: number): Samples => {
    const time = anchor.time - secondsAgo;
    const beat = anchor.beat.pos - secondsAgo * anchor.beat.bpm / 60;
    const past = deriveHudTiming({ ...input, time, track: { ...input.track, position: Math.max(0, input.track.position - (input.time - time)) },
      tempo: input.tempo ? { ...input.tempo, beatIndex: Math.floor(beat), beatPhase: beat - Math.floor(beat) } : null }, m.timing?.freeBars ?? HUD_TIMING.freeBars, { declared: m.intervals });
    return { timing: past, audio, seed: scene.seed, events: evalHudEvents(m.events, past) };
  };
  samples.at = history(timing);
  const hasTrail = scene.layers.some(c => c.layer.k === 'bar' && (c.layer.trail || c.layer.beh?.includes('ghost')));
  const oldSamples: Samples = hasTrail ? samples.at(HUD_TIMING.trailHold) : samples;
  if (hasTrail) oldSamples.at = history(oldSamples.timing);
  // One sampled space per instant; bindings read numeric slots, rather than parsing strings per instrument.
  samples.values = new Float32Array(scene.sampleReaders.map(read => read(samples)));
  if (hasTrail) oldSamples.values = new Float32Array(scene.sampleReaders.map(read => read(oldSamples)));
  let reserved = 0, flashes = 0;
  const states: HudDrawState[] = scene.layers.map(c => {
    const l = c.layer, value = c.read(samples), old = c.read(oldSamples), [x, y, w, h] = c.rect;
    let alpha = 1, number = value, text = '', cueAge = 1e9, cueStyle = '', lock = 0;
    let color = scene.palette[l.c ?? 'a1'];
    if (l.k === 'counter') {
      number = l.mode === 'interval' ? lerp(l.min ?? 0, l.max ?? 99999, curve(value, l.ease)) : value;
      text = numberText(number, l.fmt, l.digits) + (l.unit ?? '');
    } else if (l.k === 'timer') {
      number = timerNumber(l, timing, value);
      number = l.dir === 'up' ? Math.floor(number + 1e-9) : hudCountdown(number);
      text = numberText(number, l.unit === 'mmss' ? 'time' : 'int', 12);
      if (number <= (l.urgent ?? 10)) color = scene.palette.warn;
    } else if (l.k === 'label') text = l.text;
    else if (l.k === 'banner') {
      const cue = cueAt(l, timing); alpha = cue ? 1 : 0; text = cue?.text ?? ''; cueAge = cue?.age ?? 1e9; cueStyle = cue?.style ?? '';
      if (cue) reserved += 3;
    } else if (l.k === 'warning') {
      alpha = activeWindow(l, timing) && (l.when !== undefined || value > 0.5) ? 1 : 0;
      text = l.text; if (alpha && l.when) reserved += 2;
    } else if (l.k === 'reticle') {
      const cycle = (timing.beat.scenePos / timing.beat.beatsPerBar) % (l.lockEvery ?? HUD_TIMING.lockEvery);
      const hold = (l.lockHold ?? HUD_TIMING.lockHold) * timing.beat.bpm / 60 / timing.beat.beatsPerBar;
      lock = cycle < hold ? 1 : cycle < hold + 0.25 ? 1 - (cycle - hold) / 0.25 : 0;
      if (l.beh?.includes('lock') && lock > 0) reserved += 1;
    } else if (l.k === 'combo') {
      cueAge = audio.live ? audio.onset.any.ageSec : 1e9;
      alpha = cueAge < (l.window ?? HUD_TIMING.comboWindow) ? 1 : 0; text = l.text;
    }
    if (l.k === 'banner') {
      const cue = cueAt(l, timing);
      if (cue?.style === 'type') text = text.slice(0, Math.ceil(text.length * clamp01(cue.age / Math.min(0.6, HUD_TIMING.cueHold))));
    }
    if (l.k === 'pips' && l.v) number = value;
    if (l.beh?.includes('dangerPulse') && value < ('danger' in l ? l.danger ?? 0.25 : 0.25)) color = mixHex(color, scene.palette.bad, policy.motion === 'reduced' ? 0.5 : 0.35 + 0.15 * Math.sin(timing.localTime * Math.PI * 2 * HUD_TIMING.dangerHz));
    if ((l.beh?.includes('pulse') || l.k === 'warning') && policy.motion === 'full') {
      const hz = l.k === 'warning' ? Math.min(l.hz ?? 1, policy.flash === 'strict' ? HUD_TIMING.strictHz : HUD_TIMING.pulseHz) : 1;
      alpha *= 0.96 + 0.04 * Math.cos(timing.localTime * Math.PI * 2 * hz);
    }
    // Blink modulates alpha gently; no black/white square wave or saturated-red pulse.
    if ((l.beh?.includes('blink') || l.k === 'label' && l.blink) && policy.motion === 'full') alpha *= 0.9 + 0.1 * Math.cos(timing.localTime * Math.PI * 2);
    return { layer: l, x, y, w, h, value, trail: Math.max(value, old), number, text, color, secondary: scene.palette[l.c2 ?? 'a2'], palette: scene.palette,
      timing, audio, seed: c.seed, policy, alpha, accent: false, cueAge, cueStyle, lock, reduced: policy.motion === 'reduced', phase: timing.beat.phase } satisfies HudDrawState;
  });
  // Live grants occupy absolute time slots, rather than an FPS-dependent token bucket. Capacity is enforced per slot and refill by slot spacing.
  // This makes duplicate rendering, dropped frames and seeks identical for equal audio snapshots.
  const capacity = m.attention?.capacity ?? HUD_DEFAULTS.attentionCapacity, refill = m.attention?.refill ?? HUD_DEFAULTS.attentionRefill;
  let budget = Math.max(0, capacity - reserved);
  const priorities = { combo: 0, warning: 1, reticle: 2, portrait: 3, bar: 4, fx: 4, counter: 5 } as const;
  const candidates = states.filter(s => s.alpha > 0 && Object.hasOwn(priorities, s.layer.k)).sort((a, b) => priorities[a.layer.k as keyof typeof priorities] - priorities[b.layer.k as keyof typeof priorities]);
  const slotPeriod = Math.max(HUD_TIMING.flashPeriod, capacity / Math.max(0.1, refill));
  const slot = Math.floor(timing.localTime / slotPeriod), within = timing.localTime - slot * slotPeriod;
  for (const s of candidates) {
    const cost = s.layer.k === 'combo' ? 3 : s.layer.k === 'warning' || s.layer.k === 'fx' ? 2 : s.layer.k === 'counter' ? 0.1 : 0.5;
    if (s.layer.k === 'fx' && s.layer.fx === 'flash' && flashes > 0) continue;
    if (audio.live && audio.onset.any.ageSec < HUD_TIMING.flashHold && within < HUD_TIMING.flashHold && budget >= cost && !s.reduced) {
      s.accent = true; budget -= cost;
      if (s.layer.k === 'fx' && s.layer.fx === 'flash' && policy.flash !== 'off') flashes++;
    }
  }
  return { timing, states, reserved, flashes };
}

/** Fit original procedural text inside the instrument rectangle without measureText or external font data. */
export function drawHudText(p: Painter, s: HudDrawState, text: string, font = 'pixel', align: 'left' | 'center' | 'right' = 'center', factor = 1): void {
  if (!text) return;
  const inset = Math.min(2, s.w * 0.04, s.h * 0.04), cell = Math.max(0.01, Math.min((s.w - 2 * inset) / Math.max(1, text.length * 6), (s.h - 2 * inset) / 7) * factor);
  const x = align === 'left' ? s.x + inset : align === 'right' ? s.x + s.w - inset : s.x + s.w / 2;
  const y = s.y + (s.h - 7 * cell) / 2;
  if (font === 'seg') p.segText(text, x, y, cell * 4, cell * 7, Math.max(cell * 0.65, p.pixel ? 1 : 0.1), s.color, null, 1, align);
  else if ((font === 'mono' || font === 'display') && !p.pixel) p.text(text, x, y + cell * 6, cell * 7, s.color, 1, align, font);
  else p.pixelText(text, x, y, p.pixel && cell >= 1 ? Math.floor(cell) : cell, s.color, 1, align);
}

export const HUD_RENDERERS: Readonly<Record<HudKind, (p: Painter, s: HudDrawState) => void>> = Object.freeze(Object.fromEntries(HUD_KINDS.map(k => [k,
  ['bar', 'pips', 'matrix', 'dial', 'slots'].includes(k) ? drawGauges : ['label', 'counter', 'timer', 'terminal', 'warning', 'combo', 'banner'].includes(k) ? drawReadouts
    : ['panel', 'viewport', 'portrait', 'radar', 'reticle'].includes(k) ? drawSpatial : drawSignal])) as Record<HudKind, (p: Painter, s: HudDrawState) => void>);

export function renderHudScene(scene: HudScene, runtime: HudRuntime, ctx: PaintContext, width: number, height: number, input: HudFrameInput, policy: HudPolicy = DEFAULT_HUD_POLICY, trace?: HudTrace): HudRenderStats {
  if (input.revision !== runtime.revision) { runtime.reset(); runtime.revision = input.revision; }
  const e = evaluateHudScene(scene, input, policy), m = scene.manifest, p = runtime.painter;
  // The compile cache holds immutable static geometry/font data. Pure decoration is evaluated into reusable diagnostic slabs.
  for (let i = 0; i < e.states.length; i++) { const s = e.states[i]!; runtime.decoration[i * 72] = s.trail; runtime.decoration[i * 72 + 1] = s.lock; runtime.decoration[i * 72 + 2] = s.audio.live ? s.audio.rms : 0; }
  p.spy = trace ?? null;
  p.begin(ctx, width, height, m.canvas.w, m.canvas.h, m.canvas.style === 'pixel', { ...HUD_BUDGET.hard, saves: 96 }, scene.palette.ink);
  // One frame save plus one per instrument: 96-layer manifests shed their lowest-priority decoration, preserving clocks/banners.
  const rank = (s: HudDrawState) => s.layer.k === 'fx' ? 0 : s.layer.k === 'viewport' ? 1 : s.layer.k === 'panel' ? 2 : isAuthoritative(s.layer) || s.layer.k === 'banner' ? 5 : 3;
  const omitted = new Set(e.states.filter(s => s.alpha > 0).sort((a, b) => rank(a) - rank(b)).slice(0, Math.max(0, e.states.filter(s => s.alpha > 0).length - 95)));
  for (const s of e.states) {
    if (!(s.alpha > 0 && s.w > 0 && s.h > 0)) continue;
    // Leave capacity for timers/values: decorative detail degrades first, before the hard painter cap is reached.
    if (omitted.has(s) || (s.layer.k === 'fx' || s.layer.k === 'viewport') && (p.stats.draws > 350 || p.stats.paths > 1800)) { p.stats.degraded++; continue; }
    p.layerId = s.layer.id; p.alphaScale = s.alpha;
    if (!p.clipBegin(s.x, s.y, s.w, s.h)) { p.stats.degraded++; continue; }
    HUD_RENDERERS[s.layer.k](p, s); p.clipEnd(); p.stats.instruments++;
    p.spy?.(s.layer.id, 'value', s.number, s.trail);
  }
  p.stats.flashEvents = e.flashes; p.end();
  return { ...p.stats };
}
export type { PaintContext, HudRenderStats, HudTrace } from './hud-painter.ts';
