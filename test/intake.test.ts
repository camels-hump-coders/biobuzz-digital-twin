import { describe, expect, it } from "vitest";
import { chassisPush, inIntakeMouth, intakePoint } from "../src/sim/intake";

const fp = { lengthM: 0.44, widthM: 0.44 };
const geom = { side: "front" as const, widthM: 0.33 };
const r = 0.036;

describe("intake mouth", () => {
  it("front intake point is ahead of the robot (heading 0 faces -Z)", () => {
    const p = intakePoint({ x: 0, z: 0, heading: 0 }, fp, "front");
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(-0.22, 6);
    const rear = intakePoint({ x: 0, z: 0, heading: 0 }, fp, "rear");
    expect(rear.z).toBeCloseTo(0.22, 6);
  });
  it("accepts a ball just ahead of the front edge and rejects one at the back or far off-centre", () => {
    const pose = { x: 0, z: 0, heading: 0 };
    expect(inIntakeMouth(pose, fp, geom, { x: 0, z: -0.3 }, r, 0.18)).toBe(true);
    expect(inIntakeMouth(pose, fp, geom, { x: 0.3, z: -0.3 }, r, 0.18)).toBe(false); // outside the mouth width
    expect(inIntakeMouth(pose, fp, geom, { x: 0, z: 0.3 }, r, 0.18)).toBe(false); // behind the robot
    expect(inIntakeMouth(pose, fp, geom, { x: 0, z: -0.6 }, r, 0.18)).toBe(false); // too far ahead
  });
  it("rear intake follows the heading", () => {
    const pose = { x: 1, z: 1, heading: Math.PI / 2 }; // forward = -X
    expect(inIntakeMouth(pose, fp, { side: "rear", widthM: 0.3 }, { x: 1.3, z: 1 }, r, 0.18)).toBe(true);
    expect(inIntakeMouth(pose, fp, { side: "rear", widthM: 0.3 }, { x: 0.7, z: 1 }, r, 0.18)).toBe(false);
  });
});

describe("chassis push", () => {
  it("pushes an overlapping ball out through the nearest side", () => {
    const pose = { x: 0, z: 0, heading: 0 };
    const p = chassisPush(pose, fp, { x: 0.2, z: 0.05 }, r)!; // near the right side (+X when facing -Z is the robot's right)
    expect(p).toBeDefined();
    expect(p.nx).toBeCloseTo(1, 6);
    expect(0.2 + p.dx).toBeCloseTo(fp.widthM / 2 + r, 6);
  });
  it("ignores a ball clear of the chassis", () => {
    expect(chassisPush({ x: 0, z: 0, heading: 0 }, fp, { x: 0.5, z: 0.5 }, r)).toBeUndefined();
  });
});
