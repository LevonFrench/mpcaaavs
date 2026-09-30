// Frame recorder regression check (src/frame-recorder.ts): percentile maths,
// dropped-frame counting, gap handling, preset-switch latency and the ring
// window, all on synthetic timestamps with hand-computed answers.
import {
  FrameRecorder, GAP_MS, createFrameReadout, droppedFor, percentileSorted,
} from '../src/frame-recorder.ts';

let checks = 0;
const VSYNC = 1000 / 60;

// 1. Percentiles: 1..100 ms, nearest rank.
{
  const sorted = Float64Array.from({ length: 100 }, (_, i) => i + 1);
  equal(percentileSorted(sorted, 100, 50), 50, 'p50 of 1..100');
  equal(percentileSorted(sorted, 100, 95), 95, 'p95 of 1..100');
  equal(percentileSorted(sorted, 100, 99), 99, 'p99 of 1..100');
  equal(percentileSorted(sorted, 100, 100), 100, 'p100 is the max');
  equal(percentileSorted(sorted, 10, 95), 10, 'p95 of 1..10 is the max (why small samples lie)');
  assert(Number.isNaN(percentileSorted(sorted, 0, 50)), 'empty percentile is NaN');

  // Through the recorder: feed the same deltas shuffled.
  const rec = new FrameRecorder();
  rec.setDisplayHz(60);
  let t = 0;
  rec.frame(t);
  const order = Array.from({ length: 100 }, (_, i) => ((i * 37) % 100) + 1);
  for (const d of order) rec.frame((t += d));
  const r = rec.readout(createFrameReadout());
  equal(r.samples, 100, 'recorder sample count');
  equal(r.p50, 50, 'recorder p50');
  equal(r.p95, 95, 'recorder p95');
  equal(r.p99, 99, 'recorder p99');
  equal(r.maxMs, 100, 'recorder max');
  near(r.fps, (100 * 1000) / 5050, 1e-9, 'delivered fps = frames / window time');
  equal(r.histogram.reduce((a, b) => a + b, 0), 100, 'histogram holds every sample');
}

// 2. Dropped frames against an ESTIMATED 60 Hz display.
{
  const rec = new FrameRecorder();
  let t = 1000;
  rec.frame(t);
  let expected = 0;
  for (let i = 1; i <= 600; i++) {
    // Drops only after the estimator has a baseline (it needs 30 samples).
    let d = VSYNC;
    if (i === 300) { d = VSYNC * 3; expected += 2; }                   // two missed refreshes
    else if (i > 60 && i % 50 === 0) { d = VSYNC * 2; expected += 1; } // one missed refresh
    rec.frame((t += d));
  }
  const r = rec.readout(createFrameReadout());
  near(r.displayHz, 60, 0.5, 'display rate estimated from the deltas');
  equal(r.droppedTotal, expected, 'dropped frames counted per missed refresh');
  equal(r.droppedWindow, expected, 'window drops equal total while nothing has been evicted');
  // Jitter within 1.5 intervals is not a drop.
  equal(droppedFor(VSYNC * 1.4, VSYNC), 0, 'a late frame inside 1.5 intervals is not a drop');
  equal(droppedFor(VSYNC * 2, VSYNC), 1, 'a doubled interval is one drop');
  equal(droppedFor(VSYNC * 4.1, VSYNC), 3, 'four intervals is three drops');
  equal(droppedFor(VSYNC * 10, 0), 0, 'no drops judged without a known interval');

  // Negative: the same 60 Hz stream judged against a pinned 120 Hz display
  // drops every other refresh — the counter is not stuck at a constant.
  const fast = new FrameRecorder();
  fast.setDisplayHz(120);
  let u = 0;
  fast.frame(u);
  for (let i = 0; i < 100; i++) fast.frame((u += VSYNC));
  equal(fast.readout(createFrameReadout()).droppedTotal, 100, '60 fps on a 120 Hz display drops one refresh per frame');
}

