import * as THREE from 'three';
import { fetchJson, loadGltf, loadObj } from './assets';
import { MaterialFactory, type MaterialDesc } from './materials';
import { resolveCable, resolveWheel, type CableDef, type LightGroup, type ModelDef, type PackManifest } from '../pack';
import type { ChargingState } from '../types';

/** `*.overrides.json` written by tesla-view-extractor for a Godot scene */
export interface SceneOverrides {
  nodes: Record<string, { parent?: string | null; type?: string; visible?: boolean; matrix?: number[]; mesh?: string; materials?: Record<string, string> }>;
  materials: Record<string, MaterialDesc>;
  materials_by_name?: Record<string, string>;
}
interface AnimKey { time: number; position?: number[]; quaternion?: number[]; scale?: number[] }
interface AnimJson { name: string; length: number; tracks: { nodePath: string; keys: AnimKey[] }[] }

const meshesOf = (o: THREE.Object3D): THREE.Mesh[] => (o as THREE.Mesh).isMesh ? [o as THREE.Mesh] : o.children.filter(c => (c as THREE.Mesh).isMesh) as THREE.Mesh[];

/** Loads a Godot scene GLB and applies its overrides (transforms, visibility, per-surface materials). */
export function applyOverrides(root: THREE.Object3D, ov: SceneOverrides, byName: Record<string, THREE.Object3D>, factory: MaterialFactory) {
  root.traverse(o => { if (o.name) byName[o.name] = o; });
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  const overridden = new Set<THREE.Mesh>();
  for (const [name, n] of Object.entries(ov.nodes)) {
    const o = byName[name]; if (!o) continue;
    if (n.matrix) { new THREE.Matrix4().fromArray(n.matrix).decompose(pos, quat, scl); o.position.copy(pos); o.quaternion.copy(quat); o.scale.copy(scl); }
    if (n.visible !== undefined) o.visible = n.visible;
    if (n.materials) {
      const ms = meshesOf(o);
      for (const [slot, key] of Object.entries(n.materials)) {
        const mesh = ms[+slot]; if (!mesh) continue;
        mesh.material = factory.build(ov.materials[key], key); mesh.renderOrder = (mesh.material as any).userData.renderPriority; overridden.add(mesh);
      }
    }
  }
  if (ov.materials_by_name) root.traverse(o => {      // importer materials for surfaces the .tscn leaves alone
    const mesh = o as THREE.Mesh; if (!mesh.isMesh || overridden.has(mesh)) return;
    const key = ov.materials_by_name![(mesh.material as THREE.Material).name]; if (!key) return;
    mesh.material = factory.build(ov.materials[key], key); mesh.renderOrder = (mesh.material as any).userData.renderPriority;
  });
}

/** Nodes that exist only in the .tscn (the app's Marker hotspots, Spatials group, corner Position3Ds…) are not in the
 *  GLB: create them with their .tscn transform under the right parent so they can be used as 3D anchors. */
export function createTscnNodes(ov: SceneOverrides, glbRoot: THREE.Object3D, byName: Record<string, THREE.Object3D>) {
  const ensure = (name: string): THREE.Object3D | null => {
    if (byName[name]) return byName[name];
    const v = ov.nodes[name]; if (!v) return null;
    const parent = (!v.parent || v.parent === '.') ? glbRoot : ensure(v.parent.split('/').pop()!) || glbRoot;
    const o = new THREE.Object3D(); o.name = name;
    if (v.matrix) new THREE.Matrix4().fromArray(v.matrix).decompose(o.position, o.quaternion, o.scale);
    parent.add(o); byName[name] = o; return o;
  };
  for (const [name, v] of Object.entries(ov.nodes)) if (!byName[name] && v.matrix && /^(Spatial|Position3D)$/.test(v.type || '')) ensure(name);
}

