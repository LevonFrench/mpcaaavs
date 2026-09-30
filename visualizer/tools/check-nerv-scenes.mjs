import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// AAAVS_NERV_ENTRY may point at a scratch copy of nerv-scenes.ts (with absolute imports) to rehearse an edit or a mutation; the source rules below read the same file.
const entry = process.env.AAAVS_NERV_ENTRY || 'src/nerv-scenes.ts';
const bundle = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false });
const { NERV_SCENES, NERV_DESIGN, renderNervScene } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

// Every property a scene may assign. `textRendering` is the text-shaping hint set once per frame inside save/restore; `imageSmoothingEnabled` is allowed for
// surfaces that copy bitmaps (docs/design/CONTRACT.md 3.6). Anything else, including a `filter` or a shadow, fails.
const ALLOWED_SETTERS = new Set(['globalAlpha', 'globalCompositeOperation', 'font', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'shadowBlur', 'textAlign', 'textBaseline', 'textRendering', 'imageSmoothingEnabled']);
let checks = 0;
const ok = (condition, message) => { checks++; assert.ok(condition, message); };
const near = (a, b, tolerance, message) => ok(Math.abs(a - b) <= tolerance, `${message ?? 'near'}: ${a} vs ${b} (tolerance ${tolerance})`);

// Record actual path coordinates, text and styling without a browser, a canvas
// implementation, or GPU. Invalid geometry and leaked drawing state fail here.
// A translate/scale tracker follows the current transform (the scenes never rotate or skew), so device-space geometry can be derived from every recorded operation.
function recordingContext() {
  const operations = [], trace = [], stack = [], matrices = [];
  let matrix = { a: 1, d: 1, e: 0, f: 0 };
  let state = { globalAlpha: .45, globalCompositeOperation: 'multiply', font: '11px serif', fillStyle: '#abc', strokeStyle: '#def', lineWidth: 3, shadowBlur: 7 };
  const initial = { ...state };
  const methods = new Set(['setTransform', 'translate', 'scale', 'setLineDash', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'arc', 'rect', 'clip']);
  const push = operation => { operations.push(operation); trace.push({ m: matrix, lineWidth: state.lineWidth, textBaseline: state.textBaseline }); };
  const context = new Proxy({}, {
    set(_target, key, value) {
      assert.ok(ALLOWED_SETTERS.has(key), `unexpected context property ${String(key)}`);
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite ${String(key)}`);
      state[key] = value; push(['set', key, value]); return true;
    },
    get(_target, key) {
      if (key === 'save') return () => { stack.push({ ...state }); matrices.push(matrix); push(['save']); };
      if (key === 'restore') return () => { assert.ok(stack.length, 'unbalanced restore'); state = stack.pop(); matrix = matrices.pop(); push(['restore']); };
      if (methods.has(key)) return (...args) => {
        for (const value of args.flat()) if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite ${String(key)} argument`);
        if (key === 'arc') assert.ok(args[2] >= 0, 'negative arc radius');
        if (key === 'setTransform') { assert.ok(args[1] === 0 && args[2] === 0, 'no rotation or skew'); matrix = { a: args[0], d: args[3], e: args[4], f: args[5] }; }
        else if (key === 'translate') matrix = { ...matrix, e: matrix.e + matrix.a * args[0], f: matrix.f + matrix.d * args[1] };
        else if (key === 'scale') matrix = { ...matrix, a: matrix.a * args[0], d: matrix.d * args[1] };
        push([key, ...args]);
      };
      if (key in state) return state[key];
      throw new Error(`Unexpected context API: ${String(key)}`);
    },
  });
  return { context, operations, trace, verify: () => { assert.equal(stack.length, 0, 'drawing state stack leak'); assert.deepEqual(state, initial, 'caller context must be restored'); } };
}
function audio() { return { waveform: [new Uint8Array(576), new Uint8Array(576)], spectrum: [new Uint8Array(576), new Uint8Array(576)], beat: false, beatLevel: 0 }; }
const silence = audio();
const fixture = audio();
for (let i = 0; i < 576; i++) {
  fixture.waveform[0][i] = Math.round(Math.sin(i * .059) * 110) & 255;
  fixture.waveform[1][i] = Math.round(Math.cos(i * .043) * 89) & 255;
  fixture.spectrum[0][i] = (i * 19 + 61) % 256;
  fixture.spectrum[1][i] = (i * 11 + 29) % 256;
}
const frame = { time: 147.125, localTime: 7.125, progress: .43, bpm: 109, seed: 741, audio: fixture };
function render(scene, width, height, input = fixture, changes = {}) {
  const r = recordingContext();
  renderNervScene(r.context, width, height, { ...frame, scene, audio: input, ...changes });
  r.verify();
  return r;
}
function recording(scene, input = fixture, changes = {}) { return render(scene, 640, 360, input, changes).operations; }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reference = new Map(NERV_SCENES.map(scene => [scene, digest(recording(scene))]));
assert.equal(reference.size, 16); assert.equal(new Set(reference.values()).size, 16, 'plates must have distinct compositions');
for (const scene of [...NERV_SCENES].reverse()) {
  recording(scene, fixture, { time: 4000, localTime: 290, seed: 883 });
  recording(scene, fixture, { time: 0, localTime: 0, progress: 0 });
  const repeated = recording(scene);
  assert.equal(digest(repeated), reference.get(scene), `${scene}: render result depends on prior playback/seek order`);
  assert.ok(repeated.length > 400, `${scene}: incomplete instrument`);
  assert.ok(repeated.some(op => op[0] === 'fillText'), `${scene}: missing HUD text`);
  assert.notEqual(digest(recording(scene, silence)), reference.get(scene), `${scene}: disconnected audio`);
  for (const [label, bin] of [['low', 3], ['mid', 48], ['high', 400], ['nyquist-edge', 511], ['AVS-tail', 575]]) {
    const signal = audio(); signal.spectrum[1][bin] = 255;
    assert.notEqual(digest(recording(scene, signal)), digest(recording(scene, silence)), `${scene}: right-channel ${label} input disconnected`);
  }
  recording(scene, fixture, { time: Number.NaN, localTime: Infinity, progress: -2, bpm: 0, seed: Number.NaN });
  const small = recordingContext(); renderNervScene(small.context, 240, 540, { ...frame, scene }); small.verify();
}

