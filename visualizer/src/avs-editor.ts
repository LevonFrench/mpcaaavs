import type { AvsComponent, AvsPresetAst } from './avs/types.ts';
import { decodeAvsListBlend } from './avs/framebuffer.ts';
import {
  createAvsEditorModel,
  findAvsEditorNode,
  serializeAvsEditorModel,
  type AvsEditorFieldPatch,
  type AvsEditorInspection,
} from './avs/editor-model.ts';
import { avsFieldParams, mergeAvsFieldPatches } from './params/avs-fields.ts';
import { paramMax, paramMin, paramStep, paramTitle, type ParamDescriptor, type ParamValue } from './params/descriptor.ts';

const DEFAULT_STYLE_HREF = new URL('./avs-editor.css', import.meta.url).href;

const BUILTIN_EFFECT_NAMES = [
  'Simple', 'Dot Plane', 'Oscilloscope Star', 'Fade Out', 'Blitter Feedback',
  'OnBeat Clear', 'Blur', 'Bass Spin', 'Moving Particle', 'Roto Blitter',
  'SVP Loader', 'Color Fade', 'Color Clip', 'Rotating Stars', 'Ring',
  'Movement', 'Scatter', 'Dot Grid', 'Buffer Save', 'Dot Fountain', 'Water',
  'Comment', 'Brightness', 'Interleave', 'Grain', 'Clear Screen', 'Mirror',
  'Starfield', 'Text', 'Bump', 'Mosaic', 'Water Bump', 'AVI', 'Custom BPM',
  'Picture', 'Dynamic Distance Modifier', 'SuperScope', 'Invert', 'Unique Tone',
  'Timescope', 'Set Render Mode', 'Interferences', 'Dynamic Shift',
  'Dynamic Movement', 'Fast Brightness', 'Dynamic Color Modifier',
] as const;

export interface AvsEditorNodeState {
  /** The renderer's configured/native enabled bit. */
  readonly enabled: boolean;
  /** Session-level bypass. This is deliberately separate from the preset bit. */
  readonly muted: boolean;
  /** Session-level solo membership. */
  readonly soloed: boolean;
  /** False when the current runtime has no handler for this record. */
  readonly supported?: boolean;
}

export interface AvsEditorNode {
  readonly component: AvsComponent;
  readonly path: string;
  readonly parentPath: string | null;
  readonly ordinal: number;
  readonly siblingCount: number;
  readonly depth: number;
  readonly kind: 'list' | 'ape' | 'builtin';
  readonly name: string;
  readonly summary: string;
  readonly state: AvsEditorNodeState;
  readonly children: readonly AvsEditorNode[];
}

export interface AvsEditorModel {
  readonly preset: AvsPresetAst;
  readonly nodes: readonly AvsEditorNode[];
  readonly flatNodes: readonly AvsEditorNode[];
  readonly effectCount: number;
  readonly listCount: number;
  readonly maxDepth: number;
}

export interface AvsEditorCallbacks {
  readonly getNodeState?: (component: AvsComponent, path: string) => AvsEditorNodeState;
  readonly onSetEnabled?: (component: AvsComponent, path: string, enabled: boolean) => void | Promise<void>;
  readonly onSetMuted?: (component: AvsComponent, path: string, muted: boolean) => void | Promise<void>;
  readonly onSetSoloed?: (component: AvsComponent, path: string, soloed: boolean) => void | Promise<void>;
  readonly onMove?: (component: AvsComponent, path: string, parentPath: string | null, direction: -1 | 1) => void | Promise<void>;
  readonly onSave?: () => void | Promise<void>;
  readonly onAddToBank?: () => void | Promise<void>;
  readonly onPatchPayload?: (component: AvsComponent, path: string, payload: Uint8Array) => void | Promise<void>;
  readonly onPatchFields?: (component: AvsComponent, path: string, patch: AvsEditorFieldPatch) => void | Promise<void>;
  readonly onSelect?: (component: AvsComponent, path: string) => void;
  readonly onError?: (error: unknown) => void;
  /**
   * Optional: replace the whole edited preset with these exact bytes through
   * the host's normal load path. When present, undo/redo/revert restore the
   * snapshotted bytes directly. Without it they replay inverse edits through
   * `onPatchPayload` / `onMove` / `onSetEnabled` — the same paths a user edit
   * takes — and then compare the result against the snapshot.
   */
  readonly onRestoreBytes?: (bytes: Uint8Array) => void | Promise<void>;
}

export interface AvsEditorOptions extends AvsEditorCallbacks {
  readonly host: HTMLElement;
  readonly preset: AvsPresetAst;
  readonly presetName?: string;
  readonly styleHref?: string;
  /** Leaves AVS replace-mode and returns the host's native aaavs layer stack. */
  readonly onExitToNative?: () => void;
  /** The host can mount once and reveal only while an AVS preset is active. */
  readonly visible?: boolean;
  /** Expanded by default so selecting an AVS preset immediately exposes its graph. */
  readonly initiallyCollapsed?: readonly string[];
}

export type AvsEditorAction =
  | { readonly kind: 'enabled'; readonly value: boolean }
  | { readonly kind: 'muted'; readonly value: boolean }
  | { readonly kind: 'soloed'; readonly value: boolean };

/**
 * Build the stable, recursive view model used by both the DOM editor and tests.
 * No component is flattened out of its Effect List: order and containment are
 * part of AVS execution semantics.
 */
export function buildAvsEditorModel(
  preset: AvsPresetAst,
  getState?: AvsEditorCallbacks['getNodeState'],
): AvsEditorModel {
  const flatNodes: AvsEditorNode[] = [];
  let listCount = 0;
  let maxDepth = 0;

  const visit = (
    components: readonly AvsComponent[],
    parentPath: string | null,
    depth: number,
  ): AvsEditorNode[] => components.map((component, index) => {
    const path = component.path || (parentPath ? `${parentPath}.${index + 1}` : `${index + 1}`);
    const kind = component.list ? 'list' : component.apeId ? 'ape' : 'builtin';
    const state = getState?.(component, path) ?? {
      enabled: component.list?.enabled ?? true,
      muted: false,
      soloed: false,
      supported: true,
    };
    const children = visit(component.children, path, depth + 1);
    const node: AvsEditorNode = {
      component,
      path,
      parentPath,
      ordinal: index + 1,
      siblingCount: components.length,
      depth,
      kind,
      name: effectName(component),
      summary: effectSummary(component),
      state,
      children,
    };
    flatNodes.push(node);
    if (kind === 'list') listCount++;
    if (depth > maxDepth) maxDepth = depth;
    return node;
  });

  // `visit` must create children before their parent so it can freeze the child
  // array into the parent. Restore render/execution order for flat navigation.
  const nodes = visit(preset.components, null, 1);
  flatNodes.sort(comparePaths);
  return {
    preset,
    nodes,
    flatNodes,
    effectCount: flatNodes.length - listCount,
    listCount,
    maxDepth,
  };
}

