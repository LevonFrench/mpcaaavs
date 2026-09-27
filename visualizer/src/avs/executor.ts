import type { AvsAudioFrame, AvsComponent, AvsPresetAst } from './types.ts';
import { avsAudioSample } from './audio.ts';
import { compileAvsEel } from './eel/compiler.ts';
import { AvsEelGlobalState, AvsEelVm } from './eel/vm.ts';
import type { AvsEelProgram, AvsEelVariableBinding } from './eel/types.ts';
import { AvsBufferBank, AvsFramebuffer, decodeAvsListBlend } from './framebuffer.ts';

export interface AvsLineRenderState {
  blendMode: number;
  adjustableAlpha: number;
  lineWidth: number;
}

export interface AvsEffectContext {
  readonly component: AvsComponent;
  readonly input: AvsFramebuffer;
  readonly output: AvsFramebuffer;
  readonly audio: AvsAudioFrame;
  readonly buffers: AvsBufferBank;
  readonly line: AvsLineRenderState;
  readonly preinit: boolean;
  beat: boolean;
}

export interface AvsEffectResult {
  /** Mirrors renderer return bit 0: downstream reads `output`, not `input`. */
  readonly swap?: boolean;
  /** Mirrors AVS return bits 0x10000000/0x20000000 for later siblings. */
  readonly beat?: boolean;
}

export type AvsEffectHandler = (context: AvsEffectContext) => AvsEffectResult | void;

/** Dispatches built-ins by signed effect id and APEs by their fixed string id. */
export class AvsEffectRegistry {
  /** Shared NS-EEL registers and gmegabuf for every effect in this graph. */
  readonly eelGlobal: AvsEelGlobalState;
  private readonly builtins = new Map<number, AvsEffectHandler>();
  private readonly apes = new Map<string, AvsEffectHandler>();

  constructor(eelGlobal = new AvsEelGlobalState()) {
    this.eelGlobal = eelGlobal;
  }

  registerBuiltin(effectId: number, handler: AvsEffectHandler): this {
    this.builtins.set(effectId, handler);
    return this;
  }

  registerApe(apeId: string, handler: AvsEffectHandler): this {
    this.apes.set(apeId.toLowerCase(), handler);
    return this;
  }

  handler(component: AvsComponent): AvsEffectHandler | undefined {
    return component.apeId
      ? this.apes.get(component.apeId.toLowerCase())
      : this.builtins.get(component.effectId);
  }
}

export interface AvsExecutionStats {
  rendered: number;
  unsupported: number;
  lists: number;
}

/** Serializable, stable-path controls for one parsed AVS component. */
export interface AvsComponentControl {
  readonly path: string;
  /** False bypasses the component. Kept separate from mute for editor state. */
  readonly enabled?: boolean;
  /** Muting always wins over solo. A muted Effect List bypasses its subtree. */
  readonly muted?: boolean;
  /** Soloing a list includes its subtree; soloing a leaf keeps only its ancestors. */
  readonly solo?: boolean;
}

export interface AvsResolvedComponentControl {
  readonly path: string;
  readonly enabled: boolean;
  readonly muted: boolean;
  readonly solo: boolean;
}

interface AvsListEelState {
  readonly vm: AvsEelVm;
  readonly init: AvsEelProgram | null;
  readonly frame: AvsEelProgram | null;
  readonly vars: AvsListEelVariables;
  initialized: boolean;
}

/** Host-owned list variables, bound once per list VM instead of looked up by name every frame. */
interface AvsListEelVariables {
  readonly beat: AvsEelVariableBinding;
  readonly enabled: AvsEelVariableBinding;
  readonly w: AvsEelVariableBinding;
  readonly h: AvsEelVariableBinding;
  readonly clear: AvsEelVariableBinding;
  readonly alphaIn: AvsEelVariableBinding;
  readonly alphaOut: AvsEelVariableBinding;
}

interface AvsListFrameState {
  readonly enabled: boolean;
  readonly clear: boolean;
  readonly alphaIn: number;
  readonly alphaOut: number;
  readonly beat: boolean;
  readonly remainingBeatFrames: number;
}

/**
 * CPU reference state machine for AVS ordering, nested retained Effect Lists,
 * ping-pong return values, scoped line state, downstream beat overrides, and
 * the eight preset-global buffers. GPU effects can be connected later through
 * the same handler boundary without flattening the imported tree.
 */
