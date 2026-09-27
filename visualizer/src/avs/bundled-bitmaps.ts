import edge19 from '../../assets/avs/avsres_texer_circle_edgeonly_19x19.bmp';
import edge29 from '../../assets/avs/avsres_texer_circle_edgeonly_29x29.bmp';
import blur19 from '../../assets/avs/avsres_texer_circle_heavyblur_19x19.bmp';
import blur21 from '../../assets/avs/avsres_texer_circle_heavyblur_21x21.bmp';
import sharp19 from '../../assets/avs/avsres_texer_circle_sharp_19x19.bmp';
import flow from '../../assets/avs/flow3.0-5.bmp';
import skupers6 from '../../assets/avs/skupers_lp6_02.bmp';
import skupers7 from '../../assets/avs/skupers_lp7_01.bmp';
import architect256 from '../../assets/avs/sv_architectimage_256.bmp';
import architectBuffer from '../../assets/avs/sv_architectimage_buffer.bmp';
import simpleFade from '../../assets/avs/sv_texer_simplefade.bmp';
import texer4 from '../../assets/avs/tug_3dpack_texer4.bmp';
import texer5 from '../../assets/avs/tug_bit2_texer5.bmp';
import texer2 from '../../assets/avs/tug_ti_texer2.bmp';
import whacko6 from '../../assets/avs/whacko6-06.bmp';
import whacko7 from '../../assets/avs/whacko6-07.bmp';
import { createAvsBitmapResolver, type AvsBitmapResolver } from './effects/bitmap-assets.ts';

const BUNDLED = {
  'avsres_texer_circle_edgeonly_19x19.bmp': edge19,
  'avsres_texer_circle_edgeonly_29x29.bmp': edge29,
  'avsres_texer_circle_heavyblur_19x19.bmp': blur19,
  'avsres_texer_circle_heavyblur_21x21.bmp': blur21,
  'avsres_texer_circle_sharp_19x19.bmp': sharp19,
  'flow3.0-5.bmp': flow,
  'skupers_lp6_02.bmp': skupers6,
  'skupers_lp7_01.bmp': skupers7,
  'sv_architectimage_256.bmp': architect256,
  'sv_architectimage_buffer.bmp': architectBuffer,
  'sv_texer_simplefade.bmp': simpleFade,
  'tug_3dpack_texer4.bmp': texer4,
  'tug_bit2_texer5.bmp': texer5,
  'tug_ti_texer2.bmp': texer2,
  'whacko6-06.bmp': whacko6,
  'whacko6-07.bmp': whacko7,
} as const;

let bundledResolver: Promise<AvsBitmapResolver> | undefined;

/** Decode the original Texer resources once, on the first native preset load. */
export function loadBundledAvsBitmapResolver(): Promise<AvsBitmapResolver> {
  bundledResolver ??= Promise.all(Object.entries(BUNDLED).map(async ([name, url]) => {
    const response = await fetch(new URL(url, import.meta.url));
    if (!response.ok) throw new Error(`Could not load AVS bitmap ${name}: HTTP ${response.status}`);
    return [name, new Uint8Array(await response.arrayBuffer())] as const;
  })).then((entries) => createAvsBitmapResolver(new Map(entries)));
  return bundledResolver;
}