/** Pure callback router shared by UI gestures and the headless contract test. */
export function dispatchAvsEditorAction(
  callbacks: AvsEditorCallbacks,
  node: AvsEditorNode,
  action: AvsEditorAction,
): void | Promise<void> {
  if (action.kind === 'enabled') return callbacks.onSetEnabled?.(node.component, node.path, action.value);
  if (action.kind === 'muted') return callbacks.onSetMuted?.(node.component, node.path, action.value);
  return callbacks.onSetSoloed?.(node.component, node.path, action.value);
}

/** Pure routers keep structural/editor actions independently testable. */
export function dispatchAvsEditorMove(
  callbacks: AvsEditorCallbacks,
  node: AvsEditorNode,
  direction: -1 | 1,
): void | Promise<void> {
  return callbacks.onMove?.(node.component, node.path, node.parentPath, direction);
}

export function dispatchAvsEditorSave(callbacks: AvsEditorCallbacks): void | Promise<void> {
  return callbacks.onSave?.();
}

// ---------------------------------------------------------------------------
// Undo history
//
// Every recorded step carries the serialized preset bytes from BEFORE and AFTER
// the edit, plus the inverse and forward operations expressed in the editor's
// existing callbacks. Nothing here edits bytes itself: undoing replays an
// operation through the host's own load/patch path, exactly like a click would,
// so AVS semantics are whatever those paths already guarantee. The bytes are
// the oracle — an undo that does not land back on `before` says so.
//
// Bounded: past `limit` steps the oldest is discarded and `dropped` counts it,
// which is how revert-by-replay knows it can no longer reach the loaded preset.
// ---------------------------------------------------------------------------

export type AvsEditorHistoryOp =
  | { readonly kind: 'payload'; readonly path: string; readonly payload: Uint8Array }
  | { readonly kind: 'move'; readonly path: string; readonly parentPath: string | null; readonly direction: -1 | 1 }
  | { readonly kind: 'list-enabled'; readonly path: string; readonly enabled: boolean }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

export interface AvsEditorHistoryEntry {
  readonly label: string;
  readonly undo: AvsEditorHistoryOp;
  readonly redo: AvsEditorHistoryOp;
  readonly before: Uint8Array;
  readonly after: Uint8Array;
}

export const AVS_EDITOR_HISTORY_LIMIT = 64;

export function avsBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Where a node lands after moving `direction` among its siblings. AVS paths are 1-based ordinals. */
export function avsMovedPath(parentPath: string | null, ordinal: number, direction: -1 | 1): string {
  const next = ordinal + direction;
  return parentPath ? `${parentPath}.${next}` : String(next);
}

export type AvsEditorTrackedChange =
  | { readonly kind: 'payload' }
  | { readonly kind: 'move'; readonly direction: -1 | 1 }
  | { readonly kind: 'list-enabled'; readonly enabled: boolean };

/**
 * The undo/redo pair for one completed edit, expressed as replayable callback
 * operations. `node` is the node as it was BEFORE the edit, `beforePayload` its
 * payload then, and `afterPreset` the preset the host reloaded afterwards.
 * Null when the edited node cannot be found afterwards.
 */
export function avsEditorHistoryOps(
  change: AvsEditorTrackedChange,
  node: Pick<AvsEditorNode, 'path' | 'parentPath' | 'ordinal'>,
  beforePayload: Uint8Array,
  afterPreset: AvsPresetAst,
): { readonly undo: AvsEditorHistoryOp; readonly redo: AvsEditorHistoryOp } | null {
  if (change.kind === 'payload') {
    const now = buildAvsEditorModel(afterPreset).flatNodes.find((candidate) => candidate.path === node.path);
    if (!now) return null;
    return {
      undo: { kind: 'payload', path: node.path, payload: beforePayload },
      redo: { kind: 'payload', path: node.path, payload: now.component.payload.slice() },
    };
  }
  if (change.kind === 'move') {
    return {
      undo: {
        kind: 'move', path: avsMovedPath(node.parentPath, node.ordinal, change.direction),
        parentPath: node.parentPath, direction: change.direction === 1 ? -1 : 1,
      },
      redo: { kind: 'move', path: node.path, parentPath: node.parentPath, direction: change.direction },
    };
  }
  return {
    undo: { kind: 'list-enabled', path: node.path, enabled: !change.enabled },
    redo: { kind: 'list-enabled', path: node.path, enabled: change.enabled },
  };
}

/** Replay one history op through the host's ordinary edit callbacks. */
export function applyAvsEditorHistoryOp(
  op: AvsEditorHistoryOp,
  preset: AvsPresetAst,
  callbacks: AvsEditorCallbacks,
): void | Promise<void> {
  if (op.kind === 'bytes') {
    if (!callbacks.onRestoreBytes) throw new Error('This host cannot restore AVS bytes');
    return callbacks.onRestoreBytes(op.bytes.slice());
  }
  const node = buildAvsEditorModel(preset, callbacks.getNodeState).flatNodes
    .find((candidate) => candidate.path === op.path);
  if (!node) throw new Error(`Cannot undo: AVS path ${op.path} no longer exists`);
  if (op.kind === 'payload') {
    if (!callbacks.onPatchPayload) throw new Error('This host cannot patch AVS payloads');
    return callbacks.onPatchPayload(node.component, node.path, op.payload.slice());
  }
  if (op.kind === 'move') {
    if (!callbacks.onMove) throw new Error('This host cannot reorder AVS effects');
    return callbacks.onMove(node.component, node.path, op.parentPath, op.direction);
  }
  if (!callbacks.onSetEnabled) throw new Error('This host cannot toggle Effect Lists');
  return callbacks.onSetEnabled(node.component, node.path, op.enabled);
}

export class AvsEditorHistory {
  private past: AvsEditorHistoryEntry[] = [];
  private future: AvsEditorHistoryEntry[] = [];
  private droppedSteps = 0;

  constructor(readonly limit = AVS_EDITOR_HISTORY_LIMIT) {}

