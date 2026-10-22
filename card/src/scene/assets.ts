import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

/** Where the asset packs live. The integration registers the card as
 *  `/tesla_view/tesla-view-card.js?v=<version>&assets=/tesla_view_assets/&p=<index rev>`; the dev harness sets
 *  `window.TESLA_VIEW_ASSET_BASE` instead. Legacy fallback: `./assets/` next to the bundle. */
// (a variable, not the literal `new URL('./assets/', import.meta.url)` pattern, which Vite rewrites as an asset import)
const moduleUrl: string = import.meta.url;

function moduleParam(name: string): string | null {
  try { return new URL(moduleUrl).searchParams.get(name); } catch { return null; }
}
export const ASSETS_ROOT: string = (() => {
  const g = (globalThis as any).TESLA_VIEW_ASSET_BASE;
  if (g) return String(g);
  const q = moduleParam('assets');
  if (q) { try { return new URL(q.endsWith('/') ? q : q + '/', moduleUrl).href; } catch { /* fall through */ } }
  return moduleUrl.slice(0, moduleUrl.lastIndexOf('/') + 1) + 'assets/';
})();
/** revision of index.json the integration registered the resource with (cache busting) */
export const INDEX_REV: string = moduleParam('p') || '';

export const assetUrl = (rel: string, base: string = ASSETS_ROOT) => new URL(rel, base).href;

const jsonCache = new Map<string, Promise<any>>();
export function fetchJson<T = any>(rel: string, base: string = ASSETS_ROOT, opts: { noStore?: boolean } = {}): Promise<T> {
  const url = assetUrl(rel, base);
  if (opts.noStore) return fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`); return r.json(); });
  if (!jsonCache.has(url)) jsonCache.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`); return r.json(); }));
  return jsonCache.get(url)!;
}

const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();
export const loadGltf = (rel: string, base: string = ASSETS_ROOT) => new Promise<GLTF>((res, rej) => gltfLoader.load(assetUrl(rel, base), res, undefined, rej));
export const loadObj = (rel: string, base: string = ASSETS_ROOT) => new Promise<THREE.Group>((res, rej) => objLoader.load(assetUrl(rel, base), res, undefined, rej));

/** Godot SpatialMaterial uv1_scale / uv1_offset: UV = UV * scale + offset (same as three.js repeat/offset). */
export interface UvTransform { scale?: number[] | null; offset?: number[] | null }
const uvKey = (uv?: UvTransform) => uv ? `${uv.scale?.slice(0, 2) ?? ''}/${uv.offset?.slice(0, 2) ?? ''}` : '';
function applyUv(t: THREE.Texture, uv?: UvTransform) {
  if (uv?.scale) t.repeat.set(uv.scale[0], uv.scale[1]);
  if (uv?.offset) t.offset.set(uv.offset[0], uv.offset[1]);
}

/** Texture cache shared by all materials of a card. `gamma` = GLES2 look: no sRGB decode on colour textures. */
export class TextureCache {
  private loader = new THREE.TextureLoader();
  private cache = new Map<string, THREE.Texture>();
  constructor(private gamma: boolean, readonly base: string = ASSETS_ROOT) {}

  texture(rel: string, { color = false, channel = 0, uv }: { color?: boolean; channel?: number; uv?: UvTransform } = {}): THREE.Texture {
    const k = `${rel}|${color}|${channel}|${uvKey(uv)}`;
    let t = this.cache.get(k);
    if (t) return t;
    t = this.loader.load(assetUrl(rel, this.base));
    t.flipY = false;                                  // glTF UV convention
    t.colorSpace = color && !this.gamma ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.channel = channel;                              // 0 = TEXCOORD_0, 1 = TEXCOORD_1 (Godot "on_uv2")
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    applyUv(t, uv);
    this.cache.set(k, t);
    return t;
  }

  /** Godot packs metal/rough/AO in arbitrary channels (0=R 1=G 2=B 3=A 4=gray); three.js reads AO from R,
   *  roughness from G, metalness from B. Re-pack the requested source channel into the channel three.js expects. */
  packed(rel: string, srcChannel: number, dstChannel: number, uvChannel = 0, uv?: UvTransform): THREE.Texture {
    const k = `pack|${rel}|${srcChannel}|${dstChannel}|${uvChannel}|${uvKey(uv)}`;
    let t = this.cache.get(k);
    if (t) return t;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false; tex.colorSpace = THREE.NoColorSpace; tex.channel = uvChannel;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;     // body UVs sit outside 0..1 and rely on repeat
    applyUv(tex, uv);
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = assetUrl(rel, this.base);
    img.onload = () => {
      canvas.width = img.width; canvas.height = img.height;
      const g = canvas.getContext('2d')!; g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height); const p = d.data; const si = Math.min(srcChannel, 3);
      for (let i = 0; i < p.length; i += 4) {
        const v = srcChannel === 4 ? (p[i] + p[i + 1] + p[i + 2]) / 3 : p[i + si];
        p[i] = p[i + 1] = p[i + 2] = 255; p[i + dstChannel] = v; p[i + 3] = 255;
      }
      g.putImageData(d, 0, 0); tex.needsUpdate = true;
    };
    this.cache.set(k, tex);
    return tex;
  }

  dispose() { for (const t of this.cache.values()) t.dispose(); this.cache.clear(); }
}