// Verify canonical signed-byte waveform semantics, including the two extrema.
const signed = audio(); signed.waveform[0][0] = 128; signed.waveform[0][2] = 127;
const psychograph = recording('psycho', signed);
assert.ok(psychograph.some(op => op[0] === 'moveTo' && op[1] === 127 && Math.abs(op[2] - (125 + 31 + 27.9)) < 1e-8), 'signed PCM -128 must draw below the centreline');
assert.ok(psychograph.some(op => op[0] === 'lineTo' && Math.abs(op[1] - (127 + 559 / 287)) < 1e-8 && op[2] < 156), 'signed PCM +127 must draw above the centreline');

// ---- Resolution: the drawing is a function of the 960x540 design canvas. Every surface size draws the same operations in the same order with the same strings and
// font sizes; only snap offsets of at most half a device pixel differ, and every edge, hairline and baseline lands on a device pixel. (RESOLUTION-PIPELINE 6 and 8, tests 8-10.)
assert.deepEqual(NERV_DESIGN, { width: 960, height: 540 }, 'the design canvas is exported');

/** Ops up to and including the design clip are the entry set-up; the final restore closes it. Returns the design-canvas body. */
function split(operations) {
  const clip = operations.findIndex(op => op[0] === 'clip');
  ok(clip > 0 && operations[operations.length - 1][0] === 'restore', 'entry set-up, body and closing restore');
  return { start: clip + 1, head: operations.slice(0, clip + 1), body: operations.slice(clip + 1, -1) };
}
/** The entry installs an unhinted-text hint, a whole-pixel letterbox and a clip whose edges are device pixels. */
function checkHead(head, width, height) {
  const S = Math.min(width / 960, height / 540), contentWidth = Math.round(960 * S), contentHeight = Math.round(540 * S);
  const offsetX = Math.round((width - 960 * S) / 2) || 0, offsetY = Math.round((height - 540 * S) / 2) || 0;
  const at = predicate => head.findIndex(predicate);
  const save = at(op => op[0] === 'save'), transform = at(op => op[0] === 'setTransform'), clear = at(op => op[0] === 'fillRect'), hint = at(op => op[0] === 'set' && op[1] === 'textRendering');
  const translate = at(op => op[0] === 'translate'), scale = at(op => op[0] === 'scale'), clipRect = at(op => op[0] === 'rect');
  ok(save === 0 && transform === 1, 'the caller state is saved first and the transform reset to identity');
  assert.deepEqual(head[transform], ['setTransform', 1, 0, 0, 1, 0, 0]); checks++;
  assert.deepEqual(head[clear], ['fillRect', 0, 0, width, height], 'the whole surface is cleared in device space'); checks++;
  ok(hint > clear && hint < translate && head[hint][2] === 'geometricPrecision', 'text is unhinted and subpixel positioned, set inside save/restore before the design transform');
  assert.deepEqual(head[translate], ['translate', offsetX, offsetY]); checks++;
  ok(Number.isInteger(head[translate][1]) && Number.isInteger(head[translate][2]), 'the letterbox offset is whole pixels');
  assert.deepEqual(head[scale], ['scale', S, S], 'one uniform scale'); checks++;
  ok(scale > translate && clipRect > scale, 'translate, scale, then the clip');
  const [, cx, cy, cw, ch] = head[clipRect];
  ok(cx === 0 && cy === 0, 'the clip starts at the design origin');
  near(offsetX + S * cw, offsetX + contentWidth, 1e-6, 'design clip right edge is a device pixel'); near(offsetY + S * ch, offsetY + contentHeight, 1e-6, 'design clip bottom edge is a device pixel');
  return { S, offsetX, offsetY };
}

