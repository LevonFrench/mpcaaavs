import { performance } from 'node:perf_hooks';
import { compileAvsEel, AvsEelVm, type AvsEelVariableBinding } from '../src/avs/eel/index.ts';

const pointCounts = (process.env.AAAVS_EEL_POINTS ?? '1024,8192,65536')
  .split(',').map(Number);
const samples = Number(process.env.AAAVS_EEL_SAMPLES ?? 30);
const program = compileAvsEel([
  'phase=i*$pi*2+reg00;',
  'radius=.45+v*.2;',
  'x=cos(phase)*radius;',
  'y=sin(phase)*radius;',
  'red=.5+.5*sin(phase*3);',
  'green=.5+.5*cos(phase*2);',
  'blue=.5+.5*sin(phase*5);',
  'skip=below(abs(v),.002);',
  'reg00=reg00+.0000001;',
].join(''));
const vm = new AvsEelVm({ seed: 0x12345678 });
const i = vm.bindVariable('i');
const v = vm.bindVariable('v');
const x = vm.bindVariable('x');
const y = vm.bindVariable('y');
const executePoint = program.bind(vm);

for (let warm = 0; warm < 5; warm++) runPoints(8192);
const results = pointCounts.map(points => {
  const timings: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < samples; sample++) {
    const started = performance.now();
    checksum += runPoints(points);
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  const medianMs = timings[Math.trunc(timings.length / 2)]!;
  return {
    points,
    medianMs: round(medianMs),
    millionPointsPerSecond: round(points / medianMs / 1000),
    checksum: round(checksum),
  };
});
console.log(JSON.stringify({ samples, results }));

function runPoints(points: number): number {
  const denominator = Math.max(1, points - 1);
  let checksum = 0;
  for (let point = 0; point < points; point++) {
    set(i, point / denominator);
    set(v, Math.sin(point * .017) * .75);
    executePoint();
    checksum += get(x) * .3 + get(y) * .7;
  }
  return checksum;
}

function get(binding: AvsEelVariableBinding): number {
  return binding.values[binding.index] ?? 0;
}
function set(binding: AvsEelVariableBinding, value: number): void {
  binding.values[binding.index] = value;
}
function round(value: number): number { return Math.round(value * 1000) / 1000; }
