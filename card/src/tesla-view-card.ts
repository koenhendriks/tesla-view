import { LitElement, html, css, type PropertyValues } from 'lit';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LightProbeGenerator } from 'three/examples/jsm/lights/LightProbeGenerator.js';
import { ASSETS_ROOT, INDEX_REV, assetUrl, TextureCache } from './scene/assets';
import { MaterialFactory } from './scene/materials';
import { StudioScene } from './scene/studio';
import { Vehicle } from './scene/vehicle';
import { PackLoader, resolvePaint, type EnvPreset, type PackEnvironment, type PackIndex, type PackManifest } from './pack';
import { createHotspots } from './hotspots';
import { actionFor, readBool, readCharging, resolveEntities, runAction } from './ha/channels';
import type { CardConfig, ChannelId, HomeAssistant, VehicleState } from './types';
import './editor';

const DOCS_URL = 'https://github.com/koenhendriks/tesla-view';
const DOCS_PACK_URL = DOCS_URL + '#asset-pack';

/*  Everything model-specific (node names, animations, lights, markers) and the app's lighting/camera presets come from
 *  the asset pack manifest; this file only holds behaviour. The app renders in Godot 3.2 GLES2 (gamma-space shading,
 *  no lamps, one studio panorama) – reproduced here with NoToneMapping + LinearSRGB output and raw textures.       */

/** The app frames the car for a phone in portrait; the card is wider. Scale the preset camera distance to fit. */
const CAMERA_FIT = 0.84;

const DEFAULTS: Partial<CardConfig> = { trim: 'premium', plate: 'eu', seats: 5, cable: 'auto', theme: 'auto', camera: 'parked', aspect_ratio: '16:9', hotspots: true };
const LOAD_KEYS: (keyof CardConfig)[] = ['wrap_url', 'model', 'trim', 'paint', 'wheels', 'plate', 'seats', 'cable', 'rhd', 'hotspots'];

interface Pending { value: any; since: string | undefined; until: number }

export class TeslaViewCard extends LitElement {
  static styles = css`
    :host { display: block; }
    ha-card { overflow: hidden; }
    .wrap { position: relative; width: 100%; }
    canvas { display: block; width: 100%; height: 100%; touch-action: none; }
    .msg { position: absolute; left: 12px; bottom: 10px; font: 12px var(--mdc-typography-font-family, system-ui); color: var(--secondary-text-color, #aaa); pointer-events: none; }
    .err { color: var(--error-color, #f66); }
    .nopack { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center;
             font: 14px/1.4 var(--mdc-typography-font-family, system-ui); color: var(--primary-text-color, #eee); background: var(--card-background-color, #1c1c1c); }
    .nopack b { font-size: 16px; }
    .nopack a { color: var(--primary-color, #03a9f4); }
    .nopack .sub { color: var(--secondary-text-color, #aaa); font-size: 12px; }
  `;

  static getStubConfig() { return {}; }
  static getConfigElement() { return document.createElement('tesla-view-card-editor'); }

  private _hass!: HomeAssistant;
  private config!: CardConfig;
  private entities: Partial<Record<ChannelId, string>> = {};
  private pending: Partial<Record<ChannelId, Pending>> = {};
  private state: Partial<VehicleState> = {};
  private message = '';
  private error = '';
  private noPack = false;

  // asset pack
  private packs = new PackLoader(ASSETS_ROOT);
  private index: PackIndex | null = null;
  private manifest?: PackManifest;
  private base = ASSETS_ROOT;
  private envBase = '';

