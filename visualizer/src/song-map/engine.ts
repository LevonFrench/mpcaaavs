// The worker's brain, free of `self` so checks and non-worker hosts can run it in-process.
import { SongMapAnalyzer } from './analyzer.ts';
import type { SongMapRequest, SongMapResponse } from './protocol.ts';

export type Post = (message: SongMapResponse, transfer?: Transferable[]) => void;

const finiteRate = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 8000 && (n as number) <= 384000;

export class SongMapEngine {
  private job = -1;
  private analyzer: SongMapAnalyzer | null = null;
  constructor(private readonly post: Post) {}

  handle(message: SongMapRequest): void {
    try {
      switch (message.type) {
        case 'begin': {
          if (!finiteRate(message.sampleRate)) throw new RangeError('Unsupported sample rate');
          this.job = message.job;
          this.analyzer = new SongMapAnalyzer({
            sampleRate: message.sampleRate, totalSamples: message.totalSamples,
            ...(message.maxWaveSeconds !== undefined ? { maxWaveSeconds: message.maxWaveSeconds } : {}),
          });
          return;
        }
        case 'cancel': if (message.job === this.job) { this.analyzer = null; this.job = -1; } return;
        default: break;
      }
      if (message.job !== this.job || !this.analyzer) return; // stale message from a previous job
      const analyzer = this.analyzer;
      switch (message.type) {
        case 'region': analyzer.beginRegion(message.feedStart, message.coreStart, message.coreEnd); return;
        case 'pcm': {
          if (message.left.length !== message.right.length) throw new RangeError('Channel length mismatch');
          analyzer.push(message.left, message.right);
          this.post({ type: 'ack', job: message.job, samples: message.left.length });
          return;
        }
        case 'end-region':
          analyzer.endRegion(message.atTrackEnd);
          this.post({ type: 'region-done', job: message.job });
          if (message.publish) this.snapshot(message.job);
          return;
        case 'snapshot': this.snapshot(message.job); return;
      }
    } catch (error) {
      this.post({ type: 'error', job: message.job, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private snapshot(job: number): void {
    const analyzer = this.analyzer!;
    const { map, binary, coverage, complete } = analyzer.build();
    const spec = binary.spec, wave = binary.wave;
    this.post({ type: 'snapshot', job, map, spec, wave, coverage, complete, heapBytes: analyzer.bytes() },
      [spec.buffer, wave.buffer].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer && b.byteLength > 0));
  }
}
