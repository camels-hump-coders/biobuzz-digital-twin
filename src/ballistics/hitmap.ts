/**
 * Field-wide hit probability: for every 6 in square, aim at the target cell, pick the hood/RPM the launcher would use
 * from there and run a small Monte Carlo with the configured shot variability. Computed incrementally (a few cells per
 * frame) so the map fills in while the user keeps tweaking the launcher, noise or cameras.
 */
import { type CellFrame, aimPoint } from "../field/hive";
import type { BallProps } from "./projectile";
import { type LauncherConfig, exitSpeed, rpmForExitSpeed, spinRate } from "./launcher";
import { scanElevations, solveSpeedForElevation } from "./solver";
import { type NoiseConfig, monteCarlo } from "./dispersion";
import { FIELD, HIVE, m } from "../field/fieldSpec";

export interface HitCell {
  x: number; z: number;
  /** probability of landing in the target cell when aimed from here; undefined = not computed yet */
  pHit?: number;
  rpm?: number;
  /** does the selected camera see at least one AprilTag of the target cell from here (needed for auto-aim)? */
  visible?: boolean;
}

export interface HitMap { cells: HitCell[]; stepM: number; computed: number }

export class HitMapJob implements HitMap {
  cells: HitCell[] = [];
  stepM: number;
  computed = 0;
  private target: { x: number; y: number; z: number };
  private frame: CellFrame; private launcher: LauncherConfig; private ball: BallProps; private noise: NoiseConfig; private n: number;
  constructor(frame: CellFrame, launcher: LauncherConfig, ball: BallProps, noise: NoiseConfig, stepIn = 6, n = 40) {
    this.frame = frame; this.launcher = launcher; this.ball = ball; this.noise = noise; this.n = n;
    this.stepM = m(stepIn);
    const half = m(FIELD.sizeIn) / 2;
    const hz = m(HIVE.frameDepthIn) / 2 + 0.2;
    this.target = aimPoint(frame, 0.05);
    for (let x = -half + this.stepM / 2; x < half; x += this.stepM) {
      for (let z = -half + this.stepM / 2; z < half; z += this.stepM) {
        if (Math.abs(Math.abs(x) - m(HIVE.frameWidthIn) / 2) < 0.25 && Math.abs(z) < hz) continue; // on a frame leg
        this.cells.push({ x, z });
      }
    }
    // compute the cells nearest the target first: that is where the interesting gradient is
    this.cells.sort((a, b) => Math.hypot(a.x - this.target.x, a.z - this.target.z) - Math.hypot(b.x - this.target.x, b.z - this.target.z));
  }
  get done() { return this.computed >= this.cells.length; }

  /** Work for up to `budgetMs`; `visibility` (optional, needs the scene) is asked once per cell. Returns cells finished. */
  step(budgetMs: number, visibility?: (x: number, z: number) => boolean): number {
    const t0 = performance.now();
    let k = 0;
    const l = this.launcher;
    const fixed = l.elevationMinDeg === l.elevationMaxDeg;
    const vmax = exitSpeed(l, l.maxRpm);
    while (!this.done && performance.now() - t0 < budgetMs) {
      const c = this.cells[this.computed++];
      k++;
      const launchPos = { x: c.x, y: l.exitHeightM, z: c.z };
      const req = { ball: this.ball, launchPos, target: this.target, frame: this.frame, spin: spinRate(l) };
      let speed: number | undefined, elev: number | undefined;
      if (fixed) {
        const r = solveSpeedForElevation(req, (l.elevationDeg * Math.PI) / 180, vmax);
        if (r?.hit) { speed = r.speed; elev = (l.elevationDeg * Math.PI) / 180; }
      } else {
        const s = scanElevations(req, l.elevationMinDeg, l.elevationMaxDeg, 5, vmax);
        if (s.best) { speed = s.best.speed; elev = s.best.elevationRad; }
      }
      if (speed === undefined || elev === undefined || rpmForExitSpeed(l, speed) > l.maxRpm) { c.pHit = 0; }
      else {
        const dx = this.target.x - c.x, dz = this.target.z - c.z, d = Math.hypot(dx, dz) || 1;
        const mc = monteCarlo(req, { speed, elevationRad: elev, dirXZ: { x: dx / d, z: dz / d }, spin: spinRate(l, rpmForExitSpeed(l, speed)) }, this.noise, this.n, 3);
        c.pHit = mc.pHit; c.rpm = rpmForExitSpeed(l, speed);
      }
      if (visibility) c.visible = visibility(c.x, c.z);
    }
    return k;
  }
}
