// Tesla-app style interactive hotspots for a three.js scene (TypeScript port of extracted/hotspots.js).
//
// A white ring is drawn over a 3D anchor (the Godot `Marker` nodes of the vehicle scene – the same tap targets the
// Tesla app projects with VehicleManager.get_markers()). On hover the ring fills with a dot and a leader line (45°
// diagonal, then horizontal) carries a label with the action for the current state; clicking performs the action.
// On touch there is no hover, so the first tap only reveals the label (arming the hotspot) and a second tap on the same
// hotspot within ARM_MS confirms and performs the action.
// Anchors whose side of the car faces away from the camera are hidden (facing test on the marker's outward normal).
import * as THREE from 'three';

export interface HotspotItem {
  key: string;
  object: THREE.Object3D;
  label: () => string;
  onToggle: () => void;
  /** outward normal in the occluder's local space; default: ±X for flank markers, +Y otherwise */
  normal?: [number, number, number];
  /** always show (ignore facing test) */
  alwaysVisible?: boolean;
  enabled?: () => boolean;
}

export interface HotspotOptions {
  camera: THREE.Camera; canvas: HTMLElement; occluder: THREE.Object3D; container: HTMLElement; items: HotspotItem[];
  ringRadius?: number; dotPadding?: number; hitRadius?: number; diagonal?: number; labelPadding?: number;
  facingThreshold?: number; sideThreshold?: number; color?: string;
  onHoverChange?: () => void;
}

const NS = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, any> = {}) => {
  const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e;
};

interface Entry { it: HotspotItem; g: SVGGElement; leader: SVGPolylineElement; label: SVGTextElement; hint: SVGTextElement; hit: SVGCircleElement; hovered: boolean; armed: boolean; visible: boolean; sx: number; sy: number; t?: any }

const ARM_MS = 3000;

