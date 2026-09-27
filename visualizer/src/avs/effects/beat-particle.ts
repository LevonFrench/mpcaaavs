import { AvsEffectRegistry, type AvsEffectContext } from '../executor.ts';
import { blendPixel } from '../framebuffer.ts';
import { blendLine, blendLineRun } from './core.ts';

export interface AvsMovingParticleConfig {
  /** Bit 0 enables drawing; bit 1 uses beatSize on an input beat. */
  readonly enabled: number;
  readonly color: number;
  readonly maximumDistance: number;
  readonly size: number;
  readonly beatSize: number;
  /** 0 replace, 1 additive, 2 average, 3 global line blend. */
  readonly blend: number;
}

export interface AvsCustomBpmConfig {
  readonly enabled: boolean;
  readonly arbitrary: boolean;
  readonly skip: boolean;
  readonly invert: boolean;
  /** Milliseconds between arbitrary beats. */
  readonly arbitraryMilliseconds: number;
  /** Native AVS emits one beat after skipping this many input beats. */
  readonly skipCount: number;
  readonly skipFirst: number;
}

export interface AvsStarfieldConfig {
  readonly enabled: boolean;
  readonly color: number;
  readonly additive: boolean;
  readonly average: boolean;
  readonly speed: number;
  readonly maximumStars: number;
  readonly onBeat: boolean;
  readonly beatSpeed: number;
  readonly beatDurationFrames: number;
}

export interface AvsBeatParticleOptions {
  /** GetTickCount-compatible milliseconds. Values are truncated to uint32. */
  readonly now?: () => number;
  /** rand()-compatible non-negative integer source used twice per particle beat. */
  readonly random?: () => number;
}

interface MovingParticleState {
  readonly center: [number, number];
  readonly velocity: [number, number];
  readonly position: [number, number];
  size: number;
  randomState: number;
}

interface CustomBpmState {
  lastTick: number;
  skipped: number;
  inputBeats: number;
}

interface Star {
  x: number;
  y: number;
  z: number;
  speed: number;
}

interface StarfieldState {
  width: number;
  height: number;
  stars: Star[];
  currentSpeed: number;
  beatIncrement: number;
  beatFrames: number;
  randomState: number;
}

/** Decode r_parts.cpp's six fixed little-endian integers. */
export function decodeAvsMovingParticle(payload: Uint8Array): AvsMovingParticleConfig {
  return {
    enabled: i32(payload, 0, 1),
    color: i32(payload, 4, 0x00ffffff) & 0x00ffffff,
    maximumDistance: i32(payload, 8, 16),
    size: i32(payload, 12, 8),
    beatSize: i32(payload, 16, 8),
    blend: i32(payload, 20, 1),
  };
}

/** Decode r_bpm.cpp's seven fixed little-endian integers. */
export function decodeAvsCustomBpm(payload: Uint8Array): AvsCustomBpmConfig {
  return {
    enabled: i32(payload, 0, 1) !== 0,
    arbitrary: i32(payload, 4, 1) !== 0,
    skip: i32(payload, 8, 0) !== 0,
    invert: i32(payload, 12, 0) !== 0,
    arbitraryMilliseconds: i32(payload, 16, 500),
    skipCount: i32(payload, 20, 1),
    skipFirst: i32(payload, 24, 0),
  };
}

/** Decode r_stars.cpp's nine-word payload, including two IEEE-754 floats. */
export function decodeAvsStarfield(payload: Uint8Array): AvsStarfieldConfig {
  return {
    enabled: i32(payload, 0, 1) !== 0,
    color: i32(payload, 4, 0x00ffffff) & 0x00ffffff,
    additive: i32(payload, 8, 0) !== 0,
    average: i32(payload, 12, 0) !== 0,
    speed: f32(payload, 16, 6),
    maximumStars: i32(payload, 20, 350),
    onBeat: i32(payload, 24, 0) !== 0,
    beatSpeed: f32(payload, 28, 4),
    beatDurationFrames: i32(payload, 32, 15),
  };
}

/** Register Moving Particle (8), Starfield (27), and Custom BPM (33). */
export function registerAvsBeatParticleEffects(
  registry: AvsEffectRegistry,
  options: AvsBeatParticleOptions = {},
): AvsEffectRegistry {
  registerMovingParticle(registry, options);
  registerStarfield(registry, options);
  registerCustomBpm(registry, options);
  return registry;
}

