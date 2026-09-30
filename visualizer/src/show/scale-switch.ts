// Output scale of the show engine in the hosts (AAAVS).
//
// The engine's resolution multiplier is fixed per worker when its modules load (scale.ts: shaders and text sprites are
// built for it), so following the host's resolution governor means choosing a worker per scale. The host picks the
// starting scale from the governor's render size (hud-host.ts sceneWorkerLocation); when the governor later settles on
// a size that needs another scale (a quality change, the Auto tier stepping down under load, a move to a 4K display),
// the preset worker starts a copy of itself at that scale and switches once it is ready (show-render.worker.ts).
//
// Scale 2 renders 3840x2160 and is used when the render size is more than 1.25x the 1920x1080 design canvas (so the
// governor's High tier, 2560x1440, is supersampled from 4K and its Native tier is native 4K); scale 1 otherwise.
// A switch needs the new scale to persist for SWITCH_FRAMES consecutive requests, so a governor probing a tier for a
// few frames never restarts the renderer.

export const SWITCH_FRAMES = 20;
export const MAX_SHOW_SCALE = 2;

/** Engine scale for a render size (1 or 2). */
export function showScaleFor(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.max(width / 1920, height / 1080) > 1.25 ? MAX_SHOW_SCALE : 1;
}

/** Debounced scale choice across render requests. */
export class ShowScaleSwitch {
  private streak = 0;
  private want = 0;
  constructor(public current: number) {}

  /** The scale to switch to after this request, or null to stay. */
  observe(width: number, height: number): number | null {
    const s = showScaleFor(width, height);
    if (s === this.current) { this.streak = 0; this.want = 0; return null; }
    if (s !== this.want) { this.want = s; this.streak = 0; }
    return ++this.streak >= SWITCH_FRAMES ? s : null;
  }

  /** The switch to `scale` happened (or was abandoned: pass the old scale). */
  settle(scale: number) { this.current = scale; this.streak = 0; this.want = 0; }
}
