// CPU checks of the song map: clock, cache, worker protocol, progressive scan, live feed, session and
// accuracy against synthetic ground truth (tools/song-map-fixtures.ts). No audio files, no wall clock in results.
// Run through tools/check-song-map.mjs (esbuild bundle). Accuracy numbers are for synthetic music only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SongMapAnalyzer, planRegions } from '../src/song-map/analyzer.ts';
import { cacheKey, decodeRecord, encodeRecord, isTrackId, LibrarySongMapStore, MemorySongMapStore, type SongMapRecord } from '../src/song-map/cache.ts';
import { SongMapClock } from '../src/song-map/clock.ts';
import { InlineSongMapWorker } from '../src/song-map/inline-worker.ts';
import { SongMapLive } from '../src/song-map/live.ts';
import type { SongMapResponse, WorkerLike } from '../src/song-map/protocol.ts';
import { arraySource, SongMapScan, type SongMapUpdate } from '../src/song-map/scan.ts';
import { bridgeLibraryCall, createHostSongMap, httpLibraryCall } from '../src/song-map/host.ts';
import { SongMapSession, type SongMapState } from '../src/song-map/session.ts';
import { SONG_MAP_VERSION, type SongMapJSON } from '../src/song-map/types.ts';
// @ts-expect-error plain JS server module
import { createLibraryHandler } from './standalone-library.mjs';
import { FIXTURES, renderBassFixture, renderFixture, type Fixture } from './song-map-fixtures.ts';
// @ts-expect-error plain JS metrics module
import { evaluate, fMeasure, pitchAccuracy } from './song-map-metrics.mjs';

const log = (line: string) => console.log(line);
const fmt = (x: number, d = 3) => x.toFixed(d);

function scanWhole(sampleRate: number, left: Float32Array, right: Float32Array): { map: SongMapJSON; spec: Uint8Array; wave: Float32Array } {
  const analyzer = new SongMapAnalyzer({ sampleRate, totalSamples: left.length });
  for (const plan of planRegions(left.length, sampleRate)) analyzer.scanRegion(plan, (s, n) => ({ left: left.subarray(s, s + n), right: right.subarray(s, s + n) }));
  const { map, binary } = analyzer.build();
  return { map, spec: binary.spec, wave: binary.wave };
}

// ------------------------------------------------------------------------------------------ clock
{
  const beats: number[] = [], downbeats: number[] = [];
  let t = 1, bpm = 120;
  for (let b = 0; b < 64; b++) { if (b === 32) bpm = 150; beats.push(t); if (b % 4 === 0) downbeats.push(t); t += 60 / bpm; }
  const map = { version: SONG_MAP_VERSION, duration: t + 1, bpm: 120, fps: 100, beats, downbeats,
    sections: [{ name: 'intro', role: 'intro', start: 0, end: 9, energy: .2 }, { name: 'drop', role: 'drop', start: 9, end: 30, energy: .9 }, { name: 'outro', role: 'outro', start: 30, end: t + 1, energy: .1 }],
    features: {}, onsets: { kick: [], snare: [], hat: [], vocal: [] }, confidence: { tempo: 1, downbeat: 1, sections: 1 }, approximations: [] } as unknown as SongMapJSON;
  const clock = new SongMapClock(map, 7);
  assert.equal(clock.revision, 7);
  assert.throws(() => new SongMapClock(map, -1));
  for (const time of [-2, 0, 1, 1.25, 10, 17.9, 20, 27.4, 60, 99]) {
    assert.ok(Math.abs(clock.timeOfBeat(clock.beatAt(time)) - time) < 1e-9, `beat round trip ${time}`);
    assert.ok(Math.abs(clock.timeOfBar(clock.barAt(time)) - time) < 1e-9, `bar round trip ${time}`);
  }
  assert.equal(clock.beatAt(1), 0); assert.equal(clock.beatAt(1.5), 1); assert.equal(clock.barAt(3), 1);
  assert.ok(clock.beatAt(0) < 0 && clock.barAt(0) < 0, 'extrapolates before the grid');
  assert.ok(Math.abs(clock.bpmAt(5) - 120) < 1e-9 && Math.abs(clock.bpmAt(beats[40]!) - 150) < 1e-9, 'local tempo follows the beats');
  const at = clock.barPosition(3 + .5);
  assert.ok(Math.abs(at.bar - 1.25) < 1e-9 && Math.abs(at.beatInBar - 1) < 1e-9 && Math.abs(at.phase - .25) < 1e-9);
  assert.equal(clock.sectionAt(-5)!.index, 0); assert.equal(clock.sectionAt(8.999)!.section.role, 'intro');
  assert.equal(clock.sectionAt(9)!.section.role, 'drop'); assert.equal(clock.sectionAt(1e6)!.section.role, 'outro');
  assert.ok(Math.abs(clock.sectionAt(19.5)!.p - .5) < 1e-9);
  assert.equal(clock.nextBoundary(0)!.time, 9); assert.equal(clock.nextBoundary(9)!.time, 30); assert.equal(clock.nextBoundary(30), null);
  assert.equal(clock.nextBoundary(9)!.section!.role, 'outro');
  assert.equal(clock.nextBoundary(1, 'beat')!.time, beats[1]); assert.equal(clock.nextBoundary(beats[3]!, 'bar')!.time, downbeats[1]);
  assert.equal(clock.nextBoundary(1e6, 'bar'), null);
  assert.equal(SongMapClock.progress(5, 5, 9), 0); assert.equal(SongMapClock.progress(9, 5, 9), 1); assert.equal(SongMapClock.progress(7, 5, 9), .5); assert.equal(SongMapClock.progress(3, 5, 5), 0);
  const partial = new SongMapClock(map, 1, [[0, 20]]);
  assert.ok(partial.covered(19.9) && !partial.covered(20));
  assert.deepEqual([clock.sectionAt(12.3)!.index, clock.beatAt(12.3)], [clock.sectionAt(12.3)!.index, clock.beatAt(12.3)], 'pure');
  log('clock: sectionAt, nextBoundary, barAt, beatAt, timeOfBeat, revision: PASS');
}

