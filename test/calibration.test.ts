import { describe, expect, it } from "vitest";
import { exitToWallDistance, fitCalibration, heightAtWall, landingRange, nextSlot, parseCalLines, powerTable, predict, sufficiency, trajectory, type CalShot, type FlightModel, type Params, defaultCalibration } from "../src/ballistics/calibration";
import { BALL, m } from "../src/field/fieldSpec";

const model: FlightModel = { ball: { massKg: BALL.pollen.massKg, diameterM: m(BALL.pollen.diaIn), cd: 0.45, cl: 0.2 }, wheelDiameterM: 0.096, freeRpm: 6000, exitHeightM: 0.31 };
const truth: Params = { efficiency: 0.42, elevationDeg: 52, spinFraction: 0.5 };

/** Shots a robot with `truth` would produce at these powers and exit distances, with optional measurement noise. */
function synth(powers: number[], distancesM: number[], noiseM = 0, seed = 1): CalShot[] {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
  const out: CalShot[] = [];
  let id = 1;
  for (const d of distancesM) for (const power of powers) {
    const traj = trajectory(model, truth, power * model.freeRpm);
    const h = heightAtWall(traj, d);
    const shot: CalShot = h > 0.02
      ? { id: id++, power, distanceM: d, kind: "wall", measuredM: h + rnd() * 2 * noiseM }
      : { id: id++, power, distanceM: d, kind: "floor", measuredM: landingRange(traj) + rnd() * 2 * noiseM };
    out.push(shot);
  }
  return out;
}

describe("trajectory helpers", () => {
  it("interpolates the wall height and the landing range", () => {
    const traj = trajectory(model, truth, 3000);
    const d = 1.5;
    const h = heightAtWall(traj, d);
    expect(h).toBeGreaterThan(0.31);
    const land = landingRange(traj);
    expect(land).toBeGreaterThan(d);
    expect(heightAtWall(traj, land + 0.5)).toBeCloseTo(-0.5, 1); // short of the wall: negative shortfall
  });
  it("places the exit relative to the bumper that faces the wall", () => {
    const back = { exitForwardM: -0.1, yawOffsetDeg: 180 }; // StarterBot fires out the back, exit 10 cm behind centre
    expect(exitToWallDistance(1, back, 0.45)).toBeCloseTo(1 + 0.225 - 0.1);
    const front = { exitForwardM: 0.1, yawOffsetDeg: 0 };
    expect(exitToWallDistance(1, front, 0.45)).toBeCloseTo(1 + 0.225 - 0.1);
  });
});

describe("sufficiency", () => {
  it("holds the hood angle until the geometry varies", () => {
    const one = synth([0.5, 0.7, 0.9, 1], [1.5]);
    expect(sufficiency(one, false).fitElevation).toBe(false);
    expect(sufficiency(one, false).reasons.join(" ")).toMatch(/same wall distance/);
    const floorOnly: CalShot[] = [0.3, 0.3, 0.4, 0.4, 0.5, 0.5].map((power, i) => ({ id: i, power, distanceM: 4, kind: "floor", measuredM: 2 + power }));
    expect(sufficiency(floorOnly.slice(0, 4), false).fitElevation).toBe(false);
    expect(sufficiency(floorOnly, false).fitElevation).toBe(true);
    const two = synth([0.5, 0.7], [1.5, 2.5]);
    expect(sufficiency(two, false).fitElevation).toBe(true);
    expect(sufficiency(two, true).fitSpin).toBe(false);
  });
});

