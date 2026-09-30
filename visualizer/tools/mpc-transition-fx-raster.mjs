import assert from 'node:assert/strict';
// CPU doubles for the transition styles that need more than rectangular clips (docs/design/TRANSITIONS-V2.md 9.1).
// No browser, Canvas or GPU: scalar (id mode) or RGB (colour mode) pixels, nearest sampling at pixel centres, nonzero-winding
// scanline clips, and a decoration plane so reveal coverage and decoration area are counted separately.
//   Surface / PathContext      the raster: a canvas-like surface and its 2D context subset
//   RecordingContext           records and validates every call (finite arguments, balanced save/restore) and optionally forwards to a PathContext
//   idSource / colourSource    source images: id pixels (old = ID_OLD + i, next = ID_NEXT + i; ID_NEXT is above any frame's pixel count) or RGB pixels
// Identity transforms only: translate, scale, rotate and non-identity setTransform throw, so a style cannot depend on them silently.

const TAU = Math.PI * 2;
export const CLASS = Object.freeze({ HOLE: 0, OLD: 1, NEXT: 2, MIXED: 3, DECO: 4 });
export const DECO = Object.freeze({ SHAPE: 1, TEXT: 2, BRIGHT: 4 });
/** Id bases of the two sources: ID_NEXT exceeds the pixel count of any frame up to 3840x2160 + ID_OLD, so a pixel value names its source unambiguously. */
export const ID_OLD = 100, ID_NEXT = 1e7;

export class Surface {
  constructor(width, height, channels = 1) { this.tag = 'surface'; this.ch = channels; this.resize(width, height); }
  resize(width, height) {
    this._w = width; this._h = height;
    this.data = new Float64Array(width * height * this.ch);
    this.deco = new Uint8Array(width * height);
    this.blend = new Uint8Array(width * height);
  }
  get width() { return this._w; }
  set width(value) { this.resize(value, this._h); this.ctx = null; }
  get height() { return this._h; }
  set height(value) { this.resize(this._w, value); this.ctx = null; }
  getContext() { return this.ctx ??= new PathContext(this); }
  /** 1 old, 2 next, 3 blended, 4 decoration (what the viewer sees), 0 nothing drawn. `data` ignores decoration. */
  classes(includeDeco = true) {
    const out = new Uint8Array(this._w * this._h);
    for (let i = 0; i < out.length; i++) {
      const v = this.data[i * this.ch];
      out[i] = includeDeco && this.deco[i] ? CLASS.DECO : this.blend[i] ? CLASS.MIXED : v >= ID_NEXT ? CLASS.NEXT : v >= ID_OLD ? CLASS.OLD : CLASS.HOLE;
    }
    return out;
  }
  rgba() {
    const out = new Uint8ClampedArray(this._w * this._h * 4);
    for (let i = 0; i < this._w * this._h; i++) { for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(this.data[i * this.ch + (this.ch === 3 ? k : 0)]); out[i * 4 + 3] = 255; }
    return out;
  }
  count(mask) { let n = 0; for (let i = 0; i < this.deco.length; i++) if (this.deco[i] & mask) n++; return n; }
}
/** Id pixels: value = base + index, so any output pixel names its source (old = ID_OLD + i, next = ID_NEXT + i). */
export function idSource(width, height, base, tag = 'source') {
  const s = new Surface(width, height, 1); s.tag = tag;
  for (let i = 0; i < width * height; i++) s.data[i] = base + i;
  return s;
}
/** RGB pixels from fn(x, y) -> [r, g, b] in 0..255. */
export function colourSource(width, height, fn, tag = 'source') {
  const s = new Surface(width, height, 3); s.tag = tag;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const c = fn(x, y); for (let k = 0; k < 3; k++) s.data[(y * width + x) * 3 + k] = c[k]; }
  return s;
}
/** createCanvas for scratch surfaces (Mosaic Drop): resizable, same channel count as the sources it will receive. */
export const rasterCanvasFactory = (channels = 1, tag = 'scratch') => () => { const s = new Surface(1, 1, channels); s.tag = tag; return s; };

// ---- colours ---------------------------------------------------------------------------------------------------------------------------------
export function parseColour(text) {
  const s = String(text).trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map(c => parseInt(c + c, 16)).concat(1);
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  return [0, 0, 0, 1];
}
const lin = c => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
export const luminance = c => .2126 * lin(c[0]) + .7152 * lin(c[1]) + .0722 * lin(c[2]);
export const BRIGHT_LUMINANCE = .7;

