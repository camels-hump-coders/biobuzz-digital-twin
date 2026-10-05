/** Find launch parameters that put a ball through the up-cell opening. */
import { type CellFrame, type Vec3, dot, pointInOpening, sub } from "../field/hive";
import { type BallProps, simulate, velocityFrom, type TrajectorySample } from "./projectile";

/** radius of the coloured frame tubes around the CELL opening (m) */
export const LIP_TUBE_RADIUS = 0.012;

export interface ShotResult {
  elevationRad: number;
  speed: number;
  samples: TrajectorySample[];
  /** where the arc crosses the opening plane, if it does */
  crossing?: Vec3;
  /** true if the crossing is inside the opening polygon (shrunk by ball radius) and descending into it */
  hit: boolean;
  /** vertical miss at the aim range, metres (+ above target) */
  heightError: number;
  /** angle between incoming velocity and the opening plane, rad (larger = steeper entry) */
  entryAngleRad?: number;
}

export interface ShotRequest {
  ball: BallProps;
  launchPos: Vec3;
  target: Vec3;
  frame: CellFrame;
  spin?: number;
}

/** Height of the arc when it reaches the target's horizontal range. */
function heightAtRange(samples: TrajectorySample[], launchPos: Vec3, target: Vec3): number | undefined {
  const dx = target.x - launchPos.x;
  const dz = target.z - launchPos.z;
  const range = Math.hypot(dx, dz);
  const ux = dx / range, uz = dz / range;
  let prev = samples[0];
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const d = (s.pos.x - launchPos.x) * ux + (s.pos.z - launchPos.z) * uz;
    if (d >= range) {
      const dp = (prev.pos.x - launchPos.x) * ux + (prev.pos.z - launchPos.z) * uz;
      const f = (range - dp) / Math.max(1e-9, d - dp);
      return prev.pos.y + (s.pos.y - prev.pos.y) * f;
    }
    prev = s;
  }
  return undefined; // fell short
}

/** Find where the arc crosses the opening plane while moving into the cell. */
function planeCrossing(samples: TrajectorySample[], frame: CellFrame): { p: Vec3; v: Vec3 } | undefined {
  const n = frame.normal;
  const o = frame.openingCenter;
  let prevD = dot(sub(samples[0].pos, o), n);
  for (let i = 1; i < samples.length; i++) {
    const d = dot(sub(samples[i].pos, o), n);
    if (prevD > 0 && d <= 0) {
      const f = prevD / (prevD - d);
      const a = samples[i - 1].pos, b = samples[i].pos;
      const va = samples[i - 1].vel;
      return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f }, v: va };
    }
    prevD = d;
  }
  return undefined;
}

export function evaluateShot(req: ShotRequest, elevationRad: number, speed: number): ShotResult {
  const dir = { x: req.target.x - req.launchPos.x, z: req.target.z - req.launchPos.z };
  return evaluateVelocity(req, velocityFrom(speed, elevationRad, dir), elevationRad, speed);
}

/** Evaluate an arbitrary launch velocity (e.g. the direction the launcher actually points). */
export function evaluateVelocity(req: ShotRequest, vel: Vec3, elevationRad = Math.atan2(vel.y, Math.hypot(vel.x, vel.z)), speed = Math.hypot(vel.x, vel.y, vel.z)): ShotResult {
  const samples = simulate(req.ball, { pos: req.launchPos, vel, spin: req.spin ?? 0 }, { maxTime: 3 });
  const h = heightAtRange(samples, req.launchPos, req.target);
  const heightError = h === undefined ? -Infinity : h - req.target.y;
  const cross = planeCrossing(samples, req.frame);
  let hit = false;
  let entryAngleRad: number | undefined;
  if (cross) {
    // the opening is framed by ~12 mm tubes; the ball centre must clear them too
    const inside = pointInOpening(req.frame, cross.p, req.ball.diameterM / 2 + LIP_TUBE_RADIUS);
    const vn = -dot(cross.v, req.frame.normal); // component into the cell
    const vl = Math.hypot(cross.v.x, cross.v.y, cross.v.z) || 1e-9;
    entryAngleRad = Math.asin(Math.max(-1, Math.min(1, vn / vl)));
    hit = inside && vn > 0;
  }
  return { elevationRad, speed, samples, crossing: cross?.p, hit, heightError, entryAngleRad };
}

/** For a fixed elevation, bisection on speed so the arc passes through the target point. */
export function solveSpeedForElevation(req: ShotRequest, elevationRad: number, maxSpeed = 25): ShotResult | undefined {
  // monotonic enough: higher speed -> higher at range (for angles above the flat-shot threshold)
  let lo = 0.5, hi = maxSpeed;
  const fHi = evaluateShot(req, elevationRad, hi).heightError;
  if (!(fHi > 0)) return undefined; // cannot reach even at max speed
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const e = evaluateShot(req, elevationRad, mid).heightError;
    if (e > 0) hi = mid; else lo = mid;
    if (hi - lo < 1e-3) break;
  }
  return evaluateShot(req, elevationRad, (lo + hi) / 2);
}

export interface ScanResult {
  solutions: ShotResult[];
  /** lowest-speed solution that is a hit */
  best?: ShotResult;
}

/** Scan a range of elevations, solving speed for each, and keep hits. */
export function scanElevations(req: ShotRequest, minDeg: number, maxDeg: number, stepDeg = 2.5, maxSpeed = 25): ScanResult {
  const solutions: ShotResult[] = [];
  for (let d = minDeg; d <= maxDeg + 1e-9; d += stepDeg) {
    const r = solveSpeedForElevation(req, (d * Math.PI) / 180, maxSpeed);
    if (r) solutions.push(r);
  }
  const hits = solutions.filter((s) => s.hit);
  hits.sort((a, b) => a.speed - b.speed);
  return { solutions, best: hits[0] };
}

/** Analytic no-drag speed for sanity checks and seeds. */
export function vacuumSpeed(range: number, dy: number, elevationRad: number, g = 9.80665): number | undefined {
  const c = Math.cos(elevationRad), t = Math.tan(elevationRad);
  const denom = 2 * c * c * (range * t - dy);
  if (denom <= 0) return undefined;
  return Math.sqrt((g * range * range) / denom);
}
