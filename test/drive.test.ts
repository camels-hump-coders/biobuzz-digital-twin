import { describe, expect, it } from "vitest";
import { commandToVelocity, forwardVector, headingToward, maxLinearSpeed, stepPose, type DriveParams } from "../src/sim/drive";
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
  it("headingToward points forward at the target", () => {
    const h = headingToward({ x: 0, z: 0 }, { x: -1, z: 0 });
    const f = forwardVector(h);
    expect(f.x).toBeCloseTo(-1);
  });
});
