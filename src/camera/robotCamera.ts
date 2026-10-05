/** Per-camera analysis: pose extraction, visible AprilTags with occlusion raycasts. */
import * as THREE from "three";
import { type CameraPose, type Intrinsics, inFrustum, tagPixels } from "./cameraMath";
import { APRILTAG, m } from "../field/fieldSpec";

export function cameraPoseOf(cam: THREE.PerspectiveCamera): CameraPose {
  cam.updateMatrixWorld(true);
  const position = cam.getWorldPosition(new THREE.Vector3());
  const q = cam.getWorldQuaternion(new THREE.Quaternion());
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  return { position, forward, up, right };
}

export interface TagVisibility {
  id: number;
  alliance: string;
  side: string;
  inFov: boolean;
  facing: boolean;
  occluded: boolean;
  visible: boolean;
  distanceM: number;
  pixels: number;
  /** image-plane coords -1..1 */
  u: number;
  v: number;
}

const raycaster = new THREE.Raycaster();

export function analyseTags(cam: THREE.PerspectiveCamera, intr: Intrinsics, tags: THREE.Mesh[], occluders: THREE.Object3D[]): TagVisibility[] {
  const pose = cameraPoseOf(cam);
  const out: TagVisibility[] = [];
  const n = new THREE.Vector3();
  for (const t of tags) {
    const c = t.getWorldPosition(new THREE.Vector3());
    const f = inFrustum(pose, intr, c);
    // tag normal in world
    n.set(0, 0, 1).applyQuaternion(t.getWorldQuaternion(new THREE.Quaternion()));
    const toCam = new THREE.Vector3().subVectors(pose.position as THREE.Vector3, c);
    const dist = toCam.length();
    const cosAng = n.dot(toCam) / dist;
    const facing = cosAng > 0.17; // within ~80 deg of the normal
    let occluded = false;
    if (f.inside && facing) {
      raycaster.set(pose.position as THREE.Vector3, c.clone().sub(pose.position as THREE.Vector3).normalize());
      raycaster.far = dist - 0.02;
      const hits = raycaster.intersectObjects(occluders, true);
      occluded = hits.some((h) => h.distance < dist - 0.02 && h.object !== t && !isTransparentSkin(h.object));
    }
    out.push({
      id: t.userData.tagId, alliance: t.userData.alliance, side: t.userData.side,
      inFov: f.inside, facing, occluded, visible: f.inside && facing && !occluded,
      distanceM: dist, pixels: tagPixels(intr, m(APRILTAG.sizeIn), f.depth) * Math.max(0, cosAng), u: f.u, v: f.v,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function isTransparentSkin(o: THREE.Object3D): boolean {
  const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
  return !!mat && (mat as THREE.MeshPhysicalMaterial).transparent === true && ((mat as THREE.MeshPhysicalMaterial).opacity ?? 1) < 0.5;
}