// 3. A long gap (hidden tab) is neither a sample nor a burst of drops.
{
  const rec = new FrameRecorder();
  rec.setDisplayHz(60);
  let t = 0;
  rec.frame(t);
  for (let i = 0; i < 10; i++) rec.frame((t += VSYNC));
  rec.frame((t += GAP_MS + 500));
  for (let i = 0; i < 10; i++) rec.frame((t += VSYNC));
  const r = rec.readout(createFrameReadout());
  equal(r.samples, 20, 'gap delta is not a sample');
  equal(r.droppedTotal, 0, 'gap is not counted as drops');
  near(r.fps, 60, 1e-6, 'fps unaffected by the gap');
}

// 4. Ring window: old deltas and their drops leave the window, not the total.
{
  const rec = new FrameRecorder(64);
  rec.setDisplayHz(60);
  let t = 0;
  rec.frame(t);
  for (let i = 0; i < 10; i++) rec.frame((t += VSYNC * 2));   // 10 drops, soon evicted
  for (let i = 0; i < 200; i++) rec.frame((t += VSYNC));
  const r = rec.readout(createFrameReadout());
  equal(r.samples, 64, 'ring holds capacity samples');
  equal(r.droppedWindow, 0, 'evicted drops leave the window');
  equal(r.droppedTotal, 10, 'evicted drops stay in the total');
  near(r.p99, VSYNC, 1e-9, 'window percentiles only see the window');
  equal(r.histogram.reduce((a, b) => a + b, 0), 64, 'histogram tracks evictions');
}

// 5. Time to first frame after a preset switch, worker and GPU times.
{
  const rec = new FrameRecorder();
  const r0 = rec.readout(createFrameReadout());
  assert(Number.isNaN(r0.ttffMs) && Number.isNaN(r0.renderMeanMs) && Number.isNaN(r0.gpuMeanMs), 'unmeasured fields are NaN');
  rec.markPresented(5);                     // no switch pending: ignored
  rec.markPresetSwitch(1000);
  rec.markPresented(1042);
  rec.markPresented(1060);                  // second present after the switch: ignored
  rec.markPresetSwitch(2000);
  rec.markPresented(2120);
  rec.markPresetSwitch(3000);
  rec.markPresented(3030);                  // latest is not the worst
  for (const ms of [4, 6, 8, 10]) rec.recordRender(ms);
  rec.recordRender(Number.NaN);             // rejected
  for (const ms of [1, 3]) rec.recordGpu(ms);
  const r = rec.readout(createFrameReadout());
  equal(r.ttffMs, 30, 'latest switch latency');
  equal(r.ttffMaxMs, 120, 'worst switch latency');
  equal(r.renderMeanMs, 7, 'render mean');
  equal(r.renderP95Ms, 10, 'render p95');
  equal(r.gpuMeanMs, 2, 'gpu mean');
  // Negative: a wrong expectation is caught (the equal() gate can fail).
  let caught = false;
  try { equal(r.ttffMs, 42, 'deliberately wrong'); } catch { caught = true; checks--; }
  assert(caught, 'equal() rejects a wrong value');

  const json = JSON.parse(rec.exportJson({ preset: 'fixture' })) as Record<string, unknown>;
  equal(json.kind === 'aaavs-frame-recording' ? 1 : 0, 1, 'export kind');
  equal(json.preset === 'fixture' ? 1 : 0, 1, 'export carries meta');
  const summary = json.summary as Record<string, unknown>;
  equal(summary.ttffMs as number, 30, 'export summary ttff');
  equal(summary.ttffMaxMs as number, 120, 'export summary worst ttff');
  assert(summary.gpuP95Ms === 3, 'export gpu p95');

  rec.reset();
  const cleared = rec.readout(createFrameReadout());
  equal(cleared.samples, 0, 'reset clears samples');
  assert(Number.isNaN(cleared.ttffMs), 'reset clears switch latency');
}

console.log(`frame-recorder-check: PASS (${checks} assertions)`);

function assert(condition: boolean, label: string): void {
  checks++;
  if (!condition) throw new Error(`frame-recorder-check: FAIL ${label}`);
}
function equal(actual: number, expected: number, label: string): void {
  assert(actual === expected, `${label}: got ${actual}, expected ${expected}`);
}
function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected} +/- ${tolerance}`);
}
