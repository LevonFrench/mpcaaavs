// WebGPU foundation: device, swapchain, offscreen targets, ping-pong pool.
//
// Deliberately thin. Per plan §4.9 the render graph *is* the product, so this
// file owns only what every pass needs and nothing about what the passes do.

/** Everything downstream needs a handle to these. */
export interface Gpu {
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  /** Swapchain format — what `present` must target. */
  swapFormat: GPUTextureFormat;
  /** Every intermediate target. Float, because feedback in 8-bit dies (§3.2). */
  hdrFormat: GPUTextureFormat;
  width: number;
  height: number;
  hasTimestamp: boolean;
}

export class GpuInitError extends Error {}

export async function initGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!navigator.gpu) {
    throw new GpuInitError(
      'WebGPU is not available. aaavs is WebGPU-only by design (plan §4.9) — ' +
      'use Chrome, Edge, Firefox or Safari 26+.',
    );
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new GpuInitError('No WebGPU adapter. A GPU driver may be blocklisted.');

  // Capability probe. `timestamp-query` is how §4.11's per-layer budget gets
  // measured; it is optional and its absence must not be fatal.
  // ?notimer=1 disables timestamp queries. Diagnostic escape hatch: a timer that
  // maps a readback buffer every frame can serialise CPU and GPU, which shows up
  // as a low frame rate with BOTH low JS time and low reported GPU time — the
  // one failure mode the timer itself cannot report.
  const noTimer = new URLSearchParams(location.search).has('notimer');
  const hasTimestamp = !noTimer && adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    requiredFeatures: hasTimestamp ? ['timestamp-query'] : [],
  });

  device.lost.then((info) => {
    // Not thrown — device loss is asynchronous and can happen at any time.
    console.error(`[gpu] device lost: ${info.reason} — ${info.message}`);
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new GpuInitError('Could not acquire a webgpu canvas context.');

  const swapFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: swapFormat, alphaMode: 'opaque' });

  return {
    device, canvas, context, swapFormat,
    hdrFormat: 'rgba16float',
    width: canvas.width,
    height: canvas.height,
    hasTimestamp,
  };
}

/** A render target we can both draw into and sample from. */
export interface Target {
  texture: GPUTexture;
  view: GPUTextureView;
}

export function createTarget(gpu: Gpu, label: string): Target {
  const texture = gpu.device.createTexture({
    label,
    size: [gpu.width, gpu.height],
    format: gpu.hdrFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT
         | GPUTextureUsage.TEXTURE_BINDING
         | GPUTextureUsage.COPY_DST,
  });
  return { texture, view: texture.createView() };
}

/**
 * Two targets that swap roles each frame. Every effect that reads what came
 * before and writes a modified copy needs this; it is the single most reused
 * primitive in the whole renderer.
 */
export class PingPong {
  private a: Target;
  private b: Target;

  constructor(gpu: Gpu, label: string) {
    this.a = createTarget(gpu, `${label}:a`);
    this.b = createTarget(gpu, `${label}:b`);
  }

  /** What a pass should read this frame. */
  get read(): Target { return this.a; }
  /** What a pass should write this frame. */
  get write(): Target { return this.b; }

  /** Call after a pass has written, so the next reader sees fresh data. */
  swap(): void { const t = this.a; this.a = this.b; this.b = t; }

  destroy(): void { this.a.texture.destroy(); this.b.texture.destroy(); }
}

/** Linear sampler with clamped edges — the default for full-screen passes. */
export function createSampler(gpu: Gpu): GPUSampler {
  return gpu.device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
}

/**
 * A full-screen pass. There is no vertex buffer anywhere in this project — the
 * vertex shader generates a covering triangle from `vertex_index`, which is
 * both faster than a quad (no diagonal seam, one fewer vertex) and removes an
 * entire category of buffer plumbing.
 */
export function createFullscreenPipeline(
  gpu: Gpu,
  label: string,
  code: string,
  format: GPUTextureFormat,
  blend?: GPUBlendState,
): GPURenderPipeline {
  const module = gpu.device.createShaderModule({ label, code });
  return gpu.device.createRenderPipeline({
    label,
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
    primitive: { topology: 'triangle-list' },
  });
}

/** Begin a render pass that clears, or loads and preserves, its target. */
export function beginPass(
  encoder: GPUCommandEncoder,
  view: GPUTextureView,
  label: string,
  load: GPULoadOp = 'clear',
): GPURenderPassEncoder {
  return encoder.beginRenderPass({
    label,
    colorAttachments: [{
      view,
      loadOp: load,
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
}

/** Resize backing store to the device pixel ratio, capped for sanity. */
export function resize(gpu: Gpu, cssW: number, cssH: number, dpr: number): boolean {
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (w === gpu.width && h === gpu.height) return false;
  gpu.canvas.width = w;
  gpu.canvas.height = h;
  gpu.width = w;
  gpu.height = h;
  return true;
}
