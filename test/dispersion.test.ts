import { describe, expect, it } from "vitest";
import { monteCarlo, perturb, rng, gaussian } from "../src/ballistics/dispersion";
import { aimPoint, upCellFrame } from "../src/field/hive";
import { BALL, m } from "../src/field/fieldSpec";
import { solveSpeedForElevation } from "../src/ballistics/solver";

describe("dispersion", () => {
  it("gaussian has roughly unit variance", () => {
    const r = rng(42);
    let s = 0, s2 = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) { const g = gaussian(r); s += g; s2 += g * g; }
    expect(Math.abs(s / n)).toBeLessThan(0.03);
    expect(Math.abs(s2 / n - 1)).toBeLessThan(0.05);
  });
  it("zero noise reproduces the nominal shot exactly", () => {
    const r = rng(1);
    const n = { speed: 6, elevationRad: 1, dirXZ: { x: 0, z: -1 }, spin: 10 };
    const p = perturb(n, { speedFrac: 0, elevationDeg: 0, yawDeg: 0, spinFrac: 0 }, r);
    expect(p.speed).toBeCloseTo(6);
    expect(p.vel.z).toBeCloseTo(-6 * Math.cos(1));
  });
  it("a well-aimed shot has high hit probability; a noisy one is lower", () => {
    const frame = upCellFrame({ alliance: "red", upCell: "audience" });
    const target = aimPoint(frame);
    const launchPos = { x: target.x, y: 0.4, z: target.z + 2.0 };
    const ball = { massKg: BALL.pollen.massKg, diameterM: m(BALL.pollen.diaIn), cd: 0.45, cl: 0 };
    const req = { ball, launchPos, target, frame, spin: 0 };
    const el = (60 * Math.PI) / 180;
    const sol = solveSpeedForElevation(req, el)!;
    const nominal = { speed: sol.speed, elevationRad: el, dirXZ: { x: 0, z: -1 }, spin: 0 };
    const tight = monteCarlo(req, nominal, { speedFrac: 0.01, elevationDeg: 0.3, yawDeg: 0.3, spinFrac: 0 }, 100);
    const loose = monteCarlo(req, nominal, { speedFrac: 0.10, elevationDeg: 4, yawDeg: 4, spinFrac: 0 }, 100);
    expect(tight.pHit).toBeGreaterThan(0.9);
    expect(loose.pHit).toBeLessThan(tight.pHit);
    expect(tight.lo).toBeLessThanOrEqual(tight.pHit + 1e-9);
    expect(tight.hi).toBeGreaterThanOrEqual(tight.pHit - 1e-9);
    expect(tight.points.length).toBe(100);
  });
});
