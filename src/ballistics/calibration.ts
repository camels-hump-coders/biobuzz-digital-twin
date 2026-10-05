/** Shooter calibration: fit the twin's launcher model to shots measured on the real robot.
 *
 * Protocol: park the robot square to a wall, spin the flywheel at a known power, fire one ball and note where it hit
 * (height on the wall, or the floor distance if it fell short). Each shot is one point on a trajectory; the fitter
 * adjusts the launcher knobs (efficiency = exit speed / wheel surface speed, hood elevation, optional backspin) until
 * the twin's own flight model (drag + Magnus, see projectile.ts) reproduces every point. Pure and unit-tested. */
import { acceleration, type BallProps } from "./projectile";
import type { LauncherConfig } from "./launcher";

export type ImpactKind = "wall" | "floor";

export interface CalShot {
  id: number;
  /** flywheel motor power the OpMode commanded (0..1) */
  power: number;
  /** measured flywheel speed (RPM) if the OpMode reported it; otherwise derived from power x free speed */
  rpm?: number;
  /** horizontal distance from the launcher exit to the wall plane (wall shots) or along the shot line (floor shots), metres */
  distanceM: number;
  kind: ImpactKind;
  /** wall shots: impact height above the floor, metres. Floor shots: landing distance from the exit, metres */
  measuredM: number;
  /** sideways offset of the impact from the shot line, metres (positive = left), optional */
  lateralM?: number;
  /** battery voltage at the shot, informational */
  volts?: number;
  note?: string;
}

export interface CalSetup {
  /** distance from the wall to the bumper that faces it, metres */
  bumperDistanceM: number;
  /** measured height of the ball exit above the floor, metres */
  exitHeightM: number;
  /** flywheel power levels and bumper distances the wizard asks for, in the order it suggests them */
  powers: number[];
  bumperDistancesIn: number[];
  /** shots wanted per (power, distance) slot */
  perSlot: number;
}

export interface CalibrationSession {
  setup: CalSetup;
  shots: CalShot[];
  /** shots announced by the OpMode (log lines) that still need an impact measurement */
  inbox: { id: number; power: number; rpm?: number; volts?: number }[];
  nextId: number;
  fitSpin: boolean;
}

export function defaultCalibration(exitHeightM = 0.31): CalibrationSession {
  return {
    setup: { bumperDistanceM: 48 * 0.0254, exitHeightM, powers: [0.5, 0.65, 0.8, 1], bumperDistancesIn: [48, 96], perSlot: 2 },
    shots: [],
    inbox: [],
    nextId: 1,
    fitSpin: false,
  };
}

/** Horizontal distance from the ball exit to the wall when the bumper the launcher fires over is `bumper` metres from it. */
export function exitToWallDistance(bumperM: number, launcher: Pick<LauncherConfig, "exitForwardM" | "yawOffsetDeg">, robotLengthM: number): number {
  // the launcher fires along yawOffset relative to the robot's forward arrow; the exit sits exitForward along that arrow
  const toward = Math.cos((launcher.yawOffsetDeg * Math.PI) / 180); // +1 fires forward, -1 fires out the back
  return bumperM + robotLengthM / 2 - launcher.exitForwardM * toward;
}

export interface FlightModel {
  ball: BallProps;
  wheelDiameterM: number;
  /** flywheel motor free speed (RPM) used to turn power into RPM when a shot has no measurement */
  freeRpm: number;
  exitHeightM: number;
}

export interface Params { efficiency: number; elevationDeg: number; spinFraction: number }

export function shotRpm(shot: Pick<CalShot, "power" | "rpm">, freeRpm: number): number {
  return shot.rpm !== undefined && shot.rpm > 0 ? shot.rpm : shot.power * freeRpm;
}

/** Side-view trajectory (x along the shot, y up) for one shot under these parameters. */
export function trajectory(model: FlightModel, p: Params, rpm: number, dt = 0.002, maxX = 8): { x: number; y: number; vy: number }[] {
  const surface = (Math.PI * model.wheelDiameterM * rpm) / 60;
  const speed = surface * p.efficiency;
  const spin = ((rpm * 2 * Math.PI) / 60) * p.spinFraction;
  const el = (p.elevationDeg * Math.PI) / 180;
  let x = 0, y = model.exitHeightM, vx = speed * Math.cos(el), vy = speed * Math.sin(el);
  const out = [{ x, y, vy }];
  for (let t = 0; t < 6 && x < maxX; t += dt) {
    const a = acceleration(model.ball, vx, vy, 0, spin);
    vx += a.ax * dt; vy += a.ay * dt; x += vx * dt; y += vy * dt;
    out.push({ x, y, vy });
    if (y <= 0 && vy < 0) break;
    if (vx <= 0) break;
  }
  return out;
}

