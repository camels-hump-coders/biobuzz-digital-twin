import { describe, expect, it } from "vitest";
import { STOP_RAD, loadTorque, remainingSwing, stepHinge, trayTorque, type HingeState } from "../src/sim/hiveDynamics";

/** Swing a released tray from +30° with `kg` of balls at the loaded (+Z, up) cell, 0.55 m from the pivot. The balls
 *  stay in the cell until the floor tilts toward the opening, then roll out (crudely: removed at θ < -20°). */
function swing(kg: number): { t: number; peak: number } {
  const s: HingeState = { angle: STOP_RAD, omega: 0, to: -STOP_RAD, t: 0 };
  let peak = 0, done = false;
  while (!done && s.t < 20) {
    const riding = s.angle > -20 * Math.PI / 180 ? [{ massKg: kg, rz: 0.55 * Math.cos(s.angle) }] : [];
    done = stepHinge(s, loadTorque(riding), 0.005, riding.reduce((a, b) => a + b.massKg * b.rz * b.rz, 0));
    peak = Math.max(peak, Math.abs(s.omega));
  }
  return { t: s.t, peak };
}

describe("hive hinge", () => {
  it("is bi-stable: the tray torque pushes away from level", () => {
    expect(trayTorque(0.3)).toBeGreaterThan(0); expect(trayTorque(-0.3)).toBeLessThan(0); expect(trayTorque(0)).toBe(0);
  });
  it("balls in the raised +Z cell pull the tray down", () => {
    expect(loadTorque([{ massKg: 0.2, rz: 0.5 }])).toBeLessThan(0);
  });
  it("a 200 g load completes the swing in 2–3.5 s, a 400 g load faster, and an unloaded release still finishes", () => {
    const a = swing(0.2), b = swing(0.4), c = swing(0);
    expect(a.t).toBeGreaterThan(2.0); expect(a.t).toBeLessThan(3.5);
    expect(b.t).toBeLessThan(a.t);
    expect(c.t).toBeLessThan(6);
  });
  it("reports the remaining swing for the HUD", () => {
    const s: HingeState = { angle: 0, omega: -0.5, to: -STOP_RAD, t: 1 };
    expect(remainingSwing(s)).toBeCloseTo(STOP_RAD / 0.5, 3);
  });
});
