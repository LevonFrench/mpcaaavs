// Markdown tables from a bench-shows.mjs report (docs/PERFORMANCE.md is pasted from this, so the numbers are never retyped).
//   node tools/bench-report.mjs docs/perf/baseline.json [more.json ...] > tables.md
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node tools/bench-report.mjs <bench.json> [...]'); process.exit(2); }
const docs = files.map((f) => JSON.parse(readFileSync(resolve(f), 'utf8')));
const rs = docs.flatMap((d) => d.results).filter((r) => r.side === 'candidate' || !r.side);
const f1 = (x) => (x === undefined || x === null ? '-' : x >= 100 ? x.toFixed(0) : x.toFixed(1));
const f2 = (x) => (x === undefined || x === null ? '-' : x.toFixed(2));
const out = [];
const p = (s = '') => out.push(s);
const d0 = docs[0];
p(`Machine: ${d0.machine.cpu} x${d0.machine.cores}, ${d0.machine.platform}; browser ${d0.browser.version}; GL ${d0.browser.gl ? `${d0.browser.gl.vendor} / ${d0.browser.gl.renderer}` : 'unavailable'}.`);
p(`Run: ${d0.options.seconds} s measured + ${d0.options.warmup} s warmup per plate and size, at least ${d0.options.minFrames} frames, pacing ${d0.options.pacing}, completion readback ${d0.options.complete ? 'on' : 'off'}, created ${d0.created}.`);
p();

const plates = rs.filter((r) => r.kind === 'plate');
const modes = [...new Set(plates.map((r) => r.stagesMode))];
const order = ['boot', 'magi', 'psycho', 'radar', 'harmonics', 'seele', 'battery', 'atfield', 'alert', 'plug', 'target', 'city', 'sync', 'berserk', 'impact', 'end'];
const byPlate = (a, b) => order.indexOf(a.name) - order.indexOf(b.name);
const LEAF = ['scene.render', 'engine.hud', 'post.bloom', 'post.final', 'engine.blit', 'engine.xfade', 'engine.spectrum', 'frame.fit', 'frame.transition', 'frame.bitmap', 'frame.window', 'live.push'];
const stage = (r, n) => r.trace.stages[n];