// ------------------------------------------------------------------------------------------ fixtures
const rendered = new Map<string, Fixture>();
for (const spec of FIXTURES) rendered.set(spec.name, renderFixture(spec));

// ------------------------------------------------------------------------------------------ accuracy
const THRESHOLD = { tempo: .01, beatF: .95, downbeatF: .95, boundary: .85, roleAccuracy: .85, roleTime: .9, kickF: .6, snareF: .6, hatF: .6, pitch: .55 };
const summary: string[] = [];
const whole = new Map<string, { map: SongMapJSON; spec: Uint8Array; wave: Float32Array; ms: number }>();
for (const spec of FIXTURES) {
  const fx = rendered.get(spec.name)!;
  const t0 = performance.now();
  const result = scanWhole(spec.sampleRate, fx.left, fx.right);
  const ms = performance.now() - t0;
  whole.set(spec.name, { ...result, ms });
  const ev = evaluate(fx, result.map);
  const s = ev.sections;
  const label = spec.name.padEnd(17);
  summary.push(`${label} tempo err ${fmt(ev.tempoError * 100, 3)}%  beat F ${fmt(ev.beatF)}  downbeat F ${fmt(ev.downbeatF)}  boundary R ${fmt(s.boundaryRecall, 2)} P ${fmt(s.boundaryPrecision, 2)} worst ${fmt(s.worstBars, 2)} bar  roles ${fmt(s.roleAccuracy, 2)} (time ${fmt(s.roleTimeAccuracy, 2)})`
    + `  kick ${fmt(ev.kick.f, 2)} snare ${fmt(ev.snare.f, 2)} hat ${fmt(ev.hat.f, 2)} vocal-proxy ${fmt(ev.vocal.f, 2)}  bass pitch ${fmt(ev.pitch, 2)}`);
  assert.ok(ev.tempoError <= THRESHOLD.tempo, `${spec.name}: tempo error ${ev.tempoError}`);
  assert.ok(ev.beatF >= THRESHOLD.beatF, `${spec.name}: beat F ${ev.beatF}`);
  assert.ok(ev.downbeatF >= THRESHOLD.downbeatF, `${spec.name}: downbeat F ${ev.downbeatF}`);
  assert.ok(s.boundaryRecall >= THRESHOLD.boundary && s.boundaryPrecision >= THRESHOLD.boundary, `${spec.name}: section boundaries ${JSON.stringify(s)}`);
  assert.ok(s.worstBars <= 1 + 1e-6, `${spec.name}: worst boundary error ${s.worstBars} bars`);
  assert.ok(s.roleAccuracy >= THRESHOLD.roleAccuracy && s.roleTimeAccuracy >= THRESHOLD.roleTime, `${spec.name}: roles ${s.roleAccuracy} ${s.roleTimeAccuracy}`);
  assert.ok(ev.kick.f >= THRESHOLD.kickF && ev.snare.f >= THRESHOLD.snareF && ev.hat.f >= THRESHOLD.hatF, `${spec.name}: drum onsets`);
  assert.ok(ev.pitch >= THRESHOLD.pitch, `${spec.name}: bass pitch ${ev.pitch}`);
  const m = result.map;
  assert.equal(m.version, SONG_MAP_VERSION); assert.equal(m.fps, 100);
  for (const c of Object.values(m.confidence)) assert.ok(c >= 0 && c <= 1);
  assert.ok(m.approximations.includes('vocal') && m.approximations.includes('drums'), 'stem-free features are declared approximations');
  assert.equal(m.spectrum!.frames, m.features.rms.length); assert.equal(result.spec.length, m.spectrum!.frames * (m.spectrum!.mel + m.spectrum!.chroma));
  assert.ok(m.wave && result.wave.length === m.wave.frames * 2 && m.wave.rate === 11025, 'waveform ships when the scan is complete');
  if (spec.name === 'house-128') assert.deepEqual(scanWhole(spec.sampleRate, fx.left, fx.right).map, result.map, 'the same PCM always gives the same map');
  if (spec.name === 'house-128') assert.ok(m.confidence.tempo > .8 && m.confidence.downbeat > .8);
}
{
  const fx = renderBassFixture(44100);
  const { map } = scanWhole(44100, fx.left, fx.right);
  const acc = pitchAccuracy(fx.truth, map);
  summary.push(`bass-line (E1..C3)   bass pitch accuracy ${fmt(acc, 3)} on ${fx.truth.bass.length} sustained notes`);
  assert.ok(acc >= .9, `bass line pitch ${acc}`);
}
log('accuracy against synthetic ground truth (not real music):'); for (const line of summary) log('  ' + line);
log('accuracy thresholds: PASS');

