import assert from 'node:assert/strict';
// Deliberately small CPU rasterizer: opaque scalar pixels, nearest-neighbor
// sampling, alpha and rectangular clips. No browser/Canvas/GPU dependency.
// checkTransitionRaster: geometry of classic styles 1-13 (default options; expectations unchanged except that style 8 uses floor(w / 2),
// which is identical at every even width). checkTransitionScaling: the resolution unit, the `smooth` option and the scratch surfaces
// of Dot Dissolve, recorded without pixels (docs/design/CONTRACT.md 2.3.4 and C-10).
class Raster {
  constructor(width, height, base = 0) {
    this.width = width; this.height = height;
    this.pixels = Array.from({ length: width * height }, (_, i) => base + i);
  }
  getContext() { return new RasterContext(this); }
}
class RasterContext {
  constructor(canvas) { this.canvas = canvas; this.globalAlpha = 1; this.bounds = [0, 0, canvas.width, canvas.height]; this.stack = []; }
  save() { this.stack.push([this.bounds.slice(), this.globalAlpha]); }
  restore() { [this.bounds, this.globalAlpha] = this.stack.pop(); }
  beginPath() {}
  rect(x, y, w, h) { this.path = [x, y, x + w, y + h]; }
  clip() { this.bounds = this.bounds.map((n, i) => i < 2 ? Math.max(n, this.path[i]) : Math.min(n, this.path[i])); }
  drawImage(source, dx, dy, dw, dh) {
    for (let y = 0; y < this.canvas.height; y++) for (let x = 0; x < this.canvas.width; x++) {
      const [l, t, r, b] = this.bounds;
      if (x + .5 < l || x + .5 >= r || y + .5 < t || y + .5 >= b || x + .5 < dx || x + .5 >= dx + dw || y + .5 < dy || y + .5 >= dy + dh) continue;
      const sx = Math.floor((x + .5 - dx) * source.width / dw), sy = Math.floor((y + .5 - dy) * source.height / dh);
      const i = y * this.canvas.width + x, value = source.pixels[sy * source.width + sx];
      assert.ok(Number.isFinite(value), 'sampling must stay inside source');
      this.canvas.pixels[i] += (value - this.canvas.pixels[i]) * this.globalAlpha;
    }
  }
}
export function checkTransitionRaster(AvsTransition) {
  for (const [w, h] of [[12, 8], [13, 9]]) for (const t of [.2, .7]) {
    const old = new Raster(w, h, 100), next = new Raster(w, h, 10000);
    // Independent reference uses source coordinates, never draw calls.
    const s = (Math.sin(t * Math.PI - Math.PI / 2) + 1) / 2;
    const ix = Math.floor(s * w), iy = Math.floor(s * h), half = Math.floor(s * w / 2);
    for (const mode of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13]) {
      const output = new Raster(w, h); new AvsTransition(mode).draw(output.getContext(), old, next, t, w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let source = old, sx = x, sy = y;
        const direction = mode === 7 ? (y < Math.floor(h / 2) ? 2 : 3) : mode;
        if (direction === 2) { source = x < ix ? next : old; sx = x < ix ? w - ix + x : x - ix; }
        if (direction === 3) { source = x >= w - ix ? next : old; sx = x >= w - ix ? x - w + ix : x + ix; }
        if (mode === 4) { source = y < iy ? next : old; sy = y < iy ? h - iy + y : y - iy; }
        if (mode === 5) { source = y >= h - iy ? next : old; sy = y >= h - iy ? y - h + iy : y + iy; }
        if (mode === 8 && (x < half || x >= w - half)) { source = next; sx = Math.floor(x + .5 + (x < half ? Math.floor(w / 2) - half : half - Math.floor(w / 2))); }   // offset is floor(w / 2): identical for every even width
        if (mode === 9) {
          source = x < half || x >= w - half ? next : old;
          sx = x < half ? Math.floor((x + .5) * w / (2 * half)) : x >= w - half ? Math.floor((x + .5 - w + 2 * half) * w / (2 * half)) : Math.floor((x + .5 - half) * w / (w - 2 * half));
        }
        if ((mode === 10 && x < ix) || (mode === 11 && x >= w - ix) || (mode === 12 && y < iy) || (mode === 13 && y >= h - iy)) source = next;
        const expected = mode === 1 ? old.pixels[y * w + x] * (1 - t) + next.pixels[y * w + x] * t : source.pixels[sy * w + sx];
        assert.ok(Math.abs(output.pixels[y * w + x] - expected) < 1e-8, `mode ${mode}, ${w}x${h}, t=${t}, pixel ${x},${y}`);
      }
    }
    const blocks = new AvsTransition(6); blocks.order.splice(0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0);
    for (const progress of [0, .05, .8, 1]) {
      const output = new Raster(w, h); blocks.draw(output.getContext(), old, next, progress, w, h);
      const revealed = new Set(blocks.order.slice(0, Math.min(9, 1 + Math.floor(progress * 255 / 28))));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const col = x < Math.floor(w / 3) ? 0 : x < Math.floor(2 * w / 3) ? 1 : 2;
        const row = y < Math.floor(h / 3) ? 0 : y < Math.floor(2 * h / 3) ? 1 : 2;
        const source = revealed.has(row * 3 + col) ? next : old;
        assert.equal(output.pixels[y * w + x], source.pixels[y * w + x], 'blocks must catch up after skipped frames without holes');
      }
    }
  }
}