/** Instantiates an .obj-based Godot scene (brakes, charge cable) from its overrides JSON. */
async function loadObjScene(ov: SceneOverrides, factory: MaterialFactory, base: string, materialFor?: (node: string, key: string, desc: MaterialDesc) => THREE.Material | undefined) {
  const root = new THREE.Group(); const byName: Record<string, THREE.Object3D> = {};
  const names = Object.keys(ov.nodes).sort((a, b) => (ov.nodes[a].parent || '').split('/').length - (ov.nodes[b].parent || '').split('/').length);
  for (const name of names) {
    const v = ov.nodes[name];
    const parent = (!v.parent || v.parent === '.') ? root : byName[v.parent.split('/').pop()!] || root;
    let o: THREE.Object3D;
    if (v.mesh) {
      o = await loadObj(v.mesh, base); o.name = name;
      const meshes: THREE.Mesh[] = []; o.traverse(c => { if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh); });
      for (const [slot, key] of Object.entries(v.materials || {})) {
        const desc = ov.materials[key]; const mat = materialFor?.(name, key, desc) || factory.build(desc, key);
        // several usemtl blocks → OBJLoader returns one mesh with a material array (one entry per surface)
        const multi = meshes.length === 1 && Array.isArray(meshes[0].material) ? meshes[0].material as THREE.Material[] : null;
        if (multi) { if (+slot < multi.length) multi[+slot] = mat; continue; }
        const mesh = meshes[+slot] || meshes[0]; if (!mesh) continue;
        mesh.material = mat;
      }
    } else { o = new THREE.Object3D(); o.name = name; }
    if (v.matrix) new THREE.Matrix4().fromArray(v.matrix).decompose(o.position, o.quaternion, o.scale);
    if (v.visible !== undefined) o.visible = v.visible;
    parent.add(o); byName[name] = o;
  }
  return { root, byName };
}

/** three.js port of mobile/materials/PowerflowSingle.shader: travelling pulse of emission along the cable's U. */
export class FlowMaterial extends THREE.MeshStandardMaterial {
  flow = { uFlowState: { value: 0 }, uFlowColor: { value: new THREE.Color(0.18, 0.8, 0.44) }, uTime: { value: 0 },
           uPulseLength: { value: 1.5 }, uPulseFreq: { value: 1.5 }, uSnakeFraction: { value: 1.0 }, uSnakeExponent: { value: 2.0 } };
  constructor(bc: THREE.Texture | null, roughness: THREE.Texture | null, params: Record<string, any> = {}) {
    super({ map: bc, roughnessMap: roughness, roughness: 1, metalness: 0 });
    if (typeof params.pulse_length === 'number') this.flow.uPulseLength.value = params.pulse_length;
    if (typeof params.pulse_frequency === 'number') this.flow.uPulseFreq.value = params.pulse_frequency;
    if (typeof params.snake_fraction === 'number') this.flow.uSnakeFraction.value = params.snake_fraction;
    if (typeof params.snake_exponent === 'number') this.flow.uSnakeExponent.value = params.snake_exponent;
    this.customProgramCacheKey = () => 'tesla-view-flow';
    this.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.flow);
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec2 vFlowUv;\nvoid main() {')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n vFlowUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `uniform int uFlowState; uniform vec3 uFlowColor; uniform float uTime, uPulseLength, uPulseFreq, uSnakeFraction, uSnakeExponent;
varying vec2 vFlowUv;
void main() {`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  { float t = uTime / uPulseFreq; float flow = 0.0;
    if (uFlowState == 1) flow = pow(max(1.0 - fract(t - vFlowUv.x / uPulseLength) / uSnakeFraction, 0.0), uSnakeExponent);
    if (uFlowState == 5) flow = pow(max(1.0 - fract(t + vFlowUv.x / uPulseLength) / uSnakeFraction, 0.0), uSnakeExponent);
    if (uFlowState == 1 || uFlowState == 5) { diffuseColor.rgb *= (1.0 - flow) * 0.2; totalEmissiveRadiance += uFlowColor * flow; }
    else if (uFlowState == 2) { diffuseColor.rgb *= 0.2; totalEmissiveRadiance += uFlowColor * abs(sin(3.14159265 * t)) * 0.7; }
    else if (uFlowState == 3) { diffuseColor.rgb *= 0.2; totalEmissiveRadiance += uFlowColor * 0.5; }
    else { diffuseColor.rgb *= 0.2; } }`);
    };
  }
}

interface Player { t: number; dir: number; json: AnimJson }

export interface LoadOptions {
  manifest: PackManifest; modelId: string; base: string; factory: MaterialFactory;
  performance?: boolean; rhd?: boolean; plate?: 'eu' | 'us'; seats7?: boolean; wheels?: string | null; cable?: string;
}

export class Vehicle {
  root!: THREE.Group;                 // GLTF scene
  glbRoot!: THREE.Object3D;           // GODOT_single_root node
  nodes: Record<string, THREE.Object3D> = {};
  markers: Record<string, THREE.Object3D> = {};   // hotspot anchors by marker name (frunk, trunk, charge_port, lock, lights …)
  lights: Record<string, LightGroup>;
  anims: Record<string, AnimJson> = {};
  wheelName: string | null = null;
  private players: Record<string, Player> = {};
  private lightState: Record<string, boolean> = {};
  private flash?: { until: number; timer: any };
  cable?: { group: THREE.Group; flow: FlowMaterial; state: ChargingState };
  private cablePending?: Promise<void>;
  private cableDef: CableDef | null;