  get undoDepth(): number { return this.past.length; }
  get redoDepth(): number { return this.future.length; }
  /** Steps discarded by the bound since the last reset. */
  get dropped(): number { return this.droppedSteps; }
  /** True when replaying every undo would land exactly on the loaded preset. */
  get canReplayToLoaded(): boolean { return this.droppedSteps === 0; }

  /** Record a completed edit. A no-op edit (identical bytes) is not a step. Clears redo. */
  record(entry: AvsEditorHistoryEntry): boolean {
    if (avsBytesEqual(entry.before, entry.after)) return false;
    this.past.push(entry);
    this.future = [];
    while (this.past.length > this.limit) {
      this.past.shift();
      this.droppedSteps++;
    }
    return true;
  }

  peekUndo(): AvsEditorHistoryEntry | null { return this.past.at(-1) ?? null; }
  peekRedo(): AvsEditorHistoryEntry | null { return this.future.at(-1) ?? null; }

  /** Call only after the undo op has been applied successfully. */
  commitUndo(): void {
    const entry = this.past.pop();
    if (entry) this.future.push(entry);
  }

  /** Call only after the redo op has been applied successfully. */
  commitRedo(): void {
    const entry = this.future.pop();
    if (entry) this.past.push(entry);
  }

  reset(): void {
    this.past = [];
    this.future = [];
    this.droppedSteps = 0;
  }
}

/** Parse the exact byte-oriented format shown by the advanced payload editor. */
export function parseAvsPayloadHex(source: string): Uint8Array {
  const tokens = source.trim() ? source.trim().split(/\s+/) : [];
  if (tokens.some((token) => !/^[0-9a-f]{2}$/i.test(token))) {
    throw new Error('Payload must be two-digit hexadecimal bytes separated by whitespace.');
  }
  return Uint8Array.from(tokens.map((token) => Number.parseInt(token, 16)));
}

/**
 * A real AVS graph editor surface. The host remains authoritative for runtime
 * state; `refresh()` asks its callbacks again instead of mirroring mute/solo in
 * a second, eventually-stale model.
 */
export class AvsEditor {
  private preset: AvsPresetAst;
  private presetName: string;
  private readonly callbacks: AvsEditorCallbacks;
  private readonly collapsed: Set<string>;
  private decodedModel: ReturnType<typeof createAvsEditorModel>;
  private statusLine: HTMLElement | null = null;
  private selectedPath: string | null = null;
  private workbenchCollapsed = false;
  private visible: boolean;
  private disposed = false;
  private readonly history = new AvsEditorHistory();
  /** Exact bytes of the preset as it was loaded: the revert target. */
  private loadedBytes: Uint8Array;
  private currentBytes: Uint8Array;
  private historyBusy = false;

  constructor(private readonly options: AvsEditorOptions) {
    this.preset = options.preset;
    this.presetName = options.presetName ?? 'Imported AVS preset';
    this.callbacks = options;
    this.collapsed = new Set(options.initiallyCollapsed ?? []);
    this.decodedModel = createAvsEditorModel(options.preset);
    this.visible = options.visible ?? true;
    this.loadedBytes = serializeAvsEditorModel(this.decodedModel);
    this.currentBytes = this.loadedBytes;
    // Scoped to the editor: the listener sits on the host, so Ctrl+Z only acts
    // while focus is inside the editor panel. Text fields keep native undo.
    options.host.addEventListener('keydown', this.onHistoryKey);
    ensureStylesheet(options.styleHref ?? DEFAULT_STYLE_HREF);
    this.render();
    this.applyVisibility();
  }

  setPreset(preset: AvsPresetAst, presetName = this.presetName): void {
    // The host re-enters here after every edit with the same name. A different
    // name is a different preset, so it becomes the new revert floor.
    const isNewPreset = presetName !== this.presetName;
    this.preset = preset;
    this.presetName = presetName;
    this.decodedModel = createAvsEditorModel(preset);
    this.currentBytes = serializeAvsEditorModel(this.decodedModel);
    if (isNewPreset) {
      this.loadedBytes = this.currentBytes;
      this.history.reset();
    }
    const model = buildAvsEditorModel(preset, this.callbacks.getNodeState);
    if (!model.flatNodes.some((node) => node.path === this.selectedPath)) {
      this.selectedPath = model.flatNodes[0]?.path ?? null;
    }
    this.render(model);
  }

  refresh(): void { this.render(); }

  /**
   * Replace-mode hook for LayerUI integration. The host hides its native list
   * and shows this editor in the exact same panel region while this is true.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  isVisible(): boolean { return this.visible; }

  select(path: string): void {
    const model = buildAvsEditorModel(this.preset, this.callbacks.getNodeState);
    const node = model.flatNodes.find((candidate) => candidate.path === path);
    if (!node) return;
    this.selectedPath = path;
    this.callbacks.onSelect?.(node.component, node.path);
    this.render(model);
  }

  /** Undo depth, redo depth, and whether the preset differs from what was loaded. */
  historyState(): { readonly undo: number; readonly redo: number; readonly edited: boolean } {
    return {
      undo: this.history.undoDepth,
      redo: this.history.redoDepth,
      edited: !avsBytesEqual(this.currentBytes, this.loadedBytes),
    };
  }

  dispose(): void {
    this.options.host.removeEventListener('keydown', this.onHistoryKey);
    this.disposed = true;
    this.options.host.replaceChildren();
  }