// ------------------------------------------------------------------------------------------ chunked equals continuous
const house = rendered.get('house-128')!, houseSpec = FIXTURES.find(f => f.name === 'house-128')!;
const continuous = whole.get('house-128')!;
{
  const updates: SongMapUpdate[] = [];
  const worker = wrapCounting(new InlineSongMapWorker(task => { setTimeout(task, 0); }));
  const scan = new SongMapScan({ worker, source: arraySource(houseSpec.sampleRate, house.left, house.right), coreSeconds: 45, firstCoreSeconds: 20, blockSeconds: 1, maxInFlight: 3, onUpdate: u => updates.push(u) });
  assert.equal(await scan.start(), 'complete');
  assert.deepEqual(updates.map(u => u.revision), [1, 2, 3, 4, 5], 'one strictly increasing revision per region');
  assert.ok(updates[0]!.coverage[0]![1] <= 20.1 && !updates[0]!.complete && updates[0]!.map.approximations.includes('partial'), 'first useful result is partial and labelled');
  assert.ok(!updates[0]!.map.wave, 'no waveform until every sample of it was analysed');
  assert.ok(updates.slice(1).every((u, i) => u.coverage.at(-1)![1] >= updates[i]!.coverage.at(-1)![1]), 'coverage only grows');
  assert.equal(updates[0]!.clock.revision, 1);
  const last = updates.at(-1)!;
  assert.ok(last.complete && last.map.wave);
  assert.ok(!updates[0]!.map.sections.some(s => s.role === 'outro'), 'a chunk edge is not evidence of an outro');
  assert.deepEqual(last.map, continuous.map, 'chunked scan reproduces the continuous scan exactly');
  assert.deepEqual(last.binary.spec, continuous.spec); assert.deepEqual(last.binary.wave, continuous.wave);
  for (const kind of ['kick', 'snare', 'hat', 'vocal'] as const) {
    const times = last.map.onsets[kind].map(o => o[0]);
    assert.ok(times.every((x, i) => i === 0 || x > times[i - 1]!), `${kind}: no duplicate onsets across region seams`);
  }
  assert.ok(worker.maxOutstanding <= 3, `backpressure bounds in-flight blocks (${worker.maxOutstanding})`);
  log(`chunked scan (5 regions, cores 20/45 s): identical to continuous; ${updates.length} revisions; max ${worker.maxOutstanding} blocks in flight: PASS`);
}

