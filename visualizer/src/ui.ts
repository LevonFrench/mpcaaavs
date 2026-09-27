// The layer stack panel (plan §11, Phase 3: "add/remove/reorder-by-drag,
// solo/mute, preset save/load, URL-hash sharing").
//
// Its job is to be the hands on the data-driven renderer. `layers.ts` already
// turns an ordered list of `LayerSpec` into a pass plan every frame; until this
// file existed there was no way to change that list except by editing source,
// which makes a stack of five layers with ten blend modes a thing you can
// describe but not use.
//
// Three decisions shape everything below, and each one was forced by the
// existing API rather than chosen for elegance:
//
// 1. THE PANEL DOES NOT OWN THE STACK. `LayerStack` is the authority; this file
//    reads `stack.all` on every refresh and never keeps a parallel array of
//    layers. A UI that mirrors its model has to keep the mirror in step with
//    every path that mutates the model — drag, undo, preset load, and whatever
//    the host does — and the failure mode is a row that controls a layer which
//    is no longer where the row thinks it is. What this file DOES own is the
//    preset metadata the stack does not hold: name, seed and palette.
//
// 2. HOT EDITS ARE WRITTEN THROUGH THE SPEC; STRUCTURAL EDITS REBUILD THE LAYER.
//    `Layer` caches exactly two things from its spec in the constructor —
//    `strideSlots` (from `trigger.division`) and the Euclidean `pattern` (from
//    `euclidK`/`euclidN`) — plus its seed, from the layer id. Every other field
//    is read fresh from `spec` each frame. So opacity, blend, family, envelope,
//    palette slot and resolution scale can be written straight into the live
//    spec and take effect on the next frame, while a division change has to
//    remove and re-add the layer. That asymmetry is not laziness: rebuilding on
//    every `input` event of an opacity slider resets `triggeredAtBeats` to
//    -Infinity, which drops the layer to progress 0 until its next pulse — on a
//    `bar` division that is up to four beats of the layer simply vanishing
//    while you drag it. See `hotSet`.
//
// 3. THE PANEL MUST NOT EAT THE PAGE'S SHORTCUTS. `main.ts` binds single letters
//    (`k`, `h`, `d`, `t`, digits, brackets) on `window`. Typing `128` into a
//    seed box would otherwise fire three kaleidoscope segment changes. The guard
//    is a CAPTURE-phase listener on `window` that stops propagation when the
//    event target is a text field, a number field or a select — capture at
//    `window` runs before any bubble-phase listener on `window` regardless of
//    which was registered first, which is the only ordering-independent way to
//    do this without editing `main.ts`.
//
// What this file deliberately does NOT do: touch a GPUDevice or the renderer,
// edit the palette (that is a separate control surface and mixing it in here
// would make this file the place where every future control lands), evaluate an
// envelope, read a clock, or decide what any layer type draws. It also does not
// generate ids from `Date.now()` or `Math.random()` — a preset saved from this
// panel has to be byte-reproducible (§4.7), so new layer ids are the type name
// plus the lowest free integer.

import {
  type LayerFamily,
  type LayerSpec,
  type PaletteSlot,
  type Palette,
  type PassRegistry,
  type Preset,
  PRESET_VERSION,
  PresetVersionError,
} from './contracts.ts';
import type { BlendMode } from './contracts.ts';
import { DIVISIONS, type DivisionName } from './clock.ts';
import type { LayerStack } from './layers.ts';
import { PresetError, encodeHash, deserialise, serialise } from './preset.ts';
import { paramMax, paramMin, paramStep, type ParamDescriptor } from './params/descriptor.ts';
import { CRATE_GO_KEY, CRATE_SEARCH_KEY, CratePanel } from './crate/crate.ts';
import { browserCrateStorage, type CrateBank, type CrateEntry } from './crate/crate-model.ts';
import { flashFlagFor } from './crate/flash-flags.ts';

// ---------------------------------------------------------------------------
// Enumerations offered by the controls
//
// Listed here rather than derived from the types, for the same reason
// `preset.ts` lists them: a TypeScript union does not survive to runtime. These
// must stay in step with `preset.ts`'s validators — a mode offered in a dropdown
// that the validator then rejects on save is the worst of both.
// ---------------------------------------------------------------------------

const FAMILIES: readonly LayerFamily[] = ['source', 'warp', 'color', 'feedback', 'operator'];

const BLENDS: readonly BlendMode[] = [
  'replace', 'add', 'max', 'min', '50/50',
  'subtract', 'multiply', 'xor', 'adjustable', 'alpha',
];

const PALETTE_SLOTS: readonly PaletteSlot[] = ['bg', 'primary', 'secondary', 'accent'];

/** Ordered as `clock.ts` declares them: straight, then triplet, quintuplet, dotted. */
const DIVISION_NAMES = Object.keys(DIVISIONS) as readonly DivisionName[];

/** Plan §4.11: new layers render at half and get promoted deliberately. */
const DEFAULT_RESOLUTION_SCALE = 0.5;

/**
 * The per-layer sliders, described as parameter descriptors so their bounds
 * come from one place and the widget reads them through `paramMin`/`paramMax`/
 * `paramStep` like every other surface (software-architect review §3.5).
 *
 * Declared here only because `src/params/` does not export layer-field
 * descriptors yet — these are LayerSpec fields (`opacity`, `resolutionScale`,
 * `params.mix`), not globals, so none of them is in `globals.ts`. When params
 * grows a `LAYER_FIELD_PARAMS` export, this table should be deleted in favour
 * of an import; the call sites already take a descriptor.
 */
const LAYER_FIELD_PARAMS = {
  opacity: {
    id: 'layer.opacity', label: 'opacity', kind: 'number', lane: 'native',
    defaultValue: 1, min: 0, max: 1, step: 0.01, group: 'layer',
  },
  resolutionScale: {
    id: 'layer.resolutionScale', label: 'res scale', kind: 'number', lane: 'native',
    defaultValue: DEFAULT_RESOLUTION_SCALE, min: 0.05, max: 1, step: 0.05, group: 'layer',
  },
  mix: {
    id: 'layer.blendMix', label: 'blend mix', kind: 'number', lane: 'native',
    defaultValue: 0.5, min: 0, max: 1, step: 0.01, group: 'layer',
    hint: 'adjustable blend only',
  },
} as const satisfies Record<string, ParamDescriptor>;

/**
 * Where the stylesheet is fetched from.
 *
 * Resolved against this module's own URL rather than the document, so it is
 * correct both bundled (`dist/main.js` -> `../src/ui.css`) and when a module is
 * loaded straight from `src/`. A build that relocates the CSS should pass
 * `styleHref` instead of moving this.
 */
// Source and bundle each sit beside their stylesheet (`src/ui.css` and
// `dist/ui.css`), so the public runtime never needs the private source tree.
const DEFAULT_STYLE_HREF = new URL('./ui.css', import.meta.url).href;

/** Toggles the panel body. `l` for layers; deliberately not one of `main.ts`'s letters. */
const DEFAULT_TOGGLE_KEY = 'l';

// ---------------------------------------------------------------------------
// Host contract
// ---------------------------------------------------------------------------

/**
 * The three numbers the transport strip shows, read once per frame by the
 * caller and passed down — the same discipline as `AudioSnapshot`, and for the
 * same reason. A panel that reached into the tempo tracker itself would sample
 * at a different point in the frame from the renderer and disagree with it about
 * where the bar line is.
 *
 * `beats` is CONTINUOUS and fractional. Bar and beat are derived here rather
 * than passed in, because two callers deriving them separately is two chances to
 * get the 1-based display off by one.
 */
export interface TransportReadout {
  readonly bpm: number;
  readonly locked: boolean;
  /** 0..1, straight from `Timeline.confidence`. Shown as a percentage, never as a boolean (§12). */
  readonly confidence: number;
  readonly beats: number;
  readonly playing: boolean;
  readonly canControl: boolean;
}