/** Height at which the arc crosses the wall plane x = d (metres). If it lands short, the result is negative:
 * minus the shortfall, so the objective stays continuous across the wall/floor boundary. */
export function heightAtWall(traj: { x: number; y: number }[], d: number): number {
  for (let i = 1; i < traj.length; i++) {
    if (traj[i].x >= d) {
      const a = traj[i - 1], b = traj[i];
      const f = (d - a.x) / Math.max(1e-9, b.x - a.x);
      return a.y + f * (b.y - a.y);
    }
  }
  return -(d - traj[traj.length - 1].x);
}

/** Landing distance (first floor crossing), metres; or the farthest x if the arc never came down (should not happen). */
export function landingRange(traj: { x: number; y: number }[]): number {
  for (let i = 1; i < traj.length; i++) {
    if (traj[i].y <= 0) {
      const a = traj[i - 1], b = traj[i];
      const f = a.y / Math.max(1e-9, a.y - b.y);
      return a.x + f * (b.x - a.x);
    }
  }
  return traj[traj.length - 1].x;
}

export function predict(model: FlightModel, p: Params, shot: CalShot): number {
  const traj = trajectory(model, p, shotRpm(shot, model.freeRpm));
  return shot.kind === "wall" ? heightAtWall(traj, shot.distanceM) : landingRange(traj);
}

export function residuals(model: FlightModel, p: Params, shots: CalShot[]): number[] {
  return shots.map((s) => predict(model, p, s) - s.measuredM);
}

export interface Sufficiency {
  /** which parameters the data can pin down */
  fitElevation: boolean;
  fitSpin: boolean;
  distinctDistances: number;
  distinctPowers: number;
  reasons: string[];
}

export function sufficiency(shots: CalShot[], wantSpin: boolean): Sufficiency {
  const dist = new Set<string>(), pow = new Set<string>();
  let wall = 0, floor = 0;
  for (const s of shots) { if (s.kind === "wall") dist.add((Math.round(s.distanceM / 0.15) * 0.15).toFixed(2)); pow.add(s.power.toFixed(2)); s.kind === "wall" ? wall++ : floor++; }
  const n = shots.length;
  const reasons: string[] = [];
  // the hood angle separates from exit speed when the arcs are sampled at different points: wall hits at two distances,
  // a wall hit plus a floor landing, or (weakly, through drag) floor landings at several powers
  const floorOnly = wall === 0 && floor >= 6 && pow.size >= 3;
  const geometryVaries = dist.size >= 2 || (wall > 0 && floor > 0) || floorOnly;
  const fitElevation = n >= 4 && geometryVaries;
  if (n === 0) reasons.push("no shots yet");
  else if (!geometryVaries && wall === 0) reasons.push("floor landings only: add a wall hit (closer robot or lower power), or at least 6 landings over 3 powers, before the hood angle is fitted");
  else if (!geometryVaries) reasons.push("all shots hit the same wall distance: move the robot (a second distance, or a shot that lands on the floor) so the hood angle can be separated from the exit speed");
  else if (n < 4) reasons.push(`${4 - n} more shot${4 - n > 1 ? "s" : ""} needed before the hood angle is fitted`);
  if (floorOnly && fitElevation) reasons.push("hood angle from floor landings alone is weakly determined (it relies on drag); one wall hit pins it down");
  if (pow.size < 2 && n > 0) reasons.push("only one power level: add shots at other powers to check that exit speed scales with flywheel speed");
  const fitSpin = wantSpin && fitElevation && n >= 8 && dist.size >= 3;
  if (wantSpin && !fitSpin && n > 0) reasons.push("backspin needs at least 8 shots over 3 distances; held at the current value");
  return { fitElevation, fitSpin, distinctDistances: dist.size, distinctPowers: pow.size, reasons };
}

export interface FitResult {
  params: Params;
  /** 1-sigma standard errors for the fitted parameters (undefined when held or not estimable) */
  stdErr: Partial<Params>;
  residualsM: number[];
  rmsM: number;
  n: number;
  sufficiency: Sufficiency;
  /** median measured RPM per unit power, when the shots carry RPM measurements */
  rpmPerPower?: number;
  /** mean sideways bias of the impacts as a yaw angle (degrees, positive = left), when lateral offsets were recorded */
  yawBiasDeg?: number;
}

const BOUNDS: Record<keyof Params, [number, number]> = { efficiency: [0.05, 1.5], elevationDeg: [5, 85], spinFraction: [0, 1] };
function clampP(p: Params): Params {
  return { efficiency: Math.min(BOUNDS.efficiency[1], Math.max(BOUNDS.efficiency[0], p.efficiency)), elevationDeg: Math.min(BOUNDS.elevationDeg[1], Math.max(BOUNDS.elevationDeg[0], p.elevationDeg)), spinFraction: Math.min(BOUNDS.spinFraction[1], Math.max(BOUNDS.spinFraction[0], p.spinFraction)) };
}

