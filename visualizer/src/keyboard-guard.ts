// The text-entry keyboard guard, shared.
//
// `main.ts` binds single letters, digits and the arrow keys on `window` in the
// bubble phase. A panel with a field in it therefore has to stop those keys
// reaching the page while the performer is typing — typing `128` into a number
// box must not fire three shortcuts, and nudging a range slider with ArrowLeft
// must not also skip a bar. `ui.ts` solved this for the layer panel with a
// capture-phase listener on `window`; this file is that same guard lifted out
// so the panels added after it (the step grid, the live-input panel) do not
// each grow a private copy.
//
// Capture at `window` runs before any bubble-phase listener on `window`,
// whichever was registered first, which is the only ordering-independent way
// to do this without editing the page's own handler. The event is STOPPED, not
// prevented: the default action still happens, so the field still types and
// the slider still moves (its `input`/`change` events are separate events and
// still fire). A `keydown` listener on the field ITSELF does not run — window
// capture precedes the target phase — so a panel that ever needs one must
// handle the key before this guard, as `ui.ts` does for the crate.
// `stopPropagation` rather than `stopImmediatePropagation`, because other
// capture-phase listeners on `window` (the layer panel's) are not this guard's
// business.
//
// Escape is let through on purpose: it is the one key a performer presses to
// get OUT of a panel, and a guard that swallowed it would trap focus.
//
// Everything is duck-typed (tag name, `type`, `isContentEditable`) rather than
// `instanceof HTMLInputElement`, so the rule can be exercised in node by a
// check tool without a DOM.

/** Input types that are buttons in disguise: they take no typing, so the page keeps its keys. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file',
]);

interface ElementLike {
  readonly tagName?: unknown;
  readonly type?: unknown;
  readonly isContentEditable?: unknown;
}

/**
 * Does a keystroke on this target belong to the field rather than the page?
 *
 * True for textareas, selects, contenteditable, and every `<input>` that is
 * not a button in disguise — which includes `number` and `range`, whose arrow
 * keys are the field's own.
 */
export function isTextEntry(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== 'object') return false;
  const node = target as ElementLike;
  if (node.isContentEditable === true) return true;
  if (typeof node.tagName !== 'string') return false;
  const tag = node.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = typeof node.type === 'string' ? node.type.toLowerCase() : 'text';
  return !NON_TEXT_INPUT_TYPES.has(type);
}

/** ARIA roles whose element takes Space/Enter activation itself. */
const ACTIVATION_ROLES: ReadonlySet<string> = new Set([
  'button', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'link', 'slider', 'spinbutton', 'combobox', 'textbox',
]);

/**
 * Does Space (or Enter) on this target belong to the control rather than to a page shortcut such as play/pause?
 *
 * True for every text entry (see `isTextEntry`), every `<input>` (checkboxes and buttons included), buttons, links with an href,
 * `<summary>`, and elements with an activation role. Shared shortcut handlers call this before claiming Space, so a focused
 * embedded button is pressed instead of toggling playback.
 */
export function isInteractiveTarget(target: EventTarget | null | undefined): boolean {
  if (isTextEntry(target)) return true;
  if (!target || typeof target !== 'object') return false;
  const node = target as ElementLike & { readonly role?: unknown; readonly href?: unknown; getAttribute?(name: string): string | null };
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'A' && (typeof node.href === 'string' ? node.href !== '' : !!node.getAttribute?.('href'))) return true;
  let role: unknown = node.role;
  if (typeof role !== 'string' && typeof node.getAttribute === 'function') role = node.getAttribute('role');
  return typeof role === 'string' && ACTIVATION_ROLES.has(role.toLowerCase());
}

/** The part of a `Node` the guard needs: is the event target inside this panel? */
export interface KeyboardGuardRoot {
  contains(other: Node | null): boolean;
}

/** Where the capture listener goes. `window` in the page; a stub in a check. */
export type KeyboardGuardHost = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** The event fields the guard reads. */
export interface KeyboardGuardEvent {
  readonly key: string;
  readonly target: EventTarget | null;
  stopPropagation(): void;
}

/**
 * The decision, separated from the listener so it can be tested on its own.
 * Returns true when the event was stopped.
 */
export function guardKeyEvent(root: KeyboardGuardRoot, event: KeyboardGuardEvent): boolean {
  if (event.key === 'Escape') return false;
  if (!isTextEntry(event.target)) return false;
  if (!root.contains(event.target as Node | null)) return false;
  event.stopPropagation();
  return true;
}

/**
 * Stop page shortcuts while focus is in a field inside `root`.
 *
 * Returns the uninstall, which the panel's `dispose()` must call — a guard
 * left on `window` after its panel is gone holds the panel's DOM alive.
 * Scoped to `root` so two panels can each install one without either
 * guarding the other's fields twice or the page's fields at all.
 */
export function installKeyboardGuard(
  root: KeyboardGuardRoot,
  host: KeyboardGuardHost = window,
): () => void {
  const listener = (event: Event): void => {
    guardKeyEvent(root, event as KeyboardEvent);
  };
  host.addEventListener('keydown', listener, true);
  let installed = true;
  return (): void => {
    if (!installed) return;
    installed = false;
    host.removeEventListener('keydown', listener, true);
  };
}
