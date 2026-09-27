import type { AvsAudioFrame } from './avs/types.ts';

export interface SourcePcm { time: number; pcm: Float32Array; sampleRate?: number; samples?: number }
/** Streaming windowed-sinc conversion for the AVS host's 44.1 kHz analysis domain.
 * Keeps real packet lengths (never inserts packet-tail zeros), filter history and stereo.
 * The short lookahead delays availability, not the timestamps used by the beat tracker.
 */
export class PcmNormalizer {
  private rate = 0;
  private left: number[] = [];
  private right: number[] = [];
  private origin = 0;
  private next = 0;
  private expected = -1;
  private output = new Float32Array(1152);
  private count = 0;
  private outputTime = 0;
  private kernels: Float32Array[] = [];
  private half = 16;
  reset() { this.rate = 0; this.left = []; this.right = []; this.count = 0; this.expected = -1; this.next = 0; }
  push(frame: SourcePcm): SourcePcm[] {
    const rate = frame.sampleRate ?? 44100, samples = frame.samples ?? 576;
    if (!Number.isFinite(frame.time) || !Number.isInteger(rate) || rate < 8000 || rate > 384000 || !Number.isInteger(samples) || samples < 1 || samples > 576 || frame.pcm.length !== 1152) return [];
    if (this.expected >= 0 && frame.time < this.expected - samples / rate * .5) return [];
    if (rate !== this.rate || this.expected < 0 || Math.abs(frame.time - this.expected) > .002) {
      this.reset(); this.rate = rate; this.origin = frame.time; this.next = 0;
      this.half = Math.ceil(16 * Math.max(1, rate / 44100));
      const cutoff = .47 * Math.min(1, 44100 / rate);
      this.kernels = Array.from({ length: 256 }, (_, phase) => {
        const kernel = new Float32Array(2 * this.half + 1); let sum = 0;
        for (let k = -this.half; k <= this.half; k++) {
          const x = k - phase / 256, v = 2 * cutoff * x;
          const sinc = Math.abs(v) < 1e-12 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v);
          const weight = sinc * (.5 + .5 * Math.cos(Math.PI * x / (this.half + 1)));
          kernel[k + this.half] = weight; sum += weight;
        }
        for (let k = 0; k < kernel.length; k++) kernel[k] = kernel[k]! / sum;
        return kernel;
      });
    }
    this.expected = frame.time + samples / rate;
    for (let i = 0; i < samples; i++) { this.left.push(frame.pcm[i]!); this.right.push(frame.pcm[576 + i]!); }
    const result: SourcePcm[] = [], step = rate / 44100;
    while (Math.floor(this.next) + this.half < this.left.length) {
      const base = Math.floor(this.next), kernel = this.kernels[Math.min(255, Math.floor((this.next - base) * 256))]!;
      let l = 0, r = 0;
      for (let k = -this.half; k <= this.half; k++) { const index = base + k, w = kernel[k + this.half]!; l += (this.left[index] ?? 0) * w; r += (this.right[index] ?? 0) * w; }
      if (!this.count) this.outputTime = this.origin + this.next / rate;
      this.output[this.count] = Math.max(-1, Math.min(1, l)); this.output[576 + this.count] = Math.max(-1, Math.min(1, r));
      this.count++; this.next += step;
      if (this.count === 576) { result.push({time:this.outputTime, pcm:this.output, sampleRate:44100, samples:576}); this.output = new Float32Array(1152); this.count = 0; }
    }
    const discard = Math.max(0, Math.floor(this.next) - this.half);
    if (discard) { this.left.splice(0, discard); this.right.splice(0, discard); this.next -= discard; this.origin += discard / rate; }
    return result;
  }
}
/** Already log-mapped spectrum: max-hold per renderer, with no second logarithm. */
export class AudioHold {
  private frame: AvsAudioFrame = { waveform:[new Uint8Array(576),new Uint8Array(576)], spectrum:[new Uint8Array(576),new Uint8Array(576)], beat:false, beatLevel:0 };
  push(audio: AvsAudioFrame) {
    for (const ch of [0,1] as const) { this.frame.waveform[ch].set(audio.waveform[ch]); for(let i=0;i<576;i++) this.frame.spectrum[ch][i]=Math.max(this.frame.spectrum[ch][i]!,audio.spectrum[ch][i]!); }
    this.frame = {...this.frame, beat:this.frame.beat || audio.beat, beatLevel:Math.max(this.frame.beatLevel,audio.beatLevel)};
  }
  consume(): AvsAudioFrame {
    const result = {...this.frame, waveform:[this.frame.waveform[0].slice(),this.frame.waveform[1].slice()] as const, spectrum:[this.frame.spectrum[0].slice(),this.frame.spectrum[1].slice()] as const};
    this.frame.spectrum[0].fill(0);this.frame.spectrum[1].fill(0);this.frame={...this.frame,beat:false,beatLevel:0}; return result;
  }
  reset() { this.frame.waveform[0].fill(0);this.frame.waveform[1].fill(0);this.consume(); }
}
