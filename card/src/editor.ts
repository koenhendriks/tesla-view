import { LitElement, css, html, nothing } from 'lit';
import { validateWrapImage } from './wrap-upload';
import { ASSETS_ROOT, INDEX_REV } from './scene/assets';
import { PackLoader, type PackIndex, type PackManifest } from './pack';
import { CHANNELS } from './ha/channels';
import type { CardConfig, ChannelId, HomeAssistant } from './types';

/** Domains offered by the entity picker of each channel (any entity can still be set in YAML). */
const CHANNEL_DOMAINS: Record<ChannelId, string[]> = {
  frunk: ['cover', 'binary_sensor', 'input_boolean', 'switch'],
  trunk: ['cover', 'binary_sensor', 'input_boolean', 'switch'],
  charge_port: ['cover', 'binary_sensor', 'input_boolean', 'switch'],
  lock: ['lock', 'binary_sensor', 'input_boolean', 'switch'],
  door_fl: ['binary_sensor', 'input_boolean', 'switch', 'sensor'], door_fr: ['binary_sensor', 'input_boolean', 'switch', 'sensor'],
  door_rl: ['binary_sensor', 'input_boolean', 'switch', 'sensor'], door_rr: ['binary_sensor', 'input_boolean', 'switch', 'sensor'],
  window_fl: ['binary_sensor', 'input_boolean', 'switch', 'sensor', 'cover'], window_fr: ['binary_sensor', 'input_boolean', 'switch', 'sensor', 'cover'],
  window_rl: ['binary_sensor', 'input_boolean', 'switch', 'sensor', 'cover'], window_rr: ['binary_sensor', 'input_boolean', 'switch', 'sensor', 'cover'],
  charge_cable: ['binary_sensor', 'input_boolean', 'switch', 'sensor'],
  charging: ['sensor', 'input_select', 'binary_sensor', 'switch', 'input_boolean'],
  headlights: ['binary_sensor', 'input_boolean', 'switch', 'light', 'sensor'],
  drl: ['binary_sensor', 'input_boolean', 'switch', 'light', 'sensor'],
  flash_lights: ['button', 'input_button', 'script', 'switch', 'light'],
};

const LABELS: Record<string, string> = {
  device_id: 'Tesla Fleet device', model: 'Model', trim: 'Trim', paint: 'Paint', wheels: 'Wheels', plate: 'Plate', seats: 'Seats', cable: 'Charge cable',
  studio_enabled: 'Enable Studio light environment', scene: 'Scene', studio_reflection: 'Floor reflection', studio_light: 'Studio lighting',
  theme: 'Theme', camera: 'Camera', aspect_ratio: 'Aspect ratio', rhd: 'Right-hand drive', hotspots: 'Show hotspots',
  frunk: 'Frunk', trunk: 'Trunk', charge_port: 'Charge port door', lock: 'Lock',
  door_fl: 'Front left door', door_fr: 'Front right door', door_rl: 'Rear left door', door_rr: 'Rear right door',
  window_fl: 'Front left window', window_fr: 'Front right window', window_rl: 'Rear left window', window_rr: 'Rear right window',
  charge_cable: 'Charge cable connected', charging: 'Charging state', headlights: 'Headlights', drl: 'Daytime running lights',
  flash_lights: 'Flash lights',
};

const HELPERS: Record<string, string> = {
  device_id: 'Optional. Maps every channel from the Tesla Fleet entity registry; entities below add to or override that mapping.',
  model: 'Vehicles from your installed asset packs.',
  frunk: 'cover (open/closed) or on/off entity; the hotspot calls cover.open_cover',
  trunk: 'cover or on/off entity; hotspot calls cover.open_cover / close_cover',
  charge_port: 'cover or on/off entity; hotspot calls cover.open_cover / close_cover',
  lock: 'lock (locked/unlocked) or on/off entity; hotspot calls lock.lock / unlock',
  charging: 'Tesla Fleet charging state sensor (charging, complete, stopped, …) or any on/off entity',
  charge_cable: 'on = cable plugged in',
  flash_lights: 'button/script pressed by the lights hotspot',
  headlights: 'no Tesla Fleet equivalent – e.g. a BLE binary sensor',
  drl: 'no Tesla Fleet equivalent',
};

