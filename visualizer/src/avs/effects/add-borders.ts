import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';

export const AVS_ADD_BORDERS_APE_ID = 'Virtual Effect: Addborders';

export interface AvsAddBordersConfig {
  readonly enabled: boolean;
  readonly color: number;
  readonly size: number;
}

/**
 * The installed AddBorder.ape persists exactly three little-endian integers.
 * All three corpus payloads decode as enabled/color/size, matching their
 * observed inventory labels. Rendering is the plugin's advertised operation:
 * replace the outer `size` pixels on all four sides.
 */
export function decodeAvsAddBorders(payload: Uint8Array): AvsAddBordersConfig {
  return {
    enabled: i32(payload, 0, 1) !== 0,
    color: i32(payload, 4, 0) & 0x00ffffff,
    size: Math.max(0, i32(payload, 8, 1)),
  };
}

export function registerAvsAddBorders(registry = new AvsEffectRegistry()): AvsEffectRegistry {
  registry.registerApe(AVS_ADD_BORDERS_APE_ID, (context) => render(context, decodeAvsAddBorders(context.component.payload)));
  return registry;
}

function render(context: AvsEffectContext, config: AvsAddBordersConfig): void {
  if (context.preinit || !config.enabled || config.size === 0) return;
  const { width, height } = context.input;
  const sizeX = Math.min(width, config.size);
  const sizeY = Math.min(height, config.size);
  for (let y = 0; y < height; y++) {
    const edgeY = y < sizeY || y >= height - sizeY;
    for (let x = 0; x < width; x++) {
      if (edgeY || x < sizeX || x >= width - sizeX) {
        context.input.pixels[x + y * width] = config.color;
      }
    }
  }
}

function i32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true)
    : fallback;
}
