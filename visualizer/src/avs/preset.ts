import {
  AVS_PRESET_HEADER_V1,
  AVS_PRESET_HEADER_V2,
  type AvsComponent,
  type AvsEffectListCode,
  type AvsEffectListSettings,
  type AvsPresetAst,
  type AvsPresetVersion,
} from './types.ts';

const HEADER_BYTES = 24;
const ROOT_CONFIG_BYTES = 1;
const EFFECT_LIST_ID = -2;
const DLL_RENDER_BASE = 16_384;
const TEXT = new TextDecoder('windows-1252');

// A renderer record whose fixed name identifies the AVS 2.8+ list-code block.
// Its payload precedes the real children of the containing Effect List.
const EFFECT_LIST_CODE_ID = 16_384;
const EFFECT_LIST_CODE_NAME = 'AVS 2.8+ Effect List Config';

export class AvsPresetError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} (byte ${offset})`);
    this.name = 'AvsPresetError';
  }
}

export function parseAvsPreset(input: ArrayBuffer | Uint8Array): AvsPresetAst {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES + ROOT_CONFIG_BYTES) {
    throw new AvsPresetError('AVS preset is shorter than its header', bytes.byteLength);
  }

  const header = decode(bytes.subarray(0, HEADER_BYTES));
  let version: AvsPresetVersion;
  if (header === AVS_PRESET_HEADER_V2) version = 2;
  else if (header === AVS_PRESET_HEADER_V1) version = 1;
  else throw new AvsPresetError(`Unsupported AVS preset signature ${JSON.stringify(header)}`, 0);

  const components = readComponents(bytes, HEADER_BYTES + ROOT_CONFIG_BYTES, bytes.byteLength, '');
  return {
    version,
    header,
    clearEveryFrame: bytes[HEADER_BYTES] === 1,
    components,
    byteLength: bytes.byteLength,
  };
}

/**
 * Lossless writer for parsed presets. Component payloads remain the original
 * opaque bytes, so unsupported renderers, disabled branches, and private APE
 * configuration survive a parse/write round trip byte-for-byte.
 */
export function serializeAvsPreset(preset: AvsPresetAst): Uint8Array {
  const chunks: Uint8Array[] = [];
  chunks.push(latin1(preset.header));
  chunks.push(Uint8Array.of(preset.clearEveryFrame ? 1 : 0));
  for (const component of preset.components) chunks.push(serializeComponent(component));
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function serializeComponent(component: AvsComponent): Uint8Array {
  const isApe = component.apeId !== null;
  const headerLength = isApe ? 40 : 8;
  const out = new Uint8Array(headerLength + component.payload.length);
  const view = new DataView(out.buffer);
  view.setInt32(0, component.effectId, true);
  let lengthOffset = 4;
  if (isApe) {
    const id = latin1(component.apeId!);
    out.set(id.subarray(0, 31), 4);
    lengthOffset += 32;
  }
  view.setUint32(lengthOffset, component.payload.length, true);
  out.set(component.payload, headerLength);
  return out;
}

function readComponents(
  bytes: Uint8Array,
  start: number,
  end: number,
  parent: string,
  absoluteBase = 0,
): AvsComponent[] {
  const components: AvsComponent[] = [];
  let cursor = start;
  let ordinal = 0;

  while (cursor < end) {
    // AVS itself ignores a short tail. Refuse non-zero garbage, because accepting
    // it makes a truncated payload look like a valid but visually wrong preset.
    if (end - cursor < 8) {
      for (let i = cursor; i < end; i++) {
        if (bytes[i] !== 0) throw new AvsPresetError('Truncated renderer record', absoluteBase + cursor);
      }
      break;
    }

    ordinal++;
    const path = parent ? `${parent}.${ordinal}` : `${ordinal}`;
    const effectId = i32(bytes, cursor);
    const isApe = effectId !== EFFECT_LIST_ID && (effectId >>> 0) >= DLL_RENDER_BASE;
    const headerBytes = isApe ? 40 : 8;
    requireBytes(cursor, headerBytes, end, 'renderer header', absoluteBase);

    const apeId = isApe ? nulText(bytes.subarray(cursor + 4, cursor + 36)) : null;
    const lengthOffset = cursor + 4 + (isApe ? 32 : 0);
    const payloadLength = u32(bytes, lengthOffset);
    const payloadStart = cursor + headerBytes;
    const payloadEnd = payloadStart + payloadLength;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > end) {
      throw new AvsPresetError(
        `Renderer ${path} payload (${payloadLength} bytes) exceeds its container`,
        absoluteBase + lengthOffset,
      );
    }

    const payload = bytes.slice(payloadStart, payloadEnd);
    let list: AvsEffectListSettings | null = null;
    let listCode: AvsEffectListCode | null = null;
    let children: AvsComponent[] = [];
    if (effectId === EFFECT_LIST_ID && payload.length > 0) {
      list = readListSettings(payload, payloadStart);
      let childOffset = list.byteLength;
      const codeRecord = readEffectListCode(payload, childOffset, payloadStart);
      if (codeRecord) {
        listCode = codeRecord.code;
        childOffset = codeRecord.nextOffset;
      }
      children = readComponents(payload, childOffset, payload.length, path, absoluteBase + payloadStart);
    }

    components.push({
      effectId,
      apeId,
      payload,
      fileOffset: absoluteBase + cursor,
      path,
      children,
      list,
      listCode,
    });
    cursor = payloadEnd;
  }

  return components;
}

function readListSettings(payload: Uint8Array, absoluteOffset: number): AvsEffectListSettings {
  const extended = (payload[0]! & 0x80) !== 0;
  if (!extended) {
    const mode = payload[0]!;
    return {
      mode,
      // r_list.h stores a DISABLE bit. This inversion is easy to miss because
      // most serialized modes are zero, meaning an enabled, uncleared list.
      enabled: (mode & 2) === 0,
      clearEveryFrame: (mode & 1) !== 0,
      inputBlendMode: (mode >>> 8) & 31,
      // The output selector is stored with bit zero toggled for historical
      // compatibility with the original list renderer.
      outputBlendMode: ((mode >>> 16) & 31) ^ 1,
      inputBlendValue: 128,
      outputBlendValue: 128,
      inputBuffer: 0,
      outputBuffer: 0,
      inputInvert: false,
      outputInvert: false,
      beatRender: false,
      beatRenderFrames: 1,
      byteLength: 1,
    };
  }

  requireBytes(0, 5, payload.length, 'extended Effect List header', absoluteOffset);
  const mode = u32(payload, 1);
  // The most-significant byte of the little-endian mode word is the number of
  // bytes following the 0x80 marker. AVS 2.8 normally writes 0x24 (37 total),
  // while older presets use 0x1c (29 total, seven extension fields). Both forms
  // occur in the audited Winamp 5 collection.
  const byteLength = payload[4]! + 1;
  if (byteLength < 5 || byteLength > payload.length) {
    throw new AvsPresetError(`Invalid Effect List header length ${byteLength}`, absoluteOffset + 4);
  }
  const ext = (index: number, fallback: number): number =>
    5 + index * 4 + 4 <= byteLength ? i32(payload, 5 + index * 4) : fallback;

  return {
    mode,
    enabled: (mode & 2) === 0,
    clearEveryFrame: (mode & 1) !== 0,
    inputBlendMode: (mode >>> 8) & 31,
    outputBlendMode: ((mode >>> 16) & 31) ^ 1,
    inputBlendValue: ext(0, 128),
    outputBlendValue: ext(1, 128),
    inputBuffer: ext(2, 0),
    outputBuffer: ext(3, 0),
    inputInvert: ext(4, 0) !== 0,
    outputInvert: ext(5, 0) !== 0,
    beatRender: ext(6, 0) !== 0,
    beatRenderFrames: ext(7, 1),
    byteLength,
  };
}

function readEffectListCode(
  payload: Uint8Array,
  offset: number,
  absoluteOffset: number,
): { code: AvsEffectListCode; nextOffset: number } | null {
  if (payload.length - offset < 40) return null;
  if (i32(payload, offset) !== EFFECT_LIST_CODE_ID) return null;
  const name = nulText(payload.subarray(offset + 4, offset + 36));
  if (name !== EFFECT_LIST_CODE_NAME) return null;
  const length = u32(payload, offset + 36);
  const start = offset + 40;
  const end = start + length;
  if (end > payload.length) {
    throw new AvsPresetError('Effect List code record exceeds its container', absoluteOffset + offset + 36);
  }
  const raw = payload.slice(start, end);
  const decoded = decodeListCode(raw);
  return { code: { ...decoded, raw }, nextOffset: end };
}

/** Decode the known AVS 2.8 block conservatively; raw bytes remain authoritative. */
function decodeListCode(raw: Uint8Array): Omit<AvsEffectListCode, 'raw'> {
  if (raw.length < 4) return { enabled: false, init: '', frame: '' };
  let cursor = 0;
  const enabled = i32(raw, cursor) !== 0;
  cursor += 4;
  const readString = (): string => {
    if (cursor + 4 > raw.length) return '';
    const length = u32(raw, cursor);
    cursor += 4;
    const end = Math.min(raw.length, cursor + length);
    const value = nulText(raw.subarray(cursor, end));
    cursor = end;
    return value;
  };
  return { enabled, init: readString(), frame: readString() };
}

function requireBytes(
  offset: number,
  length: number,
  end: number,
  what: string,
  base = 0,
): void {
  if (offset < 0 || length < 0 || offset + length > end) {
    throw new AvsPresetError(`Truncated ${what}`, base + offset);
  }
}

function u32(bytes: Uint8Array, offset: number): number {
  requireBytes(offset, 4, bytes.length, 'uint32');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function i32(bytes: Uint8Array, offset: number): number {
  requireBytes(offset, 4, bytes.length, 'int32');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

function decode(bytes: Uint8Array): string { return TEXT.decode(bytes); }

function latin1(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;
  return out;
}

function nulText(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  return decode(zero < 0 ? bytes : bytes.subarray(0, zero));
}
