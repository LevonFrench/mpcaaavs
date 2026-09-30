// The sprite layer (Task 5, item 1): uploads a pack's atlases, draws sprite lists at the game's native resolution with nearest-neighbour
// sampling (texelFetch: no filtering, no mip, no bleeding), anchoring and facing decided by the caller (perform.ts pushFrame), palette swap
// through an index texture plus a palette texture, and normal / additive / screen blending for effects. No drop shadows are drawn.
//
// One instanced quad per sprite; consecutive sprites with the same atlas and blend share a draw call (painter's order is kept). The result is
// a small HDR target (`target`) in native pixels that scaling.ts/present.ts put on the output.
import * as THREE from 'three';
import type { AssetPack } from '../../asset-packs/pack.ts';
import type { BlendMode } from '../../asset-packs/manifest.ts';
import { clearRT } from '../gl.ts';
import { PALETTE_WIDTH, PaletteTable } from './palettes.ts';
import type { SpriteDraw } from './perform.ts';
import { SOLID_ATLAS } from './hud.ts';

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 iRect;   // atlas x, y, w, h
in vec4 iPlace;  // native x, y, w, h (top-left origin)
in vec4 iFlags;  // flipX, palette row (-1: none), clipY, unused
in vec4 iTint;   // linear rgb multiplier, alpha
uniform vec2 nativeSize;
out vec2 vLocal;
out float vY;
flat out vec4 vRect;
flat out vec4 vPlace;
flat out vec4 vFlags;
flat out vec4 vTint;
void main() {
  vec2 px = iPlace.xy + position.xy * iPlace.zw;
  vLocal = position.xy * iPlace.zw;
  vY = px.y;
  vRect = iRect; vPlace = iPlace; vFlags = iFlags; vTint = iTint;
  gl_Position = vec4(px.x / nativeSize.x * 2.0 - 1.0, 1.0 - px.y / nativeSize.y * 2.0, 0.0, 1.0);
}`;
const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D atlas;
uniform sampler2D palTex;
uniform bool indexed;
in vec2 vLocal;
in float vY;
flat in vec4 vRect;
flat in vec4 vPlace;
flat in vec4 vFlags;
flat in vec4 vTint;
out vec4 fragColor;
void main() {
  if (vY >= vFlags.z) discard;
  vec2 texelsPerPx = vRect.zw / vPlace.zw;
  ivec2 size = ivec2(vRect.zw);
  ivec2 q = clamp(ivec2(floor(vLocal * texelsPerPx)), ivec2(0), size - 1);
  if (vFlags.x > 0.5) q.x = size.x - 1 - q.x;
  vec4 t = texelFetch(atlas, ivec2(vRect.xy) + q, 0);
  if (indexed) {
    if (vFlags.y < 0.0) discard;
    int idx = int(t.r * 255.0 + 0.5);
    vec4 c = texelFetch(palTex, ivec2(idx, int(vFlags.y + 0.5)), 0);
    t = vec4(c.rgb, c.a * t.a);
  }
  vec4 col = vec4(t.rgb * vTint.rgb, t.a * vTint.a);
  if (col.a < 0.004) discard;
  fragColor = vec4(col.rgb * col.a, col.a);
}`;

const QUAD = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
const CAP = 4096;

interface Group { mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; mat: THREE.RawShaderMaterial; rect: Float32Array; place: Float32Array; flags: Float32Array; tint: Float32Array }

/** An atlas image the layer can upload: decoded bitmaps and raw RGBA data both work. */
export interface UploadableAtlas { readonly width: number; readonly height: number; readonly data?: Uint8Array; readonly indexed?: boolean }

