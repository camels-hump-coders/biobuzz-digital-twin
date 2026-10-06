/** Find launch parameters that put a ball through the up-cell opening. */
import { type CellFrame, type Vec3, dot, openingProfile, pointInOpening, sub } from "../field/hive";
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
  /** launched from the pivot side and the arc would pass through the cell's roof before dropping in */
  blockedByCell?: boolean;
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
  let blockedByCell = false;
  if (cross) {
    // the opening is framed by ~12 mm tubes; the ball centre must clear them too
    const inside = pointInOpening(req.frame, cross.p, req.ball.diameterM / 2 + LIP_TUBE_RADIUS);
    const vn = -dot(cross.v, req.frame.normal); // component into the cell
    const vl = Math.hypot(cross.v.x, cross.v.y, cross.v.z) || 1e-9;
    entryAngleRad = Math.asin(Math.max(-1, Math.min(1, vn / vl)));
    hit = inside && vn > 0;
    // Launched from the pivot side ("behind" the hive): only the opening face is open, so the arc must clear the cell's
    // roof over its whole depth before it drops in over the top lip. The cell is a pentagonal prism: roof height = the
    // opening profile's apex along the frame's up axis, for the full cell depth behind the opening plane.
    if (hit && launchedFromBehind(req.launchPos, req.frame)) {
      const depth = cellDepthM();
      const roofU = openingApexU() + req.ball.diameterM / 2 + LIP_TUBE_RADIUS;
      let wasFront = false;
      for (const smp of samples) {
        const d = dot(sub(smp.pos, req.frame.openingCenter), req.frame.normal);
        if (d > 0) { wasFront = true; continue; } // over the lip and in front of the plane
        if (wasFront) break; // the inward crossing: everything after is inside the cell, as intended
        if (d > -depth - 0.03) { const u = dot(sub(smp.pos, req.frame.floorCenterAtOpening), req.frame.up); if (u < roofU) { blockedByCell = true; hit = false; break; } }
      }
    }
  }
  return { elevationRad, speed, samples, crossing: cross?.p, hit, heightError, entryAngleRad, blockedByCell };
}
/** "Behind" is decided horizontally (the opening plane leans back, so a close shot in front of the cell can sit behind
 * the infinite plane while still being in front of the hive). */
export function launchedFromBehind(launchPos: Vec3, frame: CellFrame): boolean {
  const nh = Math.hypot(frame.normal.x, frame.normal.z) || 1e-9;
  return ((launchPos.x - frame.openingCenter.x) * frame.normal.x + (launchPos.z - frame.openingCenter.z) * frame.normal.z) / nh < 0;
}
function cellDepthM(): number { return (HIVE_CELL_DEPTH_IN * 0.0254); }
function openingApexU(): number { return Math.max(...openingProfile().map((q) => q.u)); }
const HIVE_CELL_DEPTH_IN = 12.04;

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

/** How far inside the opening to aim, from the entry angle: a steep descending arc must cross the opening plane near
 * its centre (aiming deeper would push the crossing toward the far lip by inside x tan(entry)); a shallow or rising
 * arc may aim deeper so it carries into the cell. 2 in at 45 deg, 0.5 in at 75 deg, capped at 4 in for flat entries. */
export function adaptiveAimInsideM(entryAngleRad: number): number {
  const t = Math.tan(Math.max(0.05, Math.abs(entryAngleRad)));
  return Math.max(0, Math.min(0.10, 0.05 / t));
}

/** Solve the exit speed for a fixed elevation with the aim depth adapted to the resulting entry angle (two passes
 * converge in practice). Returns the final target used, so callers evaluate against the same point. */
export function solveSpeedAdaptive(ball: BallProps, launchPos: Vec3, frame: CellFrame, elevationRad: number, maxSpeed: number, spin = 0): { result?: ShotResult; target: Vec3; insideM: number } {
  // From the pivot side the ball clears the roof and drops onto the leaning opening plane at a shallow angle; any
  // depth offset moves the crossing by depth / sin(entry), so aim at the plane's centre itself (depth 0).
  if (launchedFromBehind(launchPos, frame)) {
    const target = aimPointInside(frame, 0);
    return { result: solveSpeedForElevation({ ball, launchPos, target, frame, spin }, elevationRad, maxSpeed), target, insideM: 0 };
  }
  let insideM = 0.05;
  let target = aimPointInside(frame, insideM);
  let result = solveSpeedForElevation({ ball, launchPos, target, frame, spin }, elevationRad, maxSpeed);
  for (let pass = 0; pass < 2 && result?.entryAngleRad !== undefined; pass++) {
    const next = adaptiveAimInsideM(result.entryAngleRad);
    if (Math.abs(next - insideM) < 0.002) break;
    insideM = next; target = aimPointInside(frame, insideM);
    result = solveSpeedForElevation({ ball, launchPos, target, frame, spin }, elevationRad, maxSpeed);
  }
  return { result, target, insideM };
}
function aimPointInside(frame: CellFrame, insideM: number): Vec3 {
  return { x: frame.openingCenter.x - frame.normal.x * insideM, y: frame.openingCenter.y - frame.normal.y * insideM, z: frame.openingCenter.z - frame.normal.z * insideM };
}
