/**
 * Ballistics worker: the pure-math parts of the twin (Monte Carlo dispersion, hit-probability and reachability maps)
 * run here so the main thread keeps its frame budget for physics, rendering and the camera-visibility probes that
 * need the scene. Map batches are processed in chunks and can be cancelled when the launcher or target changes.
 */
import { monteCarlo, type MonteCarlo, type NoiseConfig, type NominalLaunch } from "./dispersion";
import type { ShotRequest } from "./solver";
import { hitCell } from "./hitmap";
import { reachCell } from "./reachability";
import type { CellFrame } from "../field/hive";
import type { LauncherConfig } from "./launcher";
import type { BallProps } from "./projectile";

export type WorkerRequest =
  | { kind: "mc"; id: number; req: ShotRequest; nominal: NominalLaunch; noise: NoiseConfig; n: number; seed: number }
  | { kind: "hitmap"; id: number; cells: { x: number; z: number }[]; frame: CellFrame; launcher: LauncherConfig; ball: BallProps; noise: NoiseConfig; n: number }
  | { kind: "reach"; id: number; cells: { x: number; z: number }[]; frame: CellFrame; launcher: LauncherConfig; ball: BallProps }
  | { kind: "cancel"; id: number };
export type WorkerResponse =
  | { kind: "mc"; id: number; result: MonteCarlo }
  | { kind: "hitmap"; id: number; from: number; results: { pHit: number; rpm?: number }[] }
  | { kind: "reach"; id: number; from: number; results: { rpm?: number; elevationDeg?: number }[] };

const ctx = self as unknown as { postMessage(m: WorkerResponse): void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };
const cancelled = new Set<number>();
const CHUNK = 24;

function runBatch(msg: Extract<WorkerRequest, { kind: "hitmap" | "reach" }>, from = 0) {
  if (cancelled.has(msg.id)) { cancelled.delete(msg.id); return; }
  const end = Math.min(msg.cells.length, from + CHUNK);
  if (msg.kind === "hitmap") {
    const results = [] as { pHit: number; rpm?: number }[];
    for (let i = from; i < end; i++) results.push(hitCell(msg.cells[i].x, msg.cells[i].z, msg.frame, msg.launcher, msg.ball, msg.noise, msg.n));
    ctx.postMessage({ kind: "hitmap", id: msg.id, from, results });
  } else {
    const results = [] as { rpm?: number; elevationDeg?: number }[];
    for (let i = from; i < end; i++) results.push(reachCell(msg.cells[i].x, msg.cells[i].z, msg.frame, msg.launcher, msg.ball));
    ctx.postMessage({ kind: "reach", id: msg.id, from, results });
  }
  if (end < msg.cells.length) setTimeout(() => runBatch(msg, end), 0); // yield so a cancel or a Monte Carlo can slip in
}

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.kind === "cancel") { cancelled.add(msg.id); return; }
  if (msg.kind === "mc") { ctx.postMessage({ kind: "mc", id: msg.id, result: monteCarlo(msg.req, msg.nominal, msg.noise, msg.n, msg.seed) }); return; }
  runBatch(msg);
};