  constructor(public readonly def: ModelDef, public readonly manifest: PackManifest, public readonly base: string,
              public readonly factory: MaterialFactory, opts: LoadOptions) {
    this.lights = opts.plate === 'eu' && def.lights_eu ? def.lights_eu : def.lights;
    this.cableDef = resolveCable(manifest, opts.cable, opts.plate);
  }

  static async load(opts: LoadOptions) {
    const def = opts.manifest.models[opts.modelId];
    if (!def) throw new Error(`model ${opts.modelId} is not in this asset pack`);
    if (def.kind !== 'glb' || !def.glb) throw new Error(`${def.name}: only GLB-based vehicles are supported by this card version`);
    const v = new Vehicle(def, opts.manifest, opts.base, opts.factory, opts);
    const [gltf, ov] = await Promise.all([loadGltf(def.glb, opts.base), fetchJson<SceneOverrides>(def.overrides, opts.base)]);
    v.root = gltf.scene; v.glbRoot = v.root.children[0] || v.root;
    applyOverrides(v.root, ov, v.nodes, opts.factory);
    createTscnNodes(ov, v.glbRoot, v.nodes);
    v.setVisible(def.show, true); v.setVisible(def.hide, false);
    const variant = (name: string) => { const vr = def.variants?.[name]; if (vr) { v.setVisible(vr.show, true); v.setVisible(vr.hide, false); } return !!vr; };
    if (opts.performance) variant('performance');
    if (opts.rhd) variant('rhd');
    if (!variant(opts.plate === 'us' ? 'plate_us' : 'plate_eu')) { v.setVisible(['Plate_EU'], opts.plate !== 'us'); v.setVisible(['Plate_US'], opts.plate === 'us'); }
    if (opts.seats7) variant('seats_7');
    v.buildMarkers();
    await Promise.all([v.loadWheels(opts.wheels), v.loadBrakes(!!opts.performance), v.loadAnimations()]);
    for (const group of Object.values(v.lights)) { group.on.forEach(n => v.setVisible([n], false)); (group.off || []).forEach(n => v.setVisible([n], true)); }
    return v;
  }

  setVisible(names: string[], on: boolean) { for (const n of names) if (this.nodes[n]) this.nodes[n].visible = on; }

  /** Marker nodes → anchors. The app's own tap targets (kind "marker") win over the root locators. */
  private buildMarkers() {
    const rank = (k: string) => k === 'marker' ? 0 : 1;
    for (const m of [...(this.def.markers || [])].sort((a, b) => rank(a.kind) - rank(b.kind))) {
      if (this.markers[m.name]) continue;
      let o = this.nodes[m.node];
      if (!o) {
        o = new THREE.Object3D(); o.name = m.node; o.position.fromArray(m.position);
        (m.parent && this.nodes[m.parent.split('/').pop()!]) || this.glbRoot;
        ((m.parent && this.nodes[m.parent.split('/').pop()!]) || this.glbRoot).add(o);
        this.nodes[m.node] = o;
      }
      this.markers[m.name] = o;
    }
    if (!this.markers.lights) {   // front light bar: derived from the body's bounding box (nose = −Z)
      const box = new THREE.Box3().setFromObject(this.glbRoot);
      const o = new THREE.Object3D(); o.name = 'LightsAnchor';
      o.position.set(0, box.min.y + 0.45 * (box.max.y - box.min.y), box.min.z + 0.1);
      this.glbRoot.add(o); this.nodes.LightsAnchor = o; this.markers.lights = o;
    }
  }

