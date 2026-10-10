import { describe, expect, it } from "vitest";
import { GOBILDA_5203_312, PHYSICS_PROFILES, breakawayCommands, motorSpecFor, stepDrive, type ChassisParams, type DriveBody } from "../src/sim/drivePhysics";

// the StarterBot 6WD as the team measured it: 11 kg, 15.3 in track, about 13.5 in between the outer axles
const bot: ChassisParams = { massKg: 11, trackWidthM: 15.3 * 0.0254, wheelbaseM: 13.5 * 0.0254, wheelRadiusM: 0.048, motorsPerSide: 1, motor: GOBILDA_5203_312 };
const tiles = PHYSICS_PROFILES.tiles, ideal = PHYSICS_PROFILES.ideal;
const turn = (u: number) => ({ left: { u: -u, brake: true }, right: { u, brake: true } });
const straight = (u: number) => ({ left: { u, brake: true }, right: { u, brake: true } });
function run(body: DriveBody, cmd: ReturnType<typeof turn>, prof = tiles, seconds = 1.5) {
  let r = stepDrive(body, cmd, bot, prof, 0.02);
  for (let t = 0.02; t < seconds; t += 0.02) r = stepDrive(r.body, cmd, bot, prof, 0.02);
  return r;
}

describe("drive physics", () => {
  it("motor family scales stall torque with the gearbox", () => {
    expect(motorSpecFor(435).stallTorqueNm).toBeCloseTo(GOBILDA_5203_312.stallTorqueNm * 312 / 435, 6);
  });
  it("the tiles profile puts the turning breakaway between the 14 % that stalled and the 20 % that crept", () => {
    const b = breakawayCommands(bot, tiles);
    expect(b.turn).toBeGreaterThan(0.14);
    expect(b.turn).toBeLessThan(0.20);
    expect(b.straight).toBeLessThan(0.10);
  });
  it("a 14 % turn command stalls: no rotation, stuck shafts, about 1.4 A per motor", () => {
    const r = run({ vFwd: 0, omega: 0 }, turn(0.14));
    expect(r.body.omega).toBe(0);
    expect(r.shaftRevPerSec.left).toBe(0);
    expect(r.stalled.left && r.stalled.right).toBe(true);
    expect(r.currentA.left).toBeGreaterThan(1.2);
    expect(r.currentA.left).toBeLessThan(1.8);
  });
  it("a 25 % turn command turns, and encoders count", () => {
    const r = run({ vFwd: 0, omega: 0 }, turn(0.25));
    expect(r.body.omega).toBeGreaterThan(0.3);
    expect(r.shaftRevPerSec.right).toBeGreaterThan(0);
    expect(r.shaftRevPerSec.left).toBeLessThan(0);
    expect(r.stalled.left || r.stalled.right).toBe(false);
  });
  it("a 20 % straight command rolls smoothly", () => {
    const r = run({ vFwd: 0, omega: 0 }, straight(0.2));
    expect(r.body.vFwd).toBeGreaterThan(0.15);
    expect(Math.abs(r.body.omega)).toBeLessThan(1e-6);
  });
  it("ideal profile has no breakaway and reaches free speed", () => {
    const r = run({ vFwd: 0, omega: 0 }, straight(1), ideal);
    const free = (312 / 60) * 2 * Math.PI * 0.048;
    expect(r.body.vFwd).toBeCloseTo(free, 1);
    expect(breakawayCommands(bot, ideal).turn).toBe(0);
  });
  it("brake stops a rolling chassis faster than coasting", () => {
    const rolling = run({ vFwd: 0, omega: 0 }, straight(0.6), tiles, 1).body;
    const braked = run(rolling, { left: { u: 0, brake: true }, right: { u: 0, brake: true } }, tiles, 0.3).body;
    const coasted = run(rolling, { left: { u: 0, brake: false }, right: { u: 0, brake: false } }, tiles, 0.3).body;
    expect(braked.vFwd).toBeLessThan(coasted.vFwd);
    expect(braked.vFwd).toBeGreaterThanOrEqual(0);
  });
  it("battery sags under load and the stall current drops with it", () => {
    const r = run({ vFwd: 0, omega: 0 }, turn(0.14));
    expect(r.volts).toBeLessThan(12.6);
    expect(r.volts).toBeGreaterThan(12.3);
  });
  it("friction stops the chassis instead of reversing it", () => {
    let body = run({ vFwd: 0, omega: 0 }, straight(0.3), tiles, 1).body;
    const r = run(body, { left: { u: 0, brake: false }, right: { u: 0, brake: false } }, tiles, 5);
    expect(r.body.vFwd).toBe(0);
  });
});
