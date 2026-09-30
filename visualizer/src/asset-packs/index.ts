/** Public surface of the asset-pack module. Plates import from here. */
export * from './manifest.ts';
export { AssetPack, clipDuration, clipFrameIndex, glyphAdvance, glyphRect, paletteColorsAt, type AtlasImage, type ResolvedFrame } from './pack.ts';
export { ASSET_PACK_ROOT, assetPackUrl, isPackId, isPackPath, packPathProblem } from './paths.ts';
export { AssetPackMissingError, fetchPackSource, memoryPackSource, type AssetPackSource } from './source.ts';
export { loadAssetPack, loadAssetPackOrNull, type AtlasDecoder, type LoadOptions, type LoadResult } from './loader.ts';
export { drawGlyphs, drawNineSlice, drawSprite, drawStandIn, hashString, spriteSource, type DrawOptions, type SpriteContext, type SpriteSlot, type SpriteSource, type TextOptions } from './draw.ts';