// ------------------------------------------------------------------------------------------ playhead priority and cancellation
{
  const worker = new InlineSongMapWorker();
  const scan = new SongMapScan({ worker, source: arraySource(houseSpec.sampleRate, house.left, house.right), coreSeconds: 60, firstCoreSeconds: 60, playhead: () => 130, onUpdate: () => undefined });
  assert.equal(await scan.start(), 'complete');
  const starts = worker.log.filter(m => m.type === 'region').map(m => Math.round(m.feedStart! / houseSpec.sampleRate));
  assert.deepEqual(starts, [118, 178, 0, 58], 'the region under the playhead first, then the following regions, then the earlier ones');
}
{
  const first: SongMapUpdate[] = [], second: SongMapUpdate[] = [];
  // Delayed delivery keeps messages of the first job in flight when it is cancelled.
  const worker = new InlineSongMapWorker(task => { setTimeout(task, 0); });
  const shortSpec2 = { ...houseSpec, arrangement: [{ role: 'intro' as const, bars: 4 }, { role: 'groove' as const, bars: 8 }, { role: 'drop' as const, bars: 4 }], seed: 5 };
  const short2 = renderFixture(shortSpec2);
  const a: SongMapScan = new SongMapScan({ worker, job: 1, source: arraySource(houseSpec.sampleRate, house.left, house.right), coreSeconds: 30, firstCoreSeconds: 30, blockSeconds: .5,
    onUpdate: u => { first.push(u); a.cancel(); } });
  const pa = a.start();
  while (!first.length) await new Promise(resolve => setTimeout(resolve, 1));
  const b = new SongMapScan({ worker, job: 2, source: arraySource(shortSpec2.sampleRate, short2.left, short2.right), onUpdate: u => second.push(u) });
  const pb = b.start();
  assert.equal(await pa, 'cancelled'); assert.equal(await pb, 'complete');
  assert.equal(first.length, 1, 'no update after cancel');
  assert.deepEqual(second.at(-1)!.map, scanWhole(shortSpec2.sampleRate, short2.left, short2.right).map, 'a cancelled job cannot leak into the next track');
  assert.deepEqual(second.map(u => u.revision), second.map((_, i) => i + 1), 'each job numbers its own revisions from 1');
  assert.ok(worker.log.some(m => m.type === 'cancel' && m.job === 1));
  log('scheduling: playhead-first regions, cancellation and stale-job rejection: PASS');
}

// ------------------------------------------------------------------------------------------ live feed
{
  const spec = houseSpec, fx = house, rate = spec.sampleRate, hop = 576;
  const updates: SongMapUpdate[] = [];
  const live = new SongMapLive({ worker: new InlineSongMapWorker(), onUpdate: u => updates.push(u), publishEverySeconds: 15 });
  const play = (from: number, to: number, discontinuity: boolean) => {
    for (let s = Math.round(from * rate), first = true; s < Math.round(to * rate); s += hop, first = false) {
      live.push(s / rate, fx.left.subarray(s, s + hop), fx.right.subarray(s, s + hop), rate, discontinuity && first);
    }
  };
  play(0, 60, false); live.pause();
  play(40, 100, true); live.pause();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(updates.length >= 3 && updates.every((u, i) => u.revision === i + 1 && !u.complete), 'live snapshots are provisional and revisioned');
  const last = updates.at(-1)!;
  const spans = last.coverage;
  assert.ok(spans[0]![0] === 0 && spans.at(-1)![1] > 95, `live coverage ${JSON.stringify(spans)}`);
  assert.ok(last.map.approximations.includes('partial'));
  assert.ok(!last.map.sections.some(s => s.role === 'outro'), 'live edge is never an outro');
  for (const kind of ['kick', 'snare', 'hat'] as const) {
    const times = last.map.onsets[kind].map(o => o[0]);
    assert.ok(times.every((x, i) => i === 0 || x > times[i - 1]!), `${kind}: seek replay does not duplicate onsets`);
    const reference = continuous.map.onsets[kind].map(o => o[0]).filter(x => x > 3 && x < 96);
    const f = fMeasure(reference, times.filter(x => x > 3 && x < 96), .01).f;
    assert.ok(f >= .97, `${kind}: live equals the full scan where it has heard the audio (${f})`);
  }
  assert.ok(Math.abs(last.map.bpm - 128) < 1.3, `live tempo ${last.map.bpm}`);
  const heard = last.clock.sectionAt(80)!.section;
  assert.ok(heard.start <= 80 && heard.end >= 80);
  live.close();
  log(`live feed from 576-sample hops with a seek: ${updates.length} revisions, coverage ${JSON.stringify(spans.map(s => [+s[0].toFixed(1), +s[1].toFixed(1)]))}: PASS`);
}

