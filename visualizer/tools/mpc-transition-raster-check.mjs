import assert from 'node:assert/strict';
// Deliberately small CPU rasterizer: opaque scalar pixels, nearest-neighbor
// sampling, alpha and rectangular clips. No browser/Canvas/GPU dependency.
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
        if (mode === 8 && (x < half || x >= w - half)) { source = next; sx = Math.floor(x + .5 + (x < half ? w / 2 - half : half - w / 2)); }
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