/** Class of every path (beginPath up to the next beginPath): a single stroked segment made by `line`, a six-vertex chamfered `panel` outline, or an unsnapped `exact` path
 * (arcs, polygons, polylines, hazard stripes). Returns a per-operation array of { kind, axis, verts }. */
function pathClasses(operations, from = 0) {
  const classes = new Array(operations.length).fill(null);
  const near1 = (a, b) => Math.abs(a - b) < 1e-9;
  const panelShaped = v => v[1][1] === v[0][1] && near1(v[2][0] - v[1][0], 14) && near1(v[2][1] - v[1][1], 14) && v[3][0] === v[2][0] && v[4][1] === v[3][1]
    && near1(v[4][0] - v[0][0], 14) && v[5][0] === v[0][0] && near1(v[4][1] - v[5][1], 14);
  let start = -1;
  const flush = end => {
    if (start < 0) return;
    const segment = operations.slice(start, end);
    const verts = segment.filter(op => op[0] === 'moveTo' || op[0] === 'lineTo').map(op => [op[1], op[2]]);
    const closed = segment.some(op => op[0] === 'closePath'), arc = segment.some(op => op[0] === 'arc'), stroked = segment.some(op => op[0] === 'stroke');
    let info = { kind: 'exact', axis: null, verts };
    if (!arc && !closed && verts.length === 2 && stroked) info = { kind: 'line', axis: verts[0][0] === verts[1][0] ? 'x' : verts[0][1] === verts[1][1] ? 'y' : null, verts };
    else if (!arc && closed && verts.length === 6 && panelShaped(verts)) info = { kind: 'panel', axis: null, verts };
    for (let i = start; i < end; i++) classes[i] = info;
  };
  for (let i = from; i < operations.length; i++) if (operations[i][0] === 'beginPath') { flush(i); start = i; }
  flush(operations.length);
  return classes;
}

