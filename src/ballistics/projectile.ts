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

/** Acceleration on the ball (m/s^2): gravity, quadratic drag, Magnus lift from backspin. Shared by the
 * predictor and the live ball physics so they agree. */
export function acceleration(ball: BallProps, vx: number, vy: number, vz: number, spin: number, rho = 1.225, g = 9.80665): { ax: number; ay: number; az: number } {
  const area = Math.PI * (ball.diameterM / 2) ** 2;
  const kDrag = (0.5 * rho * ball.cd * area) / ball.massKg;
  const speed = Math.hypot(vx, vy, vz) || 1e-9;
  let ax = -kDrag * speed * vx, ay = -g - kDrag * speed * vy, az = -kDrag * speed * vz;
  if (ball.cl > 0 && spin !== 0) {
    const hl = Math.hypot(vx, vz) || 1e-9;
    const axisX = -vz / hl, axisZ = vx / hl;
    const spinRatio = (spin * (ball.diameterM / 2)) / speed;
    const cl = ball.cl * Math.min(spinRatio, 1);
    const lx = -axisZ * vy, ly = axisZ * vx - axisX * vz, lz = axisX * vy;
    const ll = Math.hypot(lx, ly, lz) || 1e-9;
    const mag = ((0.5 * rho * area) / ball.massKg) * cl * speed * speed;
    ax += (mag * lx) / ll; ay += (mag * ly) / ll; az += (mag * lz) / ll;
  }
  return { ax, ay, az };
}

export function simulate(ball: BallProps, launch: LaunchState, opts: TrajectoryOptions = {}): TrajectorySample[] {
  const dt = opts.dt ?? 0.002;
  const maxTime = opts.maxTime ?? 4;
  const floorY = opts.floorY ?? 0;
  const rho = opts.airDensity ?? 1.225;
  const g = opts.gravity ?? 9.80665;
  let { x, y, z } = launch.pos;
  let { x: vx, y: vy, z: vz } = launch.vel;
  const out: TrajectorySample[] = [{ t: 0, pos: { x, y, z }, vel: { x: vx, y: vy, z: vz } }];
  for (let t = dt; t <= maxTime; t += dt) {
    const { ax, ay, az } = acceleration(ball, vx, vy, vz, launch.spin, rho, g);
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
