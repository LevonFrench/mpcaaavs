// Determinism (plan §4.7).
//
// Given (preset, audio, t) the engine must produce identical pixels. That buys
// three things at once: golden-image regression testing, correct video export,
// and presets that look the same on someone else's machine.
//
// So: no Math.random(), anywhere. Every "random" value is a pure function of a
// seed. Pulse learned this the same way and it is cheap to hold to from day one.

/** 32-bit integer hash (PCG-style finaliser). Deterministic, well-distributed. */
export function hashU32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** Hash to [0,1). */
export function hash01(x: number): number {
  return hashU32(x) / 4294967296;
}

/** Two-input hash — the workhorse for per-item, per-cycle variation. */
export function hash2(a: number, b: number): number {
  return hash01(hashU32(a) ^ Math.imul(b | 0, 0x9e3779b9));
}

/**
 * Seeded generator. Explicitly *not* a global — a shared mutable stream makes
 * output depend on call order across modules, which is the same
 * non-determinism we are trying to avoid.
 */
export class Rng {
  private state: number;
  constructor(seed: number) { this.state = hashU32(seed) || 1; }

  /** Next float in [0,1). */
  next(): number {
    this.state = hashU32(this.state);
    return this.state / 4294967296;
  }

  /** Next float in [lo,hi). */
  range(lo: number, hi: number): number { return lo + this.next() * (hi - lo); }

  /** Next integer in [0,n). */
  int(n: number): number { return Math.floor(this.next() * n) % n; }

  /** Deterministic pick. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty');
    return items[this.int(items.length)]!;
  }
}

/**
 * Stable 32-bit hash of a string — used to seed from a preset name so the same
 * preset always looks the same.
 */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Development guard. In dev builds this replaces the global sources of
 * non-determinism with throwing stubs, so an accidental `Math.random()`
 * surfaces immediately rather than as an unreproducible golden-image diff.
 *
 * Not called in production — the point is to fail loudly while building.
 */
export function forbidNondeterminism(): void {
  const boom = (name: string) => () => {
    throw new Error(
      `${name}() is banned — aaavs must be deterministic (plan §4.7). ` +
      `Use rng.ts instead.`,
    );
  };
  Math.random = boom('Math.random') as typeof Math.random;
  Date.now = boom('Date.now') as typeof Date.now;
}
