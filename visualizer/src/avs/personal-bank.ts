export interface PersonalAvsPreset {
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly updatedAt: number;
}

interface StoredPersonalPreset extends PersonalAvsPreset {
  readonly data: ArrayBuffer;
}

interface ExportedBank {
  readonly schema: 'aaavs_personal_avs_bank_v1';
  readonly presets: readonly {
    readonly name: string;
    readonly fileName: string;
    readonly sha256: string;
    readonly dataBase64: string;
  }[];
}

const DB_NAME = 'aaavs-personal-preset-bank';
const STORE = 'presets';

/** Persistent, origin-local AVS bank. Preset bytes remain private to this browser profile. */
export class AvsPersonalBank {
  private database: Promise<IDBDatabase> | null = null;

  async list(): Promise<readonly PersonalAvsPreset[]> {
    const records = await this.request<StoredPersonalPreset[]>('readonly', (store) => store.getAll());
    return records.map(stripData).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<{ preset: PersonalAvsPreset; bytes: Uint8Array }> {
    const record = await this.request<StoredPersonalPreset | undefined>('readonly', (store) => store.get(id));
    if (!record) throw new Error(`Personal AVS preset not found: ${id}`);
    return { preset: stripData(record), bytes: new Uint8Array(record.data.slice(0)) };
  }

  async put(name: string, bytes: Uint8Array, fileName = `${name}.avs`): Promise<PersonalAvsPreset> {
    if (bytes.byteLength === 0) throw new Error('Cannot save an empty AVS preset');
    const sha256 = await sha256Hex(bytes);
    const cleanName = name.trim() || 'Untitled AVS preset';
    const record: StoredPersonalPreset = {
      id: `personal:${sha256}`,
      name: cleanName,
      fileName: fileName.toLowerCase().endsWith('.avs') ? fileName : `${fileName}.avs`,
      sha256,
      bytes: bytes.byteLength,
      updatedAt: Date.now(),
      data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
    const sameName = (await this.list()).find((preset) => preset.name.localeCompare(cleanName, undefined, { sensitivity: 'base' }) === 0);
    if (sameName && sameName.id !== record.id) await this.remove(sameName.id);
    await this.request<IDBValidKey>('readwrite', (store) => store.put(record));
    return stripData(record);
  }

  async remove(id: string): Promise<void> {
    await this.request<undefined>('readwrite', (store) => store.delete(id));
  }

  async exportBlob(): Promise<Blob> {
    const records = await this.request<StoredPersonalPreset[]>('readonly', (store) => store.getAll());
    const bank: ExportedBank = {
      schema: 'aaavs_personal_avs_bank_v1',
      presets: records.map((record) => ({
        name: record.name, fileName: record.fileName, sha256: record.sha256,
        dataBase64: bytesToBase64(new Uint8Array(record.data)),
      })),
    };
    return new Blob([JSON.stringify(bank, null, 2)], { type: 'application/json' });
  }

  async importFile(file: File): Promise<number> {
    const value = JSON.parse(await file.text()) as Partial<ExportedBank>;
    if (value.schema !== 'aaavs_personal_avs_bank_v1' || !Array.isArray(value.presets)) {
      throw new Error('Not an AAAVS personal AVS bank');
    }
    let imported = 0;
    for (const entry of value.presets) {
      if (!entry || typeof entry.name !== 'string' || typeof entry.fileName !== 'string'
        || typeof entry.sha256 !== 'string' || typeof entry.dataBase64 !== 'string') {
        throw new Error(`Invalid personal bank entry ${imported}`);
      }
      const bytes = base64ToBytes(entry.dataBase64);
      const digest = await sha256Hex(bytes);
      if (digest !== entry.sha256) throw new Error(`Personal bank hash mismatch for ${entry.name}`);
      await this.put(entry.name, bytes, entry.fileName);
      imported++;
    }
    return imported;
  }

  private async request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await (this.database ??= openDatabase());
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('Personal bank request failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Personal bank transaction aborted'));
    });
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB is unavailable; personal banks cannot persist here'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the personal AVS bank'));
  });
}

function stripData(record: StoredPersonalPreset): PersonalAvsPreset {
  const { data: _data, ...preset } = record;
  return preset;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
