import * as THREE from 'three';
import { TextureCache } from './assets';

/** Paint definition from paint-colors.json (what the Tesla app feeds its paint shader). */
export interface Paint { albedo: string; metallic: number; roughness: number }

/** Normalised material description from the asset pack's *.overrides.json (tesla-view-extractor). */
export interface MaterialDesc {
  name?: string; kind: string; source?: string; params?: Record<string, any>;
  albedo?: number[]; alpha?: number; albedo_texture?: string | null;
  metallic?: number; metallic_texture?: string | null; metallic_channel?: number; specular?: number;
  roughness?: number; roughness_texture?: string | null; roughness_channel?: number;
  ao_texture?: string | null; ao_channel?: number; ao_on_uv2?: boolean;
  normal_texture?: string | null; normal_scale?: number;
  emission?: number[]; emission_energy?: number; emission_texture?: string | null; emission_on_uv2?: boolean;
  transparent?: boolean; unshaded?: boolean; cull_mode?: number; blend_mode?: number; depth_draw_mode?: number;
  render_priority?: number;
}

/**
 * Turns Godot SpatialMaterial / ShaderMaterial descriptions into three.js materials.
 * `gamma` reproduces the app (Godot 3.2 GLES2 shades in gamma space: colours used raw, no sRGB decode/encode).
 */
export class MaterialFactory {
  private cache = new Map<string, THREE.Material>();
  constructor(public readonly textures: TextureCache, public paint: Paint, private gamma = true, private roughRoughness = 1.0, private wrapUrl = '') {}