  private async loadWheels(want?: string | null) {
    const pick = resolveWheel(this.manifest, this.def, want);
    if (!pick) { console.warn('tesla-view-card: asset pack has no usable wheel'); return; }
    this.wheelName = pick.name;
    const w = pick.def;
    let scene: THREE.Object3D;
    if (w.kind === 'glb' && w.glb) {
      const [gltf, ov] = await Promise.all([loadGltf(w.glb, this.base), w.overrides ? fetchJson<SceneOverrides>(w.overrides, this.base).catch(() => null) : Promise.resolve(null)]);
      scene = gltf.scene;
      if (ov) {
        const byName: Record<string, THREE.Object3D> = {};
        applyOverrides(scene, ov, byName, this.factory);
        // the .tscn overrides the single mesh child by its Godot name; GDRE renames it in the GLB (e.g. GeminiDark → GeminiDark2)
        const mesh = scene.getObjectByProperty('isMesh', true) as THREE.Mesh | undefined;
        const slots = (Object.values(ov.nodes) as SceneOverrides['nodes'][string][]).find(n => n.materials)?.materials;
        if (mesh && slots) { const ms = meshesOf(mesh.parent!.children.length > 1 ? mesh.parent! : mesh); for (const [slot, key] of Object.entries(slots)) if (ms[+slot] && ov.materials[key]) ms[+slot].material = this.factory.build(ov.materials[key], key); }
      }
    } else if (w.kind === 'obj' && w.overrides) {
      scene = (await loadObjScene(await fetchJson<SceneOverrides>(w.overrides, this.base), this.factory, this.base)).root;
    } else return;
    if (w.root_matrix) new THREE.Matrix4().fromArray(w.root_matrix).decompose(scene.position, scene.quaternion, scene.scale);
    for (const n of this.def.pivots.wheels) this.nodes[n]?.add(scene.clone(true));
  }

  private async loadBrakes(performance: boolean) {
    const sets = this.def.brakes || {};
    const set = (performance && sets.performance) || sets[this.def.brakes_default || 'standard'] || Object.values(sets)[0];
    if (!set) return;
    const pivots = this.def.pivots.brakes || [];
    const [f, r] = await Promise.all([set.front ? fetchJson<SceneOverrides>(set.front, this.base) : null, set.rear ? fetchJson<SceneOverrides>(set.rear, this.base) : null]);
    for (const [i, pivot] of pivots.entries()) {
      const ov = i < 2 ? f : r; if (!ov) continue;
      const { root } = await loadObjScene(ov, this.factory, this.base);
      const p = this.nodes[pivot]; if (p) { p.add(root); p.visible = true; }
    }
  }

  private async loadAnimations() {
    const names = [...new Set(Object.values(this.def.closures || {}).flat())];
    await Promise.all(names.map(async n => {
      const path = this.def.animations?.[n]; if (!path) return;
      try { this.anims[n] = await fetchJson<AnimJson>(path, this.base); } catch (e) { console.warn(`tesla-view-card: animation ${n} failed`, e); }
    }));
  }

  // ---------- closures ----------
  /** open/close a closure; animate=false seeks to the end state immediately (initial sync) */
  setClosure(channel: string, open: boolean, animate = true) {
    for (const name of this.def.closures?.[channel] || []) {
      const json = this.anims[name]; if (!json) continue;
      const p = this.players[name] || (this.players[name] = { t: 0, dir: 0, json });
      if (animate) p.dir = open ? 1 : -1;
      else { p.t = open ? json.length : 0; p.dir = 0; this.applyAnim(json, p.t); }
    }
  }
  hasClosure(channel: string) { return (this.def.closures?.[channel] || []).some(n => this.anims[n]); }

  private applyAnim(j: AnimJson, t: number) {
    const P = new THREE.Vector3(), Q = new THREE.Quaternion(), P2 = new THREE.Vector3(), Q2 = new THREE.Quaternion();
    for (const tr of j.tracks) {
      const node = this.nodes[tr.nodePath.split('/').pop()!]; if (!node || !tr.keys.length) continue;
      const k = tr.keys; let a: AnimKey, b: AnimKey, f = 0;
      if (t <= k[0].time) a = b = k[0]; else if (t >= k[k.length - 1].time) a = b = k[k.length - 1];
      else { let i = 1; while (k[i].time < t) i++; a = k[i - 1]; b = k[i]; f = (t - a.time) / (b.time - a.time); }
      if (a.position && b.position) node.position.copy(P.fromArray(a.position).lerp(P2.fromArray(b.position), f));
      if (a.quaternion && b.quaternion) node.quaternion.copy(Q.fromArray(a.quaternion).slerp(Q2.fromArray(b.quaternion), f));
      if (a.scale && b.scale) node.scale.copy(P.fromArray(a.scale).lerp(P2.fromArray(b.scale), f));
    }
  }