// ---- resolution unit, smoothing and scratch surfaces (CONTRACT 2.3.4, C-10) ---------------------------------------------------------------------
function scratchFactory(log) {
  return () => {
    const canvas = { tag: log.canvases.length === 0 ? 'mask' : 'tile', sets: [], ops: [] };
    let w = 0, h = 0;
    Object.defineProperties(canvas, {
      width: { get: () => w, set: v => { w = v; canvas.sets.push(['width', v]); } },
      height: { get: () => h, set: v => { h = v; canvas.sets.push(['height', v]); } },
    });
    const ctx = {
      canvas, globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '',
      clearRect: (...a) => canvas.ops.push(['clearRect', ...a]), fillRect: (...a) => canvas.ops.push(['fillRect', ...a]),
      drawImage: (source, ...a) => canvas.ops.push(['drawImage', source?.tag ?? 'source', ...a]),
      createPattern: (source, repeat) => { canvas.ops.push(['createPattern', source.tag, repeat]); return { pattern: true }; },
    };
    canvas.getContext = () => ctx;
    log.canvases.push(canvas);
    return canvas;
  };
}
function mainRecorder() {
  const calls = [];
  const ctx = { calls, globalAlpha: 1, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {}, drawImage(source, ...a) { calls.push([source.tag, ...a]); } };
  let smoothing, quality;
  Object.defineProperty(ctx, 'imageSmoothingEnabled', { get: () => smoothing, set: v => { smoothing = v; } });
  Object.defineProperty(ctx, 'imageSmoothingQuality', { get: () => quality, set: v => { quality = v; } });
  return ctx;
}
export function checkTransitionScaling(AvsTransition, transitionUnit) {
  // The unit is exactly 1 for every classic AVS surface (width 640) and grows with the render surface.
  for (const [w, h, unit] of [[640, 360, 1], [640, 640, 1], [640, 480, 1], [320, 180, 1], [12, 8, 1], [13, 9, 1], [800, 450, 1], [960, 540, 2], [1024, 576, 2], [1280, 720, 2], [1920, 1080, 3], [2560, 1440, 4], [3840, 2160, 6], [4096, 4096, 6]])
    assert.equal(transitionUnit(w, h), unit, `transitionUnit(${w}, ${h})`);
  for (const [w, h] of [[0, 0], [-5, 10], [NaN, 360], [640, Infinity], [1e-9, 1e-9]]) assert.equal(transitionUnit(w, h), 1, `degenerate unit ${w}x${h}`);

  const old = { tag: 'old', width: 640, height: 360 }, next = { tag: 'next', width: 640, height: 360 };
  // Smoothing: off by default (classic AVS output), 'high' when asked, and imageSmoothingQuality is never touched by default.
  for (let mode = 1; mode <= 14; mode++) for (const smooth of [undefined, false, true]) {
    const log = { canvases: [] }, ctx = mainRecorder();
    const tr = new AvsTransition(mode, { seed: 5, createCanvas: scratchFactory(log), ...(smooth === undefined ? {} : { smooth }) });
    tr.draw(ctx, old, next, .4, 640, 360);
    assert.equal(ctx.imageSmoothingEnabled, smooth === true, `mode ${mode} smooth=${smooth}`);
    assert.equal(ctx.imageSmoothingQuality, smooth === true ? 'high' : undefined, `mode ${mode}: the default never touches imageSmoothingQuality`);
  }
  // Dot Dissolve: cell and dot scale with the unit; unit 1 is the legacy 2^k + 1 pattern with a single white pixel at (cell - 1).
  for (const [w, h] of [[640, 360], [640, 640], [1280, 720], [1920, 1080]]) {
    const unit = transitionUnit(w, h);
    for (const t of [.05, .3, .5, .7, .95]) {
      const log = { canvases: [] }, ctx = mainRecorder(), tr = new AvsTransition(14, { seed: 3, createCanvas: scratchFactory(log) });
      tr.draw(ctx, { tag: 'old', width: w, height: h }, { tag: 'next', width: w, height: h }, t, w, h);
      const [mask, tile] = log.canvases, s = (1 - Math.cos(t * Math.PI)) / 2, cell = (1 << Math.max(0, 4 - Math.floor(s * 5))) + 1, spacing = cell * unit;
      assert.equal(tile.width, spacing, `tile spacing ${w}x${h} t=${t}`); assert.equal(tile.height, spacing);
      assert.deepEqual(tile.ops.filter(op => op[0] === 'fillRect'), [['fillRect', (cell - 1) * unit, (cell - 1) * unit, unit, unit]], `one dot of ${unit} px at the cell corner`);
      assert.equal(mask.width, w); assert.equal(mask.height, h);
      assert.deepEqual(mask.ops.filter(op => op[0] === 'drawImage'), [['drawImage', 'next', 0, 0, w, h]]);
      assert.deepEqual(mask.ops.filter(op => op[0] === 'createPattern'), [['createPattern', 'tile', 'repeat']]);
      assert.equal(ctx.calls.at(-1)[0], 'mask', 'the masked next frame is the last draw');
    }
  }
  // Scratch surfaces are resized only when their size changes and are cleared every frame (clearRect) instead of by assigning width and height.
  {
    const log = { canvases: [] }, ctx = mainRecorder(), tr = new AvsTransition(14, { seed: 9, createCanvas: scratchFactory(log) });
    const steps = 240, spacings = new Set();
    for (let i = 1; i < steps; i++) {
      const t = i / steps, s = (1 - Math.cos(t * Math.PI)) / 2;
      spacings.add((1 << Math.max(0, 4 - Math.floor(s * 5))) + 1);
      tr.draw(ctx, old, next, t, 640, 360);
    }
    const [mask, tile] = log.canvases;
    assert.deepEqual(mask.sets, [['width', 640], ['height', 360]], 'the mask is sized once for a constant frame size');
    assert.equal(tile.sets.filter(s => s[0] === 'width').length, spacings.size, 'the tile is resized once per distinct cell size'); assert.equal(spacings.size, 5);
    assert.equal(mask.ops.filter(op => op[0] === 'clearRect').length, steps - 1, 'cleared every frame');
    assert.deepEqual(mask.ops.find(op => op[0] === 'clearRect'), ['clearRect', 0, 0, 640, 360]);
    tr.draw(ctx, { tag: 'old', width: 320, height: 180 }, { tag: 'next', width: 320, height: 180 }, .5, 320, 180);
    assert.deepEqual(mask.sets.slice(-2), [['width', 320], ['height', 180]], 'a new frame size resizes the mask again');
  }
  // Style 8 at an odd width: every destination offset is an integer (floor(w / 2)), so nearest sampling has no half-pixel seam.
  for (const [w, h] of [[13, 9], [641, 359], [12, 8], [640, 360]]) for (const t of [.2, .5, .8]) {
    const ctx = mainRecorder(), tr = new AvsTransition(8, { createCanvas: scratchFactory({ canvases: [] }) });
    tr.draw(ctx, { tag: 'old', width: w, height: h }, { tag: 'next', width: w, height: h }, t, w, h);
    for (const call of ctx.calls) assert.ok(call.slice(1, 3).every(Number.isInteger), `style 8 ${w}x${h} t=${t}: integer offsets ${call.slice(1, 3)}`);
  }
  // Invalid geometry draws nothing; invalid progress is clamped; neither throws.
  for (const [w, h] of [[0, 360], [640, 0], [NaN, 360], [640, Infinity], [-1, -1]]) for (let mode = 0; mode <= 32; mode++) {
    const ctx = mainRecorder(), tr = new AvsTransition(mode, { seed: 1, createCanvas: scratchFactory({ canvases: [] }) });
    assert.doesNotThrow(() => tr.draw(ctx, old, next, .5, w, h)); assert.equal(ctx.calls.length, 0, `mode ${mode}: no draw for ${w}x${h}`);
  }
  for (const progress of [NaN, -Infinity, -3]) {
    const ctx = mainRecorder(), tr = new AvsTransition(2, { createCanvas: scratchFactory({ canvases: [] }) });
    tr.draw(ctx, old, next, progress, 640, 360); assert.equal(ctx.calls[0][0], 'old');
  }
  for (const progress of [1, 1.5, Infinity]) {
    const ctx = mainRecorder(), tr = new AvsTransition(2, { createCanvas: scratchFactory({ canvases: [] }) });
    tr.draw(ctx, old, next, progress, 640, 360); assert.deepEqual(ctx.calls.map(c => c[0]), ['next']);
  }
}