  private render(model = buildAvsEditorModel(this.preset, this.callbacks.getNodeState)): void {
    if (this.disposed) return;
    if (!this.selectedPath && model.flatNodes.length) this.selectedPath = model.flatNodes[0]!.path;

    const root = element('section', 'avs-editor');
    root.setAttribute('aria-label', 'AVS preset graph');
    const header = element('header', 'avs-editor__header');
    const titleBlock = element('div', 'avs-editor__title-block');
    const eyebrow = element('span', 'avs-editor__eyebrow', `AVS ${this.preset.version === 2 ? '0.2' : '0.1'} / ordered graph`);
    const title = element('h2', 'avs-editor__title', this.presetName);
    titleBlock.append(eyebrow, title);
    const meter = element('div', 'avs-editor__meter');
    meter.setAttribute('aria-label', `${model.effectCount} effects in ${model.listCount} effect lists`);
    meter.append(
      stat(String(model.effectCount), 'effects'),
      stat(String(model.listCount), 'lists'),
      stat(String(model.maxDepth), 'depth'),
    );
    const workbench = element('div', 'avs-editor__workbench');
    workbench.id = 'aaavs-avs-workbench';
    workbench.hidden = this.workbenchCollapsed;
    root.classList.toggle('is-workbench-collapsed', this.workbenchCollapsed);
    const actions = element('div', 'avs-editor__actions');
    const collapse = controlButton(
      'avs-editor__action avs-editor__collapse',
      this.workbenchCollapsed ? '▸' : '▾',
      this.workbenchCollapsed ? 'Expand AVS layer list' : 'Collapse AVS layer list',
    );
    collapse.setAttribute('aria-controls', workbench.id);
    collapse.setAttribute('aria-expanded', String(!this.workbenchCollapsed));
    collapse.addEventListener('click', () => {
      this.workbenchCollapsed = !this.workbenchCollapsed;
      workbench.hidden = this.workbenchCollapsed;
      root.classList.toggle('is-workbench-collapsed', this.workbenchCollapsed);
      collapse.textContent = this.workbenchCollapsed ? '▸' : '▾';
      collapse.title = this.workbenchCollapsed ? 'Expand AVS layer list' : 'Collapse AVS layer list';
      collapse.setAttribute('aria-label', collapse.title);
      collapse.setAttribute('aria-expanded', String(!this.workbenchCollapsed));
    });
    actions.append(collapse);
    if (this.options.onExitToNative) {
      const exit = controlButton('avs-editor__action', 'Native layers', 'Return to native aaavs layers');
      exit.addEventListener('click', () => {
        this.setVisible(false);
        this.options.onExitToNative?.();
      });
      actions.append(exit);
    }
    if (this.historySupported()) actions.append(...this.renderHistoryControls());
    if (this.callbacks.onSave) {
      const save = controlButton('avs-editor__action', 'Save .avs', 'Save the edited AVS preset');
      save.addEventListener('click', () => this.runButtonAction(save, () => dispatchAvsEditorSave(this.callbacks), false));
      actions.append(save);
    }
    if (this.callbacks.onAddToBank) {
      const add = controlButton('avs-editor__action is-primary', 'Add to My AVS', 'Save the edited preset in My AVS bank');
      add.addEventListener('click', () => this.runButtonAction(add, () => this.callbacks.onAddToBank?.(), false));
      actions.append(add);
    }
    header.append(titleBlock, meter);
    if (actions.childElementCount) header.append(actions);

    const graph = element('div', 'avs-editor__graph');
    const graphHead = element('div', 'avs-editor__section-head');
    graphHead.append(
      element('h3', '', 'Render order'),
      element('span', '', this.preset.clearEveryFrame ? 'root clears every frame' : 'root feedback retained'),
    );
    graph.append(graphHead);
    if (model.nodes.length) {
      const tree = element('ul', 'avs-editor__tree');
      tree.setAttribute('role', 'tree');
      tree.setAttribute('aria-label', 'Ordered AVS effects');
      for (const node of model.nodes) tree.append(this.renderNode(node));
      tree.addEventListener('keydown', (event) => this.handleTreeKey(event));
      graph.append(tree);
    } else {
      graph.append(element('p', 'avs-editor__empty', 'This preset has no renderer records.'));
    }

    const selected = model.flatNodes.find((node) => node.path === this.selectedPath) ?? model.flatNodes[0];
    const inspector = selected ? this.renderInspector(selected) : this.renderEmptyInspector();
    workbench.append(graph, inspector);
    this.statusLine = element('p', 'avs-editor__status');
    this.statusLine.setAttribute('role', 'status');
    this.statusLine.setAttribute('aria-live', 'polite');
    root.append(header, this.statusLine, workbench);
    this.options.host.replaceChildren(root);
    this.applyVisibility();
  }

  private renderNode(node: AvsEditorNode): HTMLLIElement {
    const item = element('li', 'avs-editor__node') as HTMLLIElement;
    item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-level', String(node.depth));
    item.setAttribute('aria-selected', String(node.path === this.selectedPath));
    item.dataset.avsPath = node.path;
    if (node.children.length) item.setAttribute('aria-expanded', String(!this.collapsed.has(node.path)));
    if (!node.state.enabled) item.classList.add('is-disabled');
    if (node.state.muted) item.classList.add('is-muted');
    if (node.state.soloed) item.classList.add('is-soloed');
    if (node.state.supported === false) item.classList.add('is-unsupported');

    const row = element('div', 'avs-editor__node-row');
    if (node.children.length) {
      const disclosure = controlButton('avs-editor__disclosure', this.collapsed.has(node.path) ? '▸' : '▾', `Toggle ${node.name}`);
      disclosure.setAttribute('aria-expanded', String(!this.collapsed.has(node.path)));
      disclosure.addEventListener('click', (event) => {
        event.stopPropagation();
        if (this.collapsed.has(node.path)) this.collapsed.delete(node.path);
        else this.collapsed.add(node.path);
        this.render();
      });
      row.append(disclosure);
    } else {
      const continuation = element('span', 'avs-editor__continuation', '↳');
      continuation.setAttribute('aria-hidden', 'true');
      row.append(continuation);
    }

    const order = element('span', 'avs-editor__order', String(node.ordinal).padStart(2, '0'));
    const identity = element('button', 'avs-editor__identity');
    identity.type = 'button';
    identity.tabIndex = node.path === this.selectedPath ? 0 : -1;
    identity.setAttribute('aria-label', `Inspect ${node.name}, path ${node.path}`);
    identity.append(
      element('strong', 'avs-editor__node-name', node.name),
      element('span', 'avs-editor__node-summary', node.summary),
    );
    identity.addEventListener('click', () => this.select(node.path));
    const controls = element('span', 'avs-editor__node-controls');
    controls.append(
      this.stateButton(node, 'enabled', 'P', 'Power', this.callbacks.onSetEnabled),
      this.stateButton(node, 'muted', 'M', 'Mute', this.callbacks.onSetMuted),
      this.stateButton(node, 'soloed', 'S', 'Solo', this.callbacks.onSetSoloed),
      this.moveButton(node, -1, '↑', 'Move earlier'),
      this.moveButton(node, 1, '↓', 'Move later'),
    );
    row.append(order, identity, controls);
    item.append(row);

    if (node.children.length && !this.collapsed.has(node.path)) {
      const children = element('ul', 'avs-editor__children');
      children.setAttribute('role', 'group');
      for (const child of node.children) children.append(this.renderNode(child));
      item.append(children);
    }
    return item;
  }

