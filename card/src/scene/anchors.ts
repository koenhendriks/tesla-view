import * as THREE from 'three';

/** Measure visible body geometry in the anchor parent's coordinate space. */
function bodyBounds(parent: THREE.Object3D, body: THREE.Object3D): THREE.Box3 | undefined {
  parent.updateWorldMatrix(true, true);
  const inverse = parent.matrixWorld.clone().invert();
  const bounds = new THREE.Box3();
  const transform = new THREE.Matrix4();
  const meshBounds = new THREE.Box3();

  // Ignore hidden variants and use the manifest's body when available, rather than
  // letting accessories or a charging cable move the target away from the roof.
  body.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    transform.multiplyMatrices(inverse, mesh.matrixWorld);
    meshBounds.copy(mesh.geometry.boundingBox).applyMatrix4(transform);
    bounds.union(meshBounds);
  });
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) return;

  return bounds;
}

/** Place a fallback lock target just above the roof. */
export function createRoofAnchor(parent: THREE.Object3D, body: THREE.Object3D): THREE.Object3D | undefined {
  const bounds = bodyBounds(parent, body);
  if (!bounds) return;
  const anchor = new THREE.Object3D();
  anchor.name = 'TeslaViewLockAnchor';
  bounds.getCenter(anchor.position);
  anchor.position.y = bounds.max.y + (bounds.max.y - bounds.min.y) * 0.03;
  parent.add(anchor);
  return anchor;
}

/** Place the light target on the nose, using the pack's front marker for orientation. */
export function createFrontAnchor(
  parent: THREE.Object3D,
  body: THREE.Object3D,
  front?: THREE.Object3D,
): THREE.Object3D | undefined {
  const bounds = bodyBounds(parent, body);
  if (!bounds) return;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const direction = new THREE.Vector3(0, 0, -1);
  if (front) {
    front.updateWorldMatrix(true, false);
    parent.worldToLocal(front.getWorldPosition(direction)).sub(center);
    direction.y = 0;
    if (direction.lengthSq() < 1e-10) direction.set(0, 0, -1);
    direction.normalize();
  }
  // Intersect the horizontal direction with the body's box; inset slightly so
  // the target stays on the bumper rather than floating ahead of the car.
  const distance = Math.min(
    Math.abs(direction.x) > 1e-6 ? size.x / (2 * Math.abs(direction.x)) : Infinity,
    Math.abs(direction.z) > 1e-6 ? size.z / (2 * Math.abs(direction.z)) : Infinity,
  );
  const anchor = new THREE.Object3D();
  anchor.name = 'TeslaViewLightsAnchor';
  anchor.position.copy(center).addScaledVector(direction, distance * 0.96);
  anchor.position.y = bounds.min.y + size.y * 0.45;
  parent.add(anchor);
  return anchor;
}
