import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

/** Optional, procedural presentation scene. No vehicle-specific assets or node names. */
export class StudioScene {
  readonly root = new THREE.Group();
  private floor: Reflector;
  private key = new THREE.DirectionalLight(0xffeedb, 2);
  private fill = new THREE.DirectionalLight(0xdceaff, 0.8);
  private front = new THREE.SpotLight(0xfff3e1, 30, 30, Math.PI / 5, 0.8, 2);
  private shaft: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>;
  private bounds = new THREE.Box3();

  constructor(vehicle: THREE.Object3D, frontAnchor?: THREE.Object3D) {
    vehicle.updateWorldMatrix(true, true);
    vehicle.traverseVisible(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box) return;
      const size = box.getSize(new THREE.Vector3());
      // Ignore flat ground decals and projected lights when finding the tyre plane.
      if (Math.min(size.x, size.y, size.z) < 0.015) return;
      this.bounds.union(box.clone().applyMatrix4(mesh.matrixWorld));
    });
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-1, 0, -2), new THREE.Vector3(1, 2, 2));
    const center = this.bounds.getCenter(new THREE.Vector3());
    const size = this.bounds.getSize(new THREE.Vector3());
    const forward = frontAnchor ? frontAnchor.getWorldPosition(new THREE.Vector3()).sub(center) : new THREE.Vector3(0, 0, -1);
    forward.y = 0; forward.normalize();
    if (forward.lengthSq() < 0.01) forward.set(0, 0, -1);
    // Vehicle-left, derived from the forward marker rather than model-specific axes.
    const left = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
    const lightOffset = forward.clone().multiplyScalar(3.5).addScaledVector(left, 4);
    const shader = {
      uniforms: {
        color: { value: new THREE.Color() }, tDiffuse: { value: null }, textureMatrix: { value: new THREE.Matrix4() },
        textureStrength: { value: 1 }, floorColor: { value: new THREE.Color() }, reflection: { value: 0.25 },
        lightOrigin: { value: new THREE.Vector2(lightOffset.x, -lightOffset.z) },
        pool: { value: 0.035 }, footprint: { value: new THREE.Vector2(size.x * 0.52, size.z * 0.52) },
      },
      vertexShader: `
        uniform mat4 textureMatrix;
        varying vec4 reflectedUv;
        varying vec2 floorPosition;
        void main() {
          floorPosition = position.xy;
          reflectedUv = textureMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec3 floorColor;
        uniform float reflection;
        uniform float pool;
        uniform float textureStrength;
        uniform vec2 footprint;
        uniform vec2 lightOrigin;
        varying vec4 reflectedUv;
        varying vec2 floorPosition;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
        }
        void main() {
          vec2 p = floorPosition;
          vec2 poolUv = (p - lightOrigin * 0.35) / vec2(5.5, 5.5);
          float lightPool = exp(-dot(poolUv, poolUv));
          vec2 contactUv = p / footprint;
          float contact = 0.72 * exp(-2.0 * dot(contactUv, contactUv));
          // World-space mottling and filtered fine grain: stable when orbiting/zooming.
          float mottling = noise(p * 3.0) - 0.5;
          float grain = (noise(p * 95.0) - 0.5) / (1.0 + length(fwidth(p * 95.0)));
          float surface = 1.0 + (mottling * 0.18 + grain * 0.24) * textureStrength * lightPool;
          vec3 ground = (floorColor + vec3(pool * lightPool)) * surface * (1.0 - contact);
          vec2 uv = reflectedUv.xy / reflectedUv.w;
          vec2 blur = vec2(0.0018 + 0.0006 * noise(p * 8.0));
          vec3 reflected = texture2D(tDiffuse, uv).rgb * 0.4;
          reflected += texture2D(tDiffuse, uv + vec2(blur.x, 0.)).rgb * 0.15;
          reflected += texture2D(tDiffuse, uv - vec2(blur.x, 0.)).rgb * 0.15;
          reflected += texture2D(tDiffuse, uv + vec2(0., blur.y)).rgb * 0.15;
          reflected += texture2D(tDiffuse, uv - vec2(0., blur.y)).rgb * 0.15;
          float fade = exp(-dot(p / vec2(6.0, 7.0), p / vec2(6.0, 7.0)));
          gl_FragColor = vec4(mix(ground, reflected, reflection * fade * (1.0 - contact) * (0.92 + 0.08 * surface)), 1.0);
        }`,
    };
    this.floor = new Reflector(new THREE.PlaneGeometry(200, 200), {
      textureWidth: 768, textureHeight: 768, multisample: 0, clipBias: 0.003, shader,
    });
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.set(center.x, this.bounds.min.y - 0.015, center.z);
    this.key.position.copy(center).add(lightOffset); this.key.position.y += 6;
    this.fill.position.set(center.x + 4, center.y + 3, center.z - 3);
    this.key.target.position.copy(center); this.fill.target.position.copy(center);
    this.front.position.copy(this.key.position);
    this.front.target.position.copy(center);
    // A subtle procedural shaft makes the incoming studio light visible against dark backgrounds.
    const shaftTarget = new THREE.Vector3(center.x, this.bounds.min.y, center.z);
    const shaftVector = this.front.position.clone().sub(shaftTarget);
    const shaftMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { strength: { value: 0.025 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float strength; varying vec2 vUv;
        void main() { float fade = sin(vUv.y * 3.14159265); gl_FragColor = vec4(0.82, 0.88, 1.0, strength * fade * fade); }`,
    });
    this.shaft = new THREE.Mesh(new THREE.ConeGeometry(4.5, shaftVector.length(), 64, 1, true), shaftMaterial);
    this.shaft.position.copy(shaftTarget).addScaledVector(shaftVector, 0.5);
    this.shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), shaftVector.normalize());
    this.root.add(this.shaft, this.front, this.front.target);
    this.root.add(this.floor, this.key, this.key.target, this.fill, this.fill.target);
  }

  update(background: THREE.Color, dark: boolean, reflection: number, light: number) {
    const uniforms = (this.floor.material as THREE.ShaderMaterial).uniforms;
    uniforms.floorColor.value.copy(background);
    uniforms.reflection.value = reflection;
    uniforms.textureStrength.value = dark ? 1 : 0.18;
    uniforms.pool.value = (dark ? 0.16 : 0.06) * light;
    this.shaft.material.uniforms.strength.value = (dark ? 0.045 : 0.006) * light;
    this.front.intensity = 65 * light;
    this.key.intensity = 2.5 * light;
    this.fill.intensity = 0.65 * light;
  }

  dispose() {
    this.root.removeFromParent();
    this.floor.geometry.dispose(); this.floor.dispose();
    this.shaft.geometry.dispose(); this.shaft.material.dispose();
    this.front.dispose(); this.key.dispose(); this.fill.dispose();
  }
}