  private moveButton(node: AvsEditorNode, direction: -1 | 1, label: string, title: string): HTMLButtonElement {
    const button = controlButton('avs-editor__state avs-editor__move', label, `${title}: ${node.name}`);
    button.disabled = !this.callbacks.onMove
      || (direction < 0 ? node.ordinal <= 1 : node.ordinal >= node.siblingCount);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.runButtonAction(button, () => this.trackEdit(`move ${node.name}`, node, { kind: 'move', direction },
        () => dispatchAvsEditorMove(this.callbacks, node, direction)));
    });
    return button;
  }

  private stateButton(
    node: AvsEditorNode,
    kind: AvsEditorAction['kind'],
    label: string,
    longLabel: string,
    callback: AvsEditorCallbacks['onSetEnabled'],
  ): HTMLButtonElement {
    const button = controlButton(`avs-editor__state avs-editor__state--${kind}`, label, `${longLabel} ${node.name}`);
    const active = kind === 'enabled' ? node.state.enabled : kind === 'muted' ? node.state.muted : node.state.soloed;
    button.setAttribute('aria-pressed', String(active));
    button.disabled = !callback;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const dispatch = (): void | Promise<void> => dispatchAvsEditorAction(this.callbacks, node, { kind, value: !active });
      // Only an Effect List's power bit is preset bytes; every other P/M/S is a
      // session control and deliberately not part of undo history.
      this.runButtonAction(button, kind === 'enabled' && node.component.list
        ? () => this.trackEdit(`${active ? 'disable' : 'enable'} ${node.name}`, node, { kind: 'list-enabled', enabled: !active }, dispatch)
        : dispatch);
    });
    return button;
  }

  private renderInspector(node: AvsEditorNode): HTMLElement {
    const inspector = element('aside', 'avs-editor__inspector');
    inspector.setAttribute('aria-label', `Inspector for ${node.name}`);
    const head = element('div', 'avs-editor__inspector-head');
    head.append(
      element('span', 'avs-editor__inspector-kind', node.kind === 'list' ? 'routing group' : node.kind),
      element('h3', '', node.name),
      element('code', '', node.path),
    );
    inspector.append(head);

    const facts = element('dl', 'avs-editor__facts');
    fact(facts, 'Renderer', node.component.apeId ?? `builtin ${node.component.effectId}`);
    fact(facts, 'Payload', `${node.component.payload.byteLength.toLocaleString()} bytes`);
    fact(facts, 'File offset', `${node.component.fileOffset.toLocaleString()} bytes`);
    fact(facts, 'Runtime', node.state.supported === false ? 'unsupported / preserved' : 'available');
    fact(facts, 'State', stateLabel(node.state));
    inspector.append(facts);

    if (node.component.list) {
      const routing = element('section', 'avs-editor__inspector-section');
      routing.append(element('h4', '', 'Framebuffer routing'));
      const route = element('div', 'avs-editor__route');
      route.append(
        routeStep('parent', listBlendLabel(node.component.list.inputBlendMode, node.component.list.inputBlendValue, node.component.list.inputBuffer, node.component.list.inputInvert)),
        element('span', 'avs-editor__route-arrow', '→'),
        routeStep(`list · ${node.children.length} children`, node.component.list.clearEveryFrame ? 'clear each frame' : 'retained'),
        element('span', 'avs-editor__route-arrow', '→'),
        routeStep('parent', listBlendLabel(node.component.list.outputBlendMode, node.component.list.outputBlendValue, node.component.list.outputBuffer, node.component.list.outputInvert)),
      );
      routing.append(route);
      if (node.component.list.beatRender) {
        routing.append(element('p', 'avs-editor__annotation', `Beat gate holds for ${node.component.list.beatRenderFrames} frame${node.component.list.beatRenderFrames === 1 ? '' : 's'}.`));
      }
      inspector.append(routing);
    }

    if (node.component.listCode) {
      const codeSection = element('section', 'avs-editor__inspector-section');
      codeSection.append(element('h4', '', `Effect List code · ${node.component.listCode.enabled ? 'enabled' : 'disabled'}`));
      codeSection.append(codeBlock('init', node.component.listCode.init), codeBlock('frame', node.component.listCode.frame));
      inspector.append(codeSection);
    }
    const decoded = findAvsEditorNode(this.decodedModel, node.path);
    if (decoded && decoded.inspection.kind !== 'effect-list' && decoded.inspection.kind !== 'opaque') {
      inspector.append(renderDecodedInspection(decoded.inspection, node.path, this.callbacks.onPatchFields
        ? (patch) => this.trackEdit(`edit ${node.name}`, node, { kind: 'payload' },
          () => this.callbacks.onPatchFields?.(node.component, node.path, patch))
        : undefined, (error) => this.reportError(error)));
    }
    if (!node.component.list && this.callbacks.onPatchPayload) {
      inspector.append(this.renderPayloadEditor(node));
    }
    return inspector;
  }

  private renderPayloadEditor(node: AvsEditorNode): HTMLElement {
    const section = element('details', 'avs-editor__inspector-section avs-editor__payload-editor');
    const summary = element('summary', '', 'Raw payload · exact hex');
    const note = element('p', 'avs-editor__annotation', 'Advanced: edits replace this renderer payload byte-for-byte. Unknown data is otherwise preserved unchanged.');
    section.append(summary, note);
    // Embedded images can make an APE payload hundreds of kilobytes. Build the
    // exact hex string only when the user explicitly opens this advanced tool.
    section.addEventListener('toggle', () => {
      if (!section.open || section.dataset.loaded) return;
      section.dataset.loaded = 'true';
      const input = element('textarea', 'avs-editor__payload-hex') as HTMLTextAreaElement;
      input.spellcheck = false;
      input.value = [...node.component.payload].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
      const apply = controlButton('avs-editor__action', 'Apply payload', `Apply raw payload for ${node.name}`);
      apply.addEventListener('click', () => {
        let bytes: Uint8Array;
        try { bytes = parseAvsPayloadHex(input.value); }
        catch (error) { this.reportError(error); return; }
        this.runButtonAction(apply, () => this.trackEdit(`patch ${node.name} payload`, node, { kind: 'payload' },
          () => this.callbacks.onPatchPayload?.(node.component, node.path, bytes)));
      });
      section.append(input, apply);
    });
    return section;
  }

  private renderEmptyInspector(): HTMLElement {
    const inspector = element('aside', 'avs-editor__inspector avs-editor__inspector--empty');
    inspector.append(element('p', '', 'Select an effect to inspect its native AVS record.'));
    return inspector;
  }

  private handleTreeKey(event: KeyboardEvent): void {
    if (!(event.target instanceof HTMLElement) || !event.target.matches('.avs-editor__identity')) return;
    const tree = this.options.host.querySelector<HTMLElement>('[role="tree"]');
    if (!tree) return;
    const visible = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const current = event.target.closest<HTMLElement>('[role="treeitem"]');
    if (!current) return;
    const index = visible.indexOf(current);
    let destination: HTMLElement | undefined;
    if (event.key === 'ArrowDown') destination = visible[index + 1];
    else if (event.key === 'ArrowUp') destination = visible[index - 1];
    else if (event.key === 'Home') destination = visible[0];
    else if (event.key === 'End') destination = visible.at(-1);
    else if (event.key === 'ArrowRight') {
      if (current.getAttribute('aria-expanded') === 'false') {
        this.collapsed.delete(current.dataset.avsPath!);
        this.render();
        this.focusPath(current.dataset.avsPath!);
        event.preventDefault();
        return;
      }
      destination = current.querySelector<HTMLElement>(':scope > .avs-editor__children > [role="treeitem"]') ?? undefined;
    } else if (event.key === 'ArrowLeft') {
      if (current.getAttribute('aria-expanded') === 'true') {
        this.collapsed.add(current.dataset.avsPath!);
        this.render();
        this.focusPath(current.dataset.avsPath!);
        event.preventDefault();
        return;
      }
      destination = current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined;
    }
    else return;
    event.preventDefault();
    if (destination?.dataset.avsPath) {
      this.select(destination.dataset.avsPath);
      this.focusPath(destination.dataset.avsPath);
    }
  }

  private focusPath(path: string): void {
    const item = [...this.options.host.querySelectorAll<HTMLElement>('[data-avs-path]')]
      .find((candidate) => candidate.dataset.avsPath === path);
    item?.querySelector<HTMLButtonElement>(':scope > .avs-editor__node-row > .avs-editor__identity')?.focus();
  }

  private runButtonAction(button: HTMLButtonElement, action: () => void | Promise<void>, refresh = true): void {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    let result: void | Promise<void>;
    try { result = action(); }
    catch (error) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      this.reportError(error);
      return;
    }
    if (!result || typeof result.then !== 'function') {
      button.removeAttribute('aria-busy');
      if (refresh) this.refresh();
      else button.disabled = false;
      return;
    }
    void result.then(
      () => { if (refresh) this.refresh(); else { button.disabled = false; button.removeAttribute('aria-busy'); } },
      (error) => {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        this.reportError(error);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Undo / redo / revert
  // -------------------------------------------------------------------------

  /** Replay needs the payload path at minimum; a byte-restore hook covers everything. */
  private historySupported(): boolean {
    return Boolean(this.callbacks.onRestoreBytes || this.callbacks.onPatchPayload);
  }

  private renderHistoryControls(): HTMLButtonElement[] {
    const undo = controlButton('avs-editor__action avs-editor__history', '↶', 'Undo the last AVS edit (Ctrl+Z)');
    undo.title = this.history.peekUndo() ? `Undo ${this.history.peekUndo()!.label} (Ctrl+Z)` : 'Nothing to undo';
    undo.disabled = this.historyBusy || !this.history.peekUndo();
    undo.addEventListener('click', () => { void this.undo(); });
    const redo = controlButton('avs-editor__action avs-editor__history', '↷', 'Redo the last undone AVS edit (Ctrl+Shift+Z)');
    redo.title = this.history.peekRedo() ? `Redo ${this.history.peekRedo()!.label} (Ctrl+Shift+Z)` : 'Nothing to redo';
    redo.disabled = this.historyBusy || !this.history.peekRedo();
    redo.addEventListener('click', () => { void this.redo(); });
    const edited = !avsBytesEqual(this.currentBytes, this.loadedBytes);
    const reachable = Boolean(this.callbacks.onRestoreBytes) || this.history.canReplayToLoaded;
    const revert = controlButton('avs-editor__action avs-editor__revert', 'Revert', 'Revert to the preset as it was loaded');
    revert.title = !edited ? 'Unchanged since it was loaded'
      : reachable ? 'Revert every edit back to the preset as loaded (redo can bring them back)'
        : `More than ${this.history.limit} edits: revert needs the host's byte-restore hook`;
    revert.disabled = this.historyBusy || !edited || !reachable;
    revert.addEventListener('click', () => { void this.revert(); });
    return [undo, redo, revert];
  }

  /**
   * Run one user edit and, when it lands, record it with before/after bytes.
   * Called for byte-changing edits only: field patches, raw payloads, moves and
   * Effect List power. The edit itself still goes through the host callback
   * unchanged — this only watches it.
   */
  private trackEdit(
    label: string,
    node: AvsEditorNode,
    change: AvsEditorTrackedChange,
    run: () => void | Promise<void>,
  ): void | Promise<void> {
    if (!this.historySupported() || this.historyBusy) return run();
    const before = this.currentBytes;
    const beforePayload = node.component.payload.slice();
    const finish = (): void => {
      // The host's reload calls `setPreset` before its promise resolves, so
      // `currentBytes` is already the post-edit state here. A superseded or
      // refused load leaves it equal to `before`, and `record` ignores that.
      const after = this.currentBytes;
      const ops = this.callbacks.onRestoreBytes
        ? { undo: { kind: 'bytes', bytes: before } as const, redo: { kind: 'bytes', bytes: after } as const }
        : avsEditorHistoryOps(change, node, beforePayload, this.preset);
      if (!ops) return;
      if (this.history.record({ label, ...ops, before, after })) this.refreshHistoryControls();
    };
    const result = run();
    if (result && typeof result.then === 'function') return result.then(finish);
    finish();
  }

  private async undo(): Promise<void> {
    const entry = this.history.peekUndo();
    if (!entry || this.historyBusy) return;
    await this.stepHistory(entry.undo, entry.before, `undid ${entry.label}`, () => this.history.commitUndo());
  }

  private async redo(): Promise<void> {
    const entry = this.history.peekRedo();
    if (!entry || this.historyBusy) return;
    await this.stepHistory(entry.redo, entry.after, `redid ${entry.label}`, () => this.history.commitRedo());
  }

  /**
   * Back to the loaded bytes. With a byte-restore hook this is one step that is
   * itself undoable; without one it replays every undo in order, which leaves
   * the whole run on the redo stack.
   */
  private async revert(): Promise<void> {
    if (this.historyBusy || avsBytesEqual(this.currentBytes, this.loadedBytes)) return;
    const restore = this.callbacks.onRestoreBytes;
    if (restore) {
      const before = this.currentBytes;
      const target = this.loadedBytes;
      await this.stepHistory({ kind: 'bytes', bytes: target }, target, 'reverted to the loaded preset', () => {
        this.history.record({ label: 'revert', undo: { kind: 'bytes', bytes: before }, redo: { kind: 'bytes', bytes: target }, before, after: target });
      });
      return;
    }
    if (!this.history.canReplayToLoaded) return;
    while (this.history.peekUndo()) {
      const entry = this.history.peekUndo()!;
      if (!await this.stepHistory(entry.undo, entry.before, `undid ${entry.label}`, () => this.history.commitUndo())) return;
    }
    this.setHistoryStatus(avsBytesEqual(this.currentBytes, this.loadedBytes)
      ? 'Reverted to the loaded preset — bytes match exactly.'
      : 'Reverted every recorded edit; live edits made outside the editor were kept.');
  }

  /** Apply one op, commit it to history on success, and check the bytes against the snapshot. */
  private async stepHistory(op: AvsEditorHistoryOp, expected: Uint8Array, message: string, commit: () => void): Promise<boolean> {
    this.historyBusy = true;
    this.refreshHistoryControls();
    let failure: unknown = null;
    try {
      await this.applyHistoryOp(op);
      commit();
    } catch (error) {
      failure = error ?? new Error('history step failed');
    }
    this.historyBusy = false;
    // Render first: it rebuilds the status line, so messages go on afterwards.
    this.render();
    if (failure !== null) {
      this.reportError(failure);
      return false;
    }
    const text = `${message[0]!.toUpperCase()}${message.slice(1)}`;
    this.setHistoryStatus(avsBytesEqual(this.currentBytes, expected)
      ? `${text} — bytes match the snapshot.`
      : `${text}; edits made outside the editor since then were kept.`);
    return true;
  }

  private applyHistoryOp(op: AvsEditorHistoryOp): void | Promise<void> {
    return applyAvsEditorHistoryOp(op, this.preset, this.callbacks);
  }

  /** Swap only the three history buttons, so recording an edit does not rebuild the tree. */
  private refreshHistoryControls(): void {
    const current = [...this.options.host.querySelectorAll<HTMLButtonElement>('.avs-editor__history, .avs-editor__revert')];
    const first = current[0];
    if (!first) return;
    const next = this.renderHistoryControls();
    first.replaceWith(...next);
    for (const stale of current.slice(1)) stale.remove();
  }

  private setHistoryStatus(message: string): void {
    if (!this.statusLine) return;
    this.statusLine.textContent = message;
    this.statusLine.classList.remove('is-error');
  }

  private readonly onHistoryKey = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (isTextEntry(event.target)) return;
    const key = event.key.toLowerCase();
    const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
    const undo = key === 'z' && !event.shiftKey;
    if (!undo && !redo) return;
    if (!this.historySupported()) return;
    event.preventDefault();
    event.stopPropagation();
    void (redo ? this.redo() : this.undo());
  };

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.statusLine) {
      this.statusLine.textContent = message;
      this.statusLine.classList.add('is-error');
    }
    this.callbacks.onError?.(error);
  }

  private applyVisibility(): void {
    this.options.host.hidden = !this.visible;
    this.options.host.setAttribute('aria-hidden', String(!this.visible));
  }
}