// ---- geometry --------------------------------------------------------------------------------------------------------------------------------
/** Nonzero-winding coverage of subpaths (implicitly closed), pixel centres, as a Uint8Array mask. */
function coverage(subs, width, height) {
  const mask = new Uint8Array(width * height), edges = [];
  for (const pts of subs) for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1]);
  }
  for (let y = 0; y < height; y++) {
    const yc = y + .5, xs = [];
    for (const e of edges) if (yc >= e[1] && yc < e[3]) xs.push([e[0] + (yc - e[1]) * (e[2] - e[0]) / (e[3] - e[1]), e[4]]);
    if (xs.length < 2) continue;
    xs.sort((p, q) => p[0] - q[0]);
    let winding = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      winding += xs[i][1];
      if (!winding) continue;
      const from = Math.max(0, Math.ceil(xs[i][0] - .5)), to = Math.min(width, Math.ceil(xs[i + 1][0] - .5));
      for (let x = from; x < to; x++) mask[y * width + x] = 1;
    }
  }
  return mask;
}
function arcPoints(cx, cy, r, a0, a1, ccw) {
  let sweep;
  if (!ccw) sweep = a1 - a0 >= TAU ? TAU : (((a1 - a0) % TAU) + TAU) % TAU;
  else sweep = a0 - a1 >= TAU ? -TAU : -((((a0 - a1) % TAU) + TAU) % TAU);
  const n = Math.max(2, Math.ceil(48 * Math.abs(sweep) / TAU)), out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return out;
}

