import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';

export const AVS_MULTIFILTER_APE_ID = 'Jheriko : MULTIFILTER';

export interface AvsMultiFilterConfig {
  readonly enabled: boolean;
  readonly effect: number;
  readonly toggleOnBeat: boolean;
  /** Present in the installed DLL but functionally inert for Chrome modes. */
  readonly reactiveAlpha: boolean;
}

/** Decode the installed DLL's four-int struct, including its oversized-payload rule. */
export function decodeAvsMultiFilterConfig(payload: Uint8Array): AvsMultiFilterConfig {
  const native = new Uint8Array(16);
  const view = new DataView(native.buffer);
  view.setInt32(0, 1, true);
  if (payload.length <= native.length) native.set(payload);
  return {
    enabled: view.getInt32(0, true) !== 0,
    effect: view.getInt32(4, true),
    toggleOnBeat: view.getInt32(8, true) !== 0,
    reactiveAlpha: view.getInt32(12, true) !== 0,
  };
}

/** Register the installed Jheriko MultiFilter APE's observable render behavior. */
export function registerAvsMultiFilter(
  registry = new AvsEffectRegistry(),
): AvsEffectRegistry {
  // The original DLL stores this as a process-global static, shared by instances.
  let toggleState = false;
  registry.registerApe(AVS_MULTIFILTER_APE_ID, (context) => {
    const config = decodeAvsMultiFilterConfig(context.component.payload);
    if (!config.enabled) return;
    if (config.toggleOnBeat && (context.beat || context.preinit)) toggleState = !toggleState;
    if (config.toggleOnBeat && !toggleState && !config.reactiveAlpha) return;

    if (config.effect >= 0 && config.effect <= 2) {
      // Disassembly shows the reactive path transforms a local value but never
      // writes it back. Preserve that installed-binary quirk.
      if (config.reactiveAlpha) return;
      chrome(context, config.effect + 1);
      return;
    }
    if (config.effect === 3) return infiniteRootBorder(context);
  });
  return registry;
}

function chrome(context: AvsEffectContext, repetitions: number): void {
  for (let index = 0; index < context.input.pixels.length; index++) {
    let pixel = context.input.pixels[index]!;
    for (let pass = 0; pass < repetitions; pass++) {
      let next = 0;
      for (let shift = 0; shift <= 24; shift += 8) {
        const value = (pixel >>> shift) & 255;
        const doubled = Math.min(255, value + value);
        const folded = Math.max(0, doubled - value);
        next |= Math.min(255, folded + folded) << shift;
      }
      pixel = next >>> 0;
    }
    context.input.pixels[index] = pixel;
  }
}

function infiniteRootBorder(context: AvsEffectContext): { swap: true } {
  const source = context.input.pixels;
  const target = context.output.pixels;
  const width = context.input.width;
  for (let y = 0; y < context.input.height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      target[index] = 0;
      // Installed x86 binary uses signed dword > 0, not an RGB mask.
      if ((source[index]! | 0) > 0) {
        target[index] = 0xffffffff;
        if (x > 0) target[index - 1] = 0xffffffff;
        if (y > 0) target[index - width] = 0xffffffff;
      }
    }
  }
  return { swap: true };
}
