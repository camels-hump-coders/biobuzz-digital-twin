/** Drivetrain kinematics and simple field bounds. Pure, unit tested. */
import { FIELD, FLOWER, HIVE, m } from "../field/fieldSpec";
import { clamp, wrapAngle } from "../util/units";

export type Drivetrain = "mecanum" | "tank";

export interface Pose {
  /** metres, scene frame (X toward blue, Z toward audience) */
  x: number;
  z: number;
  /** heading, radians. 0 = robot forward points toward -Z (scoring side). CCW positive viewed from above. */
  heading: number;
}

export interface DriveCommand {
  /** -1..1 forward */
  forward: number;
  /** -1..1 left strafe (ignored for tank) */
  left: number;
  /** -1..1 CCW rotation */
  turn: number;
}

export interface DriveParams {
  drivetrain: Drivetrain;
  /** Driver forward heading for field-relative mecanum; omitted preserves world-axis callers. */
  fieldHeading?: number;
  /** wheel free speed RPM and diameter -> max linear speed */
  wheelRpm: number;
  wheelDiameterM: number;
  /** track width (left-right wheel centre distance), metres; used for max turn rate */
  trackWidthM: number;
  /** wheelbase (front-back), metres */
  wheelbaseM: number;
  fieldCentric: boolean;
}

export function maxLinearSpeed(p: DriveParams): number {
  return (Math.PI * p.wheelDiameterM * p.wheelRpm) / 60;
}

/** Max yaw rate for a mecanum/tank drive turning in place. */
export function maxYawRate(p: DriveParams): number {
  const v = maxLinearSpeed(p);
  const r = p.drivetrain === "mecanum" ? (p.trackWidthM + p.wheelbaseM) / 2 : p.trackWidthM / 2;
  return v / r;
}

/** Robot-frame forward direction in the scene (unit XZ). */
export function forwardVector(heading: number): { x: number; z: number } {
  return { x: -Math.sin(heading), z: -Math.cos(heading) };
}
export function leftVector(heading: number): { x: number; z: number } {
  // left = forward rotated +90deg CCW (viewed from above, +Y)
  return { x: -Math.cos(heading), z: Math.sin(heading) };
}

export interface Velocity {
  vx: number;
  vz: number;
  yawRate: number;
}

/** Convert a command into a world velocity. */
export function commandToVelocity(cmd: DriveCommand, pose: Pose, p: DriveParams): Velocity {
  const vmax = maxLinearSpeed(p);
  let f = clamp(cmd.forward, -1, 1);
  let l = p.drivetrain === "mecanum" ? clamp(cmd.left, -1, 1) : 0;
  // normalise so a diagonal does not exceed the wheel limit (mecanum |f|+|l| <= 1 ideal)
  const mag = Math.abs(f) + Math.abs(l) + Math.abs(cmd.turn);
  const scaleDown = mag > 1 ? 1 / mag : 1;
  f *= scaleDown;
  l *= scaleDown;
  const t = clamp(cmd.turn, -1, 1) * scaleDown;
  let fx: number, fz: number, lx: number, lz: number;
  if (p.fieldCentric && p.drivetrain === "mecanum") {
    // Field-relative translation uses the driver heading, independently of robot yaw.
    ({ x: fx, z: fz } = forwardVector(p.fieldHeading ?? 0));
    ({ x: lx, z: lz } = leftVector(p.fieldHeading ?? 0));
  } else {
    ({ x: fx, z: fz } = forwardVector(pose.heading));
    ({ x: lx, z: lz } = leftVector(pose.heading));
  }
  return {
    vx: (fx * f + lx * l) * vmax,
    vz: (fz * f + lz * l) * vmax,
    yawRate: t * maxYawRate(p),
  };
}

export interface Footprint {
  lengthM: number; // along forward
  widthM: number; // across
}

/** Half extents of the rotated footprint along the world X and Z axes. */
export function worldHalfExtents(fp: Footprint, heading: number): { hx: number; hz: number } {
  const c = Math.abs(Math.cos(heading)), s = Math.abs(Math.sin(heading));
  const hl = fp.lengthM / 2, hw = fp.widthM / 2;
  return { hx: hl * s + hw * c, hz: hl * c + hw * s };
}

export interface Obstacle {
  xMin: number; xMax: number; zMin: number; zMax: number;
}

/** The frame is two triangular legs at x = +-frameWidth/2 running along Z; the space under
 * the cells between them is open, so robots may drive through the middle. */
export function hiveFrameObstacles(): Obstacle[] {
  const hx = m(HIVE.frameWidthIn) / 2, hz = m(HIVE.frameDepthIn) / 2;
  const legHalfThick = 0.03;
  return [
    { xMin: -hx - legHalfThick, xMax: -hx + legHalfThick, zMin: -hz, zMax: hz },
    { xMin: hx - legHalfThick, xMax: hx + legHalfThick, zMin: -hz, zMax: hz },
  ];
}
/** Each FLOWER's post cage, about 5.5 in square centred on its axis against the wall. */
export function flowerObstacles(): Obstacle[] {
  const half = m(2.75), off = m(FLOWER.axisFromWallIn);
  return FLOWER.positions.map((f) => {
    let x = m(f.x), z = m(f.z);
    switch (f.wall) { case "N": z += off; break; case "S": z -= off; break; case "E": x -= off; break; case "W": x += off; break; }
    return { xMin: x - half, xMax: x + half, zMin: z - half, zMax: z + half };
  });
}
/** Hive legs plus flowers: what a chassis can never overlap. */
export function fieldObstacles(): Obstacle[] { return [...hiveFrameObstacles(), ...flowerObstacles()]; }
/** @deprecated use hiveFrameObstacles */
export function hiveFrameObstacle(): Obstacle {
  return hiveFrameObstacles()[0];
}