describe("fit", () => {
  it("recovers efficiency and hood angle from noiseless shots at two distances", () => {
    const shots = synth([0.5, 0.65, 0.8, 1], [1.4, 2.6]);
    const fit = fitCalibration(model, { efficiency: 0.3, elevationDeg: 60, spinFraction: 0.5 }, shots, false);
    expect(fit.params.efficiency).toBeCloseTo(truth.efficiency, 2);
    expect(fit.params.elevationDeg).toBeCloseTo(truth.elevationDeg, 0);
    expect(fit.rmsM).toBeLessThan(0.01);
  });
  it("tolerates 2 cm measurement noise and reports standard errors", () => {
    const shots = synth([0.5, 0.65, 0.8, 1], [1.4, 2.6, 3.4], 0.02);
    const fit = fitCalibration(model, { efficiency: 0.45, elevationDeg: 55, spinFraction: 0.5 }, shots, false);
    expect(Math.abs(fit.params.efficiency - truth.efficiency)).toBeLessThan(0.03);
    expect(Math.abs(fit.params.elevationDeg - truth.elevationDeg)).toBeLessThan(3);
    expect(fit.stdErr.efficiency).toBeGreaterThan(0);
    expect(fit.stdErr.elevationDeg).toBeGreaterThan(0);
    expect(fit.rmsM).toBeLessThan(0.05);
  });
  it("fits efficiency only at a single distance and keeps the hood where it was", () => {
    const shots = synth([0.5, 0.7, 0.9], [2]);
    const fit = fitCalibration(model, { efficiency: 0.3, elevationDeg: 52, spinFraction: 0.5 }, shots, false);
    expect(fit.params.elevationDeg).toBe(52);
    expect(fit.params.efficiency).toBeCloseTo(truth.efficiency, 2);
  });
  it("uses measured RPM when present and reports rpm per power", () => {
    const shots = synth([0.5, 1], [1.5, 2.5]).map((s) => ({ ...s, rpm: s.power * 5400 }));
    // the measurements were generated at power x 6000, so telling the fitter the wheel really spun slower must raise efficiency
    const fit = fitCalibration(model, truth, shots, false);
    expect(fit.rpmPerPower).toBeCloseTo(5400);
    expect(fit.params.efficiency).toBeGreaterThan(truth.efficiency);
  });
  it("predicts a floor landing for a weak shot", () => {
    const shot: CalShot = { id: 1, power: 0.2, distanceM: 3, kind: "floor", measuredM: 1 };
    expect(predict(model, truth, shot)).toBeLessThan(3);
  });
});

describe("wizard helpers", () => {
  it("walks the schedule slot by slot", () => {
    const cal = defaultCalibration();
    const launcher = { exitForwardM: -0.1, yawOffsetDeg: 180 };
    const first = nextSlot(cal.setup, [], launcher, 0.45)!;
    expect(first.power).toBe(0.5); expect(first.bumperIn).toBe(48); expect(first.total).toBe(16);
    const d = exitToWallDistance(48 * 0.0254, launcher, 0.45);
    const shots: CalShot[] = [{ id: 1, power: 0.5, distanceM: d, kind: "wall", measuredM: 1 }, { id: 2, power: 0.5, distanceM: d, kind: "wall", measuredM: 1 }];
    const second = nextSlot(cal.setup, shots, launcher, 0.45)!;
    expect(second.power).toBe(0.65); expect(second.done).toBe(2);
  });
  it("parses the OpMode's shot lines", () => {
    const recs = parseCalLines("[I/TwinCal] CAL shot=3 power=0.60 rpm=3412 volts=12.6\nnoise\nCAL shot=4 power=1.00");
    expect(recs).toEqual([{ id: 3, power: 0.6, rpm: 3412, volts: 12.6 }, { id: 4, power: 1 }]);
  });
  it("builds a power table that rises with range", () => {
    const table = powerTable(model, truth, [48, 72, 96, 120], 59.5);
    expect(table.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < table.length; i++) expect(table[i].power).toBeGreaterThan(table[i - 1].power);
    for (const row of table) {
      const traj = trajectory(model, truth, row.rpm);
      expect(heightAtWall(traj, row.rangeIn * 0.0254)).toBeCloseTo(59.5 * 0.0254, 1);
    }
  });
});
