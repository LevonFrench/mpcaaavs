/** Loads a pack through an AssetPackSource and validates it strictly. `loadAssetPack` never throws: a missing pack is `absent`,
 * a pack that fails any check is `invalid` (with issues), and both leave plates on their procedural stand-ins. */
import { ASSET_PACK_LIMITS, ASSET_PACK_MANIFEST_FILE, parseAssetPackManifest, type AtlasDef, type ManifestIssue } from './manifest.ts';
import { AssetPack, type AtlasImage } from './pack.ts';
import { readPngHeader } from './png.ts';
import { AssetPackMissingError, type AssetPackSource } from './source.ts';

export const ASSET_PACK_TOTAL_BYTES = 32 * 1024 * 1024;

/** Turns PNG bytes into something drawable. It must reject on undecodable data. */
export type AtlasDecoder = (bytes: Uint8Array, atlas: AtlasDef, id: string) => Promise<AtlasImage>;

export interface LoadOptions {
  /** Decoder for atlas PNGs. Defaults to `createImageBitmap` where it exists; without any decoder the pack loads as metadata only. */
  readonly decode?: AtlasDecoder | null;
}
export type LoadResult =
  | { readonly status: 'loaded'; readonly pack: AssetPack; readonly issues: readonly [] }
  | { readonly status: 'absent'; readonly pack: null; readonly issues: readonly ManifestIssue[] }
  | { readonly status: 'invalid'; readonly pack: null; readonly issues: readonly ManifestIssue[] };

export const browserAtlasDecoder: AtlasDecoder = async (bytes) => {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' });
  return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
};

const problem = (path: string, message: string): readonly ManifestIssue[] => [{ level: 'error', path, message }];

export async function loadAssetPack(source: AssetPackSource, options: LoadOptions = {}): Promise<LoadResult> {
  let manifestBytes: Uint8Array;
  try { manifestBytes = await source.read(ASSET_PACK_MANIFEST_FILE, ASSET_PACK_LIMITS.manifestBytes); }
  catch (error) {
    return { status: 'absent', pack: null, issues: problem(ASSET_PACK_MANIFEST_FILE, error instanceof AssetPackMissingError ? 'pack is not installed' : `pack manifest is unreadable: ${error instanceof Error ? error.message : 'unknown error'}`) };
  }
  const checked = parseAssetPackManifest(manifestBytes);
  const manifest = checked.manifest;
  if (!manifest) return { status: 'invalid', pack: null, issues: checked.issues };
  if (manifest.id !== source.packId) return { status: 'invalid', pack: null, issues: problem('id', `manifest id ${JSON.stringify(manifest.id)} does not match its directory ${JSON.stringify(source.packId)}`) };
  const decode = options.decode === undefined ? (typeof createImageBitmap === 'function' ? browserAtlasDecoder : null) : options.decode;
  const images = new Map<string, AtlasImage>();
  const issues: ManifestIssue[] = [];
  let total = 0;
  for (const id of Object.keys(manifest.atlases).sort()) {
    const atlas = manifest.atlases[id]!, path = `atlases.${id}.file`;
    let bytes: Uint8Array;
    try { bytes = await source.read(atlas.file, Math.min(ASSET_PACK_LIMITS.atlasBytes, ASSET_PACK_TOTAL_BYTES - total)); }
    catch (error) { issues.push({ level: 'error', path, message: error instanceof AssetPackMissingError ? 'atlas file is missing' : `atlas file is unreadable: ${error instanceof Error ? error.message : 'unknown error'}` }); continue; }
    total += bytes.byteLength;
    const header = readPngHeader(bytes, ASSET_PACK_LIMITS.atlasDimension);
    if (header.problem !== undefined) { issues.push({ level: 'error', path, message: header.problem }); continue; }
    if (header.header.width !== atlas.width || header.header.height !== atlas.height) {
      issues.push({ level: 'error', path, message: `PNG is ${header.header.width}x${header.header.height} but the manifest declares ${atlas.width}x${atlas.height}` });
      continue;
    }
    if (!decode) continue;
    try {
      const image = await decode(bytes, atlas, id);
      if (image.width !== atlas.width || image.height !== atlas.height) issues.push({ level: 'error', path, message: 'decoded image size differs from the manifest' });
      else images.set(id, image);
    } catch { issues.push({ level: 'error', path, message: 'atlas image could not be decoded' }); }
  }
  if (issues.length > 0) return { status: 'invalid', pack: null, issues };
  return { status: 'loaded', pack: new AssetPack(manifest, images), issues: [] };
}

/** The pack, or null (absent or invalid). Plates pass the result straight to the stand-in helpers. */
export async function loadAssetPackOrNull(source: AssetPackSource, options: LoadOptions = {}): Promise<AssetPack | null> {
  return (await loadAssetPack(source, options)).pack;
}
