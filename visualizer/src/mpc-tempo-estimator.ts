/** Rolling musical-period evidence. No beat is inferred from a single transient.
 * Low-pass bass and high-pass percussion envelopes are evaluated independently;
 * one-, two- and four-beat recurrence distinguishes syncopation from song tempo.
 */
export class MpcTempoEstimator {
  private filters = [new LowPass(200), new LowPass(200), new LowPass(2000), new LowPass(2000)];
  private history: number[][] = [[], []];
  private previous = [0, 0];
  private power = [0, 0];
  private samples = 0;
  private previousTime = -1;
  private nextTime = 0;
  private evaluated = -Infinity;
  reset() {
    this.filters = [new LowPass(200), new LowPass(200), new LowPass(2000), new LowPass(2000)];
    this.power = [0, 0]; this.samples = 0; this.history = [[], []]; this.previous = [0, 0]; this.previousTime = -1; this.evaluated = -Infinity;
  }
  gap() {
    // Keep rolling musical evidence across a dropped packet. Only the filter
    // and incomplete sample bin straddle the missing PCM.
    this.filters = [new LowPass(200), new LowPass(200), new LowPass(2000), new LowPass(2000)];
    this.power = [0, 0]; this.samples = 0;
  }
  push(time: number, pcm: Float32Array): { bpm: number; confidence: number; anchor: number } | null {
    // Bound catch-up after a PCM outage even when the transport kept advancing.
    // The director retains its clock separately while fresh evidence accumulates.
    if (this.previousTime >= 0 && time - this.previousTime > .5) this.reset();
    for (let i = 0; i < 576; i++) {
      for (let ch = 0; ch < 2; ch++) {
        const value = pcm[ch * 576 + i]!;
        const bass = this.filters[ch]!.push(value), high = value - this.filters[ch + 2]!.push(value);
        this.power[0]! += bass * bass; this.power[1]! += high * high;
      }
      if (++this.samples === 441) {
        this.append(time + (i + 1) / 44100, this.power.map(v => Math.sqrt(v / 882)));
        this.power = [0, 0]; this.samples = 0;
      }
    }
    if (time - this.evaluated < .5 || this.history[0]!.length < 600) return null;
    this.evaluated = time;
    const evidence = this.history.map(values => this.correlate(values));
    const candidates: { bpm: number; score: number; band: number }[] = [];
    for (let bpm = 55; bpm <= 200; bpm += .25) {
      let score = 0, bestBand = 0;
      for (let band = 0; band < 2; band++) {
        const correlation = evidence[band]!.correlation;
        const at = (lag: number) => {
          const i = Math.floor(lag), f = lag - i;
          return (correlation[i] ?? 0) * (1 - f) + (correlation[i + 1] ?? 0) * f;
        };
        const value = .2 * at(6000 / bpm) + .3 * at(12000 / bpm) + .5 * at(24000 / bpm);
        if (value > score) { score = value; bestBand = band; }
      }
      candidates.push({bpm, score, band: bestBand});
    }
    candidates.sort((a,b) => b.score - a.score);
    let best = candidates[0]!;
    // A uniform eighth-note train is ambiguous. Keep the slower tied reading
    // in the conventional 85–170 range, without overriding a clear winner.
    const tied = candidates.filter(c => c.score >= best.score * .92 && c.bpm >= 85 && c.bpm < 170 &&
      (Math.abs(c.bpm / best.bpm - .5) < .015 || Math.abs(c.bpm / best.bpm - 2) < .03));
    if (tied.length && (best.bpm < 85 || best.bpm >= 170)) best = tied[0]!;
    const rival = candidates.find(c => Math.abs(c.bpm - best.bpm) > 4 &&
      ![.5, 2, 2/3, 1.5, .75, 4/3].some(ratio => Math.abs(c.bpm / best.bpm - ratio) < ratio * .03));
    const separation = (best.score - (rival?.score ?? 0)) / Math.max(.001,best.score);
    if (best.score < .1 || separation < .08) return null;
    const flux = evidence[best.band]!.flux;
    if (Math.max(...flux.slice(-200)) < .0001) return null;
    const period = 6000 / best.bpm;
    let bestPhase = 0, phaseScore = -1;
    for (let phase = 0; phase < period; phase++) {
      let sum = 0;
      for (let i = phase; i < flux.length; i += period) sum += flux[Math.round(i)] ?? 0;
      if (sum > phaseScore) { phaseScore = sum; bestPhase = phase; }
    }
    return {bpm:best.bpm, confidence:Math.min(1, best.score * 2 + separation * .5), anchor:this.nextTime - flux.length * .01 + bestPhase * .01};
  }
  private append(time:number, envelope:number[]) {
    if (this.previousTime < 0) { this.previousTime = time; this.nextTime = time; this.previous = envelope; return; }
    while (this.nextTime <= time) {
      const fraction = Math.max(0, Math.min(1, (this.nextTime - this.previousTime) / (time - this.previousTime)));
      for (let band = 0; band < 2; band++) {
        const value = this.previous[band]! + (envelope[band]! - this.previous[band]!) * fraction;
        this.history[band]!.push(value);
        if (this.history[band]!.length > 1200) this.history[band]!.shift();
      }
      this.nextTime += .01;
    }
    this.previousTime = time; this.previous = envelope;
  }
  private correlate(envelope: number[]) {
    const mean = envelope.reduce((a,b) => a+b,0) / envelope.length;
    const flux = envelope.map((v,i) => i ? Math.max(0,v-envelope[i-1]! - mean * .015) : 0);
    const average = flux.reduce((a,b) => a+b,0)/flux.length;
    const centered = flux.map(v=>v-average);
    const power = centered.reduce((a,b)=>a+b*b,0);
    const correlation = new Float64Array(439);
    // Reject stationary carriers and tiny numerical/filter ripple.
    if (Math.max(...flux) < Math.max(.0001,mean*.05) || power < 1e-8) return {correlation,flux};
    for(let lag=2;lag<correlation.length;lag++) {
      let sum=0;
      for(let i=lag;i<centered.length;i++) sum += centered[i]! * centered[i-lag]!;
      correlation[lag]=sum/power;
    }
    // A short, nearly exact carrier-envelope cycle is not a musical pulse.
    // Otherwise 30 Hz sine phase ripple aliases into many plausible bar lags.
    if (Math.max(...correlation.slice(2,11)) > .9) correlation.fill(0);
    return {correlation,flux};
  }
}

class LowPass {
  private z1=0; private z2=0;
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  constructor(hz:number) {
    const w=2*Math.PI*hz/44100, c=Math.cos(w), alpha=Math.sin(w)/Math.SQRT2, a0=1+alpha;
    this.b0=(1-c)/2/a0;this.b1=(1-c)/a0;this.b2=this.b0;this.a1=-2*c/a0;this.a2=(1-alpha)/a0;
  }
  push(x:number) {const y=this.b0*x+this.z1;this.z1=this.b1*x-this.a1*y+this.z2;this.z2=this.b2*x-this.a2*y;return y;}
}
