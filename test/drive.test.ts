import { describe, expect, it } from "vitest";
import { WALL_MU, commandToVelocity, forwardVector, headingToward, maxLinearSpeed, stepPose, flowerObstacles, type DriveParams } from "../src/sim/drive";
import { m } from "../src/field/fieldSpec";

const p: DriveParams = { drivetrain: "mecanum", wheelRpm: 312, wheelDiameterM: 0.104, trackWidthM: 0.33, wheelbaseM: 0.3, fieldCentric: false };

describe("drive", () => {
  it("312 rpm 104 mm wheels give about 1.7 m/s", () => {
    expect(maxLinearSpeed(p)).toBeCloseTo(1.699, 2);
  });
  it("heading 0 faces the scoring side (-Z)", () => {
    const f = forwardVector(0);
    expect(f.z).toBeCloseTo(-1);
    expect(f.x).toBeCloseTo(0);
  });
  it("tank drive ignores strafe", () => {
    const v = commandToVelocity({ forward: 0, left: 1, turn: 0 }, { x: 0, z: 0, heading: 0 }, { ...p, drivetrain: "tank" });
    expect(Math.hypot(v.vx, v.vz)).toBeCloseTo(0);
  });
  it("mecanum strafes left toward -X when facing -Z", () => {
    const v = commandToVelocity({ forward: 0, left: 1, turn: 0 }, { x: 0, z: 0, heading: 0 }, p);
    expect(v.vx).toBeLessThan(0);
    expect(Math.abs(v.vz)).toBeLessThan(1e-9);
  });
  it("stays inside the perimeter", () => {
    let pose = { x: 0, z: 1.5, heading: 0 };
    for (let i = 0; i < 200; i++) pose = stepPose(pose, { vx: 0, vz: 1, yawRate: 0 }, 0.05, { lengthM: m(18), widthM: m(18) });
    expect(pose.z).toBeCloseTo(m(72) - m(9), 6);
  });
  it("can drive under the cells between the frame legs", () => {
    const pose = stepPose({ x: 0, z: 1.0, heading: 0 }, { vx: 0, vz: -30, yawRate: 0 }, 0.05, { lengthM: m(18), widthM: m(18) });
    expect(pose.z).toBeLessThan(-0.4);
  });
  it("is blocked by a frame leg from the side", () => {
    let pose = { x: -1.2, z: 0, heading: 0 };
    for (let i = 0; i < 60; i++) pose = stepPose(pose, { vx: 1.5, vz: 0, yawRate: 0 }, 0.02, { lengthM: m(18), widthM: m(18) });
    expect(pose.x).toBeLessThanOrEqual(-m(49.46 / 2) - 0.03 - m(9) + 1e-9);
  });
  it("cannot drive through a flower cage", () => {
    // west-wall flower at z = +24 in, axis 3.6 in off the wall
    let pose = { x: -1.2, z: m(24), heading: Math.PI / 2 };
    for (let i = 0; i < 60; i++) pose = stepPose(pose, { vx: -1.5, vz: 0, yawRate: 0 }, 0.02, { lengthM: m(18), widthM: m(18) }, flowerObstacles());
    expect(pose.x).toBeGreaterThan(m(-72 + 3.6 + 2.75 + 9) - 1e-9);
  });
  it("headingToward points forward at the target", () => {
    const h = headingToward({ x: 0, z: 0 }, { x: -1, z: 0 });
    const f = forwardVector(h);
    expect(f.x).toBeCloseTo(-1);
  });
});

describe("wall friction", () => {
  const IN = 0.0254, fp = { lengthM: 18 * IN, widthM: 18 * IN };
  const half = 72 * IN, atWall = { x: half - fp.widthM / 2, z: 0, heading: 0 }; // touching the +x wall
  it("a tank robot pushing into the wall at 45° scrubs instead of gliding", () => {
    const v = { vx: 0.7, vz: 0.7, yawRate: 0 };
    const free = stepPose(atWall, v, 1, fp, []);
    const held = stepPose(atWall, v, 1, fp, [], WALL_MU.tank);
    expect(free.z - atWall.z).toBeCloseTo(0.7, 3);   // without friction it slides the full tangential distance
    expect(held.z - atWall.z).toBeCloseTo(0, 3);     // mu 1.0 at 45°: fully bound
    expect(held.x).toBeCloseTo(atWall.x, 6);
  });
  it("mecanum crabs along the wall at reduced speed, and a shallow approach still slides", () => {
    const v = { vx: 0.7, vz: 0.7, yawRate: 0 };
    const mec = stepPose(atWall, v, 1, fp, [], WALL_MU.mecanum);
    expect(mec.z - atWall.z).toBeCloseTo(0.7 - 0.45 * 0.7, 3);
    const shallow = stepPose(atWall, { vx: 0.2, vz: 1.0, yawRate: 0 }, 1, fp, [], WALL_MU.tank);
    expect(shallow.z - atWall.z).toBeCloseTo(0.8, 3);
  });
  it("does nothing away from the wall or when moving away from it", () => {
    const mid = { x: 0, z: 0, heading: 0 };
    expect(stepPose(mid, { vx: 0.5, vz: 0.5, yawRate: 0 }, 1, fp, [], WALL_MU.tank).z).toBeCloseTo(0.5, 3);
    const away = stepPose(atWall, { vx: -0.5, vz: 0.5, yawRate: 0 }, 0.1, fp, [], WALL_MU.tank);
    expect(away.z - atWall.z).toBeCloseTo(0.05, 3);
  });
});