export class PathContext {
  constructor(canvas) {
    this.canvas = canvas; this.stack = [];
    this.globalAlpha = 1; this.imageSmoothingEnabled = true; this.imageSmoothingQuality = 'low'; this.globalCompositeOperation = 'source-over';
    this.fillStyle = '#000000'; this.strokeStyle = '#000000'; this.lineWidth = 1; this.lineJoin = 'miter'; this.font = '10px sans-serif';
    this.textAlign = 'start'; this.textBaseline = 'alphabetic';
    this.subs = []; this.open = null; this.clipMask = null;
  }
  save() { this.stack.push({ a: this.globalAlpha, sm: this.imageSmoothingEnabled, q: this.imageSmoothingQuality, gco: this.globalCompositeOperation, f: this.fillStyle, s: this.strokeStyle, lw: this.lineWidth, lj: this.lineJoin, font: this.font, ta: this.textAlign, tb: this.textBaseline, clip: this.clipMask }); }
  restore() {
    const s = this.stack.pop(); assert.ok(s, 'restore() without save()');
    this.globalAlpha = s.a; this.imageSmoothingEnabled = s.sm; this.imageSmoothingQuality = s.q; this.globalCompositeOperation = s.gco; this.fillStyle = s.f; this.strokeStyle = s.s;
    this.lineWidth = s.lw; this.lineJoin = s.lj; this.font = s.font; this.textAlign = s.ta; this.textBaseline = s.tb; this.clipMask = s.clip;
  }
  // -- paths
  beginPath() { this.subs = []; this.open = null; }
  moveTo(x, y) { this.open = { pts: [[x, y]] }; this.subs.push(this.open.pts); }
  lineTo(x, y) { if (!this.open) return this.moveTo(x, y); this.open.pts.push([x, y]); }
  closePath() { if (this.open) { const start = this.open.pts[0]; this.open = { pts: [[start[0], start[1]]] }; this.subs.push(this.open.pts); } }
  rect(x, y, w, h) { this.subs.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); this.open = null; }
  arc(cx, cy, r, a0, a1, ccw = false) {
    assert.ok(r >= 0, 'arc radius'); const pts = arcPoints(cx, cy, r, a0, a1, ccw);
    if (this.open) this.open.pts.push(...pts); else { this.open = { pts }; this.subs.push(pts); }
  }
  // -- painting
  _visible(x, y) { return x >= 0 && y >= 0 && x < this.canvas.width && y < this.canvas.height && (!this.clipMask || this.clipMask[y * this.canvas.width + x]); }
  _paint(x, y, colour, kind) {
    const c = this.canvas, i = y * c.width + x, alpha = this.globalAlpha * colour[3];
    if (!(alpha >= 1 / 510)) return;   // below half an 8-bit level: cannot change a displayed pixel, so it is not decoration
    if (kind === 'text') c.deco[i] |= DECO.TEXT; else c.deco[i] |= DECO.SHAPE | (luminance(colour) >= BRIGHT_LUMINANCE ? DECO.BRIGHT : 0);
    if (c.ch === 3) for (let k = 0; k < 3; k++) c.data[i * 3 + k] += (colour[k] - c.data[i * 3 + k]) * alpha;
  }
  clip() {
    const mask = coverage(this.subs, this.canvas.width, this.canvas.height);
    if (this.clipMask) for (let i = 0; i < mask.length; i++) mask[i] &= this.clipMask[i];
    this.clipMask = mask;
  }
  fill() {
    const mask = coverage(this.subs, this.canvas.width, this.canvas.height), colour = parseColour(this.fillStyle), w = this.canvas.width;
    for (let y = 0; y < this.canvas.height; y++) for (let x = 0; x < w; x++) if (mask[y * w + x] && this._visible(x, y)) this._paint(x, y, colour, 'shape');
  }
  fillRect(x, y, rw, rh) {
    const colour = parseColour(this.fillStyle);
    for (let py = Math.max(0, Math.ceil(y - .5)); py < Math.min(this.canvas.height, Math.ceil(y + rh - .5)); py++)
      for (let px = Math.max(0, Math.ceil(x - .5)); px < Math.min(this.canvas.width, Math.ceil(x + rw - .5)); px++) if (this._visible(px, py)) this._paint(px, py, colour, 'shape');
  }
  clearRect(x, y, rw, rh) {
    const c = this.canvas;
    for (let py = Math.max(0, Math.ceil(y - .5)); py < Math.min(c.height, Math.ceil(y + rh - .5)); py++)
      for (let px = Math.max(0, Math.ceil(x - .5)); px < Math.min(c.width, Math.ceil(x + rw - .5)); px++) {
        const i = py * c.width + px; c.deco[i] = 0; c.blend[i] = 0; for (let k = 0; k < c.ch; k++) c.data[i * c.ch + k] = 0;
      }
  }
  stroke() {
    const colour = parseColour(this.strokeStyle), half = Math.max(.5, this.lineWidth / 2), c = this.canvas;
    for (const pts of this.subs) for (let s = 0; s < pts.length; s++) {
      const a = pts[s], b = pts[(s + 1) % pts.length];
      if (pts.length < 2) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      for (let y = Math.max(0, Math.floor(Math.min(a[1], b[1]) - half)); y <= Math.min(c.height - 1, Math.ceil(Math.max(a[1], b[1]) + half)); y++)
        for (let x = Math.max(0, Math.floor(Math.min(a[0], b[0]) - half)); x <= Math.min(c.width - 1, Math.ceil(Math.max(a[0], b[0]) + half)); x++) {
          const px = x + .5, py = y + .5, k = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2)) : 0;
          if (Math.hypot(px - a[0] - k * dx, py - a[1] - k * dy) <= half && this._visible(x, y)) this._paint(x, y, colour, 'shape');
        }
    }
  }
  _text(text, x, y, colour, grow) {
    const size = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10), width = String(text).length * size * .6, height = size * .8;
    const left = this.textAlign === 'center' ? x - width / 2 : this.textAlign === 'right' || this.textAlign === 'end' ? x - width : x;
    const top = this.textBaseline === 'middle' ? y - height / 2 : this.textBaseline === 'top' ? y : this.textBaseline === 'bottom' ? y - height : y - height;
    for (let py = Math.max(0, Math.floor(top - grow)); py < Math.min(this.canvas.height, Math.ceil(top + height + grow)); py++)
      for (let px = Math.max(0, Math.floor(left - grow)); px < Math.min(this.canvas.width, Math.ceil(left + width + grow)); px++)
        if (this._visible(px, py) && (this.canvas.ch === 1 || (px * 7 + py * 13) % 10 < 4)) this._paint(px, py, colour, 'text');
  }
  fillText(text, x, y) { this._text(text, x, y, parseColour(this.fillStyle), 0); }
  strokeText(text, x, y) { this._text(text, x, y, parseColour(this.strokeStyle), this.lineWidth / 2); }
  createPattern(source, repeat) { return { pattern: source, repeat }; }
  // -- images
  drawImage(source, ...a) {
    assert.ok(source && source.data && source.width > 0, 'drawImage needs a raster source'); assert.ok(a.every(Number.isFinite), 'drawImage arguments must be finite');
    assert.equal(this.globalCompositeOperation, 'source-over', 'only source-over is supported by the CPU double');
    let sx = 0, sy = 0, sw = source.width, sh = source.height, dx, dy, dw, dh;
    if (a.length === 2) { [dx, dy] = a; dw = sw; dh = sh; }
    else if (a.length === 4) [dx, dy, dw, dh] = a;
    else if (a.length === 8) {
      [sx, sy, sw, sh, dx, dy, dw, dh] = a;
      assert.ok(sx >= -1e-6 && sy >= -1e-6 && sx + sw <= source.width + 1e-6 && sy + sh <= source.height + 1e-6, `source rect (${sx},${sy},${sw},${sh}) must lie inside the ${source.width}x${source.height} source`);
    } else assert.fail(`drawImage takes 3, 5 or 9 arguments, got ${a.length + 1}`);
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
    const c = this.canvas, alpha = this.globalAlpha, opaque = alpha >= 1 - 1e-9;
    if (!this.clipMask && opaque && a.length <= 4 && dx === 0 && dy === 0 && dw === source.width && dh === source.height && c.width === dw && c.height === dh && c.ch === source.ch) {
      c.data.set(source.data); c.deco.fill(0); c.blend.fill(0); return;   // unscaled full-frame copy: the common base draw
    }
    for (let y = Math.max(0, Math.ceil(dy - .5)); y < Math.min(c.height, Math.ceil(dy + dh - .5)); y++) {
      const iy = Math.floor(sy + (y + .5 - dy) * sh / dh);
      assert.ok(iy >= 0 && iy < source.height, 'sampling must stay inside source (rows)');
      for (let x = Math.max(0, Math.ceil(dx - .5)); x < Math.min(c.width, Math.ceil(dx + dw - .5)); x++) {
        if (!this._visible(x, y)) continue;
        const ix = Math.floor(sx + (x + .5 - dx) * sw / dw);
        assert.ok(ix >= 0 && ix < source.width, 'sampling must stay inside source (columns)');
        const i = y * c.width + x, j = iy * source.width + ix;
        for (let k = 0; k < c.ch; k++) { const v = source.data[j * source.ch + (source.ch === c.ch ? k : 0)]; c.data[i * c.ch + k] += (v - c.data[i * c.ch + k]) * alpha; }
        if (opaque) { c.deco[i] = 0; c.blend[i] = 0; } else if (alpha > 0) c.blend[i] = 1;
      }
    }
  }
  setTransform(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) { assert.deepEqual([a, b, c, d, e, f], [1, 0, 0, 1, 0, 0], 'the CPU double supports identity transforms only'); }
  translate() { assert.fail('translate is not supported by the CPU double'); }
  scale() { assert.fail('scale is not supported by the CPU double'); }
  rotate() { assert.fail('rotate is not supported by the CPU double'); }
}