/** Nelder-Mead over the free parameters; the held ones stay at `start`. */
function nelderMead(f: (v: number[]) => number, start: number[], steps: number[], iters = 400): number[] {
  const n = start.length;
  let simplex = [start, ...start.map((_, i) => start.map((x, j) => (i === j ? x + steps[j] : x)))];
  let vals = simplex.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map((i) => simplex[i]); vals = order.map((i) => vals[i]);
    const best = vals[0], worst = vals[n];
    if (Math.abs(worst - best) < 1e-12 * (1 + best)) break;
    const centroid = Array(n).fill(0).map((_, j) => simplex.slice(0, n).reduce((s, v) => s + v[j], 0) / n);
    const reflect = centroid.map((c, j) => c + (c - simplex[n][j]));
    const fr = f(reflect);
    if (fr < best) {
      const expand = centroid.map((c, j) => c + 2 * (c - simplex[n][j]));
      const fe = f(expand);
      if (fe < fr) { simplex[n] = expand; vals[n] = fe; } else { simplex[n] = reflect; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { simplex[n] = reflect; vals[n] = fr; }
    else {
      const contract = centroid.map((c, j) => c + 0.5 * (simplex[n][j] - c));
      const fc = f(contract);
      if (fc < worst) { simplex[n] = contract; vals[n] = fc; }
      else for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((x, j) => simplex[0][j] + 0.5 * (x - simplex[0][j])); vals[i] = f(simplex[i]); }
    }
  }
  const bi = vals.indexOf(Math.min(...vals));
  return simplex[bi];
}

/** Invert a small symmetric positive matrix (Gauss-Jordan); returns undefined when singular. */
function invert(a: number[][]): number[][] | undefined {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array(n).fill(0).map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-14) return undefined;
    [m[c], m[piv]] = [m[piv], m[c]];
    const d = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const k = m[r][c]; for (let j = 0; j < 2 * n; j++) m[r][j] -= k * m[c][j]; }
  }
  return m.map((row) => row.slice(n));
}