export class AvsExecutor {
  readonly buffers = new AvsBufferBank();
  readonly stats: AvsExecutionStats = { rendered: 0, unsupported: 0, lists: 0 };
  /** Preset-global EEL registers/gmegabuf shared with registered codeable effects. */
  readonly eelGlobal: AvsEelGlobalState;
  private readonly retained = new Map<string, AvsFramebuffer>();
  private readonly alternates = new Map<string, AvsFramebuffer>();
  private readonly beatFrames = new Map<string, number>();
  private readonly listEel = new Map<string, AvsListEelState>();
  private readonly components = new Map<string, AvsComponent>();
  private readonly parents = new Map<string, string | null>();
  private controlsByPath = new Map<string, AvsResolvedComponentControl>();
  private soloSelection: ReadonlySet<string> | null = null;

  constructor(readonly preset: AvsPresetAst, readonly registry: AvsEffectRegistry) {
    this.eelGlobal = registry.eelGlobal;
    this.indexComponents(preset.components, null);
  }

  /** Current non-default controls, in preset traversal order. */
  get controls(): readonly AvsResolvedComponentControl[] {
    const result: AvsResolvedComponentControl[] = [];
    for (const path of this.components.keys()) {
      const control = this.controlsByPath.get(path);
      if (control) result.push(control);
    }
    return result;
  }

  /**
   * Atomically replaces graph controls. Unknown or duplicate paths are rejected
   * so stale editor state cannot silently control a different preset.
   */
  setControls(controls: readonly AvsComponentControl[]): void {
    const next = new Map<string, AvsResolvedComponentControl>();
    for (const control of controls) {
      if (!this.components.has(control.path)) throw new RangeError(`Unknown AVS component path ${control.path}`);
      if (next.has(control.path)) throw new RangeError(`Duplicate AVS component control path ${control.path}`);
      const resolved: AvsResolvedComponentControl = {
        path: control.path,
        enabled: control.enabled ?? true,
        muted: control.muted ?? false,
        solo: control.solo ?? false,
      };
      if (!isDefaultControl(resolved)) next.set(control.path, resolved);
    }
    if (sameControls(this.controlsByPath, next)) return;
    this.controlsByPath = next;
    this.rebuildSoloSelection();
    this.resetControlSensitiveState();
  }

  /** Merge one path's editor state without disturbing controls on other paths. */
  setComponentControl(path: string, patch: Omit<AvsComponentControl, 'path'>): void {
    if (!this.components.has(path)) throw new RangeError(`Unknown AVS component path ${path}`);
    const current = this.controlsByPath.get(path) ?? { path, enabled: true, muted: false, solo: false };
    const next = {
      path,
      enabled: patch.enabled ?? current.enabled,
      muted: patch.muted ?? current.muted,
      solo: patch.solo ?? current.solo,
    };
    this.setControls([
      ...this.controls.filter((control) => control.path !== path),
      next,
    ]);
  }

  render(framebuffer: AvsFramebuffer, audio: AvsAudioFrame, preinit = false): AvsExecutionStats {
    this.stats.rendered = 0; this.stats.unsupported = 0; this.stats.lists = 0;
    if (this.preset.clearEveryFrame && !preinit) framebuffer.clear();
    const alternate = this.surface(this.alternates, '$root', framebuffer);
    const line: AvsLineRenderState = { blendMode: 0, adjustableAlpha: 0, lineWidth: 1 };
    const result = this.runChildren(this.preset.components, framebuffer, alternate, audio, line, preinit, audio.beat);
    if (result.current !== framebuffer) framebuffer.copyFrom(result.current);
    return { ...this.stats };
  }

  reset(): void {
    this.retained.clear();
    this.alternates.clear();
    this.beatFrames.clear();
    this.listEel.clear();
    this.buffers.release();
  }

  private runChildren(
    children: readonly AvsComponent[],
    primary: AvsFramebuffer,
    alternate: AvsFramebuffer,
    audio: AvsAudioFrame,
    line: AvsLineRenderState,
    preinit: boolean,
    initialBeat: boolean,
  ): { current: AvsFramebuffer; alternate: AvsFramebuffer; beat: boolean } {
    let current = primary;
    let spare = alternate;
    let beat = initialBeat;
    for (const component of children) {
      if (!this.shouldRun(component)) continue;
      if (component.list) {
        this.runList(component, current, audio, line, preinit, beat);
        continue;
      }
      const handler = this.registry.handler(component);
      if (!handler) { this.stats.unsupported++; continue; }
      const result = handler({
        component, input: current, output: spare, audio, buffers: this.buffers,
        line, preinit, beat,
      });
      this.stats.rendered++;
      if (result?.swap) { const old = current; current = spare; spare = old; }
      if (result?.beat !== undefined && !preinit) beat = result.beat;
    }
    return { current, alternate: spare, beat };
  }