/** Device-space crispness of a recorded stream from `start` on. Returns the violations (empty when crisp) and how many items were examined. */
function crispness(operations, trace, start = 0) {
  const bad = [], seen = { rects: 0, strokes: 0, baselines: 0, clips: 0, outlines: 0 };
  const int = v => Math.abs(v - Math.round(v)) < 1e-6;
  const classes = pathClasses(operations, start);
  const fail = (i, message) => bad.push(`op ${i} ${operations[i][0]}: ${message}`);
  for (let i = start; i < operations.length; i++) {
    const op = operations[i], { m, lineWidth, textBaseline } = trace[i];
    if (op[0] === 'fillRect' || op[0] === 'rect') {
      const [, x, y, w, h] = op, x0 = m.e + m.a * x, x1 = m.e + m.a * (x + w), y0 = m.f + m.d * y, y1 = m.f + m.d * (y + h);
      if (op[0] === 'fillRect') seen.rects++; else seen.clips++;
      if (![x0, x1, y0, y1].every(int)) fail(i, `edges ${x0} ${x1} ${y0} ${y1} are not device pixels`);
      if (op[0] === 'fillRect' && ((w > 0 && x1 - x0 < 1 - 1e-6) || (h > 0 && y1 - y0 < 1 - 1e-6))) fail(i, 'thinner than one device pixel');
    } else if (op[0] === 'strokeRect') {
      const [, x, y, w, h] = op, half = lineWidth / 2;
      seen.outlines++;
      if (![m.e + m.a * (x - half), m.e + m.a * (x + w + half), m.f + m.d * (y - half), m.f + m.d * (y + h + half)].every(int)) fail(i, 'outer edge is not a device pixel');
      if (!int(lineWidth * m.a) || lineWidth * m.a < 1 - 1e-9) fail(i, `outline width ${lineWidth * m.a} device px`);
    } else if (op[0] === 'fillText') {
      const baseline = m.f + m.d * op[3];
      seen.baselines++;
      if (textBaseline !== 'alphabetic') fail(i, `text baseline mode ${textBaseline}`);
      if (!int(baseline)) fail(i, `baseline ${baseline} is not a device row`);
    } else if (op[0] === 'stroke') {
      const width = lineWidth * Math.min(m.a, m.d), c = classes[i];
      seen.strokes++;
      if (width < 1 - 1e-9) fail(i, `stroke ${width} device px is thinner than one pixel`);
      if (c && c.kind !== 'exact') {
        if (!int(width)) fail(i, `${c.kind} stroke width ${width} is not whole device pixels`);
        const edges = (centre, what) => { if (![centre - width / 2, centre + width / 2].every(int)) fail(i, `${what} stroke edges are not device pixels`); };
        if (c.kind === 'line' && c.axis === 'x') edges(m.e + m.a * c.verts[0][0], 'vertical line');
        if (c.kind === 'line' && c.axis === 'y') edges(m.f + m.d * c.verts[0][1], 'horizontal line');
        if (c.kind === 'panel') { const v = c.verts; edges(m.f + m.d * v[0][1], 'panel top'); edges(m.f + m.d * v[3][1], 'panel bottom'); edges(m.e + m.a * v[0][0], 'panel left'); edges(m.e + m.a * v[2][0], 'panel right'); }
      }
    }
  }
  return { bad, seen };
}