/** Integrate one step and keep the robot inside the field and out of obstacles. */
/** Coulomb friction against the perimeter: a robot pressing into the wall at an angle does not glide along it. The
 * tangential speed is reduced by mu x the speed it is pushing into the wall with; below that it scrubs in place. Tank
 * wheels cannot roll sideways so they bind hard; mecanum rollers let the chassis crab along the wall more easily. */
export const WALL_MU: Record<Drivetrain, number> = { tank: 1.0, mecanum: 0.45 };
export function stepPose(pose: Pose, v: Velocity, dt: number, fp: Footprint, obstacles: Obstacle[] = hiveFrameObstacles(), wallMu = 0): Pose {
  const heading = wrapAngle(pose.heading + v.yawRate * dt);
  const half = m(FIELD.sizeIn) / 2;
  const { hx, hz } = worldHalfExtents(fp, heading);
  let vx = v.vx, vz = v.vz;
  if (wallMu > 0) {
    // already touching a wall and still pushing into it: friction eats the sliding component
    const atXWall = (pose.x >= half - hx - 0.002 && vx > 0) || (pose.x <= -half + hx + 0.002 && vx < 0);
    const atZWall = (pose.z >= half - hz - 0.002 && vz > 0) || (pose.z <= -half + hz + 0.002 && vz < 0);
    if (atXWall) { const slide = Math.max(0, Math.abs(vz) - wallMu * Math.abs(vx)); vz = Math.sign(vz) * slide; }
    if (atZWall) { const slide = Math.max(0, Math.abs(vx) - wallMu * Math.abs(vz)); vx = Math.sign(vx) * slide; }
  }
  let x = pose.x + vx * dt;
  let z = pose.z + vz * dt;
  x = clamp(x, -half + hx, half - hx);
  z = clamp(z, -half + hz, half - hz);
  // two passes: a push-out can land in another obstacle; the wall always wins (a robot can be pushed against the
  // perimeter by another robot, never through it)
  for (let pass = 0; pass < 2; pass++) {
    for (const o of obstacles) {
      const push = separateFromBox(x, z, heading, fp, o);
      if (push) { x += push.x; z += push.z; }
    }
    x = clamp(x, -half + hx, half - hx);
    z = clamp(z, -half + hz, half - hz);
  }
  return { x, z, heading };
}

/** Minimum translation that moves the ROTATED chassis rectangle out of an axis-aligned box (separating-axis test over
 * the box's two axes and the robot's two axes), or undefined when they do not overlap. Using the real outline instead
 * of its bounding box lets a turned robot get as close to a hive leg or flower cage as it really can. */
export function separateFromBox(x: number, z: number, heading: number, fp: Footprint, o: Obstacle): { x: number; z: number } | undefined {
  const f = forwardVector(heading), l = leftVector(heading);
  const hl = fp.lengthM / 2, hw = fp.widthM / 2;
  const robot = [
    { x: x + f.x * hl + l.x * hw, z: z + f.z * hl + l.z * hw }, { x: x + f.x * hl - l.x * hw, z: z + f.z * hl - l.z * hw },
    { x: x - f.x * hl + l.x * hw, z: z - f.z * hl + l.z * hw }, { x: x - f.x * hl - l.x * hw, z: z - f.z * hl - l.z * hw },
  ];
  const box = [{ x: o.xMin, z: o.zMin }, { x: o.xMax, z: o.zMin }, { x: o.xMin, z: o.zMax }, { x: o.xMax, z: o.zMax }];
  let best: { x: number; z: number } | undefined, bestOverlap = Infinity;
  for (const a of [{ x: 1, z: 0 }, { x: 0, z: 1 }, f, l]) {
    let rMin = Infinity, rMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const p of robot) { const d = p.x * a.x + p.z * a.z; rMin = Math.min(rMin, d); rMax = Math.max(rMax, d); }
    for (const p of box) { const d = p.x * a.x + p.z * a.z; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
    // the two ways to separate along this axis: move the robot back (-a) by rMax - bMin, or forward (+a) by bMax - rMin
    const back = rMax - bMin, fwd = bMax - rMin;
    if (back <= 0 || fwd <= 0) return undefined; // a separating axis: no contact
    const overlap = Math.min(back, fwd);
    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      const sign = back < fwd ? -1 : 1;
      best = { x: a.x * overlap * sign, z: a.z * overlap * sign };
    }
  }
  return best;
}

export function robotToWorld(pose: Pose, forwardM: number, leftM: number): { x: number; z: number } {
  const f = forwardVector(pose.heading), l = leftVector(pose.heading);
  return { x: pose.x + f.x * forwardM + l.x * leftM, z: pose.z + f.z * forwardM + l.z * leftM };
}

/** Heading (world yaw) that points the robot's forward at a world point. */
export function headingToward(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const dx = to.x - from.x, dz = to.z - from.z;
  // forward = (-sin h, -cos h) => h = atan2(-dx, -dz)
  return Math.atan2(-dx, -dz);
}

/** W/up points away from the driver alliance wall: red +X, blue -X. */
export function allianceDriveHeading(alliance: "red" | "blue"): number { return alliance === "red" ? -Math.PI / 2 : Math.PI / 2; }
