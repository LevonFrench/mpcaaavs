export interface LocalAvsPreset {
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
  readonly parserStatus: 'lossless' | 'roundtrip-mismatch' | 'parse-error' | 'unknown';
  readonly autoEligible: boolean;
  readonly unavailableReason?: string;
}

interface LocalCatalogJson {
  readonly presets?: readonly {
    readonly sha256?: unknown;
    readonly bytes?: unknown;
    readonly canonical_path?: unknown;
    readonly display_name?: unknown;
  }[];
}

interface ParserValidationJson {
  readonly results?: readonly {
    readonly sha256?: unknown;
    readonly status?: unknown;
    readonly error?: unknown;
  }[];
}

const COLLECTION_ROOT = './avs presets/';

/** Load the private/local 3,409-preset catalog without adding it to the public bundle. */
export async function fetchLocalAvsCatalog(): Promise<readonly LocalAvsPreset[]> {
  const base = typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI;
  const catalogUrl = new URL(`${COLLECTION_ROOT}catalog/presets.json`, base);
  const validationUrl = new URL(`${COLLECTION_ROOT}catalog/parser-validation.json`, base);
  const [response, validationResponse] = await Promise.all([
    fetch(catalogUrl, { cache: 'no-store' }),
    fetch(validationUrl, { cache: 'no-store' }),
  ]);
  if (!response.ok) throw new Error(`Local AVS collection unavailable (HTTP ${response.status})`);
  if (!validationResponse.ok) throw new Error(`Local AVS parser metadata unavailable (HTTP ${validationResponse.status})`);
  return parseLocalAvsCatalog(
    await response.json() as LocalCatalogJson,
    await validationResponse.json() as ParserValidationJson,
    base,
  );
}

/** Pure parser used by browser loading and the deterministic catalog check. */
export function parseLocalAvsCatalog(
  json: LocalCatalogJson,
  validation: ParserValidationJson,
  baseUrl: string,
): readonly LocalAvsPreset[] {
  if (!Array.isArray(json.presets)) throw new Error('Local AVS catalog has no preset list');
  if (!Array.isArray(validation.results)) throw new Error('Local AVS parser metadata has no result list');
  const parserByHash = new Map(validation.results.map((entry, index) => {
    if (typeof entry.sha256 !== 'string' || typeof entry.status !== 'string') {
      throw new Error(`Invalid local AVS parser metadata entry ${index}`);
    }
    return [entry.sha256, entry] as const;
  }));
  return Object.freeze(json.presets.map((entry, index) => {
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)
      || typeof entry.display_name !== 'string' || typeof entry.canonical_path !== 'string'
      || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      throw new Error(`Invalid local AVS catalog entry ${index}`);
    }
    const parser = parserByHash.get(entry.sha256);
    const parserStatus = parser?.status === 'lossless' || parser?.status === 'roundtrip-mismatch' || parser?.status === 'parse-error'
      ? parser.status
      : 'unknown';
    const unavailableReason = parserStatus === 'parse-error'
      ? typeof parser?.error === 'string' ? parser.error : 'The AVS parser rejected this historical preset'
      : undefined;
    const relative = entry.canonical_path.split('/').map(encodeURIComponent).join('/');
    return Object.freeze({
      id: `local:${entry.sha256}`,
      name: entry.display_name,
      fileName: entry.canonical_path.split('/').at(-1)!,
      sha256: entry.sha256,
      bytes: entry.bytes,
      url: new URL(`${COLLECTION_ROOT}${relative}`, baseUrl).href,
      parserStatus,
      autoEligible: parserStatus !== 'parse-error',
      ...(unavailableReason ? { unavailableReason } : {}),
    });
  }));
}

export async function fetchLocalAvsPreset(preset: LocalAvsPreset): Promise<Uint8Array> {
  const response = await fetch(preset.url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${preset.name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== preset.bytes) throw new Error(`Local AVS size mismatch for ${preset.name}`);
  return bytes;
}
