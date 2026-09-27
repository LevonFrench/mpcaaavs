export interface AvsLiveDirectorPreset {
  readonly id: string;
  readonly name: string;
}

export interface AvsLiveDirectorDiagnostics {
  readonly enabled: boolean;
  readonly bankSize: number;
  readonly currentId: string;
  readonly pendingId: string;
  readonly nextBar: number;
  readonly sequence: number;
}

/** Deterministic, bar-quantized responsive director for imported AVS presets. */
export class AvsLiveDirector {
  enabled = false;
  minBars = 2;
  maxBars = 12;

  private bank: readonly AvsLiveDirectorPreset[] = [];
  private currentId = '';
  private pendingId = '';
  private pendingEnergy = 0;
  private nextBar = Number.POSITIVE_INFINITY;
  private sequence = 0;

  constructor(private readonly seed = 0xa45a_5eed) {}

  diagnostics(): AvsLiveDirectorDiagnostics {
    return {
      enabled: this.enabled,
      bankSize: this.bank.length,
      currentId: this.currentId,
      pendingId: this.pendingId,
      nextBar: this.nextBar,
      sequence: this.sequence,
    };
  }

  setBank(bank: readonly AvsLiveDirectorPreset[], currentId = this.currentId, bar = 0): void {
    this.bank = [...bank];
    this.currentId = bank.some((preset) => preset.id === currentId) ? currentId : bank[0]?.id ?? '';
    this.pendingId = '';
    this.pendingEnergy = 0;
    this.sequence = 0;
    this.arm(bar, 0);
  }

  select(id: string, bar: number, energy = 0): void {
    this.currentId = id;
    this.pendingId = '';
    this.pendingEnergy = 0;
    this.arm(bar, energy);
  }

  update(barPosition: number, energy: number, impact = 0): AvsLiveDirectorPreset | null {
    if (!this.enabled || this.pendingId || this.bank.length < 2 || barPosition + 1e-9 < this.nextBar) return null;
    const bar = Math.floor(barPosition);
    const hash = mix32(this.seed ^ Math.imul(++this.sequence, 0x9e3779b1) ^ Math.imul(bar, 0x85ebca6b));
    const current = this.bank.findIndex((preset) => preset.id === this.currentId);
    let index = hash % (this.bank.length - 1);
    if (current >= 0 && index >= current) index++;
    const selected = this.bank[index]!;
    this.pendingId = selected.id;
    this.pendingEnergy = Math.max(energy, impact);
    // Selection is two-phase because preset bytes/load are asynchronous. Do
    // not choose another candidate while this one is still in flight.
    this.nextBar = Number.POSITIVE_INFINITY;
    return selected;
  }

  commit(id: string, bar: number, energy = this.pendingEnergy): void {
    if (this.pendingId && this.pendingId !== id) return;
    this.currentId = id;
    this.pendingId = '';
    this.pendingEnergy = 0;
    this.arm(bar, energy);
  }

  cancel(id: string, bar: number, energy = this.pendingEnergy): void {
    if (this.pendingId !== id) return;
    this.pendingId = '';
    this.pendingEnergy = 0;
    this.arm(bar, energy);
  }

  private arm(barPosition: number, energy: number): void {
    const bar = Math.floor(barPosition);
    const intensity = clamp01(energy);
    const dwell = Math.round(this.maxBars - (this.maxBars - this.minBars) * intensity);
    this.nextBar = bar + Math.max(this.minBars, Math.min(this.maxBars, dwell));
  }
}

/** Latest-request-wins gate for async catalog fetch + renderer load. */
export class AvsLiveLoadGuard {
  private revision = 0;
  private active = 0;
  get busy(): boolean { return this.active !== 0; }
  begin(): number { const ticket = ++this.revision; this.active = ticket; return ticket; }
  isCurrent(ticket: number): boolean { return ticket === this.revision; }
  finish(ticket: number): void { if (this.active === ticket) this.active = 0; }
  supersede(): void { this.revision++; this.active = 0; }
}

/** Musical bars before tempo lock; a stationary audio clock remains stationary. */
export function resolveAvsLiveBarPosition(
  trackedBarPosition: number,
  trackedBpm: number,
  audioTime: number,
  fallbackBpm = 120,
): number {
  if (trackedBpm > 0 && Number.isFinite(trackedBarPosition)) return Math.max(0, trackedBarPosition);
  if (!(audioTime > 0) || !(fallbackBpm > 0)) return 0;
  return audioTime * fallbackBpm / 240;
}

function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