/** Compare a stream (A, at scale SA) with the ideal one (B, at scale SB): identical kinds, order, strings and fonts; snapped values within the snap bound; the rest exactly equal. */
function compareStreams(a, b) {
  const bad = [];
  if (a.body.length !== b.body.length) return [`op count ${a.body.length} vs ${b.body.length}`];
  const tp = .5 / a.S + .5 / b.S + 1e-9, tl = 1 / a.S + 1 / b.S + 1e-9, ts = 2 * tl;
  const ca = pathClasses(a.body), cb = pathClasses(b.body);
  const within = (i, name, x, y, tolerance) => { if (!(Math.abs(x - y) <= tolerance)) bad.push(`op ${i} ${name}: ${x} vs ${y} (tolerance ${tolerance.toPrecision(3)})`); };
  const exact = (i, name, x, y) => { if (x !== y) bad.push(`op ${i} ${name}: ${x} vs ${y} (must be exactly equal)`); };
  for (let i = 0; i < a.body.length; i++) {
    const x = a.body[i], y = b.body[i];
    if (x[0] !== y[0] || x.length !== y.length) { bad.push(`op ${i}: ${x[0]} vs ${y[0]}`); continue; }
    if (ca[i]?.kind !== cb[i]?.kind || ca[i]?.axis !== cb[i]?.axis) bad.push(`op ${i}: path class ${ca[i]?.kind}/${ca[i]?.axis} vs ${cb[i]?.kind}/${cb[i]?.axis}`);
    switch (x[0]) {
      case 'set':
        exact(i, 'property', x[1], y[1]);
        if (x[1] === 'lineWidth') within(i, 'lineWidth', x[2], y[2], tl); else exact(i, x[1], x[2], y[2]);
        break;
      case 'fillRect': case 'rect': within(i, 'x', x[1], y[1], tp); within(i, 'y', x[2], y[2], tp); within(i, 'w', x[3], y[3], tl); within(i, 'h', x[4], y[4], tl); break;
      case 'strokeRect': for (let k = 1; k <= 4; k++) within(i, 'strokeRect', x[k], y[k], ts); break;
      case 'fillText': exact(i, 'text', x[1], y[1]); exact(i, 'x anchor', x[2], y[2]); within(i, 'baseline', x[3], y[3], .5 / a.S + .5 / b.S + 1e-9); break;
      case 'translate': exact(i, 'translate x', x[1], y[1]); within(i, 'translate y', x[2], y[2], tp); break;
      case 'scale': exact(i, 'scale x', x[1], y[1]); exact(i, 'scale y', x[2], y[2]); break;
      case 'moveTo': case 'lineTo': {
        const c = ca[i];
        for (const k of [0, 1]) {
          const snapped = c?.kind === 'panel' || (c?.kind === 'line' && c.axis === (k === 0 ? 'x' : 'y'));
          if (snapped) within(i, `${x[0]} ${k ? 'y' : 'x'}`, x[1 + k], y[1 + k], tp); else exact(i, `${x[0]} ${k ? 'y' : 'x'}`, x[1 + k], y[1 + k]);
        }
        break;
      }
      case 'arc': for (let k = 1; k < x.length; k++) exact(i, 'arc', x[k], y[k]); break;
      case 'setLineDash': assert.deepEqual(x, y); break;
      case 'beginPath': case 'closePath': case 'fill': case 'stroke': case 'clip': case 'save': case 'restore': break;
      default: bad.push(`op ${i}: unhandled operation ${x[0]}`);
    }
  }
  return bad;
}

const SIZES = [[640, 360], [960, 540], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [1920, 900], [480, 480], [240, 540], [1918, 960], [1366, 768], [1280, 590]];
const IDEAL = [15360, 8640];   // 16 device pixels per design unit: the snap offsets shrink to 1/32 of a design unit
const gridFrame = { time: 61.25, localTime: 21.25, bpm: 133.5, grid: { offset: 2, beatsPerBar: 7, bpm: 133.5, changes: [[40, 90]] }, sceneStart: 40, sceneEnd: 100 };
const ideal = { plain: new Map(), gridded: new Map() };
for (const [name, extra] of [['plain', {}], ['gridded', gridFrame]]) for (const scene of NERV_SCENES) {
  const r = render(scene, IDEAL[0], IDEAL[1], fixture, extra), s = split(r.operations);
  ideal[name].set(scene, { ...s, S: Math.min(IDEAL[0] / 960, IDEAL[1] / 540) });
}
const totals = { compared: 0, rects: 0, strokes: 0, baselines: 0, clips: 0, outlines: 0 };
for (const [name, extra] of [['plain', {}], ['gridded', gridFrame]]) for (const [w, h] of SIZES) {
  const digests = new Set();
  for (const scene of NERV_SCENES) {
    const tag = `${scene} ${name} ${w}x${h}`, r = render(scene, w, h, fixture, extra), s = split(r.operations);
    const geometry = checkHead(s.head, w, h);
    // (a)+(b) scale invariance against the near-ideal drawing
    const differences = compareStreams({ ...s, S: geometry.S }, ideal[name].get(scene));
    assert.deepEqual(differences.slice(0, 5), [], `${tag}: drawing differs from the design canvas beyond the snap bound`);
    totals.compared += s.body.length;
    // (c) crispness on device pixels
    const c = crispness(r.operations, r.trace, s.start);
    assert.deepEqual(c.bad.slice(0, 5), [], `${tag}: edges, hairlines or baselines off the device grid`);
    for (const key of Object.keys(c.seen)) totals[key] += c.seen[key];
    ok(c.seen.baselines > 5 && c.seen.rects > 5 && c.seen.strokes >= 2, `${tag}: crispness analyser saw the plate ${JSON.stringify(c.seen)}`);
    // determinism at this size: another frame in between changes nothing
    const first = digest(r.operations);
    render(scene, w, h, fixture, { time: 4000, localTime: 290, seed: 883 });
    assert.equal(digest(render(scene, w, h, fixture, extra).operations), first, `${tag}: replay differs`); checks++;
    digests.add(first);
  }
  assert.equal(digests.size, 16, `${name} ${w}x${h}: 16 distinct drawing streams`);
}

