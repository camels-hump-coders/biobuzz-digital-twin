import { describe, expect, it } from "vitest";
import { diagonalDeg, fromDiagonal, fromHorizontal, groundFootprint, inFrustum } from "../src/camera/cameraMath";

describe("camera math", () => {
  it("78 deg diagonal at 16:9 gives about 70.4 x 43.3 deg", () => {
    const i = fromDiagonal(78, 1920, 1080);
    expect((i.hfov * 180) / Math.PI).toBeCloseTo(70.4, 0);
    expect((i.vfov * 180) / Math.PI).toBeCloseTo(43.3, 0);
    expect(diagonalDeg(i)).toBeCloseTo(78, 6);
  });
  it("horizontal fov round trips", () => {
    const i = fromHorizontal(54.5, 1280, 960);
    expect(Math.abs((i.vfov * 180) / Math.PI - 41.7)).toBeLessThan(1);
  });
  const pose = {
    position: { x: 0, y: 0.3, z: 0 },
    forward: { x: 0, y: -Math.sin(0.3), z: -Math.cos(0.3) },
    up: { x: 0, y: Math.cos(0.3), z: -Math.sin(0.3) },
    right: { x: 1, y: 0, z: 0 },
  };
  it("ground footprint lies ahead of a downward-pitched camera", () => {
    const fp = groundFootprint(pose, fromDiagonal(78, 1920, 1080), 5);
    expect(fp.length).toBeGreaterThan(0);
    for (const p of fp) expect(p.z).toBeLessThan(0.01);
  });
  it("frustum test", () => {
    const i = fromDiagonal(78, 1920, 1080);
    expect(inFrustum(pose, i, { x: 0, y: 0.1, z: -2 }).inside).toBe(true);
    expect(inFrustum(pose, i, { x: 0, y: 0.1, z: 2 }).inside).toBe(false);
    expect(inFrustum(pose, i, { x: 5, y: 0.1, z: -2 }).inside).toBe(false);
  });
});