/** Visual editor: device + look (from the asset pack) + one entity picker per channel. `states:` / `actions:` stay YAML. */
export class TeslaViewCardEditor extends LitElement {
  hass?: HomeAssistant;
  private config: CardConfig = { type: 'custom:tesla-view-card' };
  private index: PackIndex | null | undefined = undefined;   // undefined = loading
  private manifest?: PackManifest;
  private manifestFor = '';
  private wrapBusy = false;
  private wrapError = '';
  private wrapMessage = '';
  private wrapUpload?: AbortController;
  private packs = new PackLoader(ASSETS_ROOT);

  static properties = {
    hass: {}, config: { state: true }, index: { state: true }, manifest: { state: true },
    wrapBusy: { state: true }, wrapError: { state: true }, wrapMessage: { state: true },
  };

  static styles = css`
    .wrap { padding: 16px; border: 1px solid var(--divider-color); border-radius: 12px; margin-bottom: 20px; }
    .wrap h3 { margin: 0 0 8px; }
    .wrap-help { margin: 0 0 12px; }
    .wrap-preview { width: 120px; height: 120px; object-fit: contain; background: var(--secondary-background-color, #222); border-radius: 8px; }
    .wrap-upload { display: block; margin: 12px 0; }
    .wrap-upload input { display: block; margin-top: 8px; max-width: 100%; }
    .wrap-error { color: var(--error-color); }
  `;