function renderDecodedInspection(
  inspection: Exclude<AvsEditorInspection, { kind: 'effect-list' } | { kind: 'opaque' }>,
  path: string,
  onPatch?: (patch: AvsEditorFieldPatch) => void | Promise<void>,
  onError?: (error: unknown) => void,
): HTMLElement {
  const section = element('section', 'avs-editor__inspector-section');
  section.append(element('h4', '', `Decoded ${inspection.kind.replaceAll('-', ' ')}`));
  const value = 'config' in inspection ? inspection.config : inspection;
  const facts = element('dl', 'avs-editor__facts avs-editor__decoded');
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'kind') continue;
    fact(facts, key.replaceAll(/([A-Z])/g, ' $1'), inspectionValue(raw));
  }
  section.append(facts);
  // The editable half is built from `avsFieldParams`, the same descriptors the
  // MIDI mapping panel and the step lane list. There is no `if (kind === ...)`
  // ladder here any more, and no second copy of the eight numeric bounds that
  // `patchAvsEditorNodeFields` already asserts: adding a field to that adapter
  // adds it to this form and to those two surfaces at once.
  //
  // Everything else keeps its bespoke editor, deliberately: the read-only fact
  // list above (EEL programs, kernels, colour arrays, structured colour maps)
  // and the raw hex payload editor next to it, neither of which is a knob.
  const params = onPatch ? avsFieldParams(inspection, path) : [];
  if (onPatch && params.length) {
    const form = element('form', 'avs-editor__parameter-form');
    form.append(element('p', 'avs-editor__annotation', 'Source-faithful fields. Unrecognized payload bytes are preserved.'));
    const fields = params.map((param) => {
      const field = descriptorField(param.descriptor, param.read(inspection));
      form.append(field.wrapper);
      return { param, field };
    });
    // One merged patch, not one per field: `patchAvsEditorNodeFields` reloads
    // the preset per call, and four reloads for one Apply is three too many.
    bindParameterForm(form, () => {
      const merged = mergeAvsFieldPatches(fields.map(({ param, field }) => param.patch(field.read())));
      if (!merged) throw new Error(`No patchable fields for ${path}`);
      return merged;
    }, onPatch, onError);
    section.append(form);
  }
  return section;
}