  private runList(
    component: AvsComponent,
    parent: AvsFramebuffer,
    audio: AvsAudioFrame,
    parentLine: AvsLineRenderState,
    preinit: boolean,
    beat: boolean,
  ): void {
    const settings = component.list!;
    this.stats.lists++;
    let remaining = this.beatFrames.get(component.path) ?? 0;
    // Native AVS carries preinit in the high beat bit, so its truthy beat gate
    // also arms fake_enabled during preinitialization.
    if ((beat || preinit) && settings.beatRender) {
      remaining = settings.beatRenderFrames;
      this.beatFrames.set(component.path, remaining);
    }
    const frameState = this.evaluateListCode(
      component,
      audio,
      parent.width,
      parent.height,
      preinit,
      beat,
      settings.enabled || remaining > 0,
      settings.clearEveryFrame,
      settings.inputBlendValue,
      settings.outputBlendValue,
      remaining,
    );
    if (!frameState.enabled) {
      // r_list.cpp releases thisfb when a (possibly script-disabled) list is
      // skipped; re-enabling starts from a fresh retained surface.
      this.retained.delete(component.path);
      return;
    }

    // AVS's replace-in/replace-out fast path executes directly in the parent.
    if (settings.inputBlendMode === 1 && settings.outputBlendMode === 1) {
      const alternate = this.surface(this.alternates, `${component.path}:fast`, parent);
      const line = { blendMode: 0, adjustableAlpha: 0, lineWidth: 1 };
      const result = this.runChildren(component.children, parent, alternate, audio, line, preinit, frameState.beat);
      if (result.current !== parent) parent.copyFrom(result.current);
      this.consumeBeatFrame(component.path, frameState.remainingBeatFrames);
      return;
    }

    const local = this.surface(this.retained, component.path, parent);
    const alternate = this.surface(this.alternates, component.path, parent);
    if (frameState.clear) local.clear();
    if (!preinit) {
      const depth = settings.inputBlendMode === 12
        ? this.buffers.get(settings.inputBuffer, parent.width, parent.height, false)
        : null;
      local.blendFrom(
        parent,
        decodeAvsListBlend(settings.inputBlendMode),
        frameState.alphaIn,
        depth ?? undefined,
        settings.inputInvert,
      );
    }

    // Set Render Mode is scoped to this list; child mutations do not escape.
    const line = { ...parentLine, blendMode: 0 };
    const result = this.runChildren(component.children, local, alternate, audio, line, preinit, frameState.beat);
    if (result.current !== local) local.copyFrom(result.current);
    if (!preinit) {
      const depth = settings.outputBlendMode === 12
        ? this.buffers.get(settings.outputBuffer, parent.width, parent.height, false)
        : null;
      parent.blendFrom(
        local,
        decodeAvsListBlend(settings.outputBlendMode),
        frameState.alphaOut,
        depth ?? undefined,
        settings.outputInvert,
      );
    }
    this.consumeBeatFrame(component.path, frameState.remainingBeatFrames);
  }

  private evaluateListCode(
    component: AvsComponent,
    audio: AvsAudioFrame,
    width: number,
    height: number,
    preinit: boolean,
    beat: boolean,
    enabled: boolean,
    clear: boolean,
    alphaIn: number,
    alphaOut: number,
    remainingBeatFrames: number,
  ): AvsListFrameState {
    const code = component.listCode;
    if (!code?.enabled) {
      return { enabled, clear, alphaIn, alphaOut, beat, remainingBeatFrames };
    }
    let state = this.listEel.get(component.path);
    if (!state) {
      const vm = new AvsEelVm({ global: this.eelGlobal, seed: hashPath(component.path) });
      state = {
        vm,
        init: compileOrNull(code.init),
        frame: compileOrNull(code.frame),
        vars: {
          beat: vm.bindVariable('beat'),
          enabled: vm.bindVariable('enabled'),
          w: vm.bindVariable('w'),
          h: vm.bindVariable('h'),
          clear: vm.bindVariable('clear'),
          alphaIn: vm.bindVariable('alphain'),
          alphaOut: vm.bindVariable('alphaout'),
        },
        initialized: false,
      };
      this.listEel.set(component.path, state);
    }
    const { vm, vars } = state;
    vm.setHost({
      getosc: (band, span, channel) => avsAudioSample(audio, 'osc', band, span, channel),
      getspec: (band, span, channel) => avsAudioSample(audio, 'spec', band, span, channel),
    });
    // r_list.cpp resets these host-owned variables immediately before init and
    // per-frame execution; arbitrary component-local variables remain intact.
    setBinding(vars.beat, beat && !preinit ? 1 : 0);
    setBinding(vars.enabled, enabled ? 1 : 0);
    setBinding(vars.w, width);
    setBinding(vars.h, height);
    setBinding(vars.clear, clear ? 1 : 0);
    setBinding(vars.alphaIn, alphaIn / 255);
    setBinding(vars.alphaOut, alphaOut / 255);
    if (!state.initialized) {
      execute(state.init, vm);
      state.initialized = true;
    }
    execute(state.frame, vm);
    return {
      enabled: eelSwitch(getBinding(vars.enabled)),
      clear: eelSwitch(getBinding(vars.clear)),
      alphaIn: alphaByte(getBinding(vars.alphaIn)),
      alphaOut: alphaByte(getBinding(vars.alphaOut)),
      beat: preinit ? beat : eelSwitch(getBinding(vars.beat)),
      remainingBeatFrames,
    };
  }

