// Browser-side helpers for the standalone Player: content identity of a file and decoding it to PCM.
import type { PcmSource } from './scan.ts';

/** Longest file the Player decodes whole. The decoded float PCM is about 21 MB per minute at 44.1 kHz stereo. */
export const MAX_DECODE_SECONDS = 15 * 60;
export const ANALYSIS_SAMPLE_RATE = 44100;

/** Lowercase hex SHA-256 of the file bytes, or null where SubtleCrypto is unavailable (insecure context). */
export async function contentId(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = ''; for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Decode to stereo 44.1 kHz PCM. `decodeAudioData` detaches `bytes`; hash first. */
export async function decodeToSource(bytes: ArrayBuffer): Promise<PcmSource> {
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Offline) throw new Error('OfflineAudioContext is unavailable');
  const context = new Offline(2, 1, ANALYSIS_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(bytes);
  if (buffer.duration > MAX_DECODE_SECONDS) throw new Error(`audio is ${Math.round(buffer.duration / 60)} minutes long`);
  const left = buffer.getChannelData(0), right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return { sampleRate: buffer.sampleRate, totalSamples: buffer.length, read: (start, length) => ({ left: left.subarray(start, start + length), right: right.subarray(start, start + length) }) };
}
