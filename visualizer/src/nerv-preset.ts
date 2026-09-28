import { NERV_SCENES, type NervSceneId } from './nerv-scenes.ts';

/** Deliberately small data-only presets: never evaluate user-provided source. */
export function parseNervPreset(bytes: ArrayBuffer): NervSceneId {
  if (bytes.byteLength > 4096) throw Error('NERV preset is too large');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || value.format !== 'mpcaaavs-nerv' || value.version !== 1
      || !NERV_SCENES.includes(value.scene)) throw Error('Invalid NERV scene preset');
  return value.scene;
}
