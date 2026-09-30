// Presents the sprite layer's native-resolution target on the engine's output with the pixel scaling policy of scaling.ts: integer scale
// by default (every native pixel an exact k x k block, sampled with texelFetch), sharp-bilinear for non-integer fits, and a themed border
// around the game rectangle built from the same pixel grid, so the frame reads as part of the pixel art at 1080p and at 4K.
import * as THREE from 'three';
import { FSPass } from '../gl.ts';
import type { ScaleLayout } from './scaling.ts';
import type { RGB } from './hud.ts';

export type BorderPattern = 'diamonds' | 'stripes' | 'grid' | 'dots';
export interface BorderTheme {
  /** Linear HDR colours. */
  readonly base: RGB;
  readonly accent: RGB;
  /** The one-pixel frame hugging the game rectangle, and the glow outside it. */
  readonly frame: RGB;
  readonly pattern: BorderPattern;
}
const PATTERNS: Record<BorderPattern, number> = { diamonds: 0, stripes: 1, grid: 2, dots: 3 };

const FRAG = /* glsl */ `
uniform sampler2D nativeTex;
uniform vec2 nativeSize; uniform vec2 outSize;
uniform vec4 rect;          // game rectangle on the output: x, y (top-left origin), w, h, in output px
uniform float scale; uniform int mode; uniform float cell;
uniform vec3 baseCol; uniform vec3 accentCol; uniform vec3 frameCol; uniform int pattern; uniform float beat; uniform float pulse;
void main() {
  vec2 p = vec2(gl_FragCoord.x, outSize.y - gl_FragCoord.y);
  vec2 rel = p - rect.xy;
  if (rel.x >= 0.0 && rel.y >= 0.0 && rel.x < rect.z && rel.y < rect.w) {
    vec3 c;
    if (mode == 0) {
      ivec2 q = clamp(ivec2(floor(rel / scale)), ivec2(0), ivec2(nativeSize) - 1);
      c = texelFetch(nativeTex, ivec2(q.x, int(nativeSize.y) - 1 - q.y), 0).rgb;
    } else {
      // sharp bilinear: nearest inside a texel, bilinear across a one-output-pixel seam
      vec2 px = rel / scale;
      float ps = ceil(scale);
      float range = 0.5 - 0.5 / ps;
      vec2 cd = fract(px) - 0.5;
      vec2 f = (cd - clamp(cd, -range, range)) * ps + 0.5;
      vec2 uv = (floor(px) + f) / nativeSize;
      c = texture(nativeTex, vec2(uv.x, 1.0 - uv.y)).rgb;
    }
    fragColor = vec4(c, 1.0);
    return;
  }
  // border: art on the pixel grid (cell x cell output px), nearest the game rectangle a frame line and a glow
  vec2 cp = floor(p / cell);
  float cx = cp.x, cy = cp.y;
  float sh = floor(beat * 2.0);
  float on;
  if (pattern == 0) on = mod(floor((cx + cy) / 3.0) + floor((cx - cy) / 3.0), 2.0);
  else if (pattern == 1) on = mod(floor((cx + cy + sh) / 4.0), 2.0);
  else if (pattern == 2) on = (mod(cx, 8.0) < 1.0 || mod(cy, 8.0) < 1.0) ? 1.0 : 0.0;
  else on = (mod(cx, 4.0) < 1.0 && mod(cy, 4.0) < 1.0) ? 1.0 : 0.0;
  vec2 d = max(vec2(rect.xy - p), vec2(p - (rect.xy + rect.zw)));
  float dist = max(d.x, d.y);            // px outside the rectangle (Chebyshev)
  float shade = 1.0 - smoothstep(0.0, cell * 22.0, dist) * 0.65;
  vec3 col = mix(baseCol, accentCol * (1.0 + pulse), on * 0.55) * shade;
  float fr = step(dist, cell * 1.0) ;   // the one-pixel frame line
  float fr2 = step(dist, cell * 2.0) * (1.0 - fr);
  col = mix(col, frameCol * 0.35, fr2);
  col = mix(col, frameCol, fr);
  fragColor = vec4(col, 1.0);
}`;

export class PixelPresenter {
  private readonly pass = new FSPass(FRAG, {
    nativeTex: { value: null }, nativeSize: { value: new THREE.Vector2() }, outSize: { value: new THREE.Vector2() }, rect: { value: new THREE.Vector4() },
    scale: { value: 1 }, mode: { value: 0 }, cell: { value: 1 }, baseCol: { value: new THREE.Vector3() }, accentCol: { value: new THREE.Vector3() },
    frameCol: { value: new THREE.Vector3() }, pattern: { value: 0 }, beat: { value: 0 }, pulse: { value: 0 },
  });

  present(renderer: THREE.WebGLRenderer, native: THREE.Texture, layout: ScaleLayout, theme: BorderTheme, beat: number, pulse: number, out: THREE.WebGLRenderTarget) {
    const u = this.pass.u;
    u.nativeTex!.value = native;
    (u.nativeSize!.value as THREE.Vector2).set(layout.nativeW, layout.nativeH);
    (u.outSize!.value as THREE.Vector2).set(layout.outW, layout.outH);
    (u.rect!.value as THREE.Vector4).set(layout.x, layout.y, layout.w, layout.h);
    u.scale!.value = layout.scale; u.mode!.value = layout.mode === 'integer' ? 0 : 1;
    u.cell!.value = Math.max(1, Math.round(layout.scale));
    (u.baseCol!.value as THREE.Vector3).set(...theme.base); (u.accentCol!.value as THREE.Vector3).set(...theme.accent); (u.frameCol!.value as THREE.Vector3).set(...theme.frame);
    u.pattern!.value = PATTERNS[theme.pattern]; u.beat!.value = beat; u.pulse!.value = pulse;
    this.pass.render(renderer, out);
  }
}