  private consumeBeatFrame(path: string, remaining: number): void {
    if (remaining > 0) this.beatFrames.set(path, remaining - 1);
  }

  private surface(
    store: Map<string, AvsFramebuffer>,
    key: string,
    like: AvsFramebuffer,
  ): AvsFramebuffer {
    const current = store.get(key);
    if (current?.width === like.width && current.height === like.height) return current;
    const created = new AvsFramebuffer(like.width, like.height);
    store.set(key, created);
    return created;
  }

  private indexComponents(children: readonly AvsComponent[], parent: string | null): void {
    for (const component of children) {
      if (this.components.has(component.path)) throw new Error(`Duplicate AVS component path ${component.path}`);
      this.components.set(component.path, component);
      this.parents.set(component.path, parent);
      this.indexComponents(component.children, component.path);
    }
  }

  private shouldRun(component: AvsComponent): boolean {
    const control = this.controlsByPath.get(component.path);
    if (control && (!control.enabled || control.muted)) return false;
    return this.soloSelection === null || this.soloSelection.has(component.path);
  }

  private rebuildSoloSelection(): void {
    const solos = [...this.controlsByPath.values()].filter((control) => control.solo);
    if (solos.length === 0) {
      this.soloSelection = null;
      return;
    }
    const selected = new Set<string>();
    for (const solo of solos) {
      let path: string | null = solo.path;
      while (path !== null) {
        selected.add(path);
        path = this.parents.get(path) ?? null;
      }
      const component = this.components.get(solo.path)!;
      if (component.list) this.selectSubtree(component, selected);
    }
    this.soloSelection = selected;
  }

  private selectSubtree(component: AvsComponent, selected: Set<string>): void {
    selected.add(component.path);
    for (const child of component.children) this.selectSubtree(child, selected);
  }

  private resetControlSensitiveState(): void {
    // A graph mutation invalidates list feedback, fake-beat windows and global
    // buffers whose producers may now be bypassed. Effect-local simulations
    // deliberately pause while bypassed, matching a non-destructive live mute.
    this.retained.clear();
    this.alternates.clear();
    this.beatFrames.clear();
    this.listEel.clear();
    this.buffers.release();
  }
}

function isDefaultControl(control: AvsResolvedComponentControl): boolean {
  return control.enabled && !control.muted && !control.solo;
}

function sameControls(
  left: ReadonlyMap<string, AvsResolvedComponentControl>,
  right: ReadonlyMap<string, AvsResolvedComponentControl>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, a] of left) {
    const b = right.get(path);
    if (!b || a.enabled !== b.enabled || a.muted !== b.muted || a.solo !== b.solo) return false;
  }
  return true;
}

function compileOrNull(source: string): AvsEelProgram | null {
  if (!source.trim()) return null;
  try { return compileAvsEel(source); } catch { return null; }
}
function execute(program: AvsEelProgram | null, vm: AvsEelVm): number {
  return program ? vm.execute(program) : 0;
}
function getBinding(binding: AvsEelVariableBinding): number {
  return binding.values[binding.index] ?? 0;
}
/** Same non-finite-to-zero cleaning as AvsEelVm.set(). */
function setBinding(binding: AvsEelVariableBinding, value: number): void {
  binding.values[binding.index] = Number.isFinite(value) ? value : 0;
}
function eelSwitch(value: number): boolean { return value > 0.1 || value < -0.1; }
function alphaByte(value: number): number {
  const byte = Math.trunc(value * 255);
  return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}
function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