// Random pairs: any two surfaces (64..4096 wide, 64..2400 high, so scales from 0.07 to 4.3 and any aspect) draw the same plate within the snap bound, and both are crisp.
{
  let seed = 20260929; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const surface = () => [64 + Math.floor(rnd() * 4033), 64 + Math.floor(rnd() * 2337)];
  let pairs = 0;
  for (let n = 0; n < 192; n++) {
    const scene = NERV_SCENES[n % 16];
    const extra = { time: rnd() * 400, localTime: rnd() * 60, bpm: 60 + rnd() * 140, progress: rnd(), seed: Math.floor(rnd() * 1e6), ...(n % 3 === 0 ? { grid: { offset: rnd() * 5, beatsPerBar: 1 + Math.floor(rnd() * 16), bpm: 60 + rnd() * 140 }, sceneStart: 10, sceneEnd: 10 + rnd() * 200 } : {}) };
    const sizes = [surface(), surface()], runs = sizes.map(([w, h]) => { const r = render(scene, w, h, fixture, extra), s = split(r.operations); return { r, s, w, h, S: checkHead(s.head, w, h).S }; });
    for (const { r, s, w, h } of runs) assert.deepEqual(crispness(r.operations, r.trace, s.start).bad.slice(0, 3), [], `fuzz ${n} ${scene} ${w}x${h}: off the device grid`);
    assert.deepEqual(compareStreams({ ...runs[0].s, S: runs[0].S }, { ...runs[1].s, S: runs[1].S }).slice(0, 3), [], `fuzz ${n} ${scene} ${sizes[0]} vs ${sizes[1]}`);
    pairs++; checks += 2;
  }
  ok(pairs === 192, 'fuzz ran');
}

