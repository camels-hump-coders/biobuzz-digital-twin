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

/** How far outside the intake edge a FLOWER axis may sit for the side wheels to grip the bottom POLLEN (metres): the
 *  wheels sit at the edge and a 1.4 in ball centred 1.6 in out still touches them. Further out they spin in air. */
export const FLOWER_MOUTH_REACH_M = 1.6 * 0.0254;
/** The low intake deck slides into the cage until the wall-side post, so the axis can be this far inside the edge. */
export const FLOWER_MOUTH_INSIDE_M = 1.3 * 0.0254;
const FLOWER_MOUTH_SLOP_M = 1.0 * 0.0254;

/** True when the FLOWER axis sits between the intake's side wheels: within the mouth width (plus 1 in) along the edge
 *  and between `FLOWER_MOUTH_INSIDE_M` inside and `FLOWER_MOUTH_REACH_M` outside it. Only `brushes` intakes can
 *  retrieve; callers check the kind. Getting there means driving the low intake deck under the FLOWER's mid ring. */
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

/** Feeder geometry in the mouth frame (u: out through the intake edge, positive outside; v: along the edge, metres).
 *  Two side wheels on vertical axles at the mouth ends, a roller across the mouth a little inside the edge, and the
 *  seat the feeder delivers to. The StarterBot CAD measures: side wheels 36 mm radius at the corners, roller 27 mm
 *  radius 74 mm inside the edge; the box robot draws the same parts. */
export const FEEDER = {
  sideWheelR: 0.038, sideWheelU: -0.02,
  rollerR: 0.028, rollerU: -0.05,
  /** the ball is swallowed once its centre is this far inside the edge (and near the mouth centre line) */
  seatU: -0.085,
  /** compliant wheels: contact counts a little before the geometry touches */
  gripTolM: 0.012,
  /** feeder pull, m/s toward the seat, and how fast the ball gets up to it, m/s² */
  pullMps: 0.9, pullAccel: 10,
} as const;

/** Ball position in the mouth frame. */
export function mouthFrame(pose: Pose, fp: Footprint, geom: IntakeGeom, p: { x: number; z: number }): { u: number; v: number } {
  const r = toRobotFrame(pose, p);
  switch (geom.side) {
    case "front": return { u: r.fwd - fp.lengthM / 2, v: r.left };
    case "rear": return { u: -r.fwd - fp.lengthM / 2, v: r.left };
    case "left": return { u: r.left - fp.widthM / 2, v: r.fwd };
    case "right": return { u: -r.left - fp.widthM / 2, v: r.fwd };
  }
}
/** Mouth-frame (u, v) back to a world offset direction: unit vectors of +u and +v. */
export function mouthAxes(pose: Pose, geom: IntakeGeom): { u: { x: number; z: number }; v: { x: number; z: number } } {
  const f = forwardVector(pose.heading), l = leftVector(pose.heading);
  switch (geom.side) {
    case "front": return { u: f, v: l };
    case "rear": return { u: { x: -f.x, z: -f.z }, v: l };
    case "left": return { u: l, v: f };
    case "right": return { u: { x: -l.x, z: -l.z }, v: f };
  }
}
/** Which feeder part touches a ball at (u, v) with this radius, or undefined: "side" (a side wheel), "roller". */
export function feederContact(geom: IntakeGeom, u: number, v: number, ballR: number): "side" | "roller" | undefined {
  const half = geom.widthM / 2;
  for (const sv of [-(half - FEEDER.sideWheelR), half - FEEDER.sideWheelR]) {
    if (Math.hypot(u - FEEDER.sideWheelU, v - sv) <= FEEDER.sideWheelR + ballR + FEEDER.gripTolM) return "side";
  }
  // the roller spans the mouth between the side wheels; a ball on the floor reaches up to it
  if (Math.abs(v) <= half - FEEDER.sideWheelR * 0.5 && Math.abs(u - FEEDER.rollerU) <= FEEDER.rollerR + ballR + FEEDER.gripTolM) return "roller";
  return undefined;
}
/** Is the ball in the mouth corridor: laterally within the mouth and at or inside the intake edge? The corridor runs
 *  the whole depth of the chassis so a fast robot (or a slow frame) cannot carry a ball past the roller line in one step. */
export function inCorridor(geom: IntakeGeom, u: number, v: number, ballR: number): boolean {
  return Math.abs(v) <= geom.widthM / 2 - ballR * 0.3 && u <= ballR && u >= -1.0;
}
