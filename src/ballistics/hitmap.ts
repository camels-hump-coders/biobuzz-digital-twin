/**
 * Field-wide hit probability: for every 6 in square, aim at the target cell, pick the hood/RPM the launcher would use
 * from there and run a small Monte Carlo with the configured shot variability. Computed incrementally (a few cells per
 * frame) so the map fills in while the user keeps tweaking the launcher, noise or cameras.
 */
import { type CellFrame, aimPoint } from "../field/hive";
import type { BallProps } from "./projectile";
import { type LauncherConfig, exitSpeed, rpmForExitSpeed, spinRate } from "./launcher";
import { scanElevations, solveSpeedAdaptive } from "./solver";
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

/**
 * The launcher fields the map depends on. Deliberately not the whole config: `rpm` is rewritten every frame by the
 * actuator model (flywheel spinning up or down under TeamCode) and by auto-RPM, and the map picks its own speed per
 * square, so keying on it restarted the job over and over while the robot stood still. `elevationDeg` only matters
 * for a fixed hood; with an adjustable hood the map scans the whole range.
 */
export function hitMapLauncherKey(l: LauncherConfig): unknown[] {
  const fixed = l.elevationMinDeg === l.elevationMaxDeg;
  return [l.kind, l.wheelDiameterM, l.maxRpm, l.efficiency, fixed ? l.elevationDeg : undefined, l.elevationMinDeg, l.elevationMaxDeg,
    l.exitForwardM, l.exitLeftM, l.exitHeightM, l.yawOffsetDeg, l.turretMinDeg, l.turretMaxDeg, l.spinFraction];
}

/** Hit probability and RPM for one square (pure math; also runs in the ballistics worker). */
export function hitCell(x: number, z: number, frame: CellFrame, l: LauncherConfig, ball: BallProps, noise: NoiseConfig, n: number): { pHit: number; rpm?: number } {
  const target = aimPoint(frame, 0.05);
  const fixed = l.elevationMinDeg === l.elevationMaxDeg;
  const vmax = exitSpeed(l, l.maxRpm);
  const launchPos = { x, y: l.exitHeightM, z };
  let req = { ball, launchPos, target, frame, spin: spinRate(l) };
  let speed: number | undefined, elev: number | undefined;
  if (fixed) {
    const ad = solveSpeedAdaptive(ball, launchPos, frame, (l.elevationDeg * Math.PI) / 180, vmax, spinRate(l));
    req = { ...req, target: ad.target };
    if (ad.result?.hit) { speed = ad.result.speed; elev = (l.elevationDeg * Math.PI) / 180; }
  } else {
    const s = scanElevations(req, l.elevationMinDeg, l.elevationMaxDeg, 5, vmax);
    if (s.best) { speed = s.best.speed; elev = s.best.elevationRad; }
  }
  if (speed === undefined || elev === undefined || rpmForExitSpeed(l, speed) > l.maxRpm) return { pHit: 0 };
  const dx = target.x - x, dz = target.z - z, d = Math.hypot(dx, dz) || 1;
  const mc = monteCarlo(req, { speed, elevationRad: elev, dirXZ: { x: dx / d, z: dz / d }, spin: spinRate(l, rpmForExitSpeed(l, speed)) }, noise, n, 3);
  return { pHit: mc.pHit, rpm: rpmForExitSpeed(l, speed) };
}

export class HitMapJob implements HitMap {
  cells: HitCell[] = [];
  stepM: number;
  computed = 0;
  private target: { x: number; y: number; z: number };
  private frame: CellFrame; private launcher: LauncherConfig; private ball: BallProps; private noise: NoiseConfig; private n: number;
  constructor(frame: CellFrame, launcher: LauncherConfig, ball: BallProps, noise: NoiseConfig, stepIn = 6, n = 40) {
    this.frame = frame; this.launcher = { ...launcher }; this.ball = ball; this.noise = noise; this.n = n;
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
  /** true once the ballistics worker owns the probability maths; the main thread then only probes camera visibility */
  offloaded = false;
  /** squares whose probability has arrived from the worker (visibility may still be pending) */
  private arrived = 0;
  /** payload for the ballistics worker (cells in compute order: nearest the target first) */
  batch() { return { cells: this.cells.map((c) => ({ x: c.x, z: c.z })), frame: this.frame, launcher: this.launcher, ball: this.ball, noise: this.noise, n: this.n }; }
  /** probabilities from the worker, in cell order from `from` */
  accept(from: number, results: { pHit: number; rpm?: number }[]) {
    for (let i = 0; i < results.length; i++) { const c = this.cells[from + i]; if (!c || c.pHit !== undefined) continue; c.pHit = results[i].pHit; c.rpm = results[i].rpm; this.arrived++; }
  }

  /** Work for up to `budgetMs`; `visibility` (optional, needs the scene) is asked once per cell. Returns cells finished. */
  step(budgetMs: number, visibility?: (x: number, z: number) => boolean): number {
    const t0 = performance.now();
    let k = 0;
    if (this.offloaded) {
      // the worker fills pHit; here only the camera-visibility probe (needs the scene) runs, for squares that have arrived
      while (this.computed < this.arrived && performance.now() - t0 < budgetMs) {
        const c = this.cells[this.computed++];
        k++;
        if (visibility) c.visible = visibility(c.x, c.z);
      }
      return k;
    }
    while (!this.done && performance.now() - t0 < budgetMs) {
      const c = this.cells[this.computed++];
      k++;
      const r = hitCell(c.x, c.z, this.frame, this.launcher, this.ball, this.noise, this.n);
      c.pHit = r.pHit; c.rpm = r.rpm;
      if (visibility) c.visible = visibility(c.x, c.z);
    }
    return k;
  }
}