  // ---------- lights ----------
  setLights(states: Record<string, boolean>) {
    Object.assign(this.lightState, states);
    this.applyLights();
  }
  private applyLights() {
    const on = new Set<string>(), offHide = new Set<string>();
    const flashing = this.flash && performance.now() < this.flash.until;
    for (const [name, g] of Object.entries(this.lights)) {
      const active = this.lightState[name] || (flashing && (name === 'headlights' || name === 'drl'));
      if (active) { g.on.forEach(n => on.add(n)); (g.off || []).forEach(n => offHide.add(n)); }
    }
    for (const g of Object.values(this.lights)) { g.on.forEach(n => this.setVisible([n], on.has(n))); (g.off || []).forEach(n => this.setVisible([n], !offHide.has(n))); }
  }
  /** VehicleManager.on_flash_headlights (timing from the pack's environment.flash) */
  flashLights(count = 1, onChange?: () => void) {
    if (this.flash) clearTimeout(this.flash.timer);
    const dur = (this.manifest.environment?.flash?.duration_s ?? 1.5) * 1000, gap = (this.manifest.environment?.flash?.interval_s ?? 1) * 1000;
    let i = 0;
    const step = () => {
      if (i++ >= count) { this.flash = undefined; this.applyLights(); onChange?.(); return; }
      this.flash = { until: performance.now() + dur, timer: setTimeout(() => { this.applyLights(); onChange?.(); this.flash!.timer = setTimeout(step, gap); }, dur) };
      this.applyLights(); onChange?.();
    };
    step();
  }

  // ---------- charge cable ----------
  /** plugged → cable in the port (Vehicle.gd::update_charge_state); state drives PowerflowSingle */
  setCable(plugged: boolean, state: ChargingState) {
    if (!plugged) { if (this.cable) this.cable.group.visible = false; return; }
    if (!this.cable) {
      if (!this.cableDef) return;
      if (!this.cablePending) this.cablePending = this.loadCable(this.cableDef);
      this.cablePending.then(() => this.setCable(true, state));
      return;
    }
    this.cable.group.visible = true;
    this.cable.state = state;
    const f = this.cable.flow.flow;
    // port LED colours: green flowing while charging, solid green when complete, amber pulse when stopped / no power
    if (state === 'charging') { f.uFlowState.value = 1; f.uFlowColor.value.setRGB(0.18, 0.8, 0.44); }
    else if (state === 'complete') { f.uFlowState.value = 3; f.uFlowColor.value.setRGB(0.18, 0.8, 0.44); }
    else if (state === 'stopped') { f.uFlowState.value = 2; f.uFlowColor.value.setRGB(1.0, 0.69, 0.0); }
    else { f.uFlowState.value = 0; }
  }
  private async loadCable(cable: CableDef) {
    const ov = await fetchJson<SceneOverrides>(cable.overrides, this.base);
    const T = this.factory.textures;
    // the flow node's PowerflowSingle ShaderMaterial carries the textures as params
    const flowNode = cable.flow_node && ov.nodes[cable.flow_node];
    const flowKey = flowNode?.materials ? Object.values(flowNode.materials)[0] : undefined;
    const desc = flowKey ? ov.materials[flowKey] : undefined;
    const bc = desc?.params?.texture_bc, mra = desc?.params?.texture_mra;
    const flow = new FlowMaterial(bc ? T.texture(bc, { color: true }) : null, mra ? T.packed(mra, 1, 1) : null, desc?.params || {});
    flow.transparent = true;
    const { root } = await loadObjScene(ov, this.factory, this.base, (node) => node === cable.flow_node ? flow : undefined);
    root.name = 'ChargeCable';
    ((this.def.pivots.charge_port && this.nodes[this.def.pivots.charge_port]) || this.glbRoot).add(root);
    this.cable = { group: root, flow, state: 'unknown' };
  }

  /** advance animations; returns true while something is still moving (caller keeps rendering) */
  update(dt: number): boolean {
    let busy = false;
    for (const p of Object.values(this.players)) {
      if (p.dir === 0) continue;
      p.t = THREE.MathUtils.clamp(p.t + dt * p.dir, 0, p.json.length); this.applyAnim(p.json, p.t);
      if ((p.dir > 0 && p.t >= p.json.length) || (p.dir < 0 && p.t <= 0)) p.dir = 0; else busy = true;
    }
    if (this.cable?.group.visible && this.cable.flow.flow.uFlowState.value !== 0) {
      const u = this.cable.flow.flow; u.uTime.value = (u.uTime.value + dt) % u.uPulseFreq.value; busy = true;
    }
    if (this.flash) busy = true;
    return busy;
  }

  dispose() { this.root?.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); }); }
}