function registerStarfield(registry: AvsEffectRegistry, options: AvsBeatParticleOptions): void {
  const states = new Map<string, StarfieldState>();
  registry.registerBuiltin(27, (context) => {
    const config = decodeAvsStarfield(context.component.payload);
    if (!config.enabled) return;
    let state = states.get(context.component.path);
    if (!state) {
      state = {
        width: 0, height: 0, stars: [], currentSpeed: Math.fround(config.speed),
        beatIncrement: 0, beatFrames: 0, randomState: hashPath(context.component.path),
      };
      states.set(context.component.path, state);
    }
    // Native preinit is the high beat bit and therefore also enters this gate.
    if (config.onBeat && (context.beat || context.preinit)) {
      state.currentSpeed = Math.fround(config.beatSpeed);
      state.beatIncrement = Math.fround((config.speed - state.currentSpeed) / config.beatDurationFrames);
      state.beatFrames = config.beatDurationFrames;
    }
    if (state.width !== context.input.width || state.height !== context.input.height) {
      state.width = context.input.width; state.height = context.input.height;
      initializeStars(state, config.maximumStars, options.random);
    }
    if (context.preinit) return;

    const centerX = Math.trunc(state.width / 2);
    const centerY = Math.trunc(state.height / 2);
    for (const star of state.stars) {
      const depth = Math.trunc(star.z);
      if (depth <= 0) { recreateStar(star, state, options.random); continue; }
      const x = Math.trunc(((star.x << 7) / depth)) + centerX;
      const y = Math.trunc(((star.y << 7) / depth)) + centerY;
      if (x <= 0 || x >= state.width || y <= 0 || y >= state.height) {
        recreateStar(star, state, options.random);
        continue;
      }
      const intensity = Math.trunc((255 - depth) * star.speed);
      const gray = intensity | (intensity << 8) | (intensity << 16);
      const color = config.color === 0x00ffffff
        ? gray
        : adaptiveStarColor(gray, config.color, intensity >> 4);
      const index = x + y * state.width;
      const destination = context.input.pixels[index]!;
      context.input.pixels[index] = config.additive
        ? blendPixel(color, destination, 'additive')
        : config.average ? blendPixel(color, destination, 'average') : color;
      star.z = Math.fround(star.z - Math.fround(star.speed * state.currentSpeed));
    }
    if (state.beatFrames === 0) state.currentSpeed = Math.fround(config.speed);
    else {
      state.currentSpeed = Math.fround(Math.max(0, state.currentSpeed + state.beatIncrement));
      state.beatFrames--;
    }
  });
}

function initializeStars(state: StarfieldState, configuredCount: number, random: (() => number) | undefined): void {
  const scaled = Math.round(configuredCount * state.width * state.height / (512 * 384));
  const count = Math.max(0, Math.min(4095, scaled));
  state.stars = new Array<Star>(count);
  const centerX = Math.trunc(state.width / 2);
  const centerY = Math.trunc(state.height / 2);
  for (let i = 0; i < count; i++) {
    state.stars[i] = {
      x: randomBound(state, random, state.width) - centerX,
      y: randomBound(state, random, state.height) - centerY,
      z: Math.fround(randomBound(state, random, 255)),
      speed: Math.fround((randomBound(state, random, 9) + 1) / 10),
    };
  }
}

function recreateStar(star: Star, state: StarfieldState, random: (() => number) | undefined): void {
  star.x = randomBound(state, random, state.width) - Math.trunc(state.width / 2);
  star.y = randomBound(state, random, state.height) - Math.trunc(state.height / 2);
  star.z = 255;
}

function adaptiveStarColor(gray: number, color: number, divisor: number): number {
  return ((((gray >>> 4) & 0x000f0f0f) * (16 - divisor))
    + (((color >>> 4) & 0x000f0f0f) * divisor)) & 0x00ffffff;
}

function registerMovingParticle(registry: AvsEffectRegistry, options: AvsBeatParticleOptions): void {
  const states = new Map<string, MovingParticleState>();
  registry.registerBuiltin(8, (context) => {
    const config = decodeAvsMovingParticle(context.component.payload);
    if ((config.enabled & 1) === 0 || context.preinit) return;
    let state = states.get(context.component.path);
    if (!state) {
      state = {
        center: [0, 0], velocity: [-0.01551, 0], position: [-0.6, 0.3],
        size: config.size, randomState: hashPath(context.component.path),
      };
      states.set(context.component.path, state);
    }

    if (context.beat) {
      state.center[0] = (randomModulo33(state, options.random) - 16) / 48;
      state.center[1] = (randomModulo33(state, options.random) - 16) / 48;
    }
    state.velocity[0] -= 0.004 * (state.position[0] - state.center[0]);
    state.velocity[1] -= 0.004 * (state.position[1] - state.center[1]);
    state.position[0] += state.velocity[0];
    state.position[1] += state.velocity[1];
    state.velocity[0] *= 0.991;
    state.velocity[1] *= 0.991;

    const scale = Math.min(Math.trunc(context.input.height / 2), Math.trunc(context.input.width * 3 / 8));
    const x = Math.trunc(state.position[0] * scale * (config.maximumDistance / 32))
      + Math.trunc(context.input.width / 2);
    const y = Math.trunc(state.position[1] * scale * (config.maximumDistance / 32))
      + Math.trunc(context.input.height / 2);
    if (context.beat && (config.enabled & 2) !== 0) state.size = config.beatSize;
    const drawSize = state.size;
    state.size = Math.trunc((state.size + config.size) / 2);
    drawParticle(context, x, y, drawSize, config.color, config.blend);
  });
}