// The analysers are not vacuous: unsnapped or drifting drawings are reported.
{
  const r = recordingContext(), c = r.context;
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.translate(3, 0); c.scale(2, 2);
  c.fillRect(1.3, 2, 4, 4); c.fillRect(1, 2, 0.2, 4); c.lineWidth = .4; c.beginPath(); c.moveTo(1, 5.2); c.lineTo(9, 5.2); c.stroke();
  c.textBaseline = 'alphabetic'; c.fillText('x', 3, 7.3); c.strokeRect(1, 1, 5, 5); c.restore();
  const found = crispness(r.operations, r.trace).bad.join(' | ');
  for (const needle of ['fillRect: edges', 'thinner than one device pixel', 'stroke 0.8 device px', 'baseline 14.6', 'outline width', 'outer edge']) ok(found.includes(needle), `crispness analyser reports "${needle}"; got ${found}`);
  const good = recordingContext(), g = good.context;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.translate(3, 0); g.scale(2, 2);
  g.fillRect(1.5, 2, 4, 4); g.lineWidth = 1; g.beginPath(); g.moveTo(1, 5); g.lineTo(9, 5); g.stroke(); g.textBaseline = 'alphabetic'; g.fillText('x', 3, 7); g.restore();
  assert.deepEqual(crispness(good.operations, good.trace).bad, [], 'a snapped hand-made stream is crisp'); checks++;
  const base = split(render('boot', 1280, 720).operations), drifted = base.body.map(op => op.slice()), classes = pathClasses(drifted);
  const text = drifted.findIndex(op => op[0] === 'fillText'), vertex = drifted.findIndex((op, i) => op[0] === 'lineTo' && classes[i]?.kind === 'exact');
  drifted[text][2] += .01; drifted[vertex][1] += .2;
  const d = compareStreams({ body: drifted, S: 1280 / 960 }, ideal.plain.get('boot')).join(' | ');
  ok(/x anchor/.test(d) && /lineTo x/.test(d), `comparison reports a moved text anchor and polygon vertex: ${d}`);
  ok(compareStreams({ body: base.body.slice(1), S: 1280 / 960 }, ideal.plain.get('boot'))[0].startsWith('op count'), 'comparison reports a changed operation count');
  ok(compareStreams({ body: base.body, S: 1280 / 960 }, ideal.plain.get('boot')).length === 0, 'an untouched stream compares clean');
}

// Pinned values: the snap arithmetic at four surfaces (S = 2/3, 2, 8/3, 16/9 letterboxed).
{
  const find = (operations, predicate) => operations.find(predicate);
  const rule = (w, h) => { const ops = render('end', w, h).operations, i = ops.findIndex(op => op[0] === 'moveTo' && op[1] === 254); return { move: ops[i], to: ops[i + 1], width: ops.slice(0, i).reverse().find(op => op[0] === 'set' && op[1] === 'lineWidth')[2] }; };
  const at640 = rule(640, 360); near(at640.move[2], 138.75, 1e-9, 'end rule y at 640x360 (139 * 2/3 = 92.67 -> stroke centre 92.5 device px)'); near(at640.width, 1.5, 1e-9, 'one device pixel is 1.5 design units at 640x360'); near(at640.to[2], 138.75, 1e-9);
  const at1080 = rule(1920, 1080); near(at1080.move[2], 139, 1e-9, 'end rule y at 1080p'); near(at1080.width, 1, 1e-9, 'two device pixels are one design unit at 1080p');
  const at1440 = rule(2560, 1440); near(at1440.move[2], 138.9375, 1e-9, 'end rule y at 1440p (3 device px wide, centre 370.5)'); near(at1440.width, 1.125, 1e-9);
  const raw = w => find(render('boot', w[0], w[1]).operations, op => op[0] === 'fillText' && op[1] === 'RAW AVS 576');
  const label640 = raw([640, 360]); near(label640[3], 514.5, 1e-9, 'RAW AVS 576 baseline at 640x360 (514 * 2/3 = 342.67 -> row 343)'); ok(label640[2] === 500, 'text x keeps its design coordinate');
  const head = checkHead(split(render('boot', 1918, 960).operations).head, 1918, 960);
  ok(head.offsetX === 106 && head.offsetY === 0, `letterbox 1918x960 is 106,0: ${head.offsetX},${head.offsetY}`);
}

