/** Previous walks actual history, including when shuffle is enabled. */
export class PresetNavigation {
  index = 0;
  shuffle = false;
  private history: number[] = [];
  constructor(readonly count: number, private random = Math.random) {
    if (count < 1) throw new Error('Preset catalog is empty');
  }
  next(): number {
    this.history.push(this.index);
    if (this.history.length > 256) this.history.shift();
    this.index = this.shuffle && this.count > 1
      ? (this.index + 1 + Math.floor(this.random() * (this.count - 1))) % this.count
      : (this.index + 1) % this.count;
    return this.index;
  }
  previous(): number {
    this.index = this.history.pop() ?? (this.index + this.count - 1) % this.count;
    return this.index;
  }
}
