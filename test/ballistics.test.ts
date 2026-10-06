import { describe, expect, it } from "vitest";
import { simulate, velocityFrom } from "../src/ballistics/projectile";
import { adaptiveAimInsideM, evaluateShot, scanElevations, solveSpeedAdaptive, solveSpeedForElevation, vacuumSpeed } from "../src/ballistics/solver";
import { LAUNCHER_PRESETS, exitSpeed, rpmForExitSpeed } from "../src/ballistics/launcher";
import { aimPoint, upCellFrame } from "../src/field/hive";
import { BALL, m } from "../src/field/fieldSpec";

const pollen = { massKg: BALL.pollen.massKg, diameterM: m(BALL.pollen.diaIn), cd: 0, cl: 0 };

describe("projectile", () => {
  it("matches the vacuum range with drag disabled", () => {
    const v = 8, ang = Math.PI / 4;
    const s = simulate(pollen, { pos: { x: 0, y: 0, z: 0 }, vel: velocityFrom(v, ang, { x: 0, z: -1 }), spin: 0 }, { dt: 0.001 });
    const last = s[s.length - 1];
    const range = (v * v * Math.sin(2 * ang)) / 9.80665;
    expect(Math.abs(last.pos.z)).toBeCloseTo(range, 1);
  });
  it("drag shortens the flight", () => {
    const vel = velocityFrom(8, Math.PI / 4, { x: 0, z: -1 });
    const a = simulate(pollen, { pos: { x: 0, y: 0, z: 0 }, vel, spin: 0 });
    const b = simulate({ ...pollen, cd: 0.45 }, { pos: { x: 0, y: 0, z: 0 }, vel, spin: 0 });
    expect(Math.abs(b[b.length - 1].pos.z)).toBeLessThan(Math.abs(a[a.length - 1].pos.z));
  });
});

describe("solver", () => {
  const frame = upCellFrame({ alliance: "red", upCell: "audience" });
  const target = aimPoint(frame);
  const launchPos = { x: target.x, y: 0.4, z: target.z + 2.0 }; // 2 m back on the audience side
  it("fixed-elevation speed solve agrees with the vacuum formula without drag", () => {
    const req = { ball: pollen, launchPos, target, frame };
    const el = (60 * Math.PI) / 180;
    const r = solveSpeedForElevation(req, el)!;
    const range = Math.hypot(target.x - launchPos.x, target.z - launchPos.z);
    const v = vacuumSpeed(range, target.y - launchPos.y, el)!;
    expect(r.speed).toBeCloseTo(v, 1);
    expect(r.hit).toBe(true);
  });
  it("scan finds a hit with realistic drag and prefers lower speed", () => {
    const req = { ball: { ...pollen, cd: 0.45 }, launchPos, target, frame };
    const scan = scanElevations(req, 40, 75, 5);
    expect(scan.best).toBeDefined();
    expect(scan.best!.hit).toBe(true);
    for (const s of scan.solutions.filter((s) => s.hit)) expect(scan.best!.speed).toBeLessThanOrEqual(s.speed + 1e-9);
  });
  it("an elevation below the line of sight has no solution", () => {
    const req = { ball: { ...pollen, cd: 0.45 }, launchPos: { ...launchPos, z: target.z + 3.5 }, target, frame };
    const r = solveSpeedForElevation(req, (10 * Math.PI) / 180);
    expect(r).toBeUndefined();
  });
});

describe("launcher", () => {
  it("exit speed and rpm round trip", () => {
    const cfg = LAUNCHER_PRESETS.starterbot;
    const v = exitSpeed(cfg, 4000);
    expect(rpmForExitSpeed(cfg, v)).toBeCloseTo(4000, 6);
    // 96 mm wheel at 4000 rpm: surface 20.1 m/s, x0.45 = 9.05 m/s
    expect(v).toBeCloseTo(9.05, 1);
  });
});

describe("adaptive aim depth", () => {
  it("aims at the opening centre for steep entries and deeper for flat ones", () => {
    expect(adaptiveAimInsideM((75 * Math.PI) / 180)).toBeLessThan(0.02);
    expect(adaptiveAimInsideM((45 * Math.PI) / 180)).toBeCloseTo(0.05, 3);
    expect(adaptiveAimInsideM((20 * Math.PI) / 180)).toBe(0.10);
  });
  it("a 75 deg lob still crosses inside the opening with the adapted aim", () => {
    const frame = upCellFrame({ alliance: "red", upCell: "audience" });
    const target = aimPoint(frame);
    const launchPos = { x: target.x, y: 0.31, z: target.z + 1.65 }; // 65 in back
    const drag = { massKg: BALL.pollen.massKg, diameterM: m(BALL.pollen.diaIn), cd: 0.45, cl: 0.2 };
    const ad = solveSpeedAdaptive(drag, launchPos, frame, (75 * Math.PI) / 180, 20, 157);
    expect(ad.result?.hit).toBe(true);
    // the opening plane is tilted 30 deg, so a 75 deg launch meets it at roughly 45-50 deg: the aim moves toward the centre
    expect(ad.insideM).toBeLessThan(0.05);
    expect(ad.result!.entryAngleRad!).toBeGreaterThan((40 * Math.PI) / 180);
    const centre = frame.openingCenter;
    const dist = (p: { x: number; y: number; z: number }) => Math.hypot(p.x - centre.x, p.y - centre.y, p.z - centre.z);
    expect(dist(ad.target)).toBeLessThan(dist(target)); // nearer the opening centre than the old fixed 2 in aim
  });
});

describe("shots from behind the hive", () => {
  const frame = upCellFrame({ alliance: "red", upCell: "audience" });
  const drag = { massKg: BALL.pollen.massKg, diameterM: m(BALL.pollen.diaIn), cd: 0.45, cl: 0.2 };
  const nh = Math.hypot(frame.normal.x, frame.normal.z), nx = frame.normal.x / nh, nz = frame.normal.z / nh;
  const aim = aimPoint(frame);
  it("a front shot is never flagged as blocked by the cell", () => {
    const ad = solveSpeedAdaptive(drag, { x: aim.x + nx * 1.8, y: 0.31, z: aim.z + nz * 1.8 }, frame, (55 * Math.PI) / 180, 20, 157);
    expect(ad.result?.hit).toBe(true); expect(ad.result?.blockedByCell).toBe(false);
  });
  it("from the pivot side, a flat arc through the cell is rejected as blocked and a drop-in over the lip meets the plane shallowly", () => {
    const behind = { x: aim.x - nx * 1.8, y: 0.31, z: aim.z - nz * 1.8 };
    // a flat, fast shot aimed at the opening centre from behind would go through the back skin and roof
    const flat = evaluateShot({ ball: drag, launchPos: behind, target: frame.openingCenter, frame, spin: 157 }, (35 * Math.PI) / 180, 20);
    expect(flat.hit).toBe(false);
    const results = [70, 80, 85].map((deg) => ({ deg, ad: solveSpeedAdaptive(drag, behind, frame, (deg * Math.PI) / 180, 25, 157) }));
    for (const { ad } of results) { expect(ad.insideM).toBe(0); if (ad.result?.blockedByCell) expect(ad.result.hit).toBe(false); if (ad.result?.hit) expect(ad.result.entryAngleRad!).toBeLessThan((35 * Math.PI) / 180); }
  });
});
