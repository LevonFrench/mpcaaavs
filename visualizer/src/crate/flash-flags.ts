// Flash flags for the preset crate (ux-architect review §3.5, wireframe §7b).
//
// A flag is METADATA shown next to a preset name; it never changes what a
// preset renders. The owner decided (2026-09-26) that flash limiting is
// enforced on the projector and toggled on the control window — that limiter
// lives elsewhere. This file only answers "should the list warn about this
// entry before someone puts it live?".
//
// Two tiers, deliberately kept distinguishable all the way to the UI:
//
// - HEURISTIC: a name/collection regex. It is a guess. It will miss strobing
//   presets with innocent names and flag a calm preset called "flashback". The
//   UI labels it as a guess so nobody reads its absence as a safety claim.
// - MEASURED: anything a registered source says, e.g. a future offline pass
//   that renders each preset and counts luminance flips per second against the
//   WCAG 2.3.1 three-flashes threshold. Measured beats heuristic whenever a
//   source has an opinion, including an explicit "not flashing" (`null` from a
//   source means "no opinion"; `{ kind: 'measured', flashing: false }` is an
//   opinion).

export type FlashFlagKind = 'heuristic' | 'measured';

export interface FlashFlag {
  readonly kind: FlashFlagKind;
  /** False only from a measured source that checked and found no flashing. */
  readonly flashing: boolean;
  /** One short human line for the tooltip. */
  readonly reason: string;
}

export interface FlashFlagSubject {
  /** Source bank: 'bundled' | 'local' | 'personal', or anything a host adds. */
  readonly bank: string;
  readonly id: string;
  readonly name: string;
  readonly collection: string;
}

/** A measured-flag provider. Return null for "no opinion about this entry". */
export type FlashFlagSource = (subject: FlashFlagSubject) => FlashFlag | null;

/**
 * HEURISTIC ONLY. Words that suggest strobing or flashing content in a preset
 * name or collection label. Not a measurement of any pixel.
 */
export const FLASH_NAME_HEURISTIC = /strobe|strobo|flash|flicker|epilep|seizure|blink/i;

const sources: FlashFlagSource[] = [];

/**
 * Register a measured-flag provider. Later registrations are asked first, so a
 * newer measurement pass overrides an older one. Returns an unregister handle.
 */
export function registerFlashFlagSource(source: FlashFlagSource): () => void {
  sources.unshift(source);
  return () => {
    const at = sources.indexOf(source);
    if (at >= 0) sources.splice(at, 1);
  };
}

/** The name/collection guess on its own. Exported for the check tool. */
export function heuristicFlashFlag(subject: Pick<FlashFlagSubject, 'name' | 'collection'>): FlashFlag | null {
  const match = FLASH_NAME_HEURISTIC.exec(`${subject.name} ${subject.collection}`);
  if (!match) return null;
  return {
    kind: 'heuristic',
    flashing: true,
    reason: `name suggests flashing ("${match[0].toLowerCase()}") — heuristic guess, not measured`,
  };
}

/**
 * The flag to show for one entry: the first measured opinion, else the
 * heuristic, else null. A measured `flashing: false` is returned as-is so the
 * caller can tell "checked, clean" from "never checked".
 */
export function flashFlagFor(subject: FlashFlagSubject): FlashFlag | null {
  for (const source of sources) {
    const measured = source(subject);
    if (measured) return measured;
  }
  return heuristicFlashFlag(subject);
}