  /** Godot colours are sRGB values; GLES2 uses them untransformed. */
  color(rgb: number[]) {
    return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], this.gamma ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace);
  }
  private paintColor() {
    const c = new THREE.Color(this.paint.albedo); c.convertLinearToSRGB();
    return this.gamma ? c : c.convertSRGBToLinear();
  }

  build(desc: MaterialDesc, key: string): THREE.Material {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const T = this.textures;
    const side = desc.cull_mode === 2 ? THREE.DoubleSide : desc.cull_mode === 1 ? THREE.BackSide : THREE.FrontSide;
    const base = (desc.source || '').split('/').pop() || '';
    const isPaintRough = /^Paint_Rough(_Fade)?\.|^Paint_Fade\./.test(base);
    let m: THREE.Material;

    if (desc.kind === 'car_paint' || isPaintRough) {
      // opaque_skybox.shader: ALBEDO=color, METALLIC/ROUGHNESS from the paint table, AO = CarPaint_AO.b on UV0;
      // Vehicle.gd gives paint_rough_material the same colour/metallic with roughness 1.0.
      const isPaint = desc.kind === 'car_paint';
      const pm = new THREE.MeshPhysicalMaterial({
        color: this.paintColor(), metalness: this.paint.metallic, roughness: isPaint ? this.paint.roughness : this.roughRoughness,
        clearcoat: isPaint && !this.gamma ? 1.0 : 0.0, clearcoatRoughness: 0.06, side,
      });
      const ao = desc.params?.ao || desc.ao_texture;
      if (ao) { pm.aoMap = T.packed(ao, 2, 0, 0); pm.aoMapIntensity = 1.0; }
      if (isPaint && this.wrapUrl) {
        pm.map = T.texture(this.wrapUrl, { color: true, channel: 1 });
        // Blend the wrap into paint rather than making the vehicle transparent.
        // Keep the underlying paint's material properties in transparent pixels.
        pm.onBeforeCompile = shader => {
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <map_fragment>', `
              vec4 wrapColor = texture2D(map, vMapUv);
              diffuseColor.rgb = mix(diffuseColor.rgb, wrapColor.rgb / 10.0, wrapColor.a);
            `)
            .replace('#include <roughnessmap_fragment>', `
              #include <roughnessmap_fragment>
              roughnessFactor = mix(roughnessFactor, 0.9, wrapColor.a);
            `)
            .replace('#include <metalnessmap_fragment>', `
              #include <metalnessmap_fragment>
              metalnessFactor = mix(metalnessFactor, 0.0, wrapColor.a);
            `);
        };
        pm.customProgramCacheKey = () => 'tesla-view-png-wrap-v1';
      }
      m = pm;
    } else if (desc.kind === 'tinted_glass') {
      // glass_skybox.shader: ALBEDO=color.rgb, ALPHA=color.a, METALLIC, ROUGHNESS, SPECULAR
      const c = desc.params!.color as number[];
      m = new THREE.MeshPhysicalMaterial({
        color: this.color(c), transparent: true, opacity: c[3], roughness: desc.params!.roughness ?? 0.2,
        metalness: desc.params!.metalic ?? 0, specularIntensity: (desc.params!.specular ?? 0.5) / 0.5, depthWrite: false, side,
      });
    } else if (desc.kind === 'chrome_badge') {
      m = new THREE.MeshPhysicalMaterial({ color: this.color([0.87, 0.87, 0.87]), metalness: 1, roughness: 0.12, side });
    } else if (desc.kind === 'beam_glow') {
      // headlights_beam_glow.shader: blend_add, unshaded, ALBEDO = albedo × tex, ALPHA = albedo.a × tex.a × fades
      const c = (desc.params!.albedo as number[]) || [1, 1, 1, 1];
      m = new THREE.MeshBasicMaterial({
        color: this.color(c), map: T.texture(desc.params!.texture_albedo, { color: true }), transparent: true, opacity: c[3],
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
    } else if (desc.kind === 'pbr') {
      const P = desc;
      if (P.unshaded) {
        m = new THREE.MeshBasicMaterial({ color: this.color(P.albedo!), side });
      } else {
        const pm = new THREE.MeshPhysicalMaterial({
          color: this.color(P.albedo!), metalness: P.metallic ?? 0, roughness: P.roughness ?? 1, side,
          specularIntensity: (P.specular ?? 0.5) / 0.5,
        });
        if (P.metallic_texture) pm.metalnessMap = T.packed(P.metallic_texture, P.metallic_channel ?? 0, 2);
        if (P.roughness_texture) pm.roughnessMap = T.packed(P.roughness_texture, P.roughness_channel ?? 0, 1);
        if (P.ao_texture) { pm.aoMap = T.packed(P.ao_texture, P.ao_channel ?? 0, 0, P.ao_on_uv2 ? 1 : 0); pm.aoMapIntensity = 1.0; }
        if (P.normal_texture) { pm.normalMap = T.texture(P.normal_texture); pm.normalScale.setScalar(P.normal_scale ?? 1); }
        if (P.emission) {
          pm.emissive = P.emission_texture ? new THREE.Color(1, 1, 1) : this.color(P.emission);
          pm.emissiveIntensity = P.emission_energy ?? 1;
          if (P.emission_texture) pm.emissiveMap = T.texture(P.emission_texture, { color: true, channel: P.emission_on_uv2 ? 1 : 0 });
        }
        m = pm;
      }
      const mm = m as THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial;
      if (P.albedo_texture) mm.map = T.texture(P.albedo_texture, { color: true });
      // Godot's flags_transparent with alpha 1 and no texture is only there so the app can fade the part: keep it opaque.
      if ((P.alpha ?? 1) < 1 || (P.transparent && P.albedo_texture)) {
        mm.transparent = true; mm.opacity = P.alpha ?? 1; mm.depthWrite = P.depth_draw_mode === 3 || P.depth_draw_mode === 1;
      }
      if (P.blend_mode === 1) { mm.blending = THREE.AdditiveBlending; mm.transparent = true; mm.depthWrite = false; }
    } else {
      m = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.5 });   // binary_unsupported / missing / unknown shader: neutral dark metal
    }
    m.name = desc.name || key;
    m.userData.renderPriority = desc.render_priority || 0;
    this.cache.set(key, m);
    return m;
  }

  /** Re-colour all paint materials (paint change at runtime). */
  setPaint(paint: Paint) {
    this.paint = paint;
    for (const m of this.cache.values()) {
      if (!(m instanceof THREE.MeshPhysicalMaterial) || !m.userData.isPaint) continue;
    }
    this.cache.clear();   // simplest: rebuild lazily on next applyOverrides
  }

  dispose() { for (const m of this.cache.values()) m.dispose(); this.cache.clear(); }
}
