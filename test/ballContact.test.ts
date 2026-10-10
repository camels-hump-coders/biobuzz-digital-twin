import { describe, expect, it } from "vitest";
import { GOBILDA_5203_312, PHYSICS_PROFILES, stepDrive, type ChassisParams, type DriveBody } from "../src/sim/drivePhysics";
import { FrameCadence, LatencyQueue } from "../src/runtime/visionFaults";
import type { TagPacket } from "../src/runtime/link";

// the StarterBot 6WD as the team measured it
const bot: ChassisParams = { massKg: 11, trackWidthM: 15.3 * 0.0254, wheelbaseM: 13.5 * 0.0254, wheelRadiusM: 0.048, motorsPerSide: 1, motor: GOBILDA_5203_312 };
const tiles = PHYSICS_PROFILES.tiles;
const straight = (u: number) => ({ left: { u, brake: true }, right: { u, brake: true } });
function run(body: DriveBody, cmd: ReturnType<typeof straight>, prof = tiles, seconds = 1.0, block: -1 | 0 | 1 = 0) {
  let r = stepDrive(body, cmd, bot, prof, 0.02, block);
  for (let t = 0.02; t < seconds; t += 0.02) r = stepDrive(r.body, cmd, bot, prof, 0.02, block);
  return r;
}

describe("an immovable contact (SG-005: garden balls squeezed on the wall)", () => {
  it("30 % into the contact: the chassis does not move, the shafts stall, the current rises (gecko wheels grip)", () => {
    const r = run({ vFwd: 0, omega: 0 }, straight(0.3), tiles, 1, 1);
    expect(r.body.vFwd).toBe(0);
    expect(r.shaftRevPerSec.left).toBe(0);
    expect(r.stalled.left && r.stalled.right).toBe(true);
    expect(r.slipping.left || r.slipping.right).toBe(false);
    expect(r.currentA.left).toBeGreaterThan(2); // 0.3 of the stall torque against a wall
  });
  it("with little grip the wheels spin instead: encoders count, the chassis still does not move", () => {
    const slick = { ...tiles, tractionMu: 0.1 };
    const r = run({ vFwd: 0, omega: 0 }, straight(0.3), slick, 1, 1);
    expect(r.body.vFwd).toBe(0);
    expect(r.slipping.left && r.slipping.right).toBe(true);
    expect(r.shaftRevPerSec.left).toBeGreaterThan(0.5);
    expect(r.stalled.left).toBe(false);
  });
  it("driving away from the contact is free", () => {
    const r = run({ vFwd: 0, omega: 0 }, straight(-0.3), tiles, 1, 1);
    expect(r.body.vFwd).toBeLessThan(-0.1);
    expect(r.stalled.left).toBe(false);
  });
  it("no block: the same command rolls", () => {
    const r = run({ vFwd: 0, omega: 0 }, straight(0.3), tiles, 1, 0);
    expect(r.body.vFwd).toBeGreaterThan(0.2);
  });
});

const pkt = (id: number): TagPacket => ({ id, cx: 320, cy: 240, x: 0, y: 60, z: 30, yaw: 0, pitch: 0, roll: 0, range: 67, bearing: 0, elevation: 0, robotX: 0, robotY: 0, robotYaw: 0, R: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
describe("detector frame rate (SG-003: 12 fps at decimation 1)", () => {
  it("between frames the last processed frame is held and its acquisition time ages", () => {
    const c = new FrameCadence();
    const a = c.next(0, [pkt(42)], 12);
    expect(a.fresh).toBe(true);
    const b = c.next(50, [pkt(43)], 12); // 50 ms later: inside the 83 ms frame period
    expect(b.fresh).toBe(false);
    expect(b.packets[0].id).toBe(42);
    expect(b.t).toBe(0);
    const d = c.next(100, [pkt(44)], 12);
    expect(d.fresh).toBe(true);
    expect(d.packets[0].id).toBe(44);
  });
  it("the latency queue keeps delivering the last due frame, ageing, when the detector held its frame", () => {
    const q = new LatencyQueue();
    expect(q.push(0, [pkt(42)], 200, 0)).toBeUndefined();
    expect(q.poll(100, 200)).toBeUndefined();
    expect(q.poll(250, 200)![0].ageMs).toBe(250);
    expect(q.poll(300, 200)![0].ageMs).toBe(300);
  });
});
