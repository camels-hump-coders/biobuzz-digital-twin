/** Grid of field positions -> can the launcher hit the target cell from there, and at what RPM. */
import { type CellFrame, aimPoint } from "../field/hive";
import type { BallProps } from "./projectile";
import { type LauncherConfig, exitSpeed, rpmForExitSpeed, spinRate } from "./launcher";
import { scanElevations, solveSpeedForElevation } from "./solver";
import { FIELD, HIVE, m } from "../field/fieldSpec";

export interface ReachCell {
  x: number; z: number;
  /** required RPM at the best feasible hood angle, or undefined if unreachable */
  rpm?: number;
  elevationDeg?: number;
  /** false while an incremental job has not reached this square yet (undefined = computed, for plain maps) */
  computed?: boolean;
}

export interface ReachMap {
  cells: ReachCell[];
  stepM: number;
  maxRpm: number;
}

/** The field squares a map covers (frame legs skipped), in scan order. */
export function fieldSquares(stepIn: number): { x: number; z: number }[] {
  const step = m(stepIn);
  const half = m(FIELD.sizeIn) / 2;
  const hz = m(HIVE.frameDepthIn) / 2 + 0.2;
  const out: { x: number; z: number }[] = [];
  for (let x = -half + step / 2; x < half; x += step) {
    for (let z = -half + step / 2; z < half; z += step) {
      if (Math.abs(Math.abs(x) - m(HIVE.frameWidthIn) / 2) < 0.25 && Math.abs(z) < hz) continue; // on a frame leg
      out.push({ x, z });
    }
  }
  return out;
}

/** Best hood/RPM to hit the target from one square (pure math; also runs in the ballistics worker). */
export function reachCell(x: number, z: number, frame: CellFrame, launcher: LauncherConfig, ball: BallProps): { rpm?: number; elevationDeg?: number } {
  const target = aimPoint(frame, 0.05);
  const fixed = launcher.elevationMinDeg === launcher.elevationMaxDeg;
  const vmax = exitSpeed(launcher, launcher.maxRpm);
  const launchPos = { x, y: launcher.exitHeightM, z };
  const req = { ball, launchPos, target, frame, spin: spinRate(launcher) };
  if (fixed) {
    const r = solveSpeedForElevation(req, (launcher.elevationDeg * Math.PI) / 180, vmax);
    return r?.hit ? { rpm: rpmForExitSpeed(launcher, r.speed), elevationDeg: launcher.elevationDeg } : {};
  }
  const s = scanElevations(req, launcher.elevationMinDeg, launcher.elevationMaxDeg, 5, vmax);
  return s.best ? { rpm: rpmForExitSpeed(launcher, s.best.speed), elevationDeg: (s.best.elevationRad * 180) / Math.PI } : {};
}

export function computeReachability(frame: CellFrame, launcher: LauncherConfig, ball: BallProps, stepIn = 6): ReachMap {
  const cells: ReachCell[] = fieldSquares(stepIn).map((c) => ({ x: c.x, z: c.z, ...reachCell(c.x, c.z, frame, launcher, ball) }));
  return { cells, stepM: m(stepIn), maxRpm: launcher.maxRpm };
}

/** Incremental reachability map: a few squares per frame on the main thread, or the whole grid in the worker. */
export class ReachJob implements ReachMap {
  cells: ReachCell[];
  stepM: number;
  maxRpm: number;
  computed = 0;
  private frame: CellFrame; private launcher: LauncherConfig; private ball: BallProps;
  constructor(frame: CellFrame, launcher: LauncherConfig, ball: BallProps, stepIn = 6) {
    this.frame = frame; this.launcher = { ...launcher }; this.ball = ball;
    this.stepM = m(stepIn); this.maxRpm = launcher.maxRpm;
    this.cells = fieldSquares(stepIn).map((c) => ({ x: c.x, z: c.z, computed: false }));
  }
  get done() { return this.computed >= this.cells.length; }
  /** payload for the ballistics worker */
  batch() { return { cells: this.cells.map((c) => ({ x: c.x, z: c.z })), frame: this.frame, launcher: this.launcher, ball: this.ball }; }
  /** results from the worker, in cell order from `from` */
  accept(from: number, results: { rpm?: number; elevationDeg?: number }[]) {
    for (let i = 0; i < results.length; i++) { const c = this.cells[from + i]; if (!c || c.computed) continue; Object.assign(c, results[i]); c.computed = true; this.computed++; }
  }
  /** main-thread fallback: work for up to `budgetMs` */
  step(budgetMs: number): number {
    const t0 = performance.now();
    let k = 0;
    while (!this.done && performance.now() - t0 < budgetMs) {
      const c = this.cells[this.computed++];
      Object.assign(c, reachCell(c.x, c.z, this.frame, this.launcher, this.ball)); c.computed = true; k++;
    }
    return k;
  }
}
