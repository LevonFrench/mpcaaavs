/** History records only presets whose first frame was committed. */
export class PresetNavigation {
  index = 0;
  shuffle = false;
  private history: number[] = [];
  private requested: number | null = null;
  private previousCursor: number | null = null;
  private committed = false;
  constructor(readonly count: number, private random = Math.random) {
    if (count < 1) throw new Error('Preset catalog is empty');
  }
  cancel() { this.requested = null; this.previousCursor = null; }
  select(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) throw new Error('Invalid preset');
    if (this.previousCursor !== null && this.requested === index) this.history.length = this.previousCursor;
    else if (this.committed && index !== this.index) {
      this.history.push(this.index);
      if (this.history.length > 256) this.history.shift();
    }
    this.index = index; this.committed = true; this.cancel(); return index;
  }
  next(pool?: readonly number[]): number | null {
    const base = this.requested ?? this.index;
    this.previousCursor = null;
    if (pool) {
      const choices = pool.filter(index => index !== base);
      if (!choices.length) return this.requested = null;
      if (this.shuffle) return this.requested = choices[Math.floor(this.random() * choices.length)]!;
      return this.requested = choices.find(index => index > base) ?? choices[0]!;
    }
    return this.requested = this.shuffle && this.count > 1
      ? (base + 1 + Math.floor(this.random() * (this.count - 1))) % this.count
      : (base + 1) % this.count;
  }
  previous(): number {
    const cursor = Math.max(0, (this.previousCursor ?? this.history.length) - 1);
    this.previousCursor = this.history.length ? cursor : null;
    return this.requested = this.history[cursor] ?? this.index;
  }
}