  // three.js
  private renderer?: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 150);
  private controls?: OrbitControls;
  private probe?: THREE.LightProbe;
  private vehicle?: Vehicle;
  private factory?: MaterialFactory;
  private studio?: StudioScene;
  private hotspots?: ReturnType<typeof createHotspots>;
  private clock = new THREE.Clock();
  private wakeUntil = 0; private looping = false; private visible = true; private interacting = false;
  private ro?: ResizeObserver; private io?: IntersectionObserver;
  private loadToken = 0; private firstSync = true;

  // ---------- Lovelace API ----------
  setConfig(config: CardConfig) {
    if (!config) throw new Error('Invalid configuration');
    const prev = this.config;
    this.config = { ...DEFAULTS, ...config } as CardConfig;
    if (!prev || LOAD_KEYS.some(k => (prev as any)[k] !== (this.config as any)[k])) this.loadVehicle();
    else if (prev.camera !== this.config.camera) { this.firstSync = true; this.applyPreset(); }
    this.updateStudio();
    this.applyTheme();
    if (this._hass) this.resolve();
    this.requestUpdate();
  }
  set hass(hass: HomeAssistant) {
    const first = !this._hass; this._hass = hass;
    if (first || Object.keys(this.entities).length === 0) { if (this.config) this.resolve(); }
    else this.syncState();
    this.applyTheme();
  }
  get hass() { return this._hass; }
  getCardSize() { return 6; }
  getGridOptions() { return { rows: 6, columns: 12, min_rows: 4, min_columns: 6 }; }

  render() {
    const style = this.config?.height ? `height:${this.config.height}px` : `aspect-ratio:${(this.config?.aspect_ratio || '16:9').replace(':', '/')}`;
    return html`<ha-card><div class="wrap" style=${style}><canvas></canvas>
      ${this.noPack ? html`<div class="nopack"><b>No asset pack installed</b>
        <span>Tesla View needs the 3D assets from your copy of the Tesla app. Build a pack with
          <a href="https://github.com/koenhendriks/tesla-view-extractor" target="_blank" rel="noopener">tesla-view-extractor</a> and upload it under
          <a href="/config/integrations/integration/tesla_view">Settings → Devices &amp; services → Tesla View → Configure</a>.</span>
        <span class="sub"><a href=${DOCS_PACK_URL} target="_blank" rel="noopener">How it works</a></span></div>` : ''}
      <div class="msg ${this.error ? 'err' : ''}">${this.error || this.message}</div></div></ha-card>`;
  }

  // ---------- lifecycle ----------
  protected firstUpdated() {
    const canvas = this.renderRoot.querySelector('canvas') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;      // GLES2: framebuffer written as-is
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true; this.controls.enablePan = false; this.controls.minDistance = 3; this.controls.maxDistance = 20; this.controls.maxPolarAngle = Math.PI / 2 + 0.05;
    this.controls.addEventListener('start', () => { this.interacting = true; this.wake(0); });
    this.controls.addEventListener('end', () => { this.interacting = false; this.wake(1500); });
    this.controls.addEventListener('change', () => this.wake(120));
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.renderRoot.querySelector('.wrap')!);
    this.io = new IntersectionObserver(es => { this.visible = es.some(e => e.isIntersecting); if (this.visible) this.wake(200); }); this.io.observe(this);
    this.applyTheme(); this.resize();
    if (this.config && !this.vehicle) this.loadVehicle();
  }
  disconnectedCallback() { super.disconnectedCallback(); this.ro?.disconnect(); this.io?.disconnect(); this.studio?.dispose(); this.studio = undefined; }
  connectedCallback() { super.connectedCallback(); this.updateStudio(); if (this.renderer) { this.ro?.observe(this.renderRoot.querySelector('.wrap')!); this.io?.observe(this); this.wake(200); } }
  protected updated(_: PropertyValues) { this.resize(); }

  private resize() {
    const wrap = this.renderRoot.querySelector('.wrap') as HTMLElement | null; if (!wrap || !this.renderer) return;
    const w = wrap.clientWidth, h = wrap.clientHeight; if (!w || !h) return;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.placeCamera(); this.wake(100);
  }

  // ---------- environment / camera presets (from the pack) ----------
  private preset(): EnvPreset | undefined {
    const env = this.manifest?.environment; if (!env) return undefined;
    const name = this.config?.camera || 'parked';
    return env.presets[name] || env.presets[env.fallback] || Object.values(env.presets)[0];
  }
  private placeCamera() {
    if (this.config?.camera === 'free' && this.controls && this.camera.position.lengthSq() > 0.01 && !this.firstSync) return;
    const p = this.preset(); if (!p) return;
    const e = new THREE.Euler(...(p.camera.pivot_deg.map(THREE.MathUtils.degToRad) as [number, number, number]), 'YXZ');
    const target = new THREE.Vector3().fromArray(p.camera.target || [0, 0.6, 0]);
    const offset = new THREE.Vector3().fromArray(p.camera.offset).multiplyScalar(CAMERA_FIT * Math.max(1, 1.5 / this.camera.aspect));   // narrow cards: back off so the car fits
    this.camera.position.copy(offset).applyEuler(e).add(target);
    this.controls?.target.copy(target); this.controls?.update();
  }
  private applyPreset() {
    const p = this.preset(), env = this.manifest?.environment; if (!p || !env) return;
    this.camera.fov = env.fov || 40; this.camera.updateProjectionMatrix();
    this.scene.environmentIntensity = p.env_energy;
    this.scene.environmentRotation.set(...(p.sky_rot_deg.map(THREE.MathUtils.degToRad) as [number, number, number]), 'YXZ');
    if (this.probe) this.probe.intensity = p.env_energy * (p.amb_energy - 1);   // Godot: ambient = irradiance × bg_energy × ambient_energy
    this.placeCamera(); this.wake(200);
  }
  private applyTheme() {
    const t = this.config?.theme || 'auto';
    const dark = t === 'dark' ? true : t === 'light' ? false : (this._hass?.themes?.darkMode ?? true);
    const bg = this.manifest?.environment?.bg || { dark: '#161718', light: '#F7F7F7' };
    this.scene.background = new THREE.Color(dark ? bg.dark : bg.light);
    const clamp = (value: number | undefined, fallback: number, max: number) => Number.isFinite(value) ? THREE.MathUtils.clamp(value!, 0, max) : fallback;
    this.studio?.update(this.scene.background, dark, clamp(this.config?.studio_reflection, 0.25, 1), clamp(this.config?.studio_light, 1, 3));
    this.wake(50);
  }
  private updateStudio() {
    if (this.config?.scene === 'studio' && this.vehicle && this.isConnected) {
      if (!this.studio) { this.studio = new StudioScene(this.vehicle.root); this.scene.add(this.studio.root); }
    } else { this.studio?.dispose(); this.studio = undefined; }
    if (this.controls) this.controls.maxPolarAngle = this.studio ? Math.PI / 2 - 0.02 : Math.PI / 2 + 0.05;
    this.applyTheme();
  }
  private async setupEnvironment(env: PackEnvironment, base: string) {
    if (!this.renderer || !env.panorama || this.envBase === base) return;
    this.envBase = base;
    const pano = await new Promise<THREE.Texture>((res, rej) => new THREE.TextureLoader().load(assetUrl(env.panorama!, base), res, undefined, rej));
    pano.colorSpace = THREE.NoColorSpace; pano.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(pano).texture;
    const cube = new THREE.WebGLCubeRenderTarget(128).fromEquirectangularTexture(this.renderer, pano);
    const probe = await LightProbeGenerator.fromCubeRenderTarget(this.renderer, cube);
    if (this.probe) this.scene.remove(this.probe);
    this.probe = probe; this.scene.add(probe); pmrem.dispose();
    this.applyPreset();
  }

  // ---------- vehicle ----------
  private async loadVehicle() {
    if (!this.renderer) return;                                     // firstUpdated will call us
    const token = ++this.loadToken;
    this.message = 'loading…'; this.error = ''; this.requestUpdate();
    try {
      this.index = await this.packs.index(INDEX_REV);
      const pick = PackLoader.resolveModel(this.index, this.config.model);
      if (token !== this.loadToken) return;
      if (!pick) { this.noPack = true; this.message = ''; this.requestUpdate(); return; }
      this.noPack = false;
      const manifest = await this.packs.manifest(this.index!, pick.entry.pack);
      const base = this.packs.baseOf(this.index!, pick.entry.pack);
      const gamma = (manifest.environment?.renderer || 'gles2_gamma') === 'gles2_gamma';
      const { paint } = resolvePaint(manifest, this.config.paint);
      const textures = new TextureCache(gamma, base);
      const factory = new MaterialFactory(textures, paint, gamma, 1.0, this.config.wrap_url);
      const v = await Vehicle.load({
        manifest, modelId: pick.id, base, factory, performance: this.config.trim === 'performance', rhd: !!this.config.rhd,
        plate: this.config.plate, seats7: this.config.seats === 7, wheels: this.config.wheels, cable: this.config.cable,
      });
      if (token !== this.loadToken) return;                        // superseded by a newer config
      this.studio?.dispose(); this.studio = undefined;
      if (this.vehicle) { this.scene.remove(this.vehicle.root); this.vehicle.dispose(); this.factory?.dispose(); }
      this.hotspots?.dispose();
      this.manifest = manifest; this.base = base;
      this.vehicle = v; this.factory = factory; this.scene.add(v.root);
      this.updateStudio();
      this.firstSync = true; this.applyTheme(); this.applyPreset();
      if (this.config.hotspots !== false) this.buildHotspots();
      this.message = '';
      if (this._hass) this.syncState();
      this.setupEnvironment(manifest.environment, base).catch(e => console.warn('tesla-view-card: environment', e));
      this.wake(300);
    } catch (e: any) { this.error = `Tesla View: ${e?.message || e}`; console.error(e); }
    this.requestUpdate();
  }

  private buildHotspots() {
    const v = this.vehicle!, wrap = this.renderRoot.querySelector('.wrap') as HTMLElement, canvas = this.renderRoot.querySelector('canvas') as HTMLElement;
    const st = () => this.effective();
    const items = [
      { key: 'frunk', object: v.markers.frunk, label: () => st().frunk ? 'Frunk open (close manually)' : 'Open frunk', onToggle: () => { if (!st().frunk) this.command('frunk', 'frunk_open', true); }, enabled: () => !!this.entities.frunk },
      { key: 'trunk', object: v.markers.trunk, label: () => st().trunk ? 'Close trunk' : 'Open trunk', onToggle: () => this.command('trunk', st().trunk ? 'trunk_close' : 'trunk_open', !st().trunk), enabled: () => !!this.entities.trunk },
      { key: 'charge_port', object: v.markers.charge_port, label: () => st().charge_port ? 'Close charge port' : 'Open charge port', onToggle: () => this.command('charge_port', st().charge_port ? 'charge_port_close' : 'charge_port_open', !st().charge_port), enabled: () => !!this.entities.charge_port },
      { key: 'lock', object: v.markers.lock, label: () => st().lock ? 'Unlock' : 'Lock', onToggle: () => this.command('lock', st().lock ? 'unlock' : 'lock', !st().lock), enabled: () => !!this.entities.lock, alwaysVisible: true },
      { key: 'flash_lights', object: v.markers.lights, label: () => 'Flash lights', onToggle: () => this.command('flash_lights', 'flash_lights', true), enabled: () => !!this.entities.flash_lights, normal: [0, 0.3, -1] as [number, number, number] },
    ].filter(i => i.object);
    this.hotspots = createHotspots({ camera: this.camera, canvas, occluder: v.root, container: wrap, items, onHoverChange: () => this.wake(300) });
  }

  // ---------- state ----------
  private async resolve() {
    this.entities = await resolveEntities(this._hass, this.config);
    this.firstSync = true;
    this.syncState();
    const mapped = Object.keys(this.entities).length;
    this.message = mapped || this.noPack ? '' : this.config.device_id || this.config.entities ? 'no matching entities found' : 'configure device_id or entities';
    this.requestUpdate();
  }
  /** raw entity-derived state */
  private readState(): Partial<VehicleState> {
    const s: any = {}; const cfg = this.config, H = this._hass.states;
    const ent = (ch: ChannelId) => this.entities[ch] ? H[this.entities[ch]!] : undefined;
    for (const ch of ['frunk', 'trunk', 'charge_port', 'lock', 'door_fl', 'door_fr', 'door_rl', 'door_rr', 'window_fl', 'window_fr', 'window_rl', 'window_rr', 'charge_cable', 'headlights', 'drl'] as ChannelId[]) {
      const b = readBool(ent(ch), ch, cfg); if (b !== undefined) s[ch] = b;
    }
    s.charging = readCharging(ent('charging'), cfg);
    if (s.charge_cable === undefined && s.charging !== 'unknown') s.charge_cable = s.charging !== 'disconnected';
    return s;
  }
  /** entity state overlaid with optimistic pending commands */
  private effective(): Partial<VehicleState> {
    const s: any = { ...this.state }; const now = Date.now();
    for (const [ch, p] of Object.entries(this.pending) as [ChannelId, Pending][]) {
      const e = this.entities[ch] ? this._hass?.states[this.entities[ch]!] : undefined;
      if (!p || now > p.until || (e && e.last_changed !== p.since)) { delete this.pending[ch]; continue; }
      s[ch] = p.value;
    }
    return s;
  }
  private syncState() {
    if (!this._hass) return;
    this.state = this.readState();
    this.applyState(this.effective(), !this.firstSync);
    this.firstSync = false;
  }
  private applyState(s: Partial<VehicleState>, animate: boolean) {
    const v = this.vehicle; if (!v) return;
    for (const ch of ['frunk', 'trunk', 'charge_port', 'door_fl', 'door_fr', 'door_rl', 'door_rr', 'window_fl', 'window_fr', 'window_rl', 'window_rr'] as const)
      if (s[ch] !== undefined) v.setClosure(ch, !!s[ch], animate);
    v.setLights({ drl: !!s.drl, headlights: !!s.headlights });
    if (s.charge_cable !== undefined) { v.setCable(!!s.charge_cable, s.charging || 'unknown'); if (s.charge_cable) v.setClosure('charge_port', true, animate); }   // a plugged cable implies an open port
    this.wake(1500);
  }

  private async command(channel: ChannelId, actionKey: string, optimistic: any) {
    const a = actionFor(actionKey, this.config, this.entities);
    if (!a) { this.toast(`No action configured for ${actionKey}`); return; }
    const e = this.entities[channel] ? this._hass.states[this.entities[channel]!] : undefined;
    if (channel === 'flash_lights') this.vehicle?.flashLights(1, () => this.wake(200));
    else { this.pending[channel] = { value: optimistic, since: e?.last_changed, until: Date.now() + 60_000 }; this.applyState(this.effective(), true); }
    try { await runAction(this._hass, a); }
    catch (err: any) {
      delete this.pending[channel]; this.applyState(this.effective(), true);
      this.toast(`${a.action} failed: ${err?.message || err}`);
    }
  }
  private toast(message: string) {
    this.dispatchEvent(new CustomEvent('hass-notification', { detail: { message }, bubbles: true, composed: true }));
  }

  // ---------- render loop (on demand) ----------
  private wake(ms: number) {
    this.wakeUntil = Math.max(this.wakeUntil, performance.now() + ms);
    if (!this.looping) { this.looping = true; this.clock.getDelta(); requestAnimationFrame(this.frame); }
  }
  private frame = () => {
    if (!this.renderer || !this.visible) { this.looping = false; return; }
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const busy = this.vehicle?.update(dt) || false;
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
    this.hotspots?.update();
    if (busy || this.interacting || this.hotspots?.anyHovered() || performance.now() < this.wakeUntil) requestAnimationFrame(this.frame);
    else this.looping = false;
  };
}

customElements.define('tesla-view-card', TeslaViewCard);
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({ type: 'tesla-view-card', name: 'Tesla View', description: 'Interactive 3D view of your Tesla driven by Home Assistant entities', preview: false, documentationURL: DOCS_URL });