// ---- recording -------------------------------------------------------------------------------------------------------------------------------
const STATE = ['globalAlpha', 'imageSmoothingEnabled', 'imageSmoothingQuality', 'globalCompositeOperation', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineJoin', 'font', 'textAlign', 'textBaseline'];
const num = v => Number.isFinite(v) ? (Math.round(v * 1e4) / 1e4).toString() : String(v);
const label = v => v && typeof v === 'object' ? (v.tag ?? v.label ?? 'object') : typeof v === 'number' ? num(v) : String(v);
/** Counters shared by every context of one transition (main surface, scratch surface): the cost model of TransitionMeta.cost. */
export class Counts {
  constructor() { this.draw = 0; this.clip = 0; this.fill = 0; this.text = 0; this.save = 0; this.restore = 0; }
  reset() { this.draw = this.clip = this.fill = this.text = this.save = this.restore = 0; }
}
/** A 2D context that validates and records everything, and forwards to `inner` (a PathContext) when given. */
export class RecordingContext {
  constructor(canvas, inner = null, counts = new Counts()) {
    this.canvas = canvas; this.inner = inner; this.counts = counts; this.ops = []; this.draws = []; this.depth = 0; this.maxDepth = 0; this.stack = [];
    this.state = { globalAlpha: 1, imageSmoothingEnabled: true, imageSmoothingQuality: 'low', globalCompositeOperation: 'source-over', fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineJoin: 'miter', font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic' };
    for (const key of STATE) Object.defineProperty(this, key, { get: () => this.state[key], set: v => { this.state[key] = v; if (this.inner) this.inner[key] = v; this.ops.push(`=${key}:${label(v)}`); } });
  }
  _rec(name, args) {
    assert.ok(args.every(a => typeof a !== 'number' || Number.isFinite(a)), `${name}: arguments must be finite (${args.join(',')})`);
    this.ops.push(`${name}(${args.map(label).join(',')})`);
  }
  save() { this._rec('save', []); this.counts.save++; this.depth++; this.maxDepth = Math.max(this.maxDepth, this.depth); this.stack.push({ ...this.state }); this.inner?.save(); }
  restore() { assert.ok(this.depth > 0, 'restore() without save()'); this._rec('restore', []); this.counts.restore++; this.depth--; this.state = this.stack.pop(); this.inner?.restore(); }
  beginPath() { this._rec('beginPath', []); this.inner?.beginPath(); }
  closePath() { this._rec('closePath', []); this.inner?.closePath(); }
  moveTo(...a) { this._rec('moveTo', a); this.inner?.moveTo(...a); }
  lineTo(...a) { this._rec('lineTo', a); this.inner?.lineTo(...a); }
  rect(...a) { this._rec('rect', a); this.inner?.rect(...a); }
  arc(...a) { this._rec('arc', a); assert.ok(a[2] >= 0, 'arc radius must not be negative'); this.inner?.arc(...a); }
  clip() { this._rec('clip', []); this.counts.clip++; this.inner?.clip(); }
  fill() { this._rec('fill', []); this.counts.fill++; this.inner?.fill(); }
  stroke() { this._rec('stroke', []); this.counts.fill++; this.inner?.stroke(); }
  fillRect(...a) { this._rec('fillRect', a); this.counts.fill++; this.inner?.fillRect(...a); }
  clearRect(...a) { this._rec('clearRect', a); this.inner?.clearRect(...a); }
  fillText(...a) { this._rec('fillText', a); this.counts.text++; this.inner?.fillText(...a); }
  strokeText(...a) { this._rec('strokeText', a); this.counts.text++; this.inner?.strokeText(...a); }
  createPattern(...a) { this._rec('createPattern', a); return this.inner ? this.inner.createPattern(...a) : { tag: 'pattern' }; }
  setTransform(...a) { this._rec('setTransform', a); assert.deepEqual(a, [1, 0, 0, 1, 0, 0], 'identity transforms only'); }
  translate() { assert.fail('translate is not allowed'); }
  scale() { assert.fail('scale is not allowed'); }
  rotate() { assert.fail('rotate is not allowed'); }
  drawImage(source, ...a) {
    assert.ok([2, 4, 8].includes(a.length), `drawImage takes 3, 5 or 9 arguments, got ${a.length + 1}`);
    this._rec('drawImage', [source, ...a]); this.counts.draw++;
    const dest = a.length === 2 ? [a[0], a[1], source?.width ?? this.canvas.width, source?.height ?? this.canvas.height] : a.slice(-4);
    this.draws.push({ source, args: a.length, dest, src: a.length === 8 ? a.slice(0, 4) : null, smoothing: this.state.imageSmoothingEnabled, alpha: this.state.globalAlpha });
    if (this.canvas.width > 0 && dest[2] > 0 && dest[3] > 0) {
      assert.ok(dest[0] < this.canvas.width && dest[1] < this.canvas.height && dest[0] + dest[2] > 0 && dest[1] + dest[3] > 0, `drawImage destination ${dest.map(num)} must intersect the ${this.canvas.width}x${this.canvas.height} canvas`);
    }
    this.inner?.drawImage(source, ...a);
  }
  signature() { return this.ops.join(';'); }
}
/** A source that carries only a name and a size (no pixels), for recording-only runs at any resolution. */
export const namedSource = (tag, width, height) => ({ tag, width, height });
/** Canvas factory for recording-only runs: every scratch canvas records into the same Counts and counts its own resizes. */
export function recordingCanvasFactory(counts) {
  return () => {
    let w = 1, h = 1, context = null;
    const canvas = { tag: 'scratch', resizes: 0 };
    Object.defineProperties(canvas, {
      width: { get: () => w, set: v => { w = v; canvas.resizes++; context = null; } },
      height: { get: () => h, set: v => { h = v; canvas.resizes++; context = null; } },
    });
    canvas.getContext = () => context ??= new RecordingContext(canvas, null, counts);
    return canvas;
  };
}
