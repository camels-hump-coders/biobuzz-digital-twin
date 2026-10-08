/** Intake mouth geometry: which side of the chassis collects game pieces, and the rectangle a ball must be in. */
import type { Footprint, Pose } from "./drive";
import { forwardVector, leftVector } from "./drive";
import type { IntakeKind, IntakeSide } from "../robot/robotSpec";

export interface IntakeGeom { side: IntakeSide; widthM: number; kind?: IntakeKind }

/** Ball position in the robot frame: forward (+ ahead) and left (+ to the robot's left), metres. */
export function toRobotFrame(pose: Pose, p: { x: number; z: number }): { fwd: number; left: number } {
  const f = forwardVector(pose.heading), l = leftVector(pose.heading);
  const dx = p.x - pose.x, dz = p.z - pose.z;
  return { fwd: dx * f.x + dz * f.z, left: dx * l.x + dz * l.z };
}

/** Centre of the intake edge in the robot frame. */
export function intakeEdge(fp: Footprint, side: IntakeSide): { fwd: number; left: number } {
  switch (side) {
    case "front": return { fwd: fp.lengthM / 2, left: 0 };
    case "rear": return { fwd: -fp.lengthM / 2, left: 0 };
    case "left": return { fwd: 0, left: fp.widthM / 2 };
    case "right": return { fwd: 0, left: -fp.widthM / 2 };
  }
}

/** Intake point on the field (floor level). */
export function intakePoint(pose: Pose, fp: Footprint, side: IntakeSide): { x: number; z: number } {
  const e = intakeEdge(fp, side);
  const f = forwardVector(pose.heading), l = leftVector(pose.heading);
  return { x: pose.x + f.x * e.fwd + l.x * e.left, z: pose.z + f.z * e.fwd + l.z * e.left };
}

/**
 * True when a ball centre sits in the intake mouth: within the mouth width along the intake edge and within
 * `reachM` outside that edge (slightly inside the chassis also counts: the rollers have already grabbed it).
 */
export function inIntakeMouth(pose: Pose, fp: Footprint, geom: IntakeGeom, ball: { x: number; z: number }, ballRadiusM: number, reachM: number): boolean {
  const r = toRobotFrame(pose, ball);
  // distance outward from the edge and offset along it
  let out: number, along: number;
  switch (geom.side) {
    case "front": out = r.fwd - fp.lengthM / 2; along = r.left; break;
    case "rear": out = -r.fwd - fp.lengthM / 2; along = r.left; break;
    case "left": out = r.left - fp.widthM / 2; along = r.fwd; break;
    case "right": out = -r.left - fp.widthM / 2; along = r.fwd; break;
  }
  return Math.abs(along) <= geom.widthM / 2 + ballRadiusM * 0.5 && out <= reachM && out >= -ballRadiusM * 2;
}

/**
 * Chassis vs ball on the floor. Returns the push-out needed to move the ball outside the chassis rectangle
 * (world metres) or undefined when they do not overlap. `normal` is the unit outward direction in world space.
 */
export function chassisPush(pose: Pose, fp: Footprint, ball: { x: number; z: number }, ballRadiusM: number): { dx: number; dz: number; nx: number; nz: number } | undefined {
  const r = toRobotFrame(pose, ball);
  const hl = fp.lengthM / 2 + ballRadiusM, hw = fp.widthM / 2 + ballRadiusM;
  if (Math.abs(r.fwd) >= hl || Math.abs(r.left) >= hw) return undefined;
  const pf = hl - Math.abs(r.fwd), pl = hw - Math.abs(r.left);
  const f = forwardVector(pose.heading), l = leftVector(pose.heading);
  let nx: number, nz: number, depth: number;
  if (pf < pl) { const sgn = r.fwd >= 0 ? 1 : -1; nx = f.x * sgn; nz = f.z * sgn; depth = pf; }
  else { const sgn = r.left >= 0 ? 1 : -1; nx = l.x * sgn; nz = l.z * sgn; depth = pl; }
  return { dx: nx * depth, dz: nz * depth, nx, nz };
}

/** How far outside the mouth edge a FLOWER axis may sit for the brushes to reach its retrieval opening (metres).
 *  The opening is 3.57 in deep and the lower ring 2.79 in across; the brushes must overlap the opening. */
export const FLOWER_MOUTH_REACH_M = 6.5 * 0.0254;
/** A FLOWER axis slightly behind the mouth edge still counts: the chassis stops at the ring plate, not the axis. */
const FLOWER_MOUTH_INSIDE_M = 1.0 * 0.0254;
const FLOWER_MOUTH_SLOP_M = 1.0 * 0.0254;

/** True when the FLOWER axis is inside the intake mouth frame: within the mouth width (plus 1 in) along the edge and
 *  between 1 in inside and `FLOWER_MOUTH_REACH_M` outside it. Only `brushes` intakes can retrieve; callers check the kind. */
export function flowerInMouth(pose: Pose, fp: Footprint, geom: IntakeGeom, axis: { x: number; z: number }): boolean {
  const r = toRobotFrame(pose, axis);
  let out: number, along: number;
  switch (geom.side) {
    case "front": out = r.fwd - fp.lengthM / 2; along = r.left; break;
    case "rear": out = -r.fwd - fp.lengthM / 2; along = r.left; break;
    case "left": out = r.left - fp.widthM / 2; along = r.fwd; break;
    case "right": out = -r.left - fp.widthM / 2; along = r.fwd; break;
  }
  return Math.abs(along) <= geom.widthM / 2 + FLOWER_MOUTH_SLOP_M && out <= FLOWER_MOUTH_REACH_M && out >= -FLOWER_MOUTH_INSIDE_M;
}
