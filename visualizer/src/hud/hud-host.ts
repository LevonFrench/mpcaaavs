/** Shared HUD host adapter. Transport and persistence stay in the native/Player adapters. */
import type { AvsAudioFrame } from '../avs/types.ts';
import type { LocalAvsPreset, LocalHudMeta } from '../avs/local-collection.ts';
import { isSceneKind } from '../avs/local-collection.ts';
import type { HudPlaybackFrame } from '../avs-worker-protocol.ts';
import type { SourcePcm } from '../mpc-audio-stream.ts';
import type { SceneTraits } from '../render-resolution.ts';
import { builtinDefault, canonicalPackLabel, HUD_ROOT_LABEL } from '../mpc-folder-defaults.ts';
import { defaultSceneTiming } from '../mpc-scene-clock.ts';
import type { PresetSetup } from '../mpc-setups.ts';
import { TRANSITION_COUNT } from '../mpc-contract.ts';
import { HudSignalBus, HUD_SIGNAL_OFFSETS, emptyHudSignals, packHudSignals, type HudSignalOptions } from './hud-signals.ts';
export { isSceneKind };
export { fetchLocalHudTitles, parseHudTitles, type HudTitleMap } from '../avs/preset-categories.ts';

export function sceneWorkerUrl(kind: string | undefined): string {
  return kind === 'hud' ? 'hud-render.worker.js' : kind === 'nerv' ? 'nerv-render.worker.js' : 'avs-render.worker.js';
}
/** Catalog metadata permits sizing before fetching the manifest. Pixel aspect is authored width/height. */
export function hudTraits(meta: LocalHudMeta | null | undefined): SceneTraits {
  if (!meta) return {};
  const { w, h, style, par } = meta.canvas;
  const logical = { width: w, height: h };
  return { logical, ...(style === 'pixel' ? { pixelGrid: { ...logical, ...(par ? { par: par[0] / par[1] } : {}) } } : {}) };
}

/** One analysis bus for the host, fed only normalized 44.1kHz hops. Snapshots have independent buffers for concurrent slots. */
export class HudFeed {
  readonly bus: HudSignalBus;
  constructor(options?: Partial<HudSignalOptions>) { this.bus = new HudSignalBus(options); }
  pushHop(hop: SourcePcm): void { this.bus.push(hop.pcm, hop.time); }
  reset(): void { this.bus.reset(); }
  snapshot(time: number, audio: AvsAudioFrame, live = true): Float32Array {
    const out = this.bus.snapshot(time, audio);
    if (!live) out[HUD_SIGNAL_OFFSETS.live] = 0;
    return out;
  }
}

export type HudFrameOptions = Partial<HudPlaybackFrame> & { readonly time: number };
/** The caller supplies absolute scene bounds and resolved named intervals; missing duration means unknown, never a deadline. */
export function buildHudFrame(input: HudFrameOptions): HudPlaybackFrame {
  const time = Number.isFinite(input.time) ? Math.max(0, input.time) : 0;
  return { ...input, time, seed: (input.seed ?? 1) >>> 0, revision: (input.revision ?? 0) >>> 0,
    grid: input.grid ?? null, sceneStart: input.sceneStart ?? time, sceneEnd: input.sceneEnd ?? null, tempo: input.tempo ?? null,
    track: input.track ?? { position: time, duration: null }, signals: input.signals ?? packHudSignals(emptyHudSignals(time)),
    motion: input.motion ?? 'full', flash: input.flash ?? 'strict' };
}

/** A bounded editable template; Play folder remains uncapped through the separate folder planner. */
export function hudSetup(catalog: readonly LocalAvsPreset[], pack?: string): PresetSetup | null {
  const label = pack ? canonicalPackLabel(pack) : HUD_ROOT_LABEL;
  if (!label) return null;
  const rows = catalog.filter(p => p.kind === 'hud' && p.autoEligible && !p.notWorking && (!pack || canonicalPackLabel(p.hud?.pack ?? p.folder?.split('/')[0] ?? '') === label))
    .sort((a, b) => (a.hud?.order ?? 0) - (b.hud?.order ?? 0) || a.sha256.localeCompare(b.sha256));
  const defaults = builtinDefault(label, TRANSITION_COUNT);
  if (!rows.length || !defaults) return null;
  return { id: 'hud-scene-set', name: pack ? `HUD / ${label}` : 'HUD / repeatable sequence', presets: rows.slice(0, 500).map(p => p.sha256),
    settings: { ...defaults.settings }, timing: { ...defaultSceneTiming, enabled: true, barsPerScene: defaults.barsPerScene } };
}