for (const mode of modes) {
  const set = plates.filter((r) => r.stagesMode === mode);
  const sizes = [...new Set(set.map((r) => r.size))];
  const label = mode === 'sync' ? 'GL-synchronised stage timing (each stage waits for the GPU: attributes GPU time, serialises CPU and GPU)' : 'CPU timestamps';
  for (const size of sizes) {
    const g = set.filter((r) => r.size === size).sort(byPlate);
    p(`#### ${size}, ${label}`);
    p();
    p('| plate | fps | total p50 | p95 | max | worker p50 | missed % | over 16.7 ms % | hottest stages (mean ms, share of worker mean) |');
    p('|---|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const r of g) {
      const wm = r.worker.mean || 1;
      const top = LEAF.filter((n) => stage(r, n)).sort((a, b) => stage(r, b).mean - stage(r, a).mean).slice(0, 3).map((n) => `${n} ${f1(stage(r, n).mean)} (${Math.round(100 * stage(r, n).mean / wm)}%)`).join(', ');
      p(`| ${r.name} | ${f1(r.effectiveFps)} | ${f1(r.total.p50)} | ${f1(r.total.p95)} | ${f1(r.total.max)} | ${f1(r.worker.p50)} | ${f1(r.missedPct)} | ${f1(r.overBudgetPct)} | ${top} |`);
    }
    p();
  }
  const sizeList = sizes;
  if (sizeList.length >= 2) {
    const [a, b] = sizeList;
    p(`#### ${a} against ${b} (${label})`);
    p();
    p(`| plate | total p50 ${a} | total p50 ${b} | ratio | worker p50 ${a} | worker p50 ${b} | first frame ${a} (ms) | first frame ${b} (ms) |`);
    p('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of set.filter((x) => x.size === a).sort(byPlate)) {
      const q = set.find((x) => x.size === b && x.name === r.name);
      if (!q) continue;
      p(`| ${r.name} | ${f1(r.total.p50)} | ${f1(q.total.p50)} | ${(q.total.p50 / Math.max(1e-9, r.total.p50)).toFixed(2)}x | ${f1(r.worker.p50)} | ${f1(q.worker.p50)} | ${f1(r.firstFrameMs)} | ${f1(q.firstFrameMs)} |`);
    }
    p();
  }
  // per-stage tables
  for (const size of sizes) {
    const g = set.filter((r) => r.size === size).sort(byPlate);
    const cols = ['frame.total', 'scene.render', 'canvas2d.draw', 'gl.upload.canvas', 'comp.draw', 'engine.hud', 'post.bloom', 'post.final', 'engine.blit', 'frame.fit', 'frame.bitmap', 'live.push', 'frame.window'];
    p(`#### Per-stage mean / p95 ms, ${size}, ${label}`);
    p();
    p(`| plate | ${cols.join(' | ')} |`);
    p(`|---|${cols.map(() => '---:').join('|')}|`);
    for (const r of g) p(`| ${r.name} | ${cols.map((c) => (stage(r, c) ? `${f2(stage(r, c).mean)} / ${f1(stage(r, c).p95)}` : '-')).join(' | ')} |`);
    p();
    p(`#### Canvas2D layers: draw and texture upload, mean ms, ${size}, ${label}`);
    p();
    p('| plate | layer | draw mean / p95 | upload mean / p95 |');
    p('|---|---|---:|---:|');
    for (const r of g) {
      const layers = new Map();
      for (const [k, v] of Object.entries(r.trace.stages)) { const m = /^layer\.(.+)\.(draw|upload)$/.exec(k); if (m) { if (!layers.has(m[1])) layers.set(m[1], {}); layers.get(m[1])[m[2]] = v; } }
      for (const [id, v] of [...layers].sort((x, y) => ((y[1].draw?.mean ?? 0) + (y[1].upload?.mean ?? 0)) - ((x[1].draw?.mean ?? 0) + (x[1].upload?.mean ?? 0))).slice(0, 3)) {
        p(`| ${r.name} | ${id} | ${v.draw ? `${f2(v.draw.mean)} / ${f1(v.draw.p95)}` : '-'} | ${v.upload ? `${f2(v.upload.mean)} / ${f1(v.upload.p95)}` : '-'} |`);
      }
    }
    p();
  }
  // ranking of stages over all plates at the first size
  const size = sizes[0];
  const g = set.filter((r) => r.size === size);
  const rank = new Map();
  for (const n of LEAF) { const vals = g.map((r) => stage(r, n)?.mean ?? 0); rank.set(n, vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)); }
  const tw = g.reduce((a, r) => a + r.worker.mean, 0) / Math.max(1, g.length);
  p(`#### Hottest stages averaged over the ${g.length} plates, ${size}, ${label}`);
  p();
  p('| stage | mean ms | share of worker mean |');
  p('|---|---:|---:|');
  for (const [n, v] of [...rank].sort((a, b) => b[1] - a[1]).slice(0, 8)) p(`| ${n} | ${f2(v)} | ${Math.round(100 * v / Math.max(1e-9, tw))}% |`);
  p();
}

const mv = rs.filter((r) => r.kind.startsWith('multiview'));
if (mv.length) {
  p('#### Multiview');
  p();
  p('| run | fps | per-pane fps | main p50 / p95 / max (ms) | pane total p50 / p95 | over 16.7 ms % |');
  p('|---|---:|---|---|---|---:|');
  for (const r of mv) {
    const paneFps = (r.panes ?? []).map((q) => `${q.plate} ${f1(q.fps)}`).join(', ');
    const main = r.main ? `${f1(r.main.p50)} / ${f1(r.main.p95)} / ${f1(r.main.max)}` : '-';
    p(`| ${r.kind} ${r.name} | ${f1(r.effectiveFps)} | ${paneFps} | ${main} | ${f1(r.total.p50)} / ${f1(r.total.p95)} | ${f1(r.overBudgetPct)} |`);
  }
  p();
}
const avs = rs.filter((r) => r.kind === 'avs');
if (avs.length) {
  p('#### AVS');
  p();
  p('| preset | size | fps | total p50 / p95 / max | worker p50 | effectMs p50 | over 16.7 ms % |');
  p('|---|---|---:|---|---:|---:|---:|');
  for (const r of avs) p(`| ${r.name} | ${r.size} | ${f1(r.effectiveFps)} | ${f1(r.total.p50)} / ${f1(r.total.p95)} / ${f1(r.total.max)} | ${f1(r.worker.p50)} | ${r.extras?.effectMs ? f1(r.extras.effectMs.p50) : '-'} | ${f1(r.overBudgetPct)} |`);
  p();
}
console.log(out.join('\n'));