export interface LayerUIOptions {
  readonly stack: LayerStack;
  /** Supplies name, seed and palette — the parts of a preset the stack does not hold. */
  readonly preset: Preset;
  /**
   * The registered pass types, for the "add layer" menu. Optional: without one
   * the panel still edits an existing stack, it just cannot add to it, which is
   * a better failure than offering a type the renderer has never heard of.
   */
  readonly registry?: PassRegistry;
  /** Bundled binary Winamp AVS presets, grouped by their source collection. */
  readonly avsPresets?: readonly {
    readonly id: string;
    readonly name: string;
    readonly collection: string;
  }[];
  /** Called when a bundled Winamp AVS preset is chosen. */
  readonly onPickAvsPreset?: (id: string) => void | Promise<void>;
  /** Lazy local/private collection. It is never bundled into the public app. */
  readonly onRequestLocalAvsPresets?: () => Promise<readonly { readonly id: string; readonly name: string; readonly collection?: string }[]>;
  readonly onPickLocalAvsPreset?: (id: string) => void | Promise<void>;
  /** Origin-local personal AVS bank entries. */
  readonly personalAvsPresets?: readonly { readonly id: string; readonly name: string }[];
  readonly onPickPersonalAvsPreset?: (id: string) => void | Promise<void>;
  readonly onAddPersonalAvsPreset?: () => void | Promise<void>;
  readonly onRemovePersonalAvsPreset?: (id: string) => void | Promise<void>;
  readonly onImportPersonalAvsBank?: (file: File) => void | Promise<void>;
  readonly onExportPersonalAvsBank?: () => void | Promise<void>;
  /** Called when automatic changes are toggled. */
  readonly onAutoChange?: (enabled: boolean) => void;
  /** Pause or resume the audio-clock transport. */
  readonly onTogglePlayback?: () => void | Promise<void>;
  /** Jump exactly one musical bar backward or forward. */
  readonly onSkipBar?: (direction: -1 | 1) => void | Promise<void>;
  /**
   * A whole new preset should be adopted — a file was loaded, or the seed
   * changed. The host owns the reload (`stack.load`, palette, renderer state)
   * because it knows what else depends on it; when it is done it must call
   * `setPreset` so the panel resyncs. This is a REQUEST, not a notification.
   */
  onLoadPreset(preset: Preset): void;
  /** Optional binary Winamp AVS import path. */
  onLoadAvsPreset?(bytes: Uint8Array, fileName: string): void | Promise<void>;
  /** Any edit at all, hot or structural. For marking the show dirty, or persisting. */
  onEdit?(): void;
  readonly host?: HTMLElement;
  readonly styleHref?: string;
  /** Start expanded. Defaults to true; the golden harness passes false. */
  readonly open?: boolean;
  readonly toggleKey?: string;
}

// ---------------------------------------------------------------------------
// Spec editing
// ---------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Fields a live `Layer` re-reads from its spec every frame, and which can
 * therefore be written in place.
 *
 * Derived by reading `Layer`'s constructor rather than by assumption: anything
 * it caches is excluded. `trigger` is absent from this list even though
 * `probability` and `offsetSteps` within it ARE read live, because a
 * field-level exception inside an object-level rule is exactly the sort of
 * thing that is true until someone edits the neighbouring line.
 */
type HotField = 'family' | 'blend' | 'opacity' | 'envelope' | 'palette' | 'enabled'
  | 'resolutionScale' | 'anchor' | 'params';

/**
 * Write a field into a live spec.
 *
 * `LayerSpec` is `readonly` throughout, and that is right — it is the thing that
 * round-trips to JSON and it must not drift under the renderer mid-frame. This
 * is the one sanctioned mutation, and it is narrowed to `HotField` so the cast
 * cannot quietly grow to cover `id` (which seeds the layer) or `trigger`
 * (which `Layer` caches). Anything outside that set goes through `rebuild`.
 */
function hotSet<K extends HotField>(spec: LayerSpec, key: K, value: LayerSpec[K]): void {
  (spec as Mutable<LayerSpec>)[key] = value;
}

/**
 * A new layer's starting point.
 *
 * Exported because "what does a fresh layer look like" is a UI decision — the
 * gesture is "add a layer", and the defaults are what makes that gesture
 * produce something visible — but it is worth a caller being able to reuse it
 * for a starter preset.
 *
 * The envelope is 1/8 beat attack against a 1 beat release: fast attack, slow
 * release, roughly 8:1 (art direction §3.2). Linear or symmetric would read as
 * a bouncing progress bar the moment it hit a track.
 */
