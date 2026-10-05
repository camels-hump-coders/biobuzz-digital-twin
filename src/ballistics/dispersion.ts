/** Shot-to-shot variability and Monte Carlo hit probability. */
import type { CellFrame, Vec3 } from "../field/hive";
import { evaluateVelocity, type ShotRequest, type ShotResult } from "./solver";

export interface NoiseConfig {
  /** 1-sigma exit speed error as a fraction of speed (flywheel droop, ball compression, slip) */
  speedFrac: number;
  /** 1-sigma elevation error, degrees (hood tolerance, ball seating) */
  elevationDeg: number;
  /** 1-sigma yaw error, degrees (side spin, hood guides) */
  yawDeg: number;
  /** 1-sigma backspin variation as a fraction of nominal spin */
  spinFrac: number;
}

export const DEFAULT_NOISE: NoiseConfig = { speedFrac: 0.03, elevationDeg: 1.0, yawDeg: 1.0, spinFrac: 0.2 };

/** Small deterministic PRNG (mulberry32) so a given position gives a stable cloud. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(r: () => number): number {
  const u = Math.max(1e-12, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface NominalLaunch {
  speed: number;
  elevationRad: number;
  /** horizontal heading as a unit XZ direction */
  dirXZ: { x: number; z: number };
  spin: number;
}

/** Apply one random perturbation to a nominal launch. */
export function perturb(n: NominalLaunch, noise: NoiseConfig, r: () => number): NominalLaunch & { vel: Vec3 } {
  const speed = n.speed * (1 + noise.speedFrac * gaussian(r));
  const el = n.elevationRad + (noise.elevationDeg * Math.PI / 180) * gaussian(r);
  const yaw = (noise.yawDeg * Math.PI / 180) * gaussian(r);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const dx = n.dirXZ.x * c - n.dirXZ.z * s, dz = n.dirXZ.x * s + n.dirXZ.z * c;
  const l = Math.hypot(dx, dz) || 1;
  const h = speed * Math.cos(el);
  const spin = n.spin * (1 + noise.spinFrac * gaussian(r));
  return { speed, elevationRad: el, dirXZ: { x: dx / l, z: dz / l }, spin, vel: { x: (h * dx) / l, y: speed * Math.sin(el), z: (h * dz) / l } };
}

export interface MonteCarlo {
  n: number;
  hits: number;
  pHit: number;
  /** 95% Wilson interval on pHit */
  lo: number;
  hi: number;
  /** crossing points on the opening plane (or last sample if it never crossed) */
  points: { p: Vec3; hit: boolean }[];
  /** mean miss distance of misses from the aim point, metres */
  meanMissM: number;
}

export function monteCarlo(req: ShotRequest, nominal: NominalLaunch, noise: NoiseConfig, n = 150, seed = 1): MonteCarlo {
  const r = rng(seed);
  let hits = 0;
  const points: MonteCarlo["points"] = [];
  let missSum = 0, missN = 0;
  for (let i = 0; i < n; i++) {
    const s = perturb(nominal, noise, r);
    const res: ShotResult = evaluateVelocity({ ...req, spin: s.spin }, s.vel, s.elevationRad, s.speed);
    if (res.hit) hits++;
    const p = res.crossing ?? res.samples[res.samples.length - 1].pos;
    points.push({ p, hit: res.hit });
    if (!res.hit) { missSum += Math.hypot(p.x - req.target.x, p.y - req.target.y, p.z - req.target.z); missN++; }
  }
  const pHit = hits / n;
  const z = 1.96, denom = 1 + (z * z) / n;
  const centre = (pHit + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((pHit * (1 - pHit)) / n + (z * z) / (4 * n * n))) / denom;
  return { n, hits, pHit, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), points, meanMissM: missN ? missSum / missN : 0 };
}

export function frameAimDir(frame: CellFrame, from: Vec3, target: Vec3): { x: number; z: number } {
  void frame;
  const dx = target.x - from.x, dz = target.z - from.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}