  setConfig(config: CardConfig) { this.config = { ...config }; this.loadManifest(); }
  connectedCallback() {
    super.connectedCallback();
    this.packs.index(INDEX_REV).then(idx => { this.index = idx; this.loadManifest(); }).catch(() => { this.index = null; });
  }
  private updateWrap(url: string, name = '') {
    const config = { ...this.config };
    if (url) {
      config.wrap_url = url;
      config.wrap_name = name;
    } else {
      delete config.wrap_url;
      delete config.wrap_name;
    }
    this.config = config;
    this.wrapError = '';
    this.wrapMessage = url
      ? 'Wrap selected. Click Save to keep it.'
      : 'Standard paint selected. Click Save to keep it.';
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config }, bubbles: true, composed: true,
    }));
  }

  private async uploadWrap(event: Event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    if (!file || this.wrapBusy) return;

    const upload = new AbortController();
    const isCurrent = () => this.wrapUpload === upload && !upload.signal.aborted && this.isConnected;
    this.wrapUpload = upload;
    this.wrapBusy = true;
    this.wrapError = '';
    this.wrapMessage = 'Checking PNG…';
    // Allow selecting the same file again, including after validation fails.
    input.value = '';

    try {
      const hass = this.hass;
      if (!hass?.fetchWithAuth) {
        throw new Error('Image upload is unavailable. Configure wrap_url in YAML instead.');
      }
      await validateWrapImage(file);
      if (!isCurrent()) return;

      this.wrapMessage = 'Uploading PNG…';
      const data = new FormData();
      data.append('file', new File([file], file.name, { type: 'image/png' }));
      const response = await hass.fetchWithAuth('/api/image/upload', {
        method: 'POST', body: data, signal: upload.signal,
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        throw new Error(`Upload failed (${response.status}). Your current wrap is unchanged.`);
      }
      const uploaded: unknown = await response.json();
      if (!isCurrent()) return;
      if (!uploaded || typeof uploaded !== 'object' || !('id' in uploaded)
        || typeof uploaded.id !== 'string' || !uploaded.id.trim()) {
        throw new Error('Home Assistant did not return a valid image ID.');
      }
      this.updateWrap(`/api/image/serve/${encodeURIComponent(uploaded.id)}/original`, file.name);
    } catch (error) {
      if (!isCurrent()) return;
      this.wrapError = error instanceof Error ? error.message : 'Could not upload the PNG.';
      this.wrapMessage = '';
    } finally {
      // An older request must never clear the state of a newer upload.
      if (this.wrapUpload === upload) {
        this.wrapUpload = undefined;
        this.wrapBusy = false;
      }
    }
  }

  private renderWrap() {
    return html`
      <section class="wrap" aria-labelledby="wrap-title" aria-busy=${this.wrapBusy}>
        <h3 id="wrap-title">Custom PNG wrap</h3>
        <p class="wrap-help" id="wrap-help">Choose a square PNG made for your Tesla model’s wrap template.</p>
        ${this.config.wrap_url ? html`
          <img class="wrap-preview" src=${this.config.wrap_url} alt="Current wrap texture">
          <p>${this.config.wrap_name || 'Custom wrap active'}</p>
        ` : html`<p>Using standard paint</p>`}
        <label class="wrap-upload">Upload PNG
          <input aria-label="Upload PNG wrap" aria-describedby="wrap-help" type="file" accept="image/png,.png"
            ?disabled=${this.wrapBusy} @change=${this.uploadWrap}>
        </label>
        <ha-button ?disabled=${this.wrapBusy || !this.config.wrap_url}
          @click=${() => this.updateWrap('')}>Use standard paint</ha-button>
        ${this.wrapMessage ? html`<p role="status">${this.wrapMessage}</p>` : nothing}
        ${this.wrapError ? html`<p role="alert" class="wrap-error">${this.wrapError}</p>` : nothing}
      </section>
    `;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.wrapUpload?.abort();
    this.wrapUpload = undefined;
    this.wrapBusy = false;
    this.wrapMessage = '';
    this.wrapError = '';
  }

  private modelPick() { return PackLoader.resolveModel(this.index || null, this.config.model); }
  private async loadManifest() {
    const pick = this.modelPick(); if (!pick || !this.index) return;
    if (this.manifestFor === pick.entry.pack) return;
    this.manifestFor = pick.entry.pack;
    try { this.manifest = await this.packs.manifest(this.index, pick.entry.pack); } catch { this.manifest = undefined; }
    this.requestUpdate();
  }

  private schema() {
    const sel = (opts: { value: string; label: string }[]) => ({ select: { mode: 'dropdown', options: opts } });
    const plain = (opts: string[]) => sel(opts.map(o => ({ value: o, label: o })));
    const entity = (ch: ChannelId) => ({ name: ch, selector: { entity: { domain: CHANNEL_DOMAINS[ch] } } });
    const group = (chs: ChannelId[]) => chs.map(entity);
    const idx = this.index, pick = this.modelPick(), m = this.manifest;
    const look: any[] = [];
    if (idx && pick) {
      const entry = pick.entry;
      look.push({ name: 'model', selector: sel(Object.entries(idx.models).map(([id, mm]) => ({ value: id, label: mm.name }))) });
      if (entry.variants.includes('performance')) look.push({ name: 'trim', selector: plain(['premium', 'performance']) });
      if (m) look.push({ name: 'paint', selector: sel([{ value: '', label: 'Pack default' }, ...Object.keys(m.paints?.colors || {}).map(o => ({ value: o, label: o }))]) });
      if (entry.wheels.length) look.push({ name: 'wheels', selector: plain(entry.wheels) });
      if (entry.variants.includes('plate_eu') && entry.variants.includes('plate_us')) look.push({ name: 'plate', selector: plain(['eu', 'us']) });
      if (entry.variants.includes('seats_7')) look.push({ name: 'seats', selector: sel([{ value: '5', label: '5' }, { value: '7', label: '7' }]) });
      if (m && Object.keys(m.cables || {}).length > 1) look.push({ name: 'cable', selector: plain(['auto', ...Object.keys(m.cables)]) });
      look.push({ name: 'studio_enabled', selector: { boolean: {} } });
      if (this.config.scene === 'studio') {
        look.push({ name: 'studio_reflection', selector: { number: { min: 0, max: 1, step: 0.05, mode: 'slider' } } });
        look.push({ name: 'studio_light', selector: { number: { min: 0, max: 3, step: 0.1, mode: 'slider' } } });
      }
      look.push({ name: 'theme', selector: plain(['auto', 'dark', 'light']) });
      look.push({ name: 'camera', selector: sel([...Object.keys(m?.environment?.presets || { parked: 1, top_down: 1 }).filter(name => name !== 'front_right').map(value => ({ value, label: value })), { value: 'front_right', label: 'Front right (three-quarter)' }, { value: 'free', label: 'free' }]) });
      look.push({ name: 'aspect_ratio', selector: { text: {} } });
    }
    const flags: any[] = [{ name: 'hotspots', selector: { boolean: {} } }];
    if (pick?.entry.variants.includes('rhd')) flags.unshift({ name: 'rhd', selector: { boolean: {} } });
    return [
      { name: 'device_id', selector: { device: { filter: { integration: 'tesla_fleet' } } } },
      ...(look.length ? [{ type: 'grid', name: '', schema: look }] : []),
      { type: 'grid', name: '', schema: flags },
      { type: 'expandable', name: 'entities', title: 'Entities', icon: 'mdi:car-connected',
        expanded: !this.config.device_id && !!this.config.entities && Object.keys(this.config.entities).length > 0,
        schema: [
          ...group(['frunk', 'trunk', 'charge_port', 'lock']),
          { type: 'grid', name: '', schema: group(['door_fl', 'door_fr', 'door_rl', 'door_rr']) },
          { type: 'grid', name: '', schema: group(['window_fl', 'window_fr', 'window_rl', 'window_rr']) },
          ...group(['charge_cable', 'charging', 'headlights', 'drl', 'flash_lights']),
        ] },
    ];
  }

  private label = (s: any) => LABELS[s.name] || s.name;
  private helper = (s: any) => HELPERS[s.name];

  private onChange(ev: CustomEvent) {
    ev.stopPropagation();
    const value = { ...this.config, ...ev.detail.value } as CardConfig;
    value.scene = ev.detail.value.studio_enabled ? 'studio' : 'classic';
    delete (value as any).studio_enabled;
    // drop cleared pickers so the YAML stays tidy and the card falls back to the device mapping
    const entities: Partial<Record<ChannelId, string>> = {};
    for (const ch of CHANNELS) { const id = (value.entities as any)?.[ch]; if (id) entities[ch] = id; }
    if (Object.keys(entities).length) value.entities = entities; else delete value.entities;
    if (!value.device_id) delete value.device_id;
    if (!value.paint) delete value.paint;
    if ((value as any).seats !== undefined) (value as any).seats = Number((value as any).seats) === 7 ? 7 : 5;
    this.config = value;
    this.loadManifest();
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this.config }, bubbles: true, composed: true }));
  }

  render() {
    if (!this.hass) return html``;
    const pick = this.modelPick();
    const noPack = this.index !== undefined && !pick;
    const defaults: any = { scene: 'classic', studio_reflection: 0.25, studio_light: 1, trim: 'premium', plate: 'eu', seats: '5', cable: 'auto', theme: 'auto', camera: 'parked', aspect_ratio: '16:9', hotspots: true };
    if (pick) { defaults.model = pick.id; defaults.wheels = pick.entry.default_wheel; }
    const data = { ...defaults, ...this.config, studio_enabled: this.config.scene === 'studio', seats: String((this.config as any).seats ?? 5), entities: { ...(this.config.entities || {}) } };
    return html`
      ${noPack ? html`<ha-alert alert-type="warning" title="No asset pack installed">
        Build one from your copy of the Tesla app with
        <a href="https://github.com/koenhendriks/tesla-view-extractor" target="_blank" rel="noopener">tesla-view-extractor</a> and upload it under
        <a href="/config/integrations/integration/tesla_view">Settings → Devices &amp; services → Tesla View → Configure</a>.</ha-alert>` : ''}
      ${this.renderWrap()}
      <ha-form .hass=${this.hass} .data=${data} .schema=${this.schema()} .computeLabel=${this.label} .computeHelper=${this.helper}
        @value-changed=${(ev: CustomEvent) => this.onChange(ev)}></ha-form>`;
  }
}
customElements.define('tesla-view-card-editor', TeslaViewCardEditor);
