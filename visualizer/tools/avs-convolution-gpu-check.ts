import assert from 'node:assert/strict';
import { AVS_CONVOLUTION_APE_ID, assessExactGpuConvolution, buildExactAvsConvolutionWgsl, planTerminalExactGpuConvolutions, type AvsComponent, type AvsConvolutionConfig, type AvsPresetAst } from '../src/avs/index.ts';
let assertions = 0;
const config = (first: number, overrides: Partial<AvsConvolutionConfig> = {}): AvsConvolutionConfig => { const kernel = Array(49).fill(0); if (first >= 0) kernel[first] = 1; return { enabled: true, wrap: false, absolute: false, twoPass: false, kernel, bias: 0, scale: 1, legacyFilename: '', ...overrides }; };
assert.equal(assessExactGpuConvolution(config(0)).eligible, true); assertions++;
assert.equal(assessExactGpuConvolution(config(23)).eligible, true); assertions++;
assert.equal(assessExactGpuConvolution(config(24)).eligible, false); assertions++;
assert.match(assessExactGpuConvolution(config(-1)).reason, /ordered in-place/); assertions++;
for (const candidate of [config(0), config(0, { wrap: true }), config(0, { absolute: true }), config(0, { twoPass: true }), config(0, { bias: -7, scale: -3 }), config(0, { kernel: [300, ...Array(48).fill(-2)] })]) {
  const wgsl = buildExactAvsConvolutionWgsl(candidate, 640, 360);
  assert.match(wgsl, /var<workgroup> tile: array<u32, 484>/); assertions++;
  assert.match(wgsl, /workgroupBarrier\(\)/); assertions++;
  assert.match(wgsl, /destination\[/); assertions++;
}
const fusedWgsl = buildExactAvsConvolutionWgsl(config(0), 640, 360, false, [{ kind: 'invert' }, { kind: 'fast-brightness', direction: 1 }]);
assert.match(fusedWgsl, /fused 0: Invert/); assertions++;
assert.match(fusedWgsl, /fused 1: Fast Brightness half/); assertions++;
assert.doesNotMatch(fusedWgsl, /pointwise_main/); assertions++;
const component = encode(config(0));
const preset: AvsPresetAst = { version: 2, header: 'Nullsoft AVS Preset 0.2\u001a', clearEveryFrame: true, components: [component], byteLength: 220 };
assert.equal(planTerminalExactGpuConvolutions(preset).extractedComponents, 1); assertions++;
assert.equal(planTerminalExactGpuConvolutions({ ...preset, clearEveryFrame: false }).extractedComponents, 0); assertions++;
assert.equal(planTerminalExactGpuConvolutions({ ...preset, components: [encode(config(24))] }).extractedComponents, 0); assertions++;
assert.equal(planTerminalExactGpuConvolutions({ ...preset, components: [component, component] }).configs.length, 2); assertions++;
console.log(`avs-convolution-gpu-check: PASS (${assertions} assertions)`);
function encode(value: AvsConvolutionConfig): AvsComponent { const payload = new Uint8Array(220), view = new DataView(payload.buffer); view.setInt32(0, value.enabled ? 1 : 0, true); view.setInt32(4, value.wrap ? 1 : 0, true); view.setInt32(8, value.absolute ? 1 : 0, true); view.setInt32(12, value.twoPass ? 1 : 0, true); value.kernel.forEach((coefficient, index) => view.setInt32(16 + index * 4, coefficient, true)); view.setInt32(212, value.bias, true); view.setInt32(216, value.scale, true); return { effectId: -1, apeId: AVS_CONVOLUTION_APE_ID, payload, fileOffset: 0, path: '0', children: [], list: null, listCode: null }; }