// ------------------------------------------------------------------------------------------ cache
const shortSpec = { ...houseSpec, arrangement: [{ role: 'intro' as const, bars: 4 }, { role: 'groove' as const, bars: 8 }, { role: 'drop' as const, bars: 4 }], seed: 9, lead: .1 };
const short = renderFixture(shortSpec);
const idOf = (fx: { left: Float32Array }) => createHash('sha256').update(Buffer.from(fx.left.buffer, fx.left.byteOffset, fx.left.byteLength)).digest('hex');
{
  const trackId = idOf(short);
  assert.ok(isTrackId(trackId) && !isTrackId('abc') && !isTrackId(trackId.toUpperCase()));
  assert.throws(() => cacheKey('../../etc/passwd'));
  assert.equal(cacheKey(trackId), `${trackId}-v${SONG_MAP_VERSION}`);
  const scanned = scanWhole(shortSpec.sampleRate, short.left, short.right);
  const record = (await encodeRecord(trackId, scanned.map, { spec: scanned.spec, wave: scanned.wave }))!;
  assert.ok(record && record.payload.length > 1000 && record.payload.length < 3 * 1024 * 1024);
  const back = (await decodeRecord(record))!;
  assert.ok(back, 'round trip');
  const { wave: _wave, approximations, ...rest } = scanned.map; void _wave;
  const { approximations: cachedApprox, ...cachedRest } = back.map;
  assert.deepEqual(cachedRest, rest); assert.deepEqual(back.binary.spec, scanned.spec);
  assert.deepEqual(cachedApprox, [...approximations, 'wave.not-cached'], 'a cache hit says it has no waveform');
  assert.equal(back.map.wave, undefined);
  // Strict validation: anything wrong is a miss, never data.
  const bad = async (patch: Partial<SongMapRecord>) => assert.equal(await decodeRecord({ ...record, ...patch }), null);
  await bad({ version: SONG_MAP_VERSION + 1 }); await bad({ analyzer: 'other' }); await bad({ payload: record.payload.slice(0, 200) }); await bad({ payload: '!!!not base64!!!' });
  await bad({ encoding: record.encoding === 'gzip' ? 'identity' : 'gzip' });
  const identity = { ...record, encoding: 'identity' as const, payload: Buffer.from(JSON.stringify({ hello: 1 })).toString('base64') };
  assert.equal(await decodeRecord(identity), null);
  // Library adapter: JSON transport, key and identity checks, wrong-track and corrupt records are misses.
  const stored = new Map<string, unknown>();
  const calls: string[] = [];
  const store = new LibrarySongMapStore(async request => {
    const wire = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
    calls.push(String(wire.op));
    if (wire.op === 'save-song-map') { stored.set(String(wire.key), wire.data); return { type: 'song-map-saved', key: wire.key }; }
    return { type: 'song-map-loaded', key: wire.key, data: stored.get(String(wire.key)) ?? null };
  });
  assert.equal(await store.load(trackId), null);
  await store.save(trackId, record);
  assert.deepEqual(await store.load(trackId), record);
  stored.set(cacheKey(trackId), { ...record, trackId: 'f'.repeat(64) });
  assert.equal(await store.load(trackId), null, 'a record for another track is rejected');
  stored.set(cacheKey(trackId), 'garbage'); assert.equal(await store.load(trackId), null);
  assert.deepEqual(calls, ['load-song-map', 'save-song-map', 'load-song-map', 'load-song-map', 'load-song-map']);
  log(`cache: record ${(record.payload.length / 1024).toFixed(0)} KiB for a ${short.truth.duration.toFixed(0)} s track; round trip, strict validation and library adapter: PASS`);

  // ---------------------------------------------------------------------------------------- session
  const memory = new MemorySongMapStore();
  const states: SongMapState[] = [];
  const makeSession = (extra: object = {}) => new SongMapSession({ createWorker: () => new InlineSongMapWorker(), store: memory, onChange: s => states.push(s), ...extra });
  const finished = (session: SongMapSession, want: (s: SongMapState) => boolean) => new Promise<SongMapState>(resolve => {
    const poll = () => { if (want(session.state)) resolve(session.state); else setTimeout(poll, 1); };
    poll();
  });
  const first = makeSession();
  await first.openTrack({ id: trackId, source: arraySource(shortSpec.sampleRate, short.left, short.right) });
  const done = await finished(first, s => s.cache === 'saved');
  assert.equal(done.status, 'complete'); assert.equal(done.origin, 'scan'); assert.ok(done.update!.map.wave);
  assert.equal(memory.records.size, 1);
  const revisionAfterScan = done.revision;
  // Warm start: no PCM source, map straight from the cache.
  const second = makeSession();
  await second.openTrack({ id: trackId, source: null });
  assert.equal(second.state.origin, 'cache'); assert.equal(second.state.cache, 'hit'); assert.equal(second.state.status, 'complete');
  assert.equal(second.clock!.bpm, done.update!.map.bpm); assert.equal(second.clock!.revision, 1);
  assert.deepEqual(second.state.update!.map.beats, done.update!.map.beats);
  assert.ok(revisionAfterScan >= 1);
  // A different track never sees this record; a track without identity is scanned but not cached.
  const third = makeSession({ store: new MemorySongMapStore() });
  await third.openTrack({ id: 'a'.repeat(64), source: arraySource(shortSpec.sampleRate, short.left, short.right) });
  assert.equal(third.state.cache, 'saved');
  const anon = makeSession();
  await anon.openTrack({ id: null, source: arraySource(shortSpec.sampleRate, short.left, short.right) });
  assert.equal(anon.state.status, 'complete'); assert.equal(anon.state.cache, 'none'); assert.equal(memory.records.size, 1);
  // A corrupt cache entry falls back to a scan.
  memory.records.set(cacheKey(trackId), { ...record, payload: record.payload.slice(0, 100) });
  const fourth = makeSession();
  await fourth.openTrack({ id: trackId, source: arraySource(shortSpec.sampleRate, short.left, short.right) });
  assert.equal(fourth.state.origin, 'scan'); assert.equal(fourth.state.status, 'complete');
  // Track change mid-scan: the old track never publishes again.
  const generations: number[] = []; const seen = makeSession({ store: null, coreSeconds: 10, firstCoreSeconds: 10, onChange: (s: SongMapState) => generations.push(s.generation) });
  const pending = seen.openTrack({ id: null, source: arraySource(houseSpec.sampleRate, house.left, house.right) });
  await finished(seen, s => s.revision >= 1);
  const changed = seen.openTrack({ id: null, source: arraySource(shortSpec.sampleRate, short.left, short.right) });
  await Promise.all([pending, changed]);
  const g = seen.state.generation;
  assert.equal(seen.state.status, 'complete');
  assert.ok(Math.abs(seen.state.update!.map.duration - short.left.length / shortSpec.sampleRate) < .02, 'the final state belongs to the second track');
  assert.ok(generations.at(-1) === g);
  for (const s of [first, second, third, anon, fourth, seen]) s.close();
  log('session: cache miss -> scan -> save, warm cache hit, no identity, corrupt record, track change mid-scan: PASS');
}

