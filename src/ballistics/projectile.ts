/** Point-mass projectile with quadratic drag and optional Magnus lift. SI units. */
import type { Vec3 } from "../field/hive";

export interface BallProps {
  massKg: number;
  diameterM: number;
  /** drag coefficient, ~0.45 for a smooth-ish sphere at these Reynolds numbers */
  cd: number;
  /** lift coefficient at spin ratio 1; 0 disables Magnus */
  cl: number;
}

export interface LaunchState {
  pos: Vec3;
  vel: Vec3;
  /** backspin rate in rad/s about the horizontal axis perpendicular to travel (positive = backspin) */
  spin: number;
}

export interface TrajectoryOptions {
  dt?: number;
  maxTime?: number;
  /** stop when below this height (ground) */
  floorY?: number;
  airDensity?: number;
  gravity?: number;
}

export interface TrajectorySample {
  t: number;
  pos: Vec3;
  vel: Vec3;
}

export function simulate(ball: BallProps, launch: LaunchState, opts: TrajectoryOptions = {}): TrajectorySample[] {
  const dt = opts.dt ?? 0.002;
  const maxTime = opts.maxTime ?? 4;
  const floorY = opts.floorY ?? 0;
  const rho = opts.airDensity ?? 1.225;
  const g = opts.gravity ?? 9.80665;
  const area = Math.PI * (ball.diameterM / 2) ** 2;
  const kDrag = (0.5 * rho * ball.cd * area) / ball.massKg;
  const kLift = (0.5 * rho * area) / ball.massKg;
  const r = ball.diameterM / 2;
  let { x, y, z } = launch.pos;
  let { x: vx, y: vy, z: vz } = launch.vel;
  const out: TrajectorySample[] = [{ t: 0, pos: { x, y, z }, vel: { x: vx, y: vy, z: vz } }];
  for (let t = dt; t <= maxTime; t += dt) {
    const speed = Math.hypot(vx, vy, vz) || 1e-9;
    let ax = -kDrag * speed * vx;
    let ay = -g - kDrag * speed * vy;
    let az = -kDrag * speed * vz;
    if (ball.cl > 0 && launch.spin !== 0) {
      // Spin axis: horizontal, perpendicular to horizontal travel direction. Backspin lifts.
      const hx = vx, hz = vz;
      const hl = Math.hypot(hx, hz) || 1e-9;
      const axisX = -hz / hl, axisZ = hx / hl; // axis = travel x up ... sign chosen so positive spin gives +y lift
      const spinRatio = (launch.spin * r) / speed;
      const cl = ball.cl * Math.min(spinRatio, 1);
      // lift direction = axis x velocity (unit)
      const lx = 0 * vz - axisZ * vy;
      const ly = axisZ * vx - axisX * vz;
      const lz = axisX * vy - 0 * vx;
      const ll = Math.hypot(lx, ly, lz) || 1e-9;
      const mag = kLift * cl * speed * speed;
      ax += (mag * lx) / ll;
      ay += (mag * ly) / ll;
      az += (mag * lz) / ll;
    }
    vx += ax * dt;
    vy += ay * dt;
    vz += az * dt;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    out.push({ t, pos: { x, y, z }, vel: { x: vx, y: vy, z: vz } });
    if (y < floorY && vy < 0) break;
  }
  return out;
}

/** Build a launch velocity from speed, elevation angle (rad) and horizontal heading (rad, measured in the XZ plane from +X toward -Z... we use heading as direction vector instead). */
export function velocityFrom(speed: number, elevation: number, dirXZ: { x: number; z: number }): Vec3 {
  const hl = Math.hypot(dirXZ.x, dirXZ.z) || 1;
  const h = speed * Math.cos(elevation);
  return { x: (h * dirXZ.x) / hl, y: speed * Math.sin(elevation), z: (h * dirXZ.z) / hl };
}