function drawParticle(
  context: AvsEffectContext,
  centerX: number,
  centerY: number,
  rawSize: number,
  color: number,
  blend: number,
): void {
  if (rawSize <= 1) {
    plotParticlePixel(context, centerX, centerY, color, blend);
    return;
  }
  const size = Math.min(rawSize, 128);
  const radiusSquared = size * size * 0.25;
  const top = centerY - Math.trunc(size / 2);
  for (let row = 0; row < size; row++) {
    const y = top + row;
    if (y < 0 || y >= context.input.height) continue;
    const relativeY = row - size * 0.5;
    const halfWidth = Math.max(1, Math.trunc(Math.sqrt(Math.max(0, radiusSquared - relativeY * relativeY)) + 0.99));
    const start = Math.max(0, centerX - halfWidth);
    const end = Math.min(context.input.width, centerX + halfWidth);
    if (blend === 3) {
      // Global line blend: one clipped row run through the shared span helper.
      if (start < end) {
        const row = y * context.input.width;
        blendLineRun(context.input.pixels, row + start, row + end, 1, color, context.line.blendMode, context.line.adjustableAlpha);
      }
      continue;
    }
    for (let x = start; x < end; x++) plotParticlePixel(context, x, y, color, blend);
  }
}

function plotParticlePixel(context: AvsEffectContext, x: number, y: number, color: number, blend: number): void {
  if (x < 0 || y < 0 || x >= context.input.width || y >= context.input.height) return;
  const index = x + y * context.input.width;
  const destination = context.input.pixels[index]!;
  context.input.pixels[index] = blend === 0
    ? color
    : blend === 2
      ? blendPixel(color, destination, 'average')
      : blend === 3
        ? blendLine(color, destination, context.line.blendMode, context.line.adjustableAlpha)
        : blendPixel(color, destination, 'additive');
}

function registerCustomBpm(registry: AvsEffectRegistry, options: AvsBeatParticleOptions): void {
  const states = new Map<string, CustomBpmState>();
  const now = (): number => Math.trunc(options.now?.() ?? defaultNow()) >>> 0;
  registry.registerBuiltin(33, (context) => {
    const config = decodeAvsCustomBpm(context.component.payload);
    if (!config.enabled || context.preinit) return;
    let state = states.get(context.component.path);
    if (!state) {
      state = { lastTick: now(), skipped: 0, inputBeats: 0 };
      states.set(context.component.path, state);
    }
    if (context.beat) state.inputBeats++;
    if (config.skipFirst !== 0 && state.inputBeats <= config.skipFirst) {
      return context.beat ? { beat: false } : undefined;
    }

    if (config.arbitrary) {
      const current = now();
      const deadline = (state.lastTick + config.arbitraryMilliseconds) >>> 0;
      if (current > deadline) {
        state.lastTick = current;
        return { beat: true };
      }
      return { beat: false };
    }
    if (config.skip) {
      if (context.beat && ++state.skipped >= config.skipCount + 1) {
        state.skipped = 0;
        return { beat: true };
      }
      return { beat: false };
    }
    if (config.invert) return { beat: !context.beat };
    return;
  });
}

function randomModulo33(state: MovingParticleState, hook: (() => number) | undefined): number {
  const value = hook ? Math.trunc(hook()) >>> 0 : nextRandom(state);
  return value % 33;
}

function randomBound(state: StarfieldState, hook: (() => number) | undefined, bound: number): number {
  if (bound <= 0) return 0;
  const value = hook ? Math.trunc(hook()) >>> 0 : nextStarRandom(state);
  return value % bound;
}

function nextRandom(state: MovingParticleState): number {
  let value = state.randomState || 0x6d2b79f5;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  state.randomState = value >>> 0;
  return state.randomState;
}


function nextStarRandom(state: StarfieldState): number {
  let value = state.randomState || 0x6d2b79f5;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  state.randomState = value >>> 0;
  return state.randomState;
}

function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function i32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(offset, true)
    : fallback;
}


function f32(payload: Uint8Array, offset: number, fallback: number): number {
  return offset + 4 <= payload.length
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat32(offset, true)
    : fallback;
}

function hashPath(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}
