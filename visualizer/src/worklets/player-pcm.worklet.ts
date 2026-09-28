/** A bounded stereo tap and the only audible path from the local media element. */
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, constructor: new () => AudioWorkletProcessor): void;

class PlayerPcmProcessor extends AudioWorkletProcessor {
  private free = Array.from({length: 8}, () => new Float32Array(1152));
  private packet: Float32Array<ArrayBuffer> | undefined;
  private count = 0;
  private start = 0;
  private epoch = 0;
  private active = false;
  private dropped = false;
  constructor() {
    super();
    this.port.onmessage = ({data}) => {
      if (data?.type === 'recycle' && data.pcm instanceof ArrayBuffer && data.pcm.byteLength === 4608) {
        if (this.free.length < 8) this.free.push(new Float32Array(data.pcm));
      } else if (data?.type === 'reset' && Number.isSafeInteger(data.epoch)) {
        if (this.packet) this.free.push(this.packet);
        this.packet = undefined; this.count = 0; this.epoch = data.epoch;
        this.active = data.active === true; this.dropped = false;
      }
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0], output = outputs[0];
    const left = input?.[0], right = input?.[1] ?? left;
    if (output) for (let channel = 0; channel < output.length; channel++) {
      const target = output[channel]!;
      const source = channel === 0 ? left : right;
      if (source) for(let i=0;i<target.length;i++)target[i]=source[i]??0; else target.fill(0);
    }
    if (!this.active || !left || !right) return true;
    for (let i = 0; i < left.length; i++) {
      if (!this.packet) {
        this.packet = this.free.pop();
        if (!this.packet) { this.dropped = true; break; }
        this.start = (currentFrame + i) / sampleRate;
      }
      this.packet[this.count] = left[i]!;
      this.packet[576 + this.count] = right[i]!;
      if (++this.count === 576) {
        const pcm = this.packet.buffer;
        this.port.postMessage({type:'pcm',epoch:this.epoch,time:this.start,sampleRate,samples:576,discontinuity:this.dropped,pcm}, [pcm]);
        this.packet = undefined; this.count = 0; this.dropped = false;
      }
    }
    return true;
  }
}
registerProcessor('aaavs-player-pcm', PlayerPcmProcessor);
export {};
