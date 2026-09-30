// In-process WorkerLike for checks, benchmarks and hosts without Worker support. Requests are handled on a
// later task (never re-entrantly) and replies are delivered asynchronously, like a real worker.
import { SongMapEngine } from './engine.ts';
import type { SongMapRequest, SongMapResponse, WorkerLike } from './protocol.ts';

export class InlineSongMapWorker implements WorkerLike {
  onmessage: ((event: { data: SongMapResponse }) => void) | null = null;
  private readonly engine: SongMapEngine;
  private dead = false;
  /** Every request seen, for assertions (bounded by the caller's lifetime). */
  readonly log: { type: string; job: number; feedStart?: number }[] = [];
  constructor(private readonly schedule: (task: () => void) => void = task => { void Promise.resolve().then(task); }) {
    this.engine = new SongMapEngine(message => this.schedule(() => { if (!this.dead) this.onmessage?.({ data: message }); }));
  }
  postMessage(message: SongMapRequest): void {
    this.log.push(message.type === 'region' ? { type: message.type, job: message.job, feedStart: message.feedStart } : { type: message.type, job: message.job });
    this.schedule(() => { if (!this.dead) this.engine.handle(message); });
  }
  terminate(): void { this.dead = true; }
}
