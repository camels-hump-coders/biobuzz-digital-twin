/**
 * Robot-vs-robot contact. Two chassis in contact push on each other with their wheel traction; the one that cannot
 * muster enough traction gives way. A robot driving against the push resists with full traction; an idle robot
 * (motors braking) skids sideways but can be rolled lengthwise; mecanum rollers give a little in every direction.
 * The perimeter always wins: a robot pushed against the wall stops the pusher (a PIN, see pinning.ts).
 */
import { type Drivetrain, type Footprint, type Pose, forwardVector, worldHalfExtents } from "./drive";
import { FIELD, m } from "../field/fieldSpec";
import { clamp } from "../util/units";

export const MU = 0.8; // rubber on foam tile
const G = 9.80665;

export interface ContactBody {
  pose: Pose;
  fp: Footprint;
  drivetrain: Drivetrain;
  massKg: number;
  /** world velocity the wheels are commanding (what the robot is trying to do), m/s */
  vx: number; vz: number;
}

/** Fraction of full traction a robot can set against being moved along unit normal (nx,nz). */
export function resistance(b: ContactBody, nx: number, nz: number): number {
  const speed = Math.hypot(b.vx, b.vz);
  const toward = b.vx * nx + b.vz * nz; // + = it is itself moving in the push direction
  if (speed > 0.05 && toward < -0.2 * speed) return 1; // driving against the push: all the traction it has
  const f = forwardVector(b.pose.heading);
  const along = Math.abs(f.x * nx + f.z * nz); // 1 when pushed along its own length
  if (b.drivetrain === "tank") return 0.45 + 0.55 * (1 - along); // skids sideways, rolls (braked motors) lengthwise
  return 0.55; // mecanum rollers give in every direction
}

/** Fraction of full traction a robot spends pushing toward (nx,nz): full once it drives at 0.5 m/s into the contact. */
export function effort(b: ContactBody, nx: number, nz: number): number {
  return clamp((b.vx * nx + b.vz * nz) / 0.5, 0, 1);
}

export interface ContactResult {
  a: Pose; b: Pose;
  contact: boolean;
  /** which body is doing the pushing (driving into the other), if any */
  pusher?: "a" | "b";
  /** how far the pushed body was displaced this frame (m) */
  pushedMoved: number;
  /** pushed body could not be moved (traction or the wall): the pusher is held */
  held: boolean;
}

export function resolveContact(a: ContactBody, b: ContactBody, prevA: Pose, prevB: Pose, dt: number): ContactResult {
  const ha = worldHalfExtents(a.fp, a.pose.heading), hb = worldHalfExtents(b.fp, b.pose.heading);
  const dx = b.pose.x - a.pose.x, dz = b.pose.z - a.pose.z;
  const px = ha.hx + hb.hx - Math.abs(dx), pz = ha.hz + hb.hz - Math.abs(dz);
  if (px <= 0 || pz <= 0) return { a: a.pose, b: b.pose, contact: false, pushedMoved: 0, held: false };
  // contact axis = least penetration; n points from a to b
  let nx = 0, nz = 0, pen: number, gap: number;
  if (px < pz) { nx = dx >= 0 ? 1 : -1; pen = px; gap = ha.hx + hb.hx; } else { nz = dz >= 0 ? 1 : -1; pen = pz; gap = ha.hz + hb.hz; }
  const Fa = effort(a, nx, nz) * MU * a.massKg * G; // a driving into b
  const Fb = effort(b, -nx, -nz) * MU * b.massKg * G; // b driving into a
  const half = m(FIELD.sizeIn) / 2;
  const clampPose = (p: Pose, h: { hx: number; hz: number }): Pose => ({ ...p, x: clamp(p.x, -half + h.hx, half - h.hx), z: clamp(p.z, -half + h.hz, half - h.hz) });
  let pa: Pose, pb: Pose, pusher: "a" | "b" | undefined;
  if (Fa === 0 && Fb === 0) {
    // neither is driving into the other (drift): split the overlap
    pa = clampPose({ ...a.pose, x: a.pose.x - nx * pen / 2, z: a.pose.z - nz * pen / 2 }, ha);
    pb = clampPose({ ...b.pose, x: b.pose.x + nx * pen / 2, z: b.pose.z + nz * pen / 2 }, hb);
  } else {
    pusher = Fa >= Fb ? "a" : "b";
    const P = pusher === "a" ? a : b, Q = pusher === "a" ? b : a; // pusher, pushed
    const prevQ = pusher === "a" ? prevB : prevA;
    const hP = pusher === "a" ? ha : hb, hQ = pusher === "a" ? hb : ha;
    const s = pusher === "a" ? 1 : -1; // direction the pushed body moves, along n
    const F = pusher === "a" ? Fa : Fb;
    const resist = resistance(Q, nx * s, nz * s) * MU * Q.massKg * G;
    const ratio = F > resist ? (F - resist) / F : 0; // 0 = stalemate, 1 = pushed body offers nothing
    const vP = (P.vx * nx + P.vz * nz) * s; // pusher's approach speed
    const vQ = (Q.vx * nx + Q.vz * nz) * s; // pushed body's own motion in that direction (negative = driving back)
    const vPair = Math.max(vP * ratio, Math.min(vQ, vP), 0);
    // unit direction the pushed body moves in
    const ux = nx * s, uz = nz * s;
    // pushed body: start from where it was before this frame, advance by the pair speed along u; keep its own motion across u
    let q: Pose = { ...Q.pose };
    if (nx !== 0) q.x = prevQ.x + ux * vPair * dt; else q.z = prevQ.z + uz * vPair * dt;
    q = clampPose(q, hQ); // the wall holds whatever the traction did not
    // pusher sits touching the pushed body, behind it along u
    let p: Pose = { ...P.pose };
    if (nx !== 0) p.x = q.x - ux * gap; else p.z = q.z - uz * gap;
    p = clampPose(p, hP);
    if (pusher === "a") { pa = p; pb = q; } else { pa = q; pb = p; }
  }
  const pushedMoved = pusher === "a" ? Math.abs((pb.x - prevB.x) * nx + (pb.z - prevB.z) * nz) : pusher === "b" ? Math.abs((pa.x - prevA.x) * nx + (pa.z - prevA.z) * nz) : 0;
  const held = pusher !== undefined && pushedMoved < 1e-4;
  return { a: pa, b: pb, contact: true, pusher, pushedMoved, held };
}
