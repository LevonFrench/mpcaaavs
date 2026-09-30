import { StereoAnalysisBuffer, normalizeDecodedAudio } from '../src/offline/audio-buffer.ts';
import { BoundedAsyncQueue, OfflineCancellationSource } from '../src/offline/control.ts';
import { prepareOfflineRender } from '../src/offline/engine.ts';
import { sha256Hex, stableJson } from '../src/offline/hash.ts';
import { bindAnchorHashes, createOfflineManifest, encodeStereoPcmS16leWav, offlineFramePath, OFFLINE_PACKAGE_NAMES, TransactionalPackageWriter, type PackageSink } from '../src/offline/output.ts';
import { OUTPUT_PROFILES, outputProfile } from '../src/offline/profiles.ts';
import { resolvePresetSchedule } from '../src/offline/schedule.ts';
import { canonicalTimebase, cumulativeBeatBoundarySample, RationalTimebase } from '../src/offline/timebase.ts';

function equal<T>(actual: T, expected: T, label: string): void {
  if (!Object.is(actual, expected)) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}
function ok(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

const canonical = canonicalTimebase();
equal(canonical.frameStartSample(1_968), 3_936_000, 'IAI final sample boundary');
equal(canonical.frameCount(3_936_000), 1_968, 'IAI frame count');
equal(canonical.timeSecondsAtFrame(1_968), 82, 'IAI duration');
for (let frame = 0; frame <= 1_968; frame++) {
  equal(canonical.frameStartSample(frame), frame * 2_000, `canonical sample mapping ${frame}`);
}
equal(canonical.frameCount(3_936_001), 1_969, 'partial final frame retained');

const ntscLike = new RationalTimebase(48_000, 30_000, 1_001);
for (let frame = 0; frame < 100_000; frame++) {
  const start = ntscLike.frameStartSample(frame);
  ok(start <= ntscLike.frameStartSample(frame + 1), 'rational mapping monotonic');
  equal(ntscLike.frameAtSample(start, 'floor'), frame, 'rational inverse at boundary');
}
equal(cumulativeBeatBoundarySample(1_000, 123), Math.round(1_000 * 48_000 * 60 / 123), 'cumulative beat boundary has no incremental drift');

equal(outputProfile('minimax-anchor-736x416-24').width, 736, 'canonical profile width');
equal(OUTPUT_PROFILES.length, 15, 'profile catalog size');
equal(offlineFramePath(42), 'frames/frame_000042.png', 'frame path');

const automatic = resolvePresetSchedule({
  mode: 'auto', availablePresetIds: ['z', 'a', 'z', 'b'], seed: 17,
  totalSamples: 480_000, bpm: 120, beatsPerBar: 4, downbeatSample: 24_000,
}, canonical);
equal(automatic.entries[0]!.sampleStart, 0, 'auto schedule covers audio before downbeat');
equal(automatic.entries[0]!.frameStart, 0, 'auto schedule covers frame zero');
equal(stableJson(automatic), stableJson(resolvePresetSchedule({
  mode: 'auto', availablePresetIds: ['b', 'z', 'a'], seed: 17,
  totalSamples: 480_000, bpm: 120, beatsPerBar: 4, downbeatSample: 24_000,
}, canonical)), 'auto schedule independent of input catalog order');

const source = new Float32Array([1, -1, .5, -.5, 0, 0]);
const analysisBuffer = new StereoAnalysisBuffer(source, { sourcePath: 'fixture.wav', sourceSampleFormat: 'pcm_s16le' });
source.fill(.25);
equal(analysisBuffer.sample(0, 0), 1, 'analysis buffer makes a private immutable copy');
const wav = encodeStereoPcmS16leWav(analysisBuffer);
equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF', 'WAV RIFF header');
equal(new DataView(wav.buffer).getUint32(24, true), 48_000, 'WAV rate');
equal(new DataView(wav.buffer).getUint16(22, true), 2, 'WAV channels');
equal(new DataView(wav.buffer).getInt16(44, true), 32_767, 'WAV positive sample');
equal(new DataView(wav.buffer).getInt16(46, true), -32_768, 'WAV negative sample');

const mono22k = normalizeDecodedAudio({
  sampleRate: 24_000, numberOfChannels: 1, length: 3,
  getChannelData: () => new Float32Array([0, 1, 0]),
});
equal(mono22k.totalSamplesPerChannel, 6, 'normalizer resamples to 48 kHz');
equal(mono22k.sample(0, 2), mono22k.sample(1, 2), 'normalizer duplicates mono');

const renderBuffer = new StereoAnalysisBuffer(new Float32Array(4_000));
const session = prepareOfflineRender(renderBuffer, {
  profileId: 'minimax-anchor-736x416-24', mode: 'preset', presetId: 'fixture', seed: 1, bpm: 120,
});
equal(session.plan.frameCount, 1, 'session exact frame count');
const input = session.frameAt(0);
equal(input.features.sample_end, 2_000, 'frame feature exact end sample');
equal(input.pcm.left.length, 576, 'AVS frame PCM width');
equal(input.preset.presetId, 'fixture', 'preset ledger resolved');

const queue = new BoundedAsyncQueue<number>(1);
await queue.push(1);
let secondReleased = false;
const blocked = queue.push(2).then(() => { secondReleased = true; });
await Promise.resolve();
equal(secondReleased, false, 'bounded queue applies producer backpressure');
equal((await queue.shift()).value, 1, 'queue order first');
await blocked;
equal((await queue.shift()).value, 2, 'queue order second');
queue.close();
equal((await queue.shift()).done, true, 'queue closes');
const cancellation = new OfflineCancellationSource();
cancellation.cancel();
let cancelled = false;
try { cancellation.token.throwIfCancelled(); } catch { cancelled = true; }
ok(cancelled, 'cancellation token throws');
const blockedQueue = new BoundedAsyncQueue<number>(1);
await blockedQueue.push(1);
const blockedCancellation = new OfflineCancellationSource();
const cancelledPush = blockedQueue.push(2, blockedCancellation.token).then(() => false, () => true);
blockedCancellation.cancel();
equal(await cancelledPush, true, 'cancellation immediately releases blocked producer');

class MemorySink implements PackageSink {
  readonly files = new Map<string, Uint8Array>();
  committed = false;
  aborted = false;
  async write(path: string, data: Uint8Array): Promise<void> { this.files.set(path, data.slice()); }
  async commit(): Promise<void> { this.committed = true; }
  async abort(): Promise<void> { this.aborted = true; }
}
const sink = new MemorySink();
const writer = new TransactionalPackageWriter(sink);
const frameHash = await sha256Hex('frame');
writer.registerExisting('frames/frame_000000.png', frameHash);
const wavHash = await writer.write(OFFLINE_PACKAGE_NAMES.audio, encodeStereoPcmS16leWav(renderBuffer));
const bound = bindAnchorHashes(session.plan, writer.hashes);
equal(bound.analysis.anchors[0]!.pngSha256, frameHash, 'anchor hash binding');
const manifest = await createOfflineManifest(bound, renderBuffer, { commit: 'fixture', bundleSha256: frameHash }, writer.hashes);
equal(manifest.source_audio.path, OFFLINE_PACKAGE_NAMES.audio, 'manifest source path names canonical WAV');
equal(manifest.source_audio.sha256, wavHash, 'manifest source hash matches canonical WAV artifact');
equal(manifest.source_audio.sample_format, 'pcm_s16le', 'manifest canonical WAV format');
await writer.write('events.json', '[]\n');
ok(!sink.committed, 'writes do not commit package');
await writer.abort();
ok(sink.aborted && !sink.committed, 'abort cannot publish package');

console.log('offline core: exact timebase, profiles, immutable PCM, analysis session, WAV, hashes, backpressure and transaction checks passed');