export function defaultLayerSpec(
  id: string,
  type: string,
  family: LayerFamily,
  resolutionScale = DEFAULT_RESOLUTION_SCALE,
): LayerSpec {
  return {
    id,
    type,
    family,
    params: {},
    // A source with `replace` would erase everything under it, which reads as
    // "adding a layer broke the stack". Additive is the AVS default and the
    // forgiving one; everything else transforms what is already there.
    blend: family === 'source' ? 'add' : 'replace',
    opacity: 1,
    envelope: { attackBeats: 0.125, holdBeats: 0, releaseBeats: 1 },
    trigger: { division: 'beat', euclidK: 1, euclidN: 1, probability: 1, offsetSteps: 0 },
    anchor: 'peak',
    palette: 'primary',
    enabled: true,
    resolutionScale,
  };
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fillSelect(node: HTMLSelectElement, values: readonly string[], current: string): void {
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    node.append(opt);
  }
  node.value = current;
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

/** An icon button. Always a real `<button>`; a div with a click handler is unreachable by keyboard. */
function iconButton(glyph: string, label: string, extra = ''): HTMLButtonElement {
  const b = el('button', `ui-icon ${extra}`.trim(), glyph);
  b.type = 'button';
  b.title = label;
  // The glyph is decorative and unpronounceable, so the accessible name comes
  // from here rather than from the text content.
  b.setAttribute('aria-label', label);
  return b;
}

/** Text fields, number fields and selects swallow letters; buttons do not. */
function isTextEntry(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true;
  if (node instanceof HTMLInputElement) {
    return node.type !== 'button' && node.type !== 'checkbox' && node.type !== 'radio';
  }
  return false;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Deterministic, lowercase, safe for a filename. No timestamps (§4.7). */
function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'preset';
}

function chooseRandomPreset(select: HTMLSelectElement): boolean {
  const candidates = [...select.options].filter((entry) => entry.value && !entry.disabled);
  if (candidates.length === 0) return false;
  const alternatives = candidates.length > 1
    ? candidates.filter((entry) => entry.value !== select.value)
    : candidates;
  const entropy = new Uint32Array(1);
  crypto.getRandomValues(entropy);
  const selected = alternatives[entropy[0]! % alternatives.length]!;
  select.value = selected.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function presetIconButton(label: string, glyph: string): HTMLButtonElement {
  const button = el('button', 'ui-preset-icon-button', glyph);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
}

function presetPicker(button: HTMLButtonElement, select: HTMLSelectElement): HTMLElement {
  const picker = el('div', 'ui-preset-picker');
  picker.append(button, select);
  return picker;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export class LayerUI {
  readonly root: HTMLElement;
  private avsPresetSelect: HTMLSelectElement | null = null;
  private localAvsPresetSelect: HTMLSelectElement | null = null;
  private personalAvsPresetSelect: HTMLSelectElement | null = null;
  private personalAvsRandomButton: HTMLButtonElement | null = null;
  private personalAvsAddButton: HTMLButtonElement | null = null;
  private personalAvsRemoveButton: HTMLButtonElement | null = null;
  private personalAvsCanAdd = false;
  private autoBox: HTMLInputElement | null = null;
  /** The searchable crate/cue browser. Null when the host offers no AVS source. */
  private crate: CratePanel | null = null;
  private localCatalogLoad: Promise<void> | null = null;

  private readonly opts: LayerUIOptions;
  private readonly stack: LayerStack;
  private readonly toggleKey: string;

  /** The parts of a preset `LayerStack` does not hold. */
  private presetName: string;
  private presetSeed: number;
  private palette: Palette;

  private readonly body: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly list: HTMLUListElement;
  private readonly statusLine: HTMLElement;
  private readonly addSelect: HTMLSelectElement;
  private readonly addButton: HTMLButtonElement;
  private readonly nameInput: HTMLInputElement;
  private readonly seedInput: HTMLInputElement;

  /** Transport readouts. Written per frame, so they are held rather than queried. */
  private readonly outBpm: HTMLElement;
  private readonly outLock: HTMLElement;
  private readonly outPos: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly previousBarButton: HTMLButtonElement;
  private readonly nextBarButton: HTMLButtonElement;
  private lastBpmText = '';
  private lastLockText = '';
  private lastPosText = '';

  private openState: boolean;
  /** Id of the row being dragged, or null. The only drag state that needs to outlive an event. */
  private dragId: string | null = null;
  /** Monotonic, for `for`/`id` pairs. Not a layer identity — layer ids can contain anything. */
  private uid = 0;

  constructor(opts: LayerUIOptions) {
    this.opts = opts;
    this.stack = opts.stack;
    this.toggleKey = (opts.toggleKey ?? DEFAULT_TOGGLE_KEY).toLowerCase();
    this.presetName = opts.preset.name;
    this.presetSeed = opts.preset.seed;
    this.palette = opts.preset.palette;
    this.openState = opts.open ?? true;

    ensureStylesheet(opts.styleHref ?? DEFAULT_STYLE_HREF);

    this.root = el('section');
    this.root.id = 'aaavs-ui';
    this.root.setAttribute('aria-label', 'Layer stack');

    // --- header ------------------------------------------------------------
    const head = el('div', 'ui-head');
    const title = el('h2', 'ui-title');
    title.innerHTML = '<b>aaavs</b><span>live set</span>';
    this.toggleBtn = el('button', 'ui-icon', '–');
    this.toggleBtn.type = 'button';
    this.toggleBtn.title = `Collapse or expand (${this.toggleKey})`;
    this.toggleBtn.setAttribute('aria-label', 'Collapse or expand the layer stack panel');
    this.toggleBtn.addEventListener('click', () => this.toggle());
    head.append(title, this.toggleBtn);

    this.body = el('div', 'ui-body');
    this.body.id = 'aaavs-ui-body';
    this.toggleBtn.setAttribute('aria-controls', this.body.id);

    // --- transport ---------------------------------------------------------
    const transport = el('div', 'ui-section ui-transport-section');
    const transportLegend = el('span', 'ui-legend ui-sr-only', 'live transport');
    const stats = el('dl', 'ui-transport');
    const bpmStat = this.stat('tempo', 'bpm');
    const lockStat = this.stat('lock', 'confidence');
    const posStat = this.stat('position', 'bar . beat');
    this.outBpm = bpmStat.value;
    this.outLock = lockStat.value;
    this.outPos = posStat.value;
    stats.append(bpmStat.node, lockStat.node, posStat.node);
    const transportControls = el('div', 'ui-transport-controls');
    this.previousBarButton = el('button', 'ui-transport-button', '−1');
    this.previousBarButton.type = 'button';
    this.previousBarButton.setAttribute('aria-label', 'Previous bar');
    this.previousBarButton.title = 'Previous bar (Left Arrow)';
    this.previousBarButton.addEventListener('click', () => { void opts.onSkipBar?.(-1); });
    this.playButton = el('button', 'ui-transport-button is-primary', 'Ⅱ');
    this.playButton.type = 'button';
    this.playButton.setAttribute('aria-label', 'Pause');
    this.playButton.title = 'Pause or resume (Space)';
    this.playButton.addEventListener('click', () => { void opts.onTogglePlayback?.(); });
    this.nextBarButton = el('button', 'ui-transport-button', '+1');
    this.nextBarButton.type = 'button';
    this.nextBarButton.setAttribute('aria-label', 'Next bar');
    this.nextBarButton.title = 'Next bar (Right Arrow)';
    this.nextBarButton.addEventListener('click', () => { void opts.onSkipBar?.(1); });
    transportControls.append(this.previousBarButton, this.playButton, this.nextBarButton);
    transport.append(transportLegend, stats, transportControls);

    // --- presets -----------------------------------------------------------
    // Built here rather than left to the keyboard: the director shipped with
    // `P`/`,`/`.` bindings and no visible control, which is indistinguishable
    // from it not existing.
    const presetSection = el('div', 'ui-section ui-preset-section');
    const presetLegend = el('span', 'ui-legend', 'preset library');
    presetSection.append(presetLegend);
    const autoId = this.nextId('auto');
    const autoWrap = el('label', 'ui-check ui-auto');
    this.autoBox = el('input') as HTMLInputElement;
    this.autoBox.type = 'checkbox';
    this.autoBox.id = autoId;
    this.autoBox.addEventListener('change', () => {
      opts.onAutoChange?.(this.autoBox!.checked);
    });
    autoWrap.append(this.autoBox, document.createTextNode('auto / responsive 2–12 bars'));

    // The crate is the primary browser (review §3.2/§7b): search, chips, stars,
    // recents and a CUE slot, so browsing never cuts the live output. Its `go`
    // routes to the same `onPick…` handlers the selects below call, so there is
    // one live-load path however a preset is chosen.
    const hasAvsSources = Boolean(opts.avsPresets?.length || opts.onPickPersonalAvsPreset
      || (opts.onRequestLocalAvsPresets && opts.onPickLocalAvsPreset));
    if (hasAvsSources) {
      this.crate = new CratePanel({
        storage: browserCrateStorage(),
        onGo: (entry) => this.goCrateEntry(entry),
        ...(opts.onRequestLocalAvsPresets && opts.onPickLocalAvsPreset
          ? { requestLocal: () => this.ensureLocalCatalog() }
          : {}),
      });
      if (opts.avsPresets?.length) this.crate.setBank('bundled', opts.avsPresets);
    }
    // The original selects stay, folded away: bank management (+ / − / import /
    // export) still hangs off the My AVS select, and they remain a plain-DOM
    // fallback. They commit on `change` exactly as before.
    const classic = el('details', 'ui-preset-classic');
    classic.append(el('summary', 'ui-disclosure', 'lists · bank tools'));

    if (opts.avsPresets && opts.avsPresets.length > 0) {
      const row = el('div', 'ui-preset-row');
      const pid = this.nextId('avs-preset');
      const plabel = el('label', 'ui-preset-label', 'Original AVS');
      plabel.htmlFor = pid;
      this.avsPresetSelect = el('select');
      this.avsPresetSelect.id = pid;
      this.avsPresetSelect.className = 'ui-preset-select';
      const prompt = el('option');
      prompt.value = '';
      prompt.textContent = `choose from ${opts.avsPresets.length} presets…`;
      this.avsPresetSelect.append(prompt);
      const groups = new Map<string, HTMLOptGroupElement>();
      for (const preset of opts.avsPresets) {
        let group = groups.get(preset.collection);
        if (!group) {
          group = document.createElement('optgroup');
          group.label = preset.collection;
          groups.set(preset.collection, group);
          this.avsPresetSelect.append(group);
        }
        const option = el('option');
        option.value = preset.id;
        option.textContent = flagged(preset.name, 'bundled', preset.id, preset.collection);
        group.append(option);
      }
      this.avsPresetSelect.addEventListener('change', () => {
        const id = this.avsPresetSelect!.value;
        if (!id || !opts.onPickAvsPreset) return;
        const selected = opts.avsPresets?.find((preset) => preset.id === id);
        this.status(`loading ${selected?.name ?? 'AVS preset'}…`);
        void Promise.resolve(opts.onPickAvsPreset(id)).then(
          () => this.status(`loaded ${selected?.name ?? 'AVS preset'}`),
          (error) => this.status(String(error), true),
        );
      });
      const randomButton = presetIconButton('Random Original AVS preset', '⚄');
      randomButton.addEventListener('click', () => { chooseRandomPreset(this.avsPresetSelect!); });
      row.append(plabel, presetPicker(randomButton, this.avsPresetSelect));
      classic.append(row);
    }

    if (opts.onRequestLocalAvsPresets && opts.onPickLocalAvsPreset) {
      const row = el('div', 'ui-preset-row');
      const pid = this.nextId('local-avs-preset');
      const plabel = el('label', 'ui-preset-label', 'Full local AVS');
      plabel.htmlFor = pid;
      this.localAvsPresetSelect = el('select');
      this.localAvsPresetSelect.id = pid;
      this.localAvsPresetSelect.className = 'ui-preset-select';
      this.localAvsPresetSelect.append(option('', 'open 3,409-preset catalog…'));
      // Errors are reported and swallowed here, as before; the crate calls
      // `ensureLocalCatalog` directly because it wants the rejection.
      const ensureCatalog = (): Promise<void> => this.ensureLocalCatalog().catch((error) => {
        this.status(String(error), true);
      });
      this.localAvsPresetSelect.addEventListener('pointerdown', () => { void ensureCatalog(); }, { once: true });
      this.localAvsPresetSelect.addEventListener('focus', () => { void ensureCatalog(); }, { once: true });
      this.localAvsPresetSelect.addEventListener('change', () => {
        const id = this.localAvsPresetSelect!.value;
        if (!id) return;
        if (this.avsPresetSelect) this.avsPresetSelect.value = '';
        void Promise.resolve(opts.onPickLocalAvsPreset!(id)).catch((error) => this.status(String(error), true));
      });
      const randomButton = presetIconButton('Random preset from full local AVS bank', '⚄');
      randomButton.addEventListener('click', () => {
        randomButton.disabled = true;
        void ensureCatalog().then(
          () => { chooseRandomPreset(this.localAvsPresetSelect!); randomButton.disabled = false; },
          () => { randomButton.disabled = false; },
        );
      });
      row.append(plabel, presetPicker(randomButton, this.localAvsPresetSelect));
      classic.append(row);
    }

    if (opts.onPickPersonalAvsPreset) {
      const row = el('div', 'ui-preset-row');
      const pid = this.nextId('personal-avs-preset');
      const plabel = el('label', 'ui-preset-label', 'My AVS bank');
      plabel.htmlFor = pid;
      this.personalAvsPresetSelect = el('select');
      this.personalAvsPresetSelect.id = pid;
      this.personalAvsPresetSelect.className = 'ui-preset-select';
      this.setPersonalAvsPresets(opts.personalAvsPresets ?? []);
      this.personalAvsPresetSelect.addEventListener('change', () => {
        const id = this.personalAvsPresetSelect!.value;
        if (!id) return;
        if (this.avsPresetSelect) this.avsPresetSelect.value = '';
        if (this.localAvsPresetSelect) this.localAvsPresetSelect.value = '';
        this.updatePersonalAvsActions();
        void Promise.resolve(opts.onPickPersonalAvsPreset!(id)).catch((error) => this.status(String(error), true));
      });
      this.personalAvsRandomButton = presetIconButton('Random preset from My AVS', '⚄');
      this.personalAvsRandomButton.addEventListener('click', () => { chooseRandomPreset(this.personalAvsPresetSelect!); });
      const picker = presetPicker(this.personalAvsRandomButton, this.personalAvsPresetSelect);
      if (opts.onAddPersonalAvsPreset) {
        this.personalAvsAddButton = presetIconButton('Add current edited AVS preset to My AVS', '+');
        this.personalAvsAddButton.disabled = true;
        this.personalAvsAddButton.addEventListener('click', () => {
          this.personalAvsAddButton!.disabled = true;
          void Promise.resolve(opts.onAddPersonalAvsPreset!()).then(
            () => this.status('saved current preset to My AVS'),
            (error) => this.status(String(error), true),
          ).finally(() => this.updatePersonalAvsActions());
        });
        picker.append(this.personalAvsAddButton);
      }
      if (opts.onRemovePersonalAvsPreset) {
        this.personalAvsRemoveButton = presetIconButton('Delete selected preset from My AVS', '−');
        this.personalAvsRemoveButton.classList.add('is-destructive');
        this.personalAvsRemoveButton.addEventListener('click', () => {
          const id = this.personalAvsPresetSelect?.value ?? '';
          const name = this.personalAvsPresetSelect?.selectedOptions[0]?.textContent ?? 'this preset';
          if (!id || !window.confirm(`Remove ${name} from My AVS bank?`)) return;
          this.personalAvsRemoveButton!.disabled = true;
          void Promise.resolve(opts.onRemovePersonalAvsPreset!(id)).then(
            () => this.status(`removed ${name} from My AVS`),
            (error) => this.status(String(error), true),
          ).finally(() => this.updatePersonalAvsActions());
        });
        picker.append(this.personalAvsRemoveButton);
      }
      row.append(plabel, picker);
      const bankActions = el('div', 'ui-preset-bank-actions');
      if (opts.onImportPersonalAvsBank) {
        const input = el('input') as HTMLInputElement;
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.hidden = true;
        input.addEventListener('change', () => {
          const file = input.files?.[0];
          if (file) void Promise.resolve(opts.onImportPersonalAvsBank!(file)).catch((error) => this.status(String(error), true));
          input.value = '';
        });
        const importButton = el('button', 'ui-transport-button', 'import bank');
        importButton.type = 'button';
        importButton.addEventListener('click', () => input.click());
        bankActions.append(importButton, input);
      }
      if (opts.onExportPersonalAvsBank) {
        const exportButton = el('button', 'ui-transport-button', 'export bank');
        exportButton.type = 'button';
        exportButton.addEventListener('click', () => { void Promise.resolve(opts.onExportPersonalAvsBank!()).catch((error) => this.status(String(error), true)); });
        bankActions.append(exportButton);
      }
      classic.append(row, bankActions);
      this.updatePersonalAvsActions();
    }
    if (this.crate) presetSection.append(this.crate.root);
    presetSection.append(autoWrap);
    if (classic.childElementCount > 1) presetSection.append(classic);

    // --- layers ------------------------------------------------------------
    const layers = el('div', 'ui-section ui-layers-section');
    const layersLegend = el(
      'span',
      'ui-legend',
      'layer stack',
    );
    this.list = el('ul', 'ui-list');
    const addRow = el('div', 'ui-actions');
    const addId = this.nextId('add-type');
    const addLabel = el('label', 'ui-legend', 'add layer');
    addLabel.htmlFor = addId;
    this.addSelect = el('select');
    this.addSelect.id = addId;
    this.addSelect.className = 'ui-grow';
    this.addButton = el('button', 'ui-primary', 'add layer');
    this.addButton.type = 'button';
    this.addButton.addEventListener('click', () => this.addLayer());
    const addWrap = el('div', 'ui-field is-wide');
    addWrap.append(addLabel);
    addRow.append(this.addSelect, this.addButton);
    addWrap.append(addRow);
    layers.append(layersLegend, this.list, addWrap);

    // --- preset ------------------------------------------------------------
    const preset = el('details', 'ui-section ui-preset-tools');
    const presetSummary = el('summary', 'ui-disclosure', 'preset tools');
    preset.append(presetSummary);

    const nameId = this.nextId('name');
    const nameField = el('div', 'ui-field is-wide');
    const nameLabel = el('label', undefined, 'name');
    nameLabel.htmlFor = nameId;
    this.nameInput = el('input');
    this.nameInput.id = nameId;
    this.nameInput.type = 'text';
    this.nameInput.value = this.presetName;
    this.nameInput.addEventListener('input', () => {
      this.presetName = this.nameInput.value;
      this.edited();
    });
    nameField.append(nameLabel, this.nameInput);

    const seedId = this.nextId('seed');
    const seedField = el('div', 'ui-field is-wide');
    const seedLabel = el('label', undefined, 'seed — changing it reloads the stack');
    seedLabel.htmlFor = seedId;
    this.seedInput = el('input');
    this.seedInput.id = seedId;
    this.seedInput.type = 'number';
    this.seedInput.min = '0';
    this.seedInput.max = String(0xffffffff);
    this.seedInput.step = '1';
    this.seedInput.value = String(this.presetSeed);
    // `change`, not `input`: the seed reseeds every layer, so reacting to each
    // keystroke would rebuild the whole stack four times while typing "1024".
    this.seedInput.addEventListener('change', () => this.applySeed());
    seedField.append(seedLabel, this.seedInput);

    const actions = el('div', 'ui-actions');
    const saveBtn = el('button', 'ui-primary', 'save file');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => this.savePreset());

    const fileId = this.nextId('load');
    const fileLabel = el('label', 'ui-file', 'load file');
    fileLabel.htmlFor = fileId;
    const fileInput = el('input');
    fileInput.id = fileId;
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json,.avs';
    fileInput.addEventListener('change', () => { void this.loadPresetFile(fileInput); });
    fileLabel.append(fileInput);

    const urlBtn = el('button', 'ui-quiet', 'copy URL');
    urlBtn.type = 'button';
    urlBtn.addEventListener('click', () => { void this.copyUrl(); });

    actions.append(saveBtn, fileLabel, urlBtn);
    this.statusLine = el('p', 'ui-status');
    this.statusLine.setAttribute('role', 'status');
    this.statusLine.setAttribute('aria-live', 'polite');
    preset.append(nameField, seedField, actions, this.statusLine);

    this.body.append(transport, presetSection, layers, preset);
    this.root.append(head, this.body);
    (opts.host ?? document.body).append(this.root);

    // Attached once, to the list element rather than to a row, so it survives
    // every `refresh` — the rows do not.
    this.attachListDropTarget();
    this.fillTypeMenu();
    this.refresh();
    this.setOpen(this.openState);

    window.addEventListener('keydown', this.onKeyCapture, true);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  get open(): boolean { return this.openState; }

  setOpen(open: boolean): void {
    this.openState = open;
    this.body.hidden = !open;
    this.toggleBtn.textContent = open ? '–' : '+';
    this.toggleBtn.setAttribute('aria-expanded', String(open));
  }

  toggle(): void { this.setOpen(!this.openState); }

  /**
   * Adopt a preset the host has already loaded into the stack.
   *
   * Deliberately does NOT call `stack.load` itself. The host has more to reset
   * than the stack does — feedback targets, renderer caches, the palette the
   * shaders read — and a panel that reloaded the stack behind the host's back
   * would leave those pointing at the old preset, which renders as a stack that
   * looks right and is coloured wrong.
   */
  setPreset(preset: Preset): void {
    this.presetName = preset.name;
    this.presetSeed = preset.seed;
    this.palette = preset.palette;
    this.nameInput.value = preset.name;
    this.seedInput.value = String(preset.seed);
    this.refresh();
  }

  /** Reflect the director's enabled state, which the keyboard can also change. */
  setAuto(enabled: boolean): void {
    if (this.autoBox) this.autoBox.checked = enabled;
  }

  /** Keep every preset selector aligned with the bank that actually rendered. */
  setAvsPresetSelection(
    id: string,
    bank: 'bundled' | 'local' | 'personal' | 'external',
  ): void {
    this.crate?.setLive(bank === 'external' ? null : bank, id);
    if (this.avsPresetSelect) this.avsPresetSelect.value = bank === 'bundled' ? id : '';
    if (this.localAvsPresetSelect) {
      const has = [...this.localAvsPresetSelect.options].some((entry) => entry.value === id);
      this.localAvsPresetSelect.value = bank === 'local' && has ? id : '';
    }
    if (this.personalAvsPresetSelect) this.personalAvsPresetSelect.value = bank === 'personal' ? id : '';
  }

  /** The preset as it stands: stack order plus the metadata this panel holds. */
  getPreset(): Preset {
    return {
      version: PRESET_VERSION,
      name: this.presetName,
      seed: this.presetSeed,
      layers: this.stack.all.map((l) => l.spec),
      palette: this.palette,
    };
  }

  /** Rebuild the layer list from the stack. Call after any external mutation. */
  refresh(): void {
    this.list.replaceChildren();
    const layers = this.stack.all;
    if (layers.length === 0) {
      const empty = el('li', 'ui-empty', 'no layers — the stack renders black.');
      this.list.append(empty);
      return;
    }
    layers.forEach((layer, i) => this.list.append(this.buildRow(layer.spec, i)));
  }

  setPersonalAvsPresets(presets: readonly { readonly id: string; readonly name: string }[]): void {
    this.crate?.setBank('personal', presets);
    if (!this.personalAvsPresetSelect) return;
    const selected = this.personalAvsPresetSelect.value;
    this.personalAvsPresetSelect.replaceChildren(option('', presets.length
      ? `choose from ${presets.length.toLocaleString()} saved presets…`
      : 'bank is empty · use Add to bank'));
    for (const preset of presets) this.personalAvsPresetSelect.append(option(preset.id, preset.name));
    if (presets.some((preset) => preset.id === selected)) this.personalAvsPresetSelect.value = selected;
    this.updatePersonalAvsActions();
  }

  setPersonalAvsCanAdd(canAdd: boolean): void {
    this.personalAvsCanAdd = canAdd;
    this.updatePersonalAvsActions();
  }

  private updatePersonalAvsActions(): void {
    const hasPresets = Boolean(this.personalAvsPresetSelect?.options.length && this.personalAvsPresetSelect.options.length > 1);
    const hasSelection = Boolean(this.personalAvsPresetSelect?.value);
    if (this.personalAvsAddButton) this.personalAvsAddButton.disabled = !this.personalAvsCanAdd;
    if (this.personalAvsRandomButton) this.personalAvsRandomButton.disabled = !hasPresets;
    if (this.personalAvsRemoveButton) this.personalAvsRemoveButton.disabled = !hasSelection;
  }

  /**
   * Replace only the graph-editing region while keeping shared transport and
   * preset selection visible. Passing null restores the native LayerStack.
   */
  setLayerEditor(content: HTMLElement | null): void {
    const layers = this.list.parentElement;
    if (!layers) return;
    let alternate = layers.querySelector<HTMLElement>(':scope > .ui-alternate-layer-editor');
    const addField = this.addSelect.closest<HTMLElement>('.ui-field');
    const presetTools = this.root.querySelector<HTMLDetailsElement>('.ui-preset-tools');
    if (content) {
      if (!alternate) {
        alternate = el('div', 'ui-alternate-layer-editor');
        layers.append(alternate);
      }
      alternate.replaceChildren(content);
      this.root.classList.add('is-avs-editor');
      this.list.hidden = true;
      if (addField) addField.hidden = true;
      if (presetTools) presetTools.hidden = true;
      return;
    }
    alternate?.remove();
    this.root.classList.remove('is-avs-editor');
    this.list.hidden = false;
    if (addField) addField.hidden = false;
    if (presetTools) presetTools.hidden = false;
  }

  /**
   * Per-frame transport readout.
   *
   * Writes only when the rendered text actually changes. At 120 fps three
   * unconditional `textContent` assignments per frame is three style
   * invalidations per frame for a number that changes at ~2 Hz, and the panel
   * is not allowed to cost the render budget it sits next to (§4.11).
   */
  update(readout: TransportReadout): void {
    if (!this.openState) return;

    const bpmText = readout.bpm > 0 ? readout.bpm.toFixed(1) : '—';
    if (bpmText !== this.lastBpmText) {
      this.outBpm.textContent = bpmText;
      this.outBpm.classList.toggle('is-idle', readout.bpm <= 0);
      this.lastBpmText = bpmText;
    }

    const pct = Math.round(clamp(readout.confidence, 0, 1) * 100);
    const lockText = readout.locked ? `${pct}%` : 'listening';
    if (lockText !== this.lastLockText) {
      this.outLock.textContent = lockText;
      this.outLock.classList.toggle('is-idle', !readout.locked);
      this.lastLockText = lockText;
    }

    // 1-based, because musicians count from one. Derived here rather than by
    // the caller so there is only one place for the off-by-one to live.
    const beats = Math.max(0, readout.beats);
    const bar = Math.floor(beats / 4) + 1;
    const beat = Math.floor(beats % 4) + 1;
    const posText = `${bar}.${beat}`;
    if (posText !== this.lastPosText) {
      this.outPos.textContent = posText;
      this.lastPosText = posText;
    }

    this.previousBarButton.disabled = !readout.canControl;
    this.playButton.disabled = !readout.canControl;
    this.nextBarButton.disabled = !readout.canControl;
    const playGlyph = readout.playing ? 'Ⅱ' : '▶';
    if (this.playButton.textContent !== playGlyph) this.playButton.textContent = playGlyph;
    this.playButton.setAttribute('aria-label', readout.playing ? 'Pause' : 'Resume');
  }

  /** Commit whatever the crate has cued. Exposed for hosts that bind a MIDI pad to "go". */
  commitCue(): Promise<void> {
    return this.crate?.commitCue() ?? Promise.resolve();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyCapture, true);
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  /**
   * Capture phase on `window`, so it runs before the bubble-phase shortcut
   * handler `main.ts` installed on the same node — capture always precedes
   * bubble, whichever was registered first, and `stopPropagation` here means the
   * event never reaches the bubble phase at all.
   *
   * The event is stopped, not prevented: the keystroke still reaches the field
   * and still types. Only the page's listeners are cut out. `stopPropagation`
   * rather than `stopImmediatePropagation` because other capture-phase
   * listeners on `window` are none of this panel's business.
   */
  private readonly onKeyCapture = (e: KeyboardEvent): void => {
    // The crate gets first refusal on keys aimed at it — including keys typed
    // in its search box, which the text-entry guard below would otherwise stop
    // before the box's own listeners ever ran (capture on `window` precedes the
    // target phase). It only claims the handful it binds and stops those.
    if (this.crate && e.target instanceof Node && this.crate.root.contains(e.target) && this.crate.handleKey(e)) return;
    if (isTextEntry(e.target)) {
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() === this.toggleKey) {
      this.toggle();
      e.stopPropagation();
      return;
    }
    // `g` (go) and `/` (search) are unbound in main.ts. Only honoured when focus
    // is on the page itself or inside this panel, so a key pressed on another
    // panel or behind a modal cannot put a preset live.
    if (this.crate && this.ownsGlobalKey(e.target)) {
      if (e.key === CRATE_GO_KEY) {
        // Auto-repeat is not a second "go": the first press already cleared
        // the cue, so a held key would only overwrite the status line.
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        void this.crate.commitCue();
      } else if (e.key === CRATE_SEARCH_KEY) {
        e.preventDefault();
        e.stopPropagation();
        this.setOpen(true);
        this.crate.focusSearch();
      }
    }
  };

  private ownsGlobalKey(target: EventTarget | null): boolean {
    // A click on a non-focusable part of a modal (the guide, the offline
    // studio) leaves focus on <body>, so "focus is on the page" alone would let
    // `g` put a preset live behind it. main.ts swallows its own keys while
    // either is open; this is the same rule, keyed off `aria-modal`.
    if (visibleModalOpen()) return false;
    if (target === null || target === document.body || target === document.documentElement) return true;
    return target instanceof Node && this.root.contains(target);
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  private buildRow(spec: LayerSpec, index: number): HTMLLIElement {
    const li = el('li', 'ui-layer');
    li.dataset['id'] = spec.id;
    const layer = this.stack.find(spec.id);
    const muted = layer?.muted ?? false;
    if (muted) li.classList.add('is-muted');

    // --- head --------------------------------------------------------------
    const head = el('div', 'ui-layer-head');

    const grip = iconButton('⁙', `Drag to reorder ${spec.type}`, 'ui-grip');
    grip.draggable = true;
    grip.addEventListener('dragstart', (e) => {
      this.dragId = spec.id;
      li.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // Some browsers cancel a drag that carries no payload.
        e.dataTransfer.setData('text/plain', spec.id);
      }
    });
    grip.addEventListener('dragend', () => {
      this.dragId = null;
      this.clearDropMarks();
      li.classList.remove('is-dragging');
    });

    const name = el('span', 'ui-type', spec.type);
    const idx = el('span', 'ui-index', String(index));

    const enable = el('button', 'ui-icon', spec.enabled ? '●' : '○');
    enable.type = 'button';
    enable.title = 'Enabled';
    enable.setAttribute('aria-label', `Enable ${spec.type}`);
    enable.setAttribute('aria-pressed', String(spec.enabled));
    enable.addEventListener('click', () => {
      const next = !spec.enabled;
      hotSet(spec, 'enabled', next);
      enable.setAttribute('aria-pressed', String(next));
      enable.textContent = next ? '●' : '○';
      this.edited();
    });

    const solo = iconButton('S', `Solo ${spec.type}`, 'ui-solo');
    solo.setAttribute('aria-pressed', String(this.stack.isSoloed(spec.id)));
    solo.addEventListener('click', () => {
      const next = !this.stack.isSoloed(spec.id);
      this.stack.setSolo(spec.id, next);
      solo.setAttribute('aria-pressed', String(next));
      this.edited();
    });

    const mute = iconButton('M', `Mute ${spec.type}`);
    mute.setAttribute('aria-pressed', String(muted));
    mute.addEventListener('click', () => {
      const next = !(this.stack.find(spec.id)?.muted ?? false);
      this.stack.setMuted(spec.id, next);
      mute.setAttribute('aria-pressed', String(next));
      li.classList.toggle('is-muted', next);
      this.edited();
    });

    // The keyboard route to reordering. Drag is the fast one; these are the
    // ones that work without a pointer, and they are not a lesser path.
    const up = iconButton('▲', `Move ${spec.type} earlier`);
    up.disabled = index === 0;
    up.addEventListener('click', () => this.move(spec.id, index - 1));

    const down = iconButton('▼', `Move ${spec.type} later`);
    down.disabled = index >= this.stack.length - 1;
    down.addEventListener('click', () => this.move(spec.id, index + 1));

    const del = iconButton('×', `Remove ${spec.type}`, 'ui-danger');
    del.addEventListener('click', () => {
      this.stack.remove(spec.id);
      this.refresh();
      this.edited();
    });

    head.append(grip, idx, name, enable, solo, mute, up, down, del);

    // --- fields ------------------------------------------------------------
    const fields = el('div', 'ui-fields');

    const familySelect = el('select');
    fillSelect(familySelect, FAMILIES, spec.family);
    const familyNote = el('p', 'ui-note');
    familyNote.hidden = true;
    const checkFamily = (): void => {
      const registered = this.opts.registry?.get(spec.type);
      const wrong = registered !== undefined && registered.family !== spec.family;
      familyNote.hidden = !wrong;
      if (wrong && registered) {
        // The renderer refuses a pass whose family disagrees with its
        // descriptor, and a refused pass is an invisible layer. Saying so here
        // is cheaper than the black frame it otherwise becomes.
        familyNote.textContent =
          `${spec.type} is registered as '${registered.family}'. The renderer will refuse this pass.`;
      }
    };
    familySelect.addEventListener('change', () => {
      hotSet(spec, 'family', familySelect.value as LayerFamily);
      checkFamily();
      this.edited();
    });
    checkFamily();

    const blendSelect = el('select');
    fillSelect(blendSelect, BLENDS, spec.blend);
    blendSelect.addEventListener('change', () => {
      hotSet(spec, 'blend', blendSelect.value as BlendMode);
      mixField.hidden = blendSelect.value !== 'adjustable';
      this.edited();
    });

    const opacityRow = this.rangeField(LAYER_FIELD_PARAMS.opacity, spec.opacity, (v) => {
      hotSet(spec, 'opacity', v);
    });

    const divisionSelect = el('select');
    fillSelect(divisionSelect, DIVISION_NAMES, spec.trigger.division);
    divisionSelect.addEventListener('change', () => {
      // Structural: `Layer` caches the stride in its constructor.
      this.rebuild(spec.id, {
        ...spec,
        trigger: { ...spec.trigger, division: divisionSelect.value as DivisionName },
      });
    });

    const paletteSelect = el('select');
    fillSelect(paletteSelect, PALETTE_SLOTS, spec.palette);
    paletteSelect.addEventListener('change', () => {
      hotSet(spec, 'palette', paletteSelect.value as PaletteSlot);
      this.edited();
    });

    const scaleRow = this.rangeField(LAYER_FIELD_PARAMS.resolutionScale, spec.resolutionScale, (v) => {
      hotSet(spec, 'resolutionScale', v);
    });

    // Envelope, in beats. Never seconds — at 174 BPM a 200 ms release is most of
    // a beat and at 90 BPM a third of one, so a seconds-domain preset has to be
    // retuned for every track (contracts.ts, `Envelope`).
    const envField = el('div', 'ui-field is-wide');
    const envGrid = el('div', 'ui-triple');
    const envIds = [this.nextId('atk'), this.nextId('hold'), this.nextId('rel')];
    const envLabel = el('label', undefined, 'envelope — attack / hold / release, in beats');
    envLabel.htmlFor = envIds[0] ?? '';
    const envKeys = ['attackBeats', 'holdBeats', 'releaseBeats'] as const;
    envKeys.forEach((key, i) => {
      const input = el('input');
      input.id = envIds[i] ?? '';
      input.type = 'number';
      input.min = '0';
      input.max = '256';
      input.step = '0.125';
      input.value = String(spec.envelope[key]);
      input.title = key;
      input.setAttribute('aria-label', `${key} in beats`);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        // Silently ignoring a half-typed value beats clamping it: clamping
        // rewrites the field under the cursor and makes "0.5" impossible to
        // type, because it passes through "0." on the way.
        if (!Number.isFinite(v)) return;
        hotSet(spec, 'envelope', { ...spec.envelope, [key]: clamp(v, 0, 256) });
        this.edited();
      });
      envGrid.append(input);
    });
    envField.append(envLabel, envGrid);

    // Only meaningful for `adjustable`, which reads `params.mix` through
    // `blendConstantFor`. Offering the mode with no way to set its mix leaves a
    // layer stuck at the 0.5 default with no indication that a control exists.
    const mixField = this.rangeField(LAYER_FIELD_PARAMS.mix, numberParam(spec, 'mix', LAYER_FIELD_PARAMS.mix.defaultValue), (v) => {
      hotSet(spec, 'params', { ...spec.params, mix: v });
    });
    mixField.hidden = spec.blend !== 'adjustable';

    fields.append(
      this.field('family', familySelect),
      this.field('blend', blendSelect),
      opacityRow,
      scaleRow,
      this.field('clock', divisionSelect),
      this.field('palette', paletteSelect),
      envField,
      mixField,
      familyNote,
    );

    li.append(head, fields);
    this.attachDropTarget(li, spec.id);
    return li;
  }

  /** `<div class="ui-field"><label for><control></div>`, with the pairing done once. */
  private field(labelText: string, control: HTMLElement, wide = false): HTMLDivElement {
    const id = this.nextId(labelText.replace(/\s+/g, '-'));
    control.id = id;
    const wrap = el('div', wide ? 'ui-field is-wide' : 'ui-field');
    const label = el('label', undefined, labelText);
    label.htmlFor = id;
    wrap.append(label, control);
    return wrap;
  }

  /**
   * A labelled slider with a live numeric readout.
   *
   * `input`, not `change`: these all write hot fields, so dragging shows the
   * result on the next frame, which is the entire reason hot fields exist.
   *
   * Bounds come from the descriptor. The value is clamped but deliberately not
   * re-quantised: the slider already steps, and `min + round(n) * step` would
   * write float noise (0.35000000000000003) into a spec that must round-trip
   * byte-for-byte (§4.7).
   */
  private rangeField(
    descriptor: ParamDescriptor,
    value: number,
    apply: (v: number) => void,
  ): HTMLDivElement {
    const labelText = descriptor.label;
    const min = paramMin(descriptor);
    const max = paramMax(descriptor);
    const step = paramStep(descriptor);
    const id = this.nextId(labelText.replace(/\s+/g, '-'));
    const wrap = el('div', 'ui-field');
    const label = el('label', undefined, labelText);
    label.htmlFor = id;
    const readout = el('span', 'ui-readout', value.toFixed(2));
    label.append(readout);
    const input = el('input');
    input.id = id;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      const clamped = clamp(v, min, max);
      readout.textContent = clamped.toFixed(2);
      apply(clamped);
      this.edited();
    });
    wrap.append(label, input);
    return wrap;
  }

  private stat(label: string, hint: string): { node: HTMLElement; value: HTMLElement } {
    const node = el('div', 'ui-stat');
    const dt = el('dt', 'ui-sr-only', label);
    dt.title = hint;
    const dd = el('dd', 'is-idle', '—');
    dd.title = `${label} · ${hint}`;
    node.append(dt, dd);
    return { node, value: dd };
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  /**
   * The crate's single path to the live output: the SAME `onPick…` handler
   * the matching select calls on `change`. Throws so the crate reports it.
   */
  private async goCrateEntry(entry: CrateEntry): Promise<void> {
    const opts = this.opts;
    if (entry.bank === 'bundled') {
      if (!opts.onPickAvsPreset) throw new Error('This host cannot load bundled AVS presets');
      await opts.onPickAvsPreset(entry.id);
    } else if (entry.bank === 'local') {
      if (!opts.onPickLocalAvsPreset) throw new Error('This host cannot load local AVS presets');
      await this.ensureLocalCatalog();
      await opts.onPickLocalAvsPreset(entry.id);
    } else {
      if (!opts.onPickPersonalAvsPreset) throw new Error('This host cannot load My AVS presets');
      await opts.onPickPersonalAvsPreset(entry.id);
    }
  }

  /** One lazy catalog request feeding both the local select and the crate. Rejections are not cached. */
  private ensureLocalCatalog(): Promise<void> {
    const request = this.opts.onRequestLocalAvsPresets;
    if (!request) return Promise.resolve();
    const pending = this.localCatalogLoad ??= request().then((presets) => {
      const select = this.localAvsPresetSelect;
      if (select) {
        select.replaceChildren(option('', `choose from ${presets.length.toLocaleString()} presets…`));
        const fragment = document.createDocumentFragment();
        for (const preset of presets) {
          fragment.append(option(preset.id, flagged(preset.name, 'local', preset.id, preset.collection ?? '')));
        }
        select.append(fragment);
      }
      this.crate?.setBank('local', presets);
    });
    pending.catch(() => { if (this.localCatalogLoad === pending) this.localCatalogLoad = null; });
    return pending;
  }

  private edited(): void {
    this.opts.onEdit?.();
  }

  /**
   * Replace a layer's spec wholesale, keeping its position and its mixing-desk
   * state.
   *
   * Solo and mute are runtime gestures rather than preset data, so they are not
   * carried by the spec and would otherwise be silently dropped by a rebuild —
   * a muted layer coming back at full volume because its clock division changed
   * is exactly the kind of surprise that makes a UI feel untrustworthy.
   */
  private rebuild(id: string, next: LayerSpec): void {
    const index = this.stack.all.findIndex((l) => l.id === id);
    if (index < 0) return;
    const soloed = this.stack.isSoloed(id);
    const muted = this.stack.find(id)?.muted ?? false;
    this.stack.remove(id);
    this.stack.add(next, index);
    this.stack.setMuted(next.id, muted);
    this.stack.setSolo(next.id, soloed);
    this.refresh();
    this.edited();
  }

  private move(id: string, toIndex: number): void {
    if (!this.stack.reorder(id, toIndex)) return;
    this.refresh();
    this.edited();
  }

  private addLayer(): void {
    const type = this.addSelect.value;
    if (type.length === 0) return;
    const desc = this.opts.registry?.get(type);
    const family: LayerFamily = desc?.family ?? 'source';
    const spec = defaultLayerSpec(
      this.freeId(type),
      type,
      family,
      desc?.defaultResolutionScale ?? DEFAULT_RESOLUTION_SCALE,
    );
    this.stack.add(spec);
    this.refresh();
    this.edited();
    this.status(`added ${type}`);
  }

  /**
   * The lowest free `type-n`.
   *
   * Not a counter and not a timestamp: ids seed per-layer hashed variation
   * (§4.7), so the same sequence of gestures must produce the same ids on any
   * machine and in any session, or two people building "the same" preset get
   * two different-looking shows.
   */
  private freeId(type: string): string {
    const taken = new Set(this.stack.all.map((l) => l.id));
    for (let n = 1; ; n++) {
      const id = `${type}-${n}`;
      if (!taken.has(id)) return id;
    }
  }

  private applySeed(): void {
    const raw = Number(this.seedInput.value);
    if (!Number.isFinite(raw)) {
      this.seedInput.value = String(this.presetSeed);
      return;
    }
    const seed = clamp(Math.trunc(raw), 0, 0xffffffff);
    this.seedInput.value = String(seed);
    if (seed === this.presetSeed) return;
    this.presetSeed = seed;
    // Every layer's seed is a hash of (preset seed, layer id), so this is a
    // whole-preset reload rather than an edit — hence the host, not `refresh`.
    this.opts.onLoadPreset(this.getPreset());
    this.status('seed changed — stack reloaded');
  }

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------

  /**
   * The row as a drop target.
   *
   * The insertion point is decided by which half of the row the pointer is over
   * and shown as a line, rather than by shuffling rows out of the way. A list
   * that reflows under the pointer moves the target away from where the user is
   * aiming, and the drop lands one row off often enough to be maddening.
   */
  private attachDropTarget(li: HTMLLIElement, id: string): void {
    li.addEventListener('dragover', (e) => {
      if (this.dragId === null || this.dragId === id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const before = this.isBefore(li, e);
      li.classList.toggle('is-over-before', before);
      li.classList.toggle('is-over-after', !before);
    });
    li.addEventListener('dragleave', (e) => {
      // `dragleave` also fires when the pointer crosses from the row onto one of
      // its own children — a row is mostly buttons and selects, so that is most
      // of the row. Clearing unconditionally makes the drop line strobe as the
      // pointer moves, and `dragover` only fires every ~350ms, so the gap is
      // long enough to read as "the drop target was lost". Only a departure to a
      // node genuinely outside this row counts. `relatedTarget` is null when the
      // pointer leaves the window entirely, which is also a real departure.
      const to = e.relatedTarget;
      if (to instanceof Node && li.contains(to)) return;
      li.classList.remove('is-over-before', 'is-over-after');
    });
    li.addEventListener('drop', (e) => {
      const dragged = this.dragId;
      if (dragged === null || dragged === id) return;
      e.preventDefault();
      const before = this.isBefore(li, e);
      this.clearDropMarks();
      this.dragId = null;
      this.dropOn(dragged, id, before);
    });
  }

  /**
   * The list as the drop target of last resort: "put it at the end".
   *
   * Without this, the only droppable pixels in the panel are the rows
   * themselves, and the natural gesture for "move this to the bottom" — drag it
   * past the last row into the empty space below — lands on the `<ul>`, which
   * accepts nothing, so the drag is cancelled and the stack is unchanged. The
   * inter-row gaps have the same problem in miniature. A drag that visibly
   * completes and then does nothing is worse than one that is refused, because
   * the user's next move is to try it again rather than to aim differently.
   *
   * Rows bubble their events up to here, so this defers whenever the pointer is
   * over one — the row handler has already decided, and more precisely.
   */
  private attachListDropTarget(): void {
    const overRow = (e: DragEvent): boolean =>
      e.target instanceof Element && e.target.closest('.ui-layer') !== null;

    this.list.addEventListener('dragover', (e) => {
      if (this.dragId === null || overRow(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      this.markLast();
    });

    this.list.addEventListener('drop', (e) => {
      const dragged = this.dragId;
      if (dragged === null || overRow(e)) return;
      e.preventDefault();
      this.clearDropMarks();
      this.dragId = null;
      // Already last: nothing to do, and doing it anyway would mark the show
      // dirty for a gesture that changed nothing.
      if (this.stack.all[this.stack.length - 1]?.id === dragged) return;
      this.move(dragged, this.stack.length - 1);
    });
  }

  /** Show the end-of-list insertion point on the trailing edge of the last row. */
  private markLast(): void {
    this.clearDropMarks();
    const last = this.list.lastElementChild;
    if (last instanceof HTMLElement && last.classList.contains('ui-layer')) {
      last.classList.add('is-over-after');
    }
  }

  private isBefore(li: HTMLLIElement, e: DragEvent): boolean {
    const r = li.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  }

  /**
   * `LayerStack.reorder` removes first and then inserts at `toIndex`, so the
   * target index is computed against the list WITHOUT the dragged layer. Doing
   * it any other way is off by one in exactly one direction, which is why it
   * survives casual testing.
   */
  private dropOn(dragId: string, overId: string, before: boolean): void {
    const ids = this.stack.all.map((l) => l.id).filter((x) => x !== dragId);
    const at = ids.indexOf(overId);
    if (at < 0) return;
    this.move(dragId, before ? at : at + 1);
  }

  private clearDropMarks(): void {
    for (const node of this.list.querySelectorAll('.is-over-before, .is-over-after')) {
      node.classList.remove('is-over-before', 'is-over-after');
    }
  }

  // -------------------------------------------------------------------------
  // Presets
  // -------------------------------------------------------------------------

  private fillTypeMenu(): void {
    const registry = this.opts.registry;
    const types = registry ? [...registry.keys()].sort() : [];
    this.addSelect.replaceChildren();
    if (types.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'no pass types registered';
      this.addSelect.append(opt);
      this.addSelect.disabled = true;
      this.addButton.disabled = true;
      return;
    }
    for (const type of types) {
      const desc = registry?.get(type);
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = desc ? `${type} (${desc.family})` : type;
      this.addSelect.append(opt);
    }
    this.addSelect.value = types[0] ?? '';
  }

  private savePreset(): void {
    const preset = this.getPreset();
    const blob = new Blob([serialise(preset, true)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `${slug(preset.name)}.aaavs.json`;
    a.click();
    // Revoked on the next task rather than immediately: revoking synchronously
    // after `click()` races the browser's own fetch of the blob in some builds
    // and produces an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.status(`saved ${a.download}`);
  }

  private async loadPresetFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    // Cleared unconditionally so picking the same file twice fires `change`
    // again — otherwise "load, edit, reload to undo" silently does nothing.
    input.value = '';
    if (!file) return;
    try {
      if (file.name.toLowerCase().endsWith('.avs')) {
        if (!this.opts.onLoadAvsPreset) throw new Error('This host does not enable Winamp AVS imports');
        const bytes = new Uint8Array(await file.arrayBuffer());
        await this.opts.onLoadAvsPreset(bytes, file.name);
        this.status(`loaded ${file.name}`);
        return;
      }
      const preset = deserialise(await file.text());
      this.opts.onLoadPreset(preset);
      this.status(`loaded ${preset.name}`);
    } catch (err) {
      // `preset.ts` names the exact path that failed. Passing that through
      // verbatim is the whole point of it doing so.
      const why = err instanceof PresetError || err instanceof PresetVersionError
        ? err.message
        : String(err);
      this.status(why, true);
    }
  }

  private async copyUrl(): Promise<void> {
    let hash: string;
    try {
      hash = encodeHash(this.getPreset());
    } catch (err) {
      this.status(`could not encode preset: ${String(err)}`, true);
      return;
    }
    location.hash = hash;
    try {
      await navigator.clipboard.writeText(location.href);
      this.status('URL copied to the clipboard');
    } catch {
      // Clipboard access is refused without a user gesture, over http, and by
      // permission. The URL is already in the address bar either way, so this
      // is a smaller failure than it looks.
      this.status('URL is in the address bar — the clipboard was refused');
    }
  }

  private status(message: string, isError = false): void {
    this.statusLine.textContent = message;
    this.statusLine.classList.toggle('is-error', isError);
  }

  private nextId(kind: string): string {
    this.uid += 1;
    return `aaavs-ui-${kind}-${this.uid}`;
  }
}

// ---------------------------------------------------------------------------

/** True while any `aria-modal` dialog is rendered (a `hidden` ancestor or `display: none` has no client rects). */
function visibleModalOpen(): boolean {
  for (const modal of document.querySelectorAll('[aria-modal="true"]')) {
    if (modal.getClientRects().length > 0) return true;
  }
  return false;
}

/** Prefix ⚠ on a select option whose preset is flash-flagged (heuristic or measured). */
function flagged(name: string, bank: CrateBank, id: string, collection: string): string {
  return flashFlagFor({ bank, id, name, collection })?.flashing ? `⚠ ${name}` : name;
}

function numberParam(spec: LayerSpec, key: string, fallback: number): number {
  const raw = spec.params[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

/**
 * Link the stylesheet once, however many panels are constructed.
 *
 * A `<link>` rather than an inlined string: the CSS stays a file that can be
 * edited without a rebuild, and it does not pad the bundle the render loop is
 * parsed from. The cost is one extra request and a frame or two of unstyled
 * panel on a cold load, which is why the panel is a fixed-position box rather
 * than anything the page's layout depends on.
 */
function ensureStylesheet(href: string): void {
  if (document.querySelector('link[data-aaavs-ui]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset['aaavsUi'] = '';
  link.addEventListener('error', () => {
    console.warn(`aaavs: layer panel stylesheet not found at ${href}. Pass styleHref to LayerUI.`);
  });
  document.head.append(link);
}