export class SpriteLayer {
  readonly target: THREE.WebGLRenderTarget;
  readonly palettes: PaletteTable;
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly indexed = new Map<string, boolean>();
  private readonly palTex: THREE.DataTexture;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly pool: Group[] = [];
  /** Draw calls and sprites of the last frame (reported by the stills tool). */
  lastDrawCalls = 0;
  lastSprites = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer, readonly pack: AssetPack, readonly nativeW: number, readonly nativeH: number) {
    this.target = new THREE.WebGLRenderTarget(nativeW, nativeH, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.palettes = new PaletteTable(pack.manifest.palettes);
    this.palTex = new THREE.DataTexture(this.palettes.data, PALETTE_WIDTH, Math.max(1, this.palettes.ids.length), THREE.RGBAFormat, THREE.UnsignedByteType);
    this.palTex.colorSpace = THREE.SRGBColorSpace;
    this.palTex.minFilter = this.palTex.magFilter = THREE.NearestFilter;
    this.palTex.generateMipmaps = false; this.palTex.flipY = false; this.palTex.needsUpdate = true;
    for (const id of Object.keys(pack.manifest.atlases)) {
      const img = pack.image(id) as (UploadableAtlas & object) | null;
      if (!img) continue;
      const def = pack.manifest.atlases[id]!;
      const indexed = def.indexed === true;
      let tex: THREE.Texture;
      if (img.data) tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      else tex = new THREE.Texture(img as unknown as TexImageSource);
      this.setup(tex, !indexed);
      this.textures.set(id, tex); this.indexed.set(id, indexed);
    }
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]), 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.setup(white, false);
    this.textures.set(SOLID_ATLAS, white); this.indexed.set(SOLID_ATLAS, false);
  }

  private setup(tex: THREE.Texture, srgb: boolean) {
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false; tex.flipY = false; tex.premultiplyAlpha = false;
    tex.needsUpdate = true;
  }

  /** True when the atlas of this draw was uploaded (a metadata-only pack draws nothing). */
  has(atlas: string): boolean { return this.textures.has(atlas); }

  private group(i: number, atlas: string, blend: BlendMode): Group {
    let g = this.pool[i];
    if (!g) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(QUAD, 3));
      geo.setIndex([0, 1, 2, 2, 1, 3]);
      const mk = (n: string) => { const a = new Float32Array(CAP * 4); geo.setAttribute(n, new THREE.InstancedBufferAttribute(a, 4).setUsage(THREE.DynamicDrawUsage)); return a; };
      const rect = mk('iRect'), place = mk('iPlace'), flags = mk('iFlags'), tint = mk('iTint');
      const mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending, side: THREE.DoubleSide,
        uniforms: { atlas: { value: null }, palTex: { value: this.palTex }, indexed: { value: false }, nativeSize: { value: new THREE.Vector2(this.nativeW, this.nativeH) } },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; mesh.renderOrder = i;
      this.scene.add(mesh);
      g = { mesh, geo, mat, rect, place, flags, tint };
      this.pool[i] = g;
    }
    const m = g.mat;
    m.uniforms.atlas!.value = this.textures.get(atlas);
    m.uniforms.indexed!.value = this.indexed.get(atlas) ?? false;
    m.blendEquation = THREE.AddEquation;
    if (blend === 'add') { m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; }
    else if (blend === 'screen') { m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcColorFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; }
    else { m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; }
    return g;
  }

  /** Clears to an opaque linear colour and refreshes the cycling palettes for `beat`. */
  begin(bg: readonly [number, number, number], beat: number) {
    clearRT(this.renderer, this.target, [bg[0], bg[1], bg[2]], 1);
    if (this.palettes.update(beat)) this.palTex.needsUpdate = true;
  }

  /** Draws the list in painter's order (by z, then list order) into the target. */
  draw(list: readonly SpriteDraw[]) {
    const sorted = list.map((d, i) => [d, i] as const).sort((a, b) => a[0].z - b[0].z || a[1] - b[1]).map((e) => e[0]).filter((d) => this.textures.has(d.atlas));
    let gi = -1, n = 0, atlas = '', blend: BlendMode = 'normal', g: Group | null = null;
    const close = () => { if (g) { g.geo.instanceCount = n; for (const k of ['iRect', 'iPlace', 'iFlags', 'iTint']) (g.geo.getAttribute(k) as THREE.InstancedBufferAttribute).needsUpdate = true; g.mesh.visible = true; } };
    for (const d of sorted) {
      const b = d.blend ?? 'normal';
      if (!g || d.atlas !== atlas || b !== blend || n >= CAP) { close(); gi++; atlas = d.atlas; blend = b; g = this.group(gi, atlas, blend); n = 0; }
      const s = d.scale ?? 1, w = d.w ?? d.rect[2] * s, h = d.h ?? d.rect[3] * s, o = n * 4;
      g.rect.set(d.rect, o); g.place[o] = d.x; g.place[o + 1] = d.y; g.place[o + 2] = w; g.place[o + 3] = h;
      g.flags[o] = d.flipX ? 1 : 0; g.flags[o + 1] = d.palette ? this.palettes.rowOf(d.palette) : -1; g.flags[o + 2] = d.clipY ?? 1e9; g.flags[o + 3] = 0;
      const t = d.tint ?? [1, 1, 1];
      g.tint[o] = t[0]; g.tint[o + 1] = t[1]; g.tint[o + 2] = t[2]; g.tint[o + 3] = d.alpha ?? 1;
      n++;
    }
    close();
    for (let i = gi + 1; i < this.pool.length; i++) this.pool[i]!.mesh.visible = false;
    this.lastDrawCalls = gi + 1; this.lastSprites = sorted.length;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.target.dispose(); this.palTex.dispose();
    for (const t of this.textures.values()) t.dispose();
    for (const g of this.pool) { g.geo.dispose(); g.mat.dispose(); }
  }
}
