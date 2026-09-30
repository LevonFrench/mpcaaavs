/** A loaded asset pack: typed lookups over a checked manifest plus decoded atlas images. Pure data access; drawing is in draw.ts. */
import type { ActorRegion, AssetPackManifest, AssetRole, AtlasDef, ClipDef, ClipVerb, FontDef, PaletteDef, Point, Rect, Region } from './manifest.ts';

/** Anything `drawImage` accepts that also reports its size (ImageBitmap, HTMLCanvasElement, OffscreenCanvas). */
export interface AtlasImage { readonly width: number; readonly height: number }

export interface ResolvedFrame { readonly atlas: string; readonly rect: Rect; readonly anchor: Point; readonly hold: number }

/** Frame shown `sourceFrame` source frames after a clip starts. Loops wrap, one-shots hold their last frame; negative times show frame 0. */
export function clipFrameIndex(hold: readonly number[], loop: boolean, sourceFrame: number): number {
  let total = 0;
  for (const h of hold) total += h;
  if (!(sourceFrame > 0) || total === 0) return 0;
  let t = Math.floor(sourceFrame);
  if (loop) t %= total; else if (t >= total) return hold.length - 1;
  for (let i = 0; i < hold.length; i++) { if (t < hold[i]!) return i; t -= hold[i]!; }
  return hold.length - 1;
}
export const clipDuration = (hold: readonly number[]): number => hold.reduce((sum, h) => sum + h, 0);

export class AssetPack {
  readonly id: string;
  readonly name: string;
  private readonly frames = new Map<string, readonly ResolvedFrame[]>();
  private readonly byRole = new Map<AssetRole, readonly string[]>();
  constructor(readonly manifest: AssetPackManifest, private readonly images: ReadonlyMap<string, AtlasImage>) {
    this.id = manifest.id; this.name = manifest.name;
    const roles = new Map<AssetRole, string[]>();
    for (const id of Object.keys(manifest.regions).sort()) {
      const role = manifest.regions[id]!.role;
      (roles.get(role) ?? roles.set(role, []).get(role)!).push(id);
    }
    for (const [role, ids] of roles) this.byRole.set(role, Object.freeze(ids));
  }
  /** True when the atlas image was decoded; a metadata-only pack (no decoder available) has none. */
  hasImage(atlas: string): boolean { return this.images.has(atlas); }
  image(atlas: string): AtlasImage | null { return this.images.get(atlas) ?? null; }
  atlas(id: string): AtlasDef | undefined { return Object.hasOwn(this.manifest.atlases, id) ? this.manifest.atlases[id] : undefined; }
  palette(id: string): PaletteDef | undefined { return Object.hasOwn(this.manifest.palettes, id) ? this.manifest.palettes[id] : undefined; }
  region(id: string): Region | undefined { return Object.hasOwn(this.manifest.regions, id) ? this.manifest.regions[id] : undefined; }
  /** Typed region lookup: undefined unless the region exists with exactly this role. */
  regionOf<R extends AssetRole>(id: string, role: R): Extract<Region, { role: R }> | undefined {
    const region = this.region(id);
    return region && region.role === role ? region as Extract<Region, { role: R }> : undefined;
  }
  /** Region ids of a role in sorted order (a stable order for seeded picks). */
  idsByRole(role: AssetRole): readonly string[] { return this.byRole.get(role) ?? []; }
  clip(id: string): ClipDef | undefined { return Object.hasOwn(this.manifest.clips, id) ? this.manifest.clips[id] : undefined; }
  font(id: string): FontDef | undefined { return Object.hasOwn(this.manifest.fonts, id) ? this.manifest.fonts[id] : undefined; }
  /** The clip an actor uses for a verb, with its id. */
  actorClip(actorId: string, verb: ClipVerb): { id: string; clip: ClipDef } | undefined {
    const actor: ActorRegion | undefined = this.regionOf(actorId, 'actor');
    const id = actor?.clips[verb];
    const clip = id === undefined ? undefined : this.clip(id);
    return id !== undefined && clip ? { id, clip } : undefined;
  }
  /** Every frame of a clip with its atlas rectangle, anchor and hold. Cached. */
  clipFrames(id: string): readonly ResolvedFrame[] | undefined {
    const cached = this.frames.get(id);
    if (cached) return cached;
    const clip = this.clip(id);
    if (!clip) return undefined;
    const out: ResolvedFrame[] = [];
    for (let i = 0; i < clip.length; i++) {
      let atlas: string, rect: Rect, anchor: Point;
      if (clip.frames) {
        const region = this.region(clip.frames[i]!)!;
        atlas = region.atlas; rect = region.rect; anchor = region.anchor;
      } else {
        const strip = clip.strip!, cell = strip.axis === 'x' ? strip.rect[2] / strip.count : strip.rect[3] / strip.count;
        atlas = strip.atlas;
        rect = strip.axis === 'x' ? [strip.rect[0] + i * cell, strip.rect[1], cell, strip.rect[3]] : [strip.rect[0], strip.rect[1] + i * cell, strip.rect[2], cell];
        anchor = [rect[2] >> 1, rect[3]];
      }
      out.push(Object.freeze({ atlas, rect: Object.freeze(rect) as Rect, anchor: clip.anchors ? clip.anchors[i]! : anchor, hold: clip.hold[i]! }));
    }
    const frozen = Object.freeze(out);
    this.frames.set(id, frozen);
    return frozen;
  }
}
