export type OfflineProfileKind = 'authority' | 'review' | 'archive' | 'diagnostic' | 'delivery' | 'performance';

export interface OfflineOutputProfile {
  readonly id: string;
  readonly label: string;
  readonly kind: OfflineProfileKind;
  readonly width: number;
  readonly height: number;
  readonly fpsNumerator: number;
  readonly fpsDenominator: number;
  readonly selectorMegapixels?: number;
  readonly frameFormat: 'png-rgb24' | 'h264-yuv420p' | 'ffv1-rgb24';
  readonly canonicalMiniMaxAuthority: boolean;
}

const profiles = [
  profile('minimax-anchor-736x416-24', 'MiniMax anchor · 736×416 · 24 fps', 'authority', 736, 416, 24, 'png-rgb24', .3, true),
  profile('minimax-review-736x416-24', 'MiniMax review · 736×416 · 24 fps', 'review', 736, 416, 24, 'h264-yuv420p', .3),
  profile('archive-lossless-736x416-24', 'Lossless archive · 736×416 · 24 fps', 'archive', 736, 416, 24, 'ffv1-rgb24', .3),
  profile('minimax-selector-416x256-24', 'MiniMax 0.1 MP · 416×256', 'diagnostic', 416, 256, 24, 'png-rgb24', .1),
  profile('minimax-selector-608x352-24', 'MiniMax 0.2 MP · 608×352', 'diagnostic', 608, 352, 24, 'png-rgb24', .2),
  profile('minimax-selector-864x480-24', 'MiniMax 0.4 MP · 864×480', 'diagnostic', 864, 480, 24, 'png-rgb24', .4),
  profile('minimax-selector-960x544-24', 'MiniMax 0.5 MP · 960×544', 'diagnostic', 960, 544, 24, 'png-rgb24', .5),
  profile('minimax-selector-1056x608-24', 'MiniMax 0.6 MP · 1056×608', 'diagnostic', 1056, 608, 24, 'png-rgb24', .6),
  profile('minimax-selector-1216x672-24', 'MiniMax 0.8 MP · 1216×672', 'diagnostic', 1216, 672, 24, 'png-rgb24', .8),
  profile('minimax-selector-1376x768-24', 'MiniMax 1.0 MP · 1376×768', 'diagnostic', 1376, 768, 24, 'png-rgb24', 1),
  profile('true-16x9-compact', 'True 16:9 · 768×432 · 24 fps', 'delivery', 768, 432, 24, 'png-rgb24'),
  profile('exact2x-review', 'Exact 2× · 1472×832 · 24 fps', 'review', 1472, 832, 24, 'h264-yuv420p'),
  profile('hd-delivery', 'HD delivery · 1920×1080 · 24 fps', 'delivery', 1920, 1080, 24, 'h264-yuv420p'),
  profile('qhd-performance-60', 'QHD performance · 2560×1440 · 60 fps', 'performance', 2560, 1440, 60, 'png-rgb24'),
  profile('qhd-performance-120', 'QHD performance · 2560×1440 · 120 fps', 'performance', 2560, 1440, 120, 'png-rgb24'),
] as const satisfies readonly OfflineOutputProfile[];

export const OUTPUT_PROFILES: readonly OfflineOutputProfile[] = Object.freeze(profiles);
export const DEFAULT_OFFLINE_PROFILE_ID = 'minimax-anchor-736x416-24';

export function outputProfile(profileId: string): OfflineOutputProfile {
  const found = OUTPUT_PROFILES.find((candidate) => candidate.id === profileId);
  if (!found) throw new RangeError(`Unknown offline output profile: ${profileId}`);
  return found;
}

function profile(
  id: string,
  label: string,
  kind: OfflineProfileKind,
  width: number,
  height: number,
  fpsNumerator: number,
  frameFormat: OfflineOutputProfile['frameFormat'],
  selectorMegapixels?: number,
  canonicalMiniMaxAuthority = false,
): OfflineOutputProfile {
  return Object.freeze({
    id, label, kind, width, height, fpsNumerator, fpsDenominator: 1,
    ...(selectorMegapixels === undefined ? {} : { selectorMegapixels }),
    frameFormat,
    canonicalMiniMaxAuthority,
  });
}