export function createHotspots(o: HotspotOptions) {
  const ringRadius = o.ringRadius ?? 10, dotPadding = o.dotPadding ?? 3, hitRadius = o.hitRadius ?? 18, diagonal = o.diagonal ?? 34;
  const labelPadding = o.labelPadding ?? 16, facingThreshold = o.facingThreshold ?? 0.08, sideThreshold = o.sideThreshold ?? 0.5, color = o.color ?? '#fff';

  const svg = el('svg', { class: 'hotspots' });
  Object.assign(svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' });
  svg.appendChild(el('style')).textContent = `
    .hs-hit{pointer-events:auto;cursor:pointer;fill:transparent}
    .hs-dot,.hs-leader,.hs-label{opacity:0;transition:opacity .12s ease}
    .hs-hover .hs-dot,.hs-hover .hs-leader,.hs-hover .hs-label{opacity:1}
    .hs-hidden{opacity:0;transition:opacity .12s ease}
    .hs-hidden .hs-hit{pointer-events:none}
    .hs-hint{opacity:0;transition:opacity .12s ease;font:11px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;fill:${color};fill-opacity:.75;paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:3px}
    .hs-armed .hs-hint{opacity:1}
    .hs-focus .hs:not(.hs-armed){opacity:0;transition:opacity .12s ease}
    .hs-focus .hs:not(.hs-armed) .hs-hit{pointer-events:none}
    .hs-label{font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;fill:${color};paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:3px}
  `;
  o.container.appendChild(svg);

  const setHover = (e: Entry, on: boolean) => { if (e.hovered === on) return; e.hovered = on; e.g.classList.toggle('hs-hover', on); o.onHoverChange?.(); };

  // while a touch hotspot is armed, the others are hidden so only the one awaiting confirmation is shown
  const setArmed = (e: Entry, on: boolean) => {
    e.armed = on; e.g.classList.toggle('hs-armed', on); svg.classList.toggle('hs-focus', entries.some(q => q.armed));
  };
  const disarm = (e: Entry) => { clearTimeout(e.t); setArmed(e, false); setHover(e, false); };

  const entries: Entry[] = o.items.map(it => {
    const g = el('g', { class: 'hs hs-hidden' });
    const leader = el('polyline', { class: 'hs-leader', fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linecap': 'round' });
    const ring = el('circle', { class: 'hs-ring', r: ringRadius, fill: 'none', stroke: color, 'stroke-width': 1.5 });
    const dot = el('circle', { class: 'hs-dot', r: ringRadius - dotPadding, fill: color });
    const label = el('text', { class: 'hs-label', 'text-anchor': 'middle' });
    const hint = el('text', { class: 'hs-hint', 'text-anchor': 'middle' });
    hint.textContent = 'Tap again to confirm';
    const hit = el('circle', { class: 'hs-hit', r: hitRadius });
    g.append(leader, ring, dot, label, hint, hit);
    svg.appendChild(g);
    const e: Entry = { it, g, leader, label, hint, hit, hovered: false, armed: false, visible: false, sx: 0, sy: 0 };
    // touch hover is driven by the tap handler below, not by enter/leave (which fire around every tap)
    hit.addEventListener('pointerenter', (ev: PointerEvent) => { if (ev.pointerType !== 'touch') setHover(e, true); });
    hit.addEventListener('pointerleave', (ev: PointerEvent) => { if (ev.pointerType !== 'touch') setHover(e, false); });
    hit.addEventListener('pointerdown', ev => ev.stopPropagation());     // don't start an OrbitControls drag
    hit.addEventListener('click', (ev: PointerEvent) => {
      ev.stopPropagation();
      if (ev.pointerType !== 'touch') { it.onToggle(); return; }
      if (e.armed) { disarm(e); it.onToggle(); return; }
      for (const q of entries) if (q !== e && q.armed) disarm(q);
      setArmed(e, true); setHover(e, true);
      clearTimeout(e.t); e.t = setTimeout(() => disarm(e), ARM_MS);
    });
    return e;
  });
  // a tap anywhere else on the card cancels an armed hotspot
  const cancelArmed = (ev: PointerEvent) => { if (!entries.some(e => e.hit === ev.target)) for (const e of entries) if (e.armed) disarm(e); };
  o.container.addEventListener('pointerdown', cancelArmed, true);

  const world = new THREE.Vector3(), ndc = new THREE.Vector3(), camPos = new THREE.Vector3(), toCam = new THREE.Vector3();
  const center = new THREE.Vector3(), normal = new THREE.Vector3(), local = new THREE.Vector3(), rot = new THREE.Matrix3();

  function facesCamera(e: Entry) {
    if (e.it.alwaysVisible) return true;
    if (e.it.normal) normal.set(...e.it.normal);
    else { o.occluder.worldToLocal(local.copy(world)); Math.abs(local.x) > sideThreshold ? normal.set(Math.sign(local.x), 0, 0) : normal.set(0, 1, 0); }
    rot.setFromMatrix4(o.occluder.matrixWorld); normal.applyMatrix3(rot).normalize();
    toCam.copy(camPos).sub(world).normalize();
    return normal.dot(toCam) > facingThreshold;
  }

  function update() {
    const w = o.canvas.clientWidth, h = o.canvas.clientHeight;
    if (!w || !h) return;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    o.camera.getWorldPosition(camPos);
    o.occluder.getWorldPosition(center); center.y += 0.6; center.project(o.camera);
    const centerX = (center.x + 1) / 2 * w;
    for (const e of entries) {
      e.it.object.getWorldPosition(world);
      ndc.copy(world).project(o.camera);
      const show = (e.it.enabled?.() ?? true) && ndc.z < 1 && Math.abs(ndc.x) < 1.2 && Math.abs(ndc.y) < 1.2 && facesCamera(e);
      if (show !== e.visible) { e.visible = show; e.g.classList.toggle('hs-hidden', !show); if (!show) disarm(e); }
      if (!show) continue;
      const x = (ndc.x + 1) / 2 * w, y = (1 - ndc.y) / 2 * h;
      e.sx = x; e.sy = y;
      e.g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
      if (!e.hovered) continue;
      const text = e.it.label();
      if (e.label.textContent !== text) e.label.textContent = text;
      const half = ringRadius * Math.SQRT1_2;
      const textWidth = e.label.getComputedTextLength?.() || text.length * 7;
      const hintWidth = e.armed ? (e.hint.getComputedTextLength?.() || 110) : 0;
      const width = Math.max(textWidth, hintWidth) + labelPadding;
      const rise = half + diagonal, edge = 4;
      // leader goes up unless the label would be cut off by the top of the canvas and there is room below
      const v = y - rise - 22 < edge && y + rise + 36 <= h - edge ? 1 : -1;
      const reach = rise + width + hitRadius, yTop = y + v * rise;
      // leader direction: the side where the label does not run over another visible hotspot or leave the canvas; tie → away from the car
      const overflow = (d: number) => Math.max(0, -(x + d * reach), x + d * reach - w);
      const clashes = (d: number) => entries.filter(q => q !== e && q.visible && Math.abs(q.sy - yTop) < 40 && (q.sx - x) * d > 0 && Math.abs(q.sx - x) < reach).length
        + (overflow(d) > 0 ? 10 + overflow(d) / 10 : 0);
      const away = x < centerX ? -1 : 1;
      const d = clashes(away) <= clashes(-away) ? away : -away;
      const x1 = d * rise, y1 = v * rise, x2 = x1 + d * width;
      e.leader.setAttribute('points', `${d * half},${v * half} ${x1},${y1} ${x2},${y1}`);
      // keep the text inside the canvas even when neither side has room for the full leader
      const halfText = Math.max(textWidth, hintWidth) / 2;
      const tx = Math.min(Math.max((x1 + x2) / 2, edge + halfText - x), w - edge - halfText - x);
      e.label.setAttribute('x', String(tx)); e.label.setAttribute('y', String(v < 0 ? y1 - 6 : y1 + 17));
      e.hint.setAttribute('x', String(tx)); e.hint.setAttribute('y', String(v < 0 ? y1 + 15 : y1 + 32));
    }
  }
  const anyHovered = () => entries.some(e => e.hovered);
  function dispose() { o.container.removeEventListener('pointerdown', cancelArmed, true); svg.remove(); }
  return { update, dispose, entries, svg, anyHovered };
}
