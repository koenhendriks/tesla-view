import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

/** Optional, procedural presentation scene. No vehicle-specific assets or node names. */
export class StudioScene {
  readonly root = new THREE.Group();
  private floor: Reflector;
  private key = new THREE.DirectionalLight(0xffeedb, 2);
  private fill = new THREE.DirectionalLight(0xdceaff, 0.8);
  private bounds = new THREE.Box3();

  constructor(vehicle: THREE.Object3D) {
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
    const shader = {
      uniforms: {
        color: { value: new THREE.Color() }, tDiffuse: { value: null }, textureMatrix: { value: new THREE.Matrix4() },
        floorColor: { value: new THREE.Color() }, reflection: { value: 0.25 },
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
        uniform vec2 footprint;
        varying vec4 reflectedUv;
        varying vec2 floorPosition;
        void main() {
          vec2 p = floorPosition;
          float lightPool = exp(-dot((p - vec2(-2.0, 1.0)) / vec2(5.0, 7.0), (p - vec2(-2.0, 1.0)) / vec2(5.0, 7.0)));
          vec2 contactUv = p / footprint;
          float contact = 0.65 * exp(-2.0 * dot(contactUv, contactUv));
          vec3 ground = (floorColor + vec3(pool * lightPool)) * (1.0 - contact);
          vec3 reflected = texture2DProj(tDiffuse, reflectedUv).rgb;
          float fade = exp(-dot(p / vec2(6.0, 7.0), p / vec2(6.0, 7.0)));
          gl_FragColor = vec4(mix(ground, reflected, reflection * fade * (1.0 - contact)), 1.0);
        }`,
    };
    this.floor = new Reflector(new THREE.PlaneGeometry(200, 200), {
      textureWidth: 768, textureHeight: 768, multisample: 0, clipBias: 0.003, shader,
    });
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.set(center.x, this.bounds.min.y - 0.015, center.z);
    this.key.position.set(center.x - 3, center.y + 5, center.z + 2);
    this.fill.position.set(center.x + 4, center.y + 3, center.z - 3);
    this.key.target.position.copy(center); this.fill.target.position.copy(center);
    this.root.add(this.floor, this.key, this.key.target, this.fill, this.fill.target);
  }

  update(background: THREE.Color, dark: boolean, reflection: number, light: number) {
    const uniforms = (this.floor.material as THREE.ShaderMaterial).uniforms;
    uniforms.floorColor.value.copy(background);
    uniforms.reflection.value = reflection;
    uniforms.pool.value = (dark ? 0.08 : 0.06) * light;
    this.key.intensity = 2.5 * light;
    this.fill.intensity = 1.2 * light;
  }

  dispose() {
    this.root.removeFromParent();
    this.floor.geometry.dispose(); this.floor.dispose();
    this.key.dispose(); this.fill.dispose();
  }
}