/** Fit the launcher parameters to the shots, starting from the twin's current values. */
export function fitCalibration(model: FlightModel, start: Params, shots: CalShot[], wantSpin: boolean): FitResult {
  const suff = sufficiency(shots, wantSpin);
  const keys: (keyof Params)[] = ["efficiency"];
  if (suff.fitElevation) keys.push("elevationDeg");
  if (suff.fitSpin) keys.push("spinFraction");
  let params = clampP({ ...start });
  if (shots.length > 0) {
    const toP = (v: number[]): Params => { const p = { ...params }; keys.forEach((k, i) => (p[k] = v[i])); return clampP(p); };
    const obj = (v: number[]) => { const r = residuals(model, toP(v), shots); return r.reduce((s, x) => s + x * x, 0); };
    const steps = keys.map((k) => (k === "efficiency" ? 0.08 : k === "elevationDeg" ? 6 : 0.2));
    // a few starts guard against the shallow local minima of the speed/angle trade-off
    const starts: number[][] = [keys.map((k) => params[k])];
    if (keys.includes("elevationDeg")) for (const e of [35, 50, 65]) starts.push(keys.map((k) => (k === "elevationDeg" ? e : k === "efficiency" ? 0.4 : params[k])));
    let best: number[] | undefined, bestV = Infinity;
    for (const s of starts) { const v = nelderMead(obj, s, steps); const val = obj(v); if (val < bestV) { bestV = val; best = v; } }
    params = toP(best!);
  }
  const res = residuals(model, params, shots);
  const n = shots.length, k = keys.length;
  const rms = n ? Math.sqrt(res.reduce((s, x) => s + x * x, 0) / n) : 0;
  const stdErr: Partial<Params> = {};
  if (n > k) {
    const sigma2 = res.reduce((s, x) => s + x * x, 0) / (n - k);
    const J: number[][] = shots.map(() => Array(k).fill(0));
    keys.forEach((key, j) => {
      const h = key === "elevationDeg" ? 0.05 : 0.002;
      const up = { ...params, [key]: params[key] + h }, dn = { ...params, [key]: params[key] - h };
      const ru = residuals(model, up, shots), rd = residuals(model, dn, shots);
      shots.forEach((_, i) => (J[i][j] = (ru[i] - rd[i]) / (2 * h)));
    });
    const JtJ = Array(k).fill(0).map((_, a) => Array(k).fill(0).map((_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
    const inv = invert(JtJ);
    if (inv) keys.forEach((key, j) => { const v = sigma2 * inv[j][j]; if (v >= 0 && Number.isFinite(v)) stdErr[key] = Math.sqrt(v); });
  }
  const ratios = shots.filter((s) => s.rpm && s.rpm > 0 && s.power > 0).map((s) => s.rpm! / s.power).sort((a, b) => a - b);
  const rpmPerPower = ratios.length ? ratios[Math.floor(ratios.length / 2)] : undefined;
  const lat = shots.filter((s) => s.lateralM !== undefined && s.kind === "wall").map((s) => Math.atan2(s.lateralM!, s.distanceM));
  const yawBiasDeg = lat.length ? ((lat.reduce((a, b) => a + b, 0) / lat.length) * 180) / Math.PI : undefined;
  return { params, stdErr, residualsM: res, rmsM: rms, n, sufficiency: suff, rpmPerPower, yawBiasDeg };
}

/** The (power, bumper distance) slot with the fewest shots so far, in schedule order; undefined when the plan is complete. */
export function nextSlot(setup: CalSetup, shots: CalShot[], launcher: Pick<LauncherConfig, "exitForwardM" | "yawOffsetDeg">, robotLengthM: number): { power: number; bumperIn: number; have: number; want: number; done: number; total: number } | undefined {
  let best: { power: number; bumperIn: number; have: number; want: number; done: number; total: number } | undefined;
  let done = 0;
  const total = setup.powers.length * setup.bumperDistancesIn.length * setup.perSlot;
  for (const bumperIn of setup.bumperDistancesIn) for (const power of setup.powers) {
    const d = exitToWallDistance(bumperIn * 0.0254, launcher, robotLengthM);
    const have = shots.filter((s) => Math.abs(s.power - power) < 0.011 && Math.abs(s.distanceM - d) < 0.08).length;
    done += Math.min(have, setup.perSlot);
    if (have < setup.perSlot && (!best || have < best.have)) best = { power, bumperIn, have, want: setup.perSlot, done: 0, total };
  }
  if (best) best.done = done;
  return best;
}

/** Parse the lines the TwinCalibration OpMode logs for each shot, e.g. `CAL shot=3 power=0.60 rpm=3412 volts=12.6`. */
export function parseCalLines(text: string): { id: number; power: number; rpm?: number; volts?: number }[] {
  const out: { id: number; power: number; rpm?: number; volts?: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /CAL\s+shot=(\d+)\s+power=([\d.]+)(?:\s+rpm=([\d.]+))?(?:\s+volts=([\d.]+))?/.exec(line);
    if (!m) continue;
    const rec: { id: number; power: number; rpm?: number; volts?: number } = { id: +m[1], power: +m[2] };
    if (m[3] !== undefined) rec.rpm = +m[3];
    if (m[4] !== undefined) rec.volts = +m[4];
    out.push(rec);
  }
  return out;
}

/** Exit speed that drops the ball through `targetHeightM` at horizontal `rangeM` on the descending branch, using the
 * fitted model; undefined when no speed does. Bisection on the height at the target plane. */
export function speedForRange(model: FlightModel, p: Params, rangeM: number, targetHeightM: number): number | undefined {
  const heightAt = (speed: number) => {
    // trajectory() takes rpm; feed a synthetic rpm that yields this speed at the fitted efficiency
    const rpm = (speed * 60) / (Math.PI * model.wheelDiameterM * p.efficiency);
    const traj = trajectory(model, p, rpm);
    let descending = false;
    for (let i = 1; i < traj.length; i++) if (traj[i].x >= rangeM) { descending = traj[i].vy < 0; break; }
    return { h: heightAtWall(traj, rangeM), descending };
  };
  let lo = 0.5, hi = 40;
  if (heightAt(hi).h < targetHeightM) return undefined;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (heightAt(mid).h < targetHeightM) lo = mid; else hi = mid; }
  const r = heightAt(hi);
  return r.descending ? hi : undefined;
}

/** Power table for TeamCode's range -> flywheel power model: for each range, the power whose exit speed lands the
 * ball through the target height on the way down. */
export function powerTable(model: FlightModel, p: Params, rangesIn: number[], targetHeightIn: number, minPower = 0.3, maxPower = 1): { rangeIn: number; power: number; rpm: number; exitSpeedMps: number }[] {
  const out: { rangeIn: number; power: number; rpm: number; exitSpeedMps: number }[] = [];
  for (const rangeIn of rangesIn) {
    const v = speedForRange(model, p, rangeIn * 0.0254, targetHeightIn * 0.0254);
    if (v === undefined) continue;
    const rpm = (v * 60) / (Math.PI * model.wheelDiameterM * p.efficiency);
    const power = rpm / model.freeRpm;
    if (power < minPower || power > maxPower) continue;
    out.push({ rangeIn, power: Math.round(power * 1000) / 1000, rpm: Math.round(rpm), exitSpeedMps: Math.round(v * 100) / 100 });
  }
  return out;
}
