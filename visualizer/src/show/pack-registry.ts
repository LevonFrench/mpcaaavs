/** The asset pack the show worker's plates read (docs/design/ASSET-PACK-MANIFEST.md).
 *
 * Worker-side. The host sends a `show-pack` message (src/show/protocol.ts); `receiveShowPack` re-validates the whole pack through the same
 * loader the hosts use (manifest, every PNG header against its declared size, decode) and stores it here. Plates call `getShowPack()` and pass
 * the result straight to the stand-in helpers (`drawSprite(ctx, getShowPack(), slot, ...)`): null (nothing sent, absent, invalid, cleared)
 * means every slot draws its procedural stand-in, so a plate never branches on whether a pack exists. Validation failure never throws and
 * never leaves a half-used pack: the registry is then empty. */
import { loadAssetPack, memoryPackSource, parseAssetPackManifest, type AssetPack, type AtlasDecoder, type ManifestIssue } from '../asset-packs/index.ts';
import { ASSET_PACK_MANIFEST_FILE } from '../asset-packs/manifest.ts';
import type { ShowPackMessage } from './protocol.ts';

let current: AssetPack | null = null;
let revision = 0, ticket = 0;

/** The loaded pack, or null (plates then use stand-ins). */
export function getShowPack(): AssetPack | null { return current; }
/** The `generation` of the `show-pack` message the current pack came from (-1 before any). */
export function showPackRevision(): number { return revision; }
/** Clears the registry (tests, and a host that switches the pack off). */
export function clearShowPack(): void { current = null; revision = -1; ticket++; }

export type ShowPackOutcome =
  | { readonly status: 'loaded'; readonly id: string; readonly issues: readonly [] }
  | { readonly status: 'cleared'; readonly id: null; readonly issues: readonly [] }
  | { readonly status: 'absent' | 'invalid'; readonly id: string; readonly issues: readonly ManifestIssue[] };

/** Applies a (shape-validated) `show-pack` message. The last message wins even if an earlier one finishes decoding later. */
export async function receiveShowPack(message: ShowPackMessage, options: { readonly decode?: AtlasDecoder | null } = {}): Promise<ShowPackOutcome> {
  const mine = ++ticket;
  const settle = (pack: AssetPack | null) => { if (mine === ticket) { current = pack; revision = message.generation; } };
  if (message.packId === null || !message.manifest) { settle(null); return { status: 'cleared', id: null, issues: [] }; }
  const id = message.packId;
  const files: Record<string, Uint8Array> = { [ASSET_PACK_MANIFEST_FILE]: new Uint8Array(message.manifest) };
  const checked = parseAssetPackManifest(files[ASSET_PACK_MANIFEST_FILE]!);
  if (checked.manifest) for (const [atlasId, atlas] of Object.entries(checked.manifest.atlases)) {
    const bytes = Object.hasOwn(message.atlases ?? {}, atlasId) ? message.atlases![atlasId] : undefined;
    if (bytes) files[atlas.file] = new Uint8Array(bytes);
  }
  const result = await loadAssetPack(memoryPackSource(id, files), options.decode === undefined ? {} : { decode: options.decode });
  settle(result.pack);
  return result.status === 'loaded' ? { status: 'loaded', id, issues: [] } : { status: result.status, id, issues: result.issues };
}