function bindParameterForm(
  form: HTMLFormElement,
  patch: () => AvsEditorFieldPatch,
  onPatch: (patch: AvsEditorFieldPatch) => void | Promise<void>,
  onError?: (error: unknown) => void,
): void {
  const apply = controlButton('avs-editor__action', 'Apply parameters', 'Apply AVS effect parameters');
  apply.type = 'submit';
  form.append(apply);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    apply.disabled = true;
    apply.setAttribute('aria-busy', 'true');
    try {
      const result = onPatch(patch());
      if (result && typeof result.then === 'function') {
        void result.then(
          () => { apply.disabled = false; apply.removeAttribute('aria-busy'); },
          (error) => { apply.disabled = false; apply.removeAttribute('aria-busy'); onError?.(error); },
        );
      } else { apply.disabled = false; apply.removeAttribute('aria-busy'); }
    } catch (error) {
      apply.disabled = false;
      apply.removeAttribute('aria-busy');
      onError?.(error);
    }
  });
}

function numberField(
  label: string,
  value: number,
  min: number,
  max: number,
  step = 1,
): { wrapper: HTMLLabelElement; input: HTMLInputElement } {
  const wrapper = element('label', 'avs-editor__parameter');
  wrapper.append(element('span', '', label));
  const input = element('input') as HTMLInputElement;
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  // `any` rather than 1 when a descriptor declares no step: an integer field
  // says `step: 1` for itself, and forcing 1 on a float would round it in the
  // browser before the value ever reached the clamp that owns the range.
  input.step = step > 0 ? String(step) : 'any';
  input.value = String(value);
  wrapper.append(input);
  return { wrapper, input };
}

