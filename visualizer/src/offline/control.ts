export class OfflineCancelledError extends Error {
  constructor(message = 'Offline render cancelled') { super(message); this.name = 'OfflineCancelledError'; }
}

export class OfflineCancellationToken {
  #cancelled = false;
  #reason: unknown;
  readonly #listeners = new Set<(reason: unknown) => void>();
  get cancelled(): boolean { return this.#cancelled; }
  get reason(): unknown { return this.#reason; }
  throwIfCancelled(): void { if (this.#cancelled) throw this.#reason instanceof Error ? this.#reason : new OfflineCancelledError(); }
  onCancel(listener: (reason: unknown) => void): () => void {
    if (this.#cancelled) { listener(this.#reason); return () => {}; }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  /** @internal */ cancel(reason?: unknown): void {
    if (this.#cancelled) return;
    this.#cancelled = true; this.#reason = reason;
    for (const listener of this.#listeners) listener(reason);
    this.#listeners.clear();
  }
}

export class OfflineCancellationSource {
  readonly token = new OfflineCancellationToken();
  cancel(reason?: unknown): void { this.token.cancel(reason); }
}

export interface OfflineProgress {
  readonly stage: 'decode' | 'analyze' | 'render' | 'encode' | 'package' | 'complete';
  readonly completed: number;
  readonly total: number;
  readonly ratio: number;
  readonly queueDepth: number;
  readonly message?: string;
}

export class OfflineProgressReporter {
  readonly #listener: (progress: OfflineProgress) => void;
  constructor(listener: (progress: OfflineProgress) => void) { this.#listener = listener; }
  report(stage: OfflineProgress['stage'], completed: number, total: number, queueDepth = 0, message?: string): void {
    this.#listener(Object.freeze({ stage, completed, total, ratio: total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0, queueDepth, ...(message ? { message } : {}) }));
  }
}

/** Bounded FIFO: producers await capacity, making backpressure explicit. */
export class BoundedAsyncQueue<T> {
  readonly capacity: number;
  readonly #items: T[] = [];
  readonly #readers: Array<(result: IteratorResult<T>) => void> = [];
  readonly #writers: Array<() => void> = [];
  #closed = false;
  #failure: unknown;
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('queue capacity must be a positive integer');
    this.capacity = capacity;
  }
  get size(): number { return this.#items.length; }
  async push(item: T, token?: OfflineCancellationToken): Promise<void> {
    token?.throwIfCancelled();
    if (this.#closed) throw this.failureError();
    const reader = this.#readers.shift();
    if (reader) { reader({ done: false, value: item }); return; }
    while (this.#items.length >= this.capacity) {
      await new Promise<void>((resolve, reject) => {
        let unsubscribe = (): void => {};
        const resume = (): void => { unsubscribe(); resolve(); };
        this.#writers.push(resume);
        unsubscribe = token?.onCancel((reason) => {
          const index = this.#writers.indexOf(resume);
          if (index >= 0) this.#writers.splice(index, 1);
          reject(cancellationError(reason));
        }) ?? unsubscribe;
      });
      token?.throwIfCancelled();
      if (this.#closed) throw this.failureError();
    }
    this.#items.push(item);
  }
  async shift(token?: OfflineCancellationToken): Promise<IteratorResult<T>> {
    token?.throwIfCancelled();
    if (this.#items.length > 0) {
      const item = this.#items.shift()!;
      this.#writers.shift()?.();
      return { done: false, value: item };
    }
    if (this.#closed) {
      if (this.#failure !== undefined) throw this.failureError();
      return { done: true, value: undefined };
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      let unsubscribe = (): void => {};
      const resume = (result: IteratorResult<T>): void => { unsubscribe(); resolve(result); };
      this.#readers.push(resume);
      unsubscribe = token?.onCancel((reason) => {
        const index = this.#readers.indexOf(resume);
        if (index >= 0) this.#readers.splice(index, 1);
        reject(cancellationError(reason));
      }) ?? unsubscribe;
    });
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader({ done: true, value: undefined });
    for (const writer of this.#writers.splice(0)) writer();
  }
  fail(reason: unknown): void { this.#failure = reason; this.close(); }
  private failureError(): Error { return this.#failure instanceof Error ? this.#failure : new Error('queue is closed'); }
}

function cancellationError(reason: unknown): Error {
  return reason instanceof Error ? reason : new OfflineCancelledError();
}
