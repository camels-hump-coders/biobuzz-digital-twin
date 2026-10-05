/** Convert the twin's tag visibility into FTC-style AprilTag detections in the camera frame. */
import * as THREE from "three";
import type { TagVisibility } from "../camera/robotCamera";
import type { Intrinsics } from "../camera/cameraMath";
import type { TagPacket } from "./link";
import type { Pose } from "../sim/drive";
import { gaussian, rng } from "../ballistics/dispersion";
import { mToIn, rad2deg } from "../util/units";

const IN = 0.0254;
const noise = rng(99);

/**
 * FTC camera frame: x right, y forward (out of the lens), z up. Field frame for robotPose: inches,
 * origin at field centre, +Y toward the scoring side (our scene -Z), +X toward blue, yaw CCW from +X? FTC uses
 * yaw 0 = facing +X... we report yaw as heading in degrees CCW from +Y (scoring) to match the sim's IMU.
 */
export function buildDetections(cam: THREE.Camera, intr: Intrinsics, vis: TagVisibility[], tagMeshes: THREE.Mesh[], pose: Pose, noiseIn = 0): TagPacket[] {
  cam.updateMatrixWorld(true);
  const inv = cam.matrixWorld.clone().invert();
  const out: TagPacket[] = [];
  for (const v of vis) {
    if (!v.visible) continue;
    const mesh = tagMeshes.find((m) => m.userData.tagId === v.id);
    if (!mesh) continue;
    const wp = mesh.getWorldPosition(new THREE.Vector3());
    const lp = wp.clone().applyMatrix4(inv); // three camera frame: x right, y up, z backwards
    const n = noiseIn ? () => gaussian(noise) * noiseIn : () => 0;
    const x = mToIn(lp.x) + n(), y = mToIn(-lp.z) + n(), z = mToIn(lp.y) + n();
    if (y <= 0.01) continue;
    const range = Math.hypot(x, y, z);
    const bearing = rad2deg(Math.atan2(-x, y));
    const elevation = rad2deg(Math.atan2(z, Math.hypot(x, y)));
    // tag orientation relative to the camera: yaw = rotation of the tag normal about vertical
    const wn = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
    const ln = wn.clone().transformDirection(inv); // camera frame normal
    const yaw = rad2deg(Math.atan2(ln.x, ln.z)); // 0 when the tag faces the camera squarely
    const pitch = rad2deg(Math.asin(Math.max(-1, Math.min(1, -ln.y))));
    const roll = 0;
    // Exact rotation for rawPose: tag axes (x right along the tag, y down the tag, z into the tag) expressed in the
    // OpenCV camera frame (x right, y down, z forward). three.js camera space is x right, y up, z backward.
    const q = mesh.getWorldQuaternion(new THREE.Quaternion());
    const tagX = new THREE.Vector3(1, 0, 0).applyQuaternion(q).transformDirection(inv);
    const tagYdown = new THREE.Vector3(0, -1, 0).applyQuaternion(q).transformDirection(inv);
    const tagZinto = new THREE.Vector3(0, 0, -1).applyQuaternion(q).transformDirection(inv); // plane normal faces viewers; into the tag is -normal
    const cv = (v: THREE.Vector3) => [v.x, -v.y, -v.z];
    const cx3 = cv(tagX), cy3 = cv(tagYdown), cz3 = cv(tagZinto);
    const Rm = [cx3[0], cy3[0], cz3[0], cx3[1], cy3[1], cz3[1], cx3[2], cy3[2], cz3[2]]; // columns are the tag axes
    // image coordinates from the normalised frustum coords
    const cx = ((v.u + 1) / 2) * intr.width, cy = ((1 - v.v) / 2) * intr.height;
    out.push({
      id: v.id, cx, cy, x, y, z, yaw, pitch, roll, range, bearing, elevation,
      robotX: pose.x / IN, robotY: -pose.z / IN, robotYaw: rad2deg(pose.heading),
      R: Rm,
    });
  }
  return out;
}
