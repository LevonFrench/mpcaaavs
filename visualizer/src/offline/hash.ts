export async function sha256Hex(input: string | Blob | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = await toBytes(input);
  const copy = bytes.slice().buffer;
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256Json(value: unknown): Promise<string> {
  return sha256Hex(stableJson(value));
}

export function stableJson(value: unknown, space?: number): string {
  return JSON.stringify(sortJson(value), undefined, space);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = sortJson(source[key]);
    }
    return result;
  }
  return value;
}

async function toBytes(input: string | Blob | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}
