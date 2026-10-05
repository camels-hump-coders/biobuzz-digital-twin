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
}

export interface ReachMap {
  cells: ReachCell[];
  stepM: number;
  maxRpm: number;
}

export function computeReachability(frame: CellFrame, launcher: LauncherConfig, ball: BallProps, stepIn = 6): ReachMap {
  const step = m(stepIn);
  const half = m(FIELD.sizeIn) / 2;
  const target = aimPoint(frame, 0.05);
  const cells: ReachCell[] = [];
  const hz = m(HIVE.frameDepthIn) / 2 + 0.2;
  const fixed = launcher.elevationMinDeg === launcher.elevationMaxDeg;
  const vmax = exitSpeed(launcher, launcher.maxRpm);
  for (let x = -half + step / 2; x < half; x += step) {
    for (let z = -half + step / 2; z < half; z += step) {
      if (Math.abs(Math.abs(x) - m(HIVE.frameWidthIn) / 2) < 0.25 && Math.abs(z) < hz) continue; // on a frame leg
      const launchPos = { x, y: launcher.exitHeightM, z };
      const req = { ball, launchPos, target, frame, spin: spinRate(launcher) };
      let rpm: number | undefined, elevationDeg: number | undefined;
      if (fixed) {
        const r = solveSpeedForElevation(req, (launcher.elevationDeg * Math.PI) / 180, vmax);
        if (r?.hit) { rpm = rpmForExitSpeed(launcher, r.speed); elevationDeg = launcher.elevationDeg; }
      } else {
        const s = scanElevations(req, launcher.elevationMinDeg, launcher.elevationMaxDeg, 5, vmax);
        if (s.best) { rpm = rpmForExitSpeed(launcher, s.best.speed); elevationDeg = (s.best.elevationRad * 180) / Math.PI; }
      }
      cells.push({ x, z, rpm, elevationDeg });
    }
  }
  return { cells, stepM: step, maxRpm: launcher.maxRpm };
}
