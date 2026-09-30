// Canvas creation for the show engine. The engine renders inside a worker (OffscreenCanvas); the
// upstream code (bizarro/evangelion, MIT) was written for the DOM and calls document.createElement('canvas').
// createCanvas() returns an OffscreenCanvas where there is no document, typed as an HTMLCanvasElement so
// the ported drawing code keeps its CanvasRenderingContext2D types: every member the plates use exists on
// OffscreenCanvasRenderingContext2D (Chromium: letterSpacing, filter, fontKerning, Path2D, DOMMatrix).

/** A 2D-drawable canvas: OffscreenCanvas in a worker, a detached <canvas> in a page. */
export function createCanvas(width = 300, height = 150): HTMLCanvasElement {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return new OffscreenCanvas(Math.max(1, width), Math.max(1, height)) as unknown as HTMLCanvasElement;
  }
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  return c;
}

/** The FontFaceSet of this global (document.fonts in a page, self.fonts in a worker). */
export function fontSet(): FontFaceSet {
  const g = globalThis as unknown as { document?: { fonts?: FontFaceSet }; fonts?: FontFaceSet };
  const set = g.document?.fonts ?? g.fonts;
  if (!set) throw new Error('FontFaceSet unavailable in this context');
  return set;
}

/** Fetch an engine asset (fonts) relative to the asset base the host configured. */
let assetBase = '';
export function setAssetBase(base: string) { assetBase = base.endsWith('/') || base === '' ? base : base + '/'; }
export function assetUrl(path: string) { return assetBase + path; }
export async function fetchAsset(path: string): Promise<Response> {
  const r = await fetch(assetUrl(path));
  if (!r.ok) throw new Error(`show asset missing: ${assetUrl(path)} (${r.status})`);
  return r;
}
