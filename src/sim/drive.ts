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
    // field-centric: forward = toward scoring side (-Z), left = toward red (-X)
    fx = 0; fz = -1; lx = -1; lz = 0;
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
export function stepPose(pose: Pose, v: Velocity, dt: number, fp: Footprint, obstacles: Obstacle[] = hiveFrameObstacles()): Pose {
  const heading = wrapAngle(pose.heading + v.yawRate * dt);
  let x = pose.x + v.vx * dt;
  let z = pose.z + v.vz * dt;
  const half = m(FIELD.sizeIn) / 2;
  const { hx, hz } = worldHalfExtents(fp, heading);
  x = clamp(x, -half + hx, half - hx);
  z = clamp(z, -half + hz, half - hz);
  // two passes: a push-out can land in another obstacle; the wall always wins (a robot can be pushed against the
  // perimeter by another robot, never through it)
  for (let pass = 0; pass < 2; pass++) {
    for (const o of obstacles) {
      // expanded obstacle vs robot centre; push out along the axis of least penetration
      const ex0 = o.xMin - hx, ex1 = o.xMax + hx, ez0 = o.zMin - hz, ez1 = o.zMax + hz;
      if (x > ex0 && x < ex1 && z > ez0 && z < ez1) {
        const dxl = x - ex0, dxr = ex1 - x, dzl = z - ez0, dzr = ez1 - z;
        const mn = Math.min(dxl, dxr, dzl, dzr);
        if (mn === dxl) x = ex0; else if (mn === dxr) x = ex1; else if (mn === dzl) z = ez0; else z = ez1;
      }
    }
    x = clamp(x, -half + hx, half - hx);
    z = clamp(z, -half + hz, half - hz);
  }
  return { x, z, heading };
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