// Meter cells that share an edge expression never overlap and never merge: the gap between neighbours is floor(2 S) or ceil(2 S) whole device pixels (the design gap is two units).
for (const [w, h] of [[1918, 960], [1366, 768], [2560, 1440], [640, 360], [3840, 2160]]) {
  const r = render('magi', w, h), s = split(r.operations), S = Math.min(w / 960, h / 540), ox = Math.round((w - 960 * S) / 2) || 0;
  const runs = []; let run = [];
  const flush = () => { if (run.length >= 12) runs.push(run); run = []; };
  for (let i = 0; i < s.body.length; i++) {
    const op = s.body[i], cell = s.body[i + 1];
    if (op[0] === 'set' && op[1] === 'fillStyle' && cell?.[0] === 'fillRect') { if (run.length && (cell[2] !== run[0][2] || cell[4] !== run[0][4])) flush(); run.push(cell); i++; } else flush();
  }
  flush();
  ok(runs.length >= 6, `${w}x${h}: three chrome meters and three MAGI meters found (${runs.length})`);
  for (const cells of runs) for (let j = 1; j < cells.length; j++) {
    const gap = (ox + S * cells[j][1]) - (ox + S * (cells[j - 1][1] + cells[j - 1][3]));
    ok(Math.abs(gap - Math.round(gap)) < 1e-6 && gap >= Math.floor(2 * S + 1e-9) - 1e-6 && gap <= Math.ceil(2 * S - 1e-9) + 1e-6, `${w}x${h}: meter cells ${j - 1} and ${j} are ${gap} device px apart (S = ${S})`);
  }
}

// ---- Finite geometry at extreme, tiny, fractional and invalid surfaces
for (const [w, h] of [[1, 1], [64, 64], [100, 7], [7, 100], [7680, 4320], [1918.5, 960.3], [1e5, 1e5]]) for (const scene of NERV_SCENES) render(scene, w, h);
for (const [w, h] of [[0, 360], [640, 0], [-5, 360], [NaN, 360], [640, NaN], [Infinity, 360], [640, -Infinity]]) {
  const r = recordingContext(); renderNervScene(r.context, w, h, { ...frame, scene: 'boot' }); r.verify();
  assert.equal(r.operations.length, 0, `nothing is drawn at ${w}x${h}`); checks++;
}

// ---- Source rules: no text measurement, no clock, and every fill, outline, clip and hairline goes through the snapping helpers (scenes added later must too).
{
  const source = readFileSync(entry, 'utf8');
  for (const word of ['measureText', 'Math.random', 'Date.now', 'performance.now']) ok(!source.includes(word), `nerv-scenes.ts does not use ${word}`);
  ok((source.match(/\bc\.fillRect\(/g) ?? []).length === 2, 'c.fillRect is called only by the rect helper and the whole-surface clear');
  ok((source.match(/\bc\.strokeRect\(/g) ?? []).length === 1, 'c.strokeRect is called only by the outline helper');
  ok((source.match(/\bc\.rect\(/g) ?? []).length === 1, 'c.rect is called only by the clipRect helper');
  ok(!/lineWidth = (?!hair\(|px \/ M\.scale)/.test(source), 'every line width is a snapped device width or floored by hair()');
  ok(/c\.textRendering = 'geometricPrecision'/.test(source), 'text hint present');
  assert.throws(() => recordingContext().context.measureText('x'), /Unexpected context API/); checks++;
  assert.throws(() => { recordingContext().context.filter = 'blur(2px)'; }, /unexpected context property filter/); checks++;
}

// Signed PCM stays where it was at every size: polyline coordinates are design units, not device units.
for (const [w, h] of [[3840, 2160], [1918, 960], [1280, 720]]) {
  const ops = render('psycho', w, h, signed).operations;
  ok(ops.some(op => op[0] === 'moveTo' && op[1] === 127 && Math.abs(op[2] - (125 + 31 + 27.9)) < 1e-8), `signed PCM -128 at ${w}x${h}`);
  ok(ops.some(op => op[0] === 'lineTo' && Math.abs(op[1] - (127 + 559 / 287)) < 1e-8 && op[2] < 156), `signed PCM +127 at ${w}x${h}`);
}
console.log(`NERV scenes: 16 distinct instruments, repeat/seek determinism, full stereo spectrum, signed PCM, finite geometry and context isolation; design-canvas scale invariance over ${SIZES.length} surfaces x 2 frames (${totals.compared} operations against a 16x ideal), device-pixel crispness (${totals.rects} fills, ${totals.strokes} strokes, ${totals.baselines} baselines, ${totals.clips} clips, ${totals.outlines} outlines), allowed setters, no measureText PASS (CPU-only, ${checks} assertions)`);