/**
 * One descriptor to one of the three widgets above.
 *
 * This is the whole of "how do I draw a parameter" for the AVS lane. `read`
 * returns the widget's value in the descriptor's own terms — an index for a
 * select, a boolean for a checkbox — so the caller never has to know which
 * element it got.
 */
function descriptorField(
  descriptor: ParamDescriptor,
  value: ParamValue,
): { wrapper: HTMLLabelElement; read: () => ParamValue } {
  if (descriptor.kind === 'boolean') {
    const field = checkboxField(paramTitle(descriptor), value === true);
    return { wrapper: field.wrapper, read: () => field.input.checked };
  }
  if (descriptor.kind === 'select') {
    const options = (descriptor.values ?? []).map((label, index) => [String(index), label] as const);
    const field = selectField(paramTitle(descriptor), options, String(Number(value)));
    return { wrapper: field.wrapper, read: () => Number(field.input.value) };
  }
  const field = numberField(
    paramTitle(descriptor),
    Number(value),
    paramMin(descriptor),
    paramMax(descriptor),
    paramStep(descriptor),
  );
  return { wrapper: field.wrapper, read: () => field.input.valueAsNumber };
}

function checkboxField(label: string, checked: boolean): { wrapper: HTMLLabelElement; input: HTMLInputElement } {
  const wrapper = element('label', 'avs-editor__parameter avs-editor__parameter--check');
  const input = element('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = checked;
  wrapper.append(input, element('span', '', label));
  return { wrapper, input };
}

function selectField(label: string, options: readonly (readonly [string, string])[], value: string): { wrapper: HTMLLabelElement; input: HTMLSelectElement } {
  const wrapper = element('label', 'avs-editor__parameter');
  wrapper.append(element('span', '', label));
  const input = element('select') as HTMLSelectElement;
  for (const [optionValue, optionLabel] of options) {
    const option = element('option', '', optionLabel) as HTMLOptionElement;
    option.value = optionValue;
    input.append(option);
  }
  input.value = value;
  wrapper.append(input);
  return { wrapper, input };
}

function inspectionValue(raw: unknown): string {
  if (typeof raw === 'string') return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw || '—';
  if (ArrayBuffer.isView(raw)) {
    const values = Array.from(raw as unknown as ArrayLike<number>);
    return `${values.length} bytes · ${values.slice(0, 8).join(', ')}${values.length > 8 ? ', …' : ''}`;
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return '0 values';
    const primitive = raw.every((value) => value === null || ['string', 'number', 'boolean'].includes(typeof value));
    return primitive
      ? `${raw.length} values · ${raw.slice(0, 8).join(', ')}${raw.length > 8 ? ', …' : ''}`
      : `${raw.length} structured item${raw.length === 1 ? '' : 's'}`;
  }
  if (typeof raw === 'object' && raw !== null) {
    const encoded = JSON.stringify(raw);
    return encoded.length > 240 ? `${encoded.slice(0, 240)}…` : encoded;
  }
  return String(raw);
}

function effectName(component: AvsComponent): string {
  if (component.list) return 'Effect List';
  if (component.apeId) return component.apeId;
  return BUILTIN_EFFECT_NAMES[component.effectId] ?? `Unknown renderer ${component.effectId}`;
}

function effectSummary(component: AvsComponent): string {
  if (component.list) {
    const list = component.list;
    const inBlend = decodeAvsListBlend(list.inputBlendMode);
    const outBlend = decodeAvsListBlend(list.outputBlendMode);
    const flags = [list.clearEveryFrame ? 'clear' : 'retain'];
    if (list.beatRender) flags.push(`beat×${list.beatRenderFrames}`);
    if (component.listCode) flags.push(component.listCode.enabled ? 'EEL' : 'EEL off');
    return `${component.children.length} children · ${inBlend} in / ${outBlend} out · ${flags.join(' · ')}`;
  }
  const type = component.apeId ? 'APE' : `ID ${component.effectId}`;
  return `${type} · ${component.payload.byteLength} B`;
}

function listBlendLabel(code: number, value: number, buffer: number, invert: boolean): string {
  const blend = decodeAvsListBlend(code);
  const detail = blend === 'adjustable' ? ` ${value}/255` : blend === 'buffer-depth' ? ` buffer ${buffer + 1}` : '';
  return `${blend}${detail}${invert ? ' · inverted' : ''}`;
}

function stateLabel(state: AvsEditorNodeState): string {
  if (!state.enabled) return 'disabled';
  if (state.muted) return 'muted';
  if (state.soloed) return 'solo';
  return 'active';
}

function comparePaths(a: AvsEditorNode, b: AvsEditorNode): number {
  const left = a.path.split('.').map(Number);
  const right = b.path.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return 0;
}

function stat(value: string, label: string): HTMLElement {
  const wrapper = element('span', 'avs-editor__stat');
  wrapper.append(element('b', '', value), element('small', '', label));
  return wrapper;
}

function fact(list: HTMLDListElement, label: string, value: string): void {
  list.append(element('dt', '', label), element('dd', '', value));
}

function routeStep(label: string, detail: string): HTMLElement {
  const step = element('span', 'avs-editor__route-step');
  step.append(element('b', '', label), element('small', '', detail));
  return step;
}

function codeBlock(label: string, source: string): HTMLElement {
  const wrapper = element('div', 'avs-editor__code');
  wrapper.append(element('span', '', label), element('pre', '', source.trim() || '—'));
  return wrapper;
}

/** Text fields keep the browser's own undo; the editor's history is for everything else. */
function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement
    && target.type !== 'button' && target.type !== 'checkbox' && target.type !== 'radio' && target.type !== 'submit';
}

function controlButton(className: string, text: string, ariaLabel: string): HTMLButtonElement {
  const button = element('button', className, text) as HTMLButtonElement;
  button.type = 'button';
  button.setAttribute('aria-label', ariaLabel);
  return button;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
}

function ensureStylesheet(href: string): void {
  if (typeof document === 'undefined' || document.querySelector(`link[data-aaavs-avs-editor="${CSS.escape(href)}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.aaavsAvsEditor = href;
  document.head.append(link);
}
