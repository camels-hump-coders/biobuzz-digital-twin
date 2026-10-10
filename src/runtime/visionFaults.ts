/**
 * Camera observation faults (handoff G06): wrong or duplicate decoded IDs, pose noise, dropouts, blur while turning,
 * and delivery latency, injected DOWNSTREAM of correct world geometry. Installed sticker IDs never change here; a
 * misread is a decoder fault, and the report says so. Pure.
 */
import type { TagPacket } from "./link";
import { gaussian, rng } from "../ballistics/dispersion";

export type PerceptionLevel = "ideal" | "faults" | "singles";
export interface CameraFaults {
  /** probability a visible tag is not decoded in a frame */
  dropoutProb: number;
  /** delivery delay; acquisition stamps are preserved so the OpMode sees frames this old */
  latencyMs: number;
  /** extra Gaussian noise on the camera-frame position, inches */
  poseNoiseIn: number;
  /** decoded-ID substitutions: physical tag id -> reported id (e.g. {"44": 45}) */
  misreadIds: Record<string, number>;
  /** tags reported twice per frame (the second copy slightly perturbed) */
  duplicateIds: number[];
  /** no detections while the robot turns faster than this, deg/s (motion blur); 0 = off */
  blurAboveDps: number;
  /** tags smaller than this many pixels across are not decoded; 0 = off */
  minPixels: number;
  /** detector frame rate, frames per second: between frames the OpMode keeps seeing the last processed frame with its
   * acquisition stamp ageing (the C270 pipeline ran at about 12 fps at decimation 1, 30 at the default); 0 = every
   * sensor tick (20 Hz) is a fresh frame */
  fpsCap: number;
}
export interface PerceptionSettings { level: PerceptionLevel; faults: CameraFaults }
export const NO_FAULTS: CameraFaults = { dropoutProb: 0, latencyMs: 0, poseNoiseIn: 0, misreadIds: {}, duplicateIds: [], blurAboveDps: 0, minPixels: 0, fpsCap: 0 };
export const DEFAULT_PERCEPTION: PerceptionSettings = { level: "ideal", faults: { ...NO_FAULTS } };
export const PERCEPTION_LEVELS: { id: PerceptionLevel; label: string; note: string }[] = [
  { id: "ideal", label: "Ideal geometry", note: "every visible tag decoded with its true pose (plus the Launcher-section tag noise); bypasses perception" },
  { id: "faults", label: "Parameterised faults", note: "the same observations through dropout, latency, misreads, duplicates, blur and size limits; an adversarial test, not a calibrated camera" },
  { id: "singles", label: "Individual tags", note: "every tag as an AprilTagSingleDetection (no SDK clusters), for code that assembles cells itself" },
];
export const UNSUPPORTED_PERCEPTION = ["pixels"]; // no camera frames exist in the twin

export interface FaultContext {
  /** |yaw rate| of the robot, deg/s */
  yawRateDps: number;
  /** pixel size per tag id (from the camera analysis), for minPixels */
  pixelsById?: Record<number, number>;
  /** deterministic random source; defaults to a fixed-seed generator */
  rnd?: () => number;
}

const defaultRnd = rng(4242);

/** Apply the faults to one camera's packets. `applied` names the faults that changed something this frame. */
export function applyFaults(packets: TagPacket[], f: CameraFaults, ctx: FaultContext): { out: TagPacket[]; applied: string[] } {
  const rnd = ctx.rnd ?? defaultRnd;
  const applied = new Set<string>();
  if (f.blurAboveDps > 0 && ctx.yawRateDps > f.blurAboveDps) { if (packets.length) applied.add("blur"); return { out: [], applied: [...applied] }; }
  const out: TagPacket[] = [];
  for (const p of packets) {
    if (f.minPixels > 0 && ctx.pixelsById && (ctx.pixelsById[p.id] ?? Infinity) < f.minPixels) { applied.add("minPixels"); continue; }
    if (f.dropoutProb > 0 && rnd() < f.dropoutProb) { applied.add("dropout"); continue; }
    let q: TagPacket = { ...p, R: [...p.R] };
    if (f.poseNoiseIn > 0) { q.x += gaussian(rnd) * f.poseNoiseIn; q.y += gaussian(rnd) * f.poseNoiseIn; q.z += gaussian(rnd) * f.poseNoiseIn; q = withDerived(q); applied.add("poseNoise"); }
    const mis = f.misreadIds[String(p.id)];
    if (mis !== undefined && mis !== p.id) { q.id = mis; applied.add("misread"); }
    out.push(q);
    if (f.duplicateIds.includes(p.id)) { const d = withDerived({ ...q, R: [...q.R], x: q.x + 0.3, y: q.y + 0.3 }); out.push(d); applied.add("duplicate"); }
  }
  return { out, applied: [...applied] };
}

function withDerived(p: TagPacket): TagPacket {
  const range = Math.hypot(p.x, p.y, p.z);
  const bearing = (Math.atan2(-p.x, p.y) * 180) / Math.PI;
  const elevation = (Math.atan2(p.z, Math.hypot(p.x, p.y)) * 180) / Math.PI;
  return { ...p, range, bearing, elevation };
}

/** The detector's own frame rate: a new frame is accepted only every 1000/fps ms; in between, the last processed frame
 * is what `getDetections()` keeps returning, its acquisition stamp fixed and therefore ageing. That is the real
 * pipeline's behaviour (and why a preview JPEG's age says nothing about the detector's). */
export class FrameCadence {
  private last?: { t: number; packets: TagPacket[] };
  /** returns the frame the detector holds now: the new one (fresh = true) or the previous one with its acquisition time */
  next(nowMs: number, packets: TagPacket[], fps: number): { t: number; packets: TagPacket[]; fresh: boolean } {
    if (fps <= 0 || !this.last || nowMs - this.last.t >= 1000 / fps - 1e-6) { this.last = { t: nowMs, packets }; return { ...this.last, fresh: true }; }
    return { ...this.last, fresh: false };
  }
  clear() { this.last = undefined; }
}

/** Delays delivery by `latencyMs` while keeping each frame's acquisition age so the OpMode's freshness logic sees it. */
export class LatencyQueue {
  private q: { t: number; packets: TagPacket[] }[] = [];
  /** push a frame acquired at `t` (ms); returns the frame due now (acquired at least latencyMs ago), with ageMs set */
  push(t: number, packets: TagPacket[], latencyMs: number, now = t): TagPacket[] | undefined {
    this.q.push({ t, packets });
    if (this.q.length > 400) this.q.splice(0, this.q.length - 400);
    return this.poll(now, latencyMs);
  }
  /** the frame due now without pushing a new one (the detector held its frame this tick); the last delivered frame
   * stays current, ageing, when nothing new is due */
  poll(now: number, latencyMs: number): TagPacket[] | undefined {
    let due: { t: number; packets: TagPacket[] } | undefined;
    while (this.q.length && now - this.q[0].t >= latencyMs) due = this.q.shift();
    if (due) this.delivered = due;
    if (!this.delivered) return undefined;
    const ageMs = Math.max(0, now - this.delivered.t);
    return this.delivered.packets.map((p) => ({ ...p, ageMs }));
  }
  private delivered?: { t: number; packets: TagPacket[] };
  clear() { this.q = []; this.delivered = undefined; }
}