// ------------------------------------------------------------------------------------------ host adapters
{
  // Library transport over the native bridge: replies route by op and key; an unknown op, an error reply and a silent bridge all reject.
  const posted: string[] = []; let deliver: (data: unknown) => void = () => undefined;
  const bridge = { postMessage: (m: string) => { posted.push(m); }, addEventListener: (_: 'message', l: (e: MessageEvent) => void) => { deliver = data => l({ data } as MessageEvent); } };
  const call = bridgeLibraryCall(bridge, 30);
  const key = cacheKey('c'.repeat(64));
  const loading = call({ op: 'load-song-map', key });
  assert.equal(posted[0], `library:${JSON.stringify({ op: 'load-song-map', key })}`);
  deliver({ type: 'song-map-loaded', key: 'other', data: null }); deliver({ type: 'song-map-loaded', key, data: null });
  assert.deepEqual(await loading, { type: 'song-map-loaded', key, data: null });
  const failing = call({ op: 'save-song-map', key, data: {} });
  deliver({ type: 'library-error', operation: 'save-song-map', message: 'Unknown library request' });
  await assert.rejects(failing, /Unknown library request/);
  await assert.rejects(call({ op: 'load-song-map', key }), /did not answer/);
  // Session with a bridge that never answers still scans and delivers a map.
  const mute = { postMessage: () => undefined, addEventListener: () => undefined };
  const degraded = new SongMapSession({ createWorker: () => new InlineSongMapWorker(), store: new LibrarySongMapStore(bridgeLibraryCall(mute, 20)) });
  await degraded.openTrack({ id: 'd'.repeat(64), source: arraySource(shortSpec.sampleRate, short.left, short.right) });
  assert.equal(degraded.state.status, 'complete'); assert.ok(['error', 'miss'].includes(degraded.state.cache));
  degraded.close();
  assert.equal(createHostSongMap({ call: null }), null, 'no Worker, no song map (the host keeps running)');
  assert.ok(createHostSongMap({ call: null, createWorker: () => new InlineSongMapWorker() }));

  // Real library server over HTTP: miss, scan, save, then a warm session reads the record back.
  const root = await mkdtemp(join(tmpdir(), 'aaavs-song-map-lib-'));
  await mkdir(join(root, 'avs presets', 'catalog'), { recursive: true });
  const server = createServer(async (req, res) => { if (!(await createLibraryHandler(root)(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
    const fetchWithOrigin = ((url: string, init: RequestInit) => fetch(origin + url, { ...init, headers: { ...(init.headers as Record<string, string>), Origin: origin } })) as unknown as typeof fetch;
    const id = createHash('sha256').update('http fixture').digest('hex');
    const make = () => createHostSongMap({ call: httpLibraryCall('/api/aaavs/library', fetchWithOrigin), createWorker: () => new InlineSongMapWorker() })!;
    const cold = make();
    await cold.openTrack({ id, source: arraySource(shortSpec.sampleRate, short.left, short.right) });
    for (let i = 0; i < 400 && cold.state.cache !== 'saved'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(cold.state.cache, 'saved', cold.state.message); assert.equal(cold.state.cache === 'saved' && cold.state.origin, 'scan');
    const warm = make();
    await warm.openTrack({ id, source: null });
    assert.equal(warm.state.origin, 'cache'); assert.equal(warm.state.status, 'complete');
    assert.deepEqual(warm.state.update!.map.beats, cold.state.update!.map.beats);
    cold.close(); warm.close();
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }

  // Lazy decode: the source loader runs only on a cache miss; a failing decode falls back to the live map.
  const store = new MemorySongMapStore();
  let decodes = 0;
  const lazy = () => async () => { decodes++; return arraySource(shortSpec.sampleRate, short.left, short.right); };
  const id = idOf(short);
  const a = new SongMapSession({ createWorker: () => new InlineSongMapWorker(), store });
  await a.openTrack({ id, source: lazy() }); assert.equal(decodes, 1);
  const b = new SongMapSession({ createWorker: () => new InlineSongMapWorker(), store });
  await b.openTrack({ id, source: lazy() }); assert.equal(decodes, 1, 'a cache hit never decodes'); assert.equal(b.state.origin, 'cache');
  const c = new SongMapSession({ createWorker: () => new InlineSongMapWorker(), store: null });
  await c.openTrack({ id: null, source: async () => { throw new Error('unsupported codec'); } });
  assert.equal(c.state.status, 'live'); assert.match(c.state.message, /unsupported codec/);
  assert.equal(c.authoritative, false, 'after a failed decode live PCM is accepted again');
  // hold(): live PCM is ignored while the host decodes; a full scan or cache hit later wins over a live map.
  const d = new SongMapSession({ createWorker: () => { workersMade++; return new InlineSongMapWorker(); }, store: null });
  let workersMade = 0;
  const hop = (t: number) => { const s = Math.round(t * 44100); return [t, house.left.subarray(s, s + 576), house.right.subarray(s, s + 576)] as const; };
  const generation = d.hold();
  for (let t = 0; t < 3; t += 576 / 44100) d.feedLive(...hop(t), 44100);
  assert.equal(workersMade, 0, 'no live map while a decode is pending');
  d.release(generation, 'decode failed');
  for (let t = 0; t < .9; t += 576 / 44100) d.feedLive(...hop(t), 44100);
  assert.equal(workersMade, 0, 'less than one second of playback never costs a worker');
  for (let t = .9; t < 1.2; t += 576 / 44100) d.feedLive(...hop(t), 44100);
  assert.equal(workersMade, 1, 'a live map starts after one second of contiguous audio');
  for (let t = 1.2; t < 12; t += 576 / 44100) d.feedLive(...hop(t), 44100);
  d.pauseLive();
  await new Promise(resolve => setTimeout(resolve, 5)); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(d.state.status, 'live'); assert.ok(d.state.update && d.state.update.coverage[0]![0] === 0, 'the buffered first second is analysed too');
  assert.equal(d.state.revision, d.state.update!.revision);
  for (const session of [a, b, c, d]) session.close();
  log('host adapters: bridge and HTTP library transports, real library server round trip, lazy decode, hold/release, live warm-up: PASS');
}

// ------------------------------------------------------------------------------------------ real worker thread
{
  // The shipped worker entry (src/song-map/song-map.worker.ts) in a real thread with real transfer semantics. Only the
  // Worker/`self` plumbing is shimmed: worker_threads stands in for the browser Worker.
  const scratch = await mkdtemp(join(tmpdir(), 'aaavs-song-map-thread-'));
  try {
    const bundle = join(scratch, 'worker-body.mjs'), entry = join(scratch, 'worker-entry.mjs');
    // esbuild is resolved from the project (the check itself runs from a scratch bundle).
    const { build } = await import(pathToFileURL(resolvePath('node_modules/esbuild/lib/main.js')).href) as typeof import('esbuild');
    await build({ entryPoints: [resolvePath('src/song-map/song-map.worker.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
    await writeFile(entry, `import { parentPort } from 'node:worker_threads';
globalThis.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer), set onmessage(handler) { parentPort.on('message', data => handler({ data })); } };
await import(${JSON.stringify(pathToFileURL(bundle).href)});
parentPort.postMessage({ type: 'booted', job: -1 });
`);
    const thread = new NodeWorker(entry);
    await new Promise<void>(resolve => thread.once('message', () => resolve()));
    const like: WorkerLike = {
      onmessage: null,
      postMessage: (message, transfer) => thread.postMessage(message, transfer as never),
      terminate: () => { void thread.terminate(); },
    };
    thread.on('message', data => like.onmessage?.({ data }));
    const updates: SongMapUpdate[] = [];
    const shortFx = renderFixture({ ...houseSpec, arrangement: [{ role: 'intro', bars: 4 }, { role: 'groove', bars: 8 }, { role: 'drop', bars: 4 }], seed: 5 });
    const scan = new SongMapScan({ worker: like, source: arraySource(houseSpec.sampleRate, shortFx.left, shortFx.right), coreSeconds: 12, firstCoreSeconds: 12, onUpdate: u => updates.push(u) });
    assert.equal(await scan.start(), 'complete');
    assert.deepEqual(updates.at(-1)!.map, scanWhole(houseSpec.sampleRate, shortFx.left, shortFx.right).map, 'the worker thread reproduces the in-process scan exactly');
    assert.ok(updates.length >= 3 && updates.every((u, i) => u.revision === i + 1));
    like.terminate();
    log(`worker thread: shipped entry, structured clone and transferred buffers, ${updates.length} revisions identical to in-process: PASS`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------------------------------ helpers
function wrapCounting(inner: InlineSongMapWorker): WorkerLike & { maxOutstanding: number } {
  let outstanding = 0;
  const wrapper: WorkerLike & { maxOutstanding: number } = {
    maxOutstanding: 0, onmessage: null,
    postMessage(message, transfer) { if (message.type === 'pcm') { outstanding++; wrapper.maxOutstanding = Math.max(wrapper.maxOutstanding, outstanding); } inner.postMessage(message, transfer); },
    terminate() { inner.terminate(); },
  };
  Object.defineProperty(wrapper, 'onmessage', {
    set(handler: ((event: { data: SongMapResponse }) => void) | null) { inner.onmessage = handler ? event => { if (event.data.type === 'ack') outstanding--; handler(event); } : null; },
    get() { return inner.onmessage; },
  });
  return wrapper;
}
log('song-map checks: PASS');
