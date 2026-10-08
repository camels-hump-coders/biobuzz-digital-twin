import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { splitWheelGeometry, wheelAngularSpeed } from "../src/robot/wheels";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

function chassisWithWheels(wheelXs: number[], widthM = 0.42, dia = 0.104) {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(0.44, 0.12, widthM - 0.08); body.translate(0, 0.12, 0); parts.push(body);
  // full-length side rails at axle height just inboard of the wheels, like goBILDA channel
  for (const side of [-1, 1]) { const rail = new THREE.BoxGeometry(0.44, 0.048, 0.03); rail.translate(0, dia / 2, side * (widthM / 2 - 0.036 - 0.015)); parts.push(rail); }
  for (const x of wheelXs) for (const side of [-1, 1]) {
    const w = new THREE.CylinderGeometry(dia / 2, dia / 2, 0.036, 24); w.rotateX(Math.PI / 2); w.translate(x, dia / 2, side * (widthM / 2 - 0.018)); parts.push(w);
  }
  return mergeGeometries(parts.map((g) => g.toNonIndexed()), false)!;
}

describe("CAD wheel split", () => {
  it("finds the four wheels of a mecanum chassis and leaves the body alone", () => {
    const geo = chassisWithWheels([-0.16, 0.16]);
    const split = splitWheelGeometry(geo, { widthM: 0.42, wheelDiameterM: 0.104 })!;
    expect(split).toBeDefined();
    expect(split.wheels.length).toBe(4);
    const xs = split.wheels.map((w) => +w.x.toFixed(2)).sort(); expect(xs).toEqual([-0.16, -0.16, 0.16, 0.16]);
    const total = geo.getAttribute("position").count;
    const wheelVerts = split.wheels.reduce((n, w) => n + w.geometry.getAttribute("position").count, 0);
    expect(wheelVerts + split.body.getAttribute("position").count).toBe(total);
    // no body vertex is left inside a wheel (outboard of the wheel's inner face, within its radius of an axle)
    const p = split.body.getAttribute("position");
    let leftovers = 0;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = Math.abs(p.getZ(i));
      if (z > 0.42 / 2 - 0.036 + 1e-6 && [-0.16, 0.16].some((wx) => Math.hypot(x - wx, y - 0.052) <= 0.052 + 1e-6)) leftovers++;
    }
    expect(leftovers).toBe(0);
    // wheel geometry is centred on its axle
    const w = split.wheels[0].geometry; w.computeBoundingBox(); const c = w.boundingBox!.getCenter(new THREE.Vector3());
    expect(Math.abs(c.x)).toBeLessThan(0.005); expect(Math.abs(c.y)).toBeLessThan(0.005);
  });
  it("finds six wheels on a 6WD", () => {
    const split = splitWheelGeometry(chassisWithWheels([-0.18, 0, 0.18]), { widthM: 0.42, wheelDiameterM: 0.104 })!;
    expect(split.wheels.length).toBe(6);
  });
  it("finds no wheels when there is nothing wheel-like", () => {
    const body = new THREE.BoxGeometry(0.4, 0.3, 0.3); body.translate(0, 0.15, 0);
    const split = splitWheelGeometry(body.toNonIndexed(), { widthM: 0.42, wheelDiameterM: 0.104 });
    expect(split === undefined || split.wheels.length === 0).toBe(true);
  });
});

describe("wheel kinematics", () => {
  const r = 0.052;
  it("rolls forward at v/r and the inside wheels slow in a turn", () => {
    expect(wheelAngularSpeed(0.2, -0.2, r, 1, 0, 0, "tank")).toBeCloseTo(1 / r);
    const left = wheelAngularSpeed(0.2, -0.2, r, 1, 0, 1, "tank"), right = wheelAngularSpeed(0.2, 0.2, r, 1, 0, 1, "tank");
    expect(left).toBeLessThan(right); // CCW turn: left side is the inside
  });
  it("strafing spins mecanum wheels in an X pattern and tank wheels not at all", () => {
    const fl = wheelAngularSpeed(0.2, -0.2, r, 0, 1, 0, "mecanum"), fr = wheelAngularSpeed(0.2, 0.2, r, 0, 1, 0, "mecanum");
    const bl = wheelAngularSpeed(-0.2, -0.2, r, 0, 1, 0, "mecanum"), br = wheelAngularSpeed(-0.2, 0.2, r, 0, 1, 0, "mecanum");
    expect(Math.sign(fl)).toBe(-Math.sign(fr)); expect(Math.sign(fl)).toBe(-Math.sign(bl)); expect(Math.sign(fl)).toBe(Math.sign(br));
    expect(wheelAngularSpeed(0.2, -0.2, r, 0, 1, 0, "tank")).toBe(0);
  });
});

describe("intake roller carve", async () => {
  const { splitIntakeRoller } = await import("../src/robot/wheels");
  /** a rear-intake robot: deck, two corner wheels reaching the floor, and 7 roller wheels on a shaft at y=0.09 */
  function cadLike(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => { const g = new THREE.BoxGeometry(sx, sy, sz, 2, 2, 2); g.translate(x, y, z); parts.push(g); };
    box(0.44, 0.01, 0.40, 0, 0.2, 0); // deck
    box(0.44, 0.02, 0.02, 0, 0.19, 0.2); box(0.44, 0.02, 0.02, 0, 0.19, -0.2); // rails
    for (const sz of [-1, 1]) box(0.12, 0.17, 0.07, -0.17, 0.085, sz * 0.17); // corner wheels: floor to 0.17
    const cyl = (r: number, len: number, z: number, segs: number) => { const g = new THREE.CylinderGeometry(r, r, len, 16, segs); g.rotateX(Math.PI / 2); g.translate(-0.15, 0.09, z); parts.push(g); };
    for (let i = -3; i <= 3; i++) cyl(0.024, 0.016, i * 0.028, 3); // 7 compliant wheels on an axle at (-0.15, 0.09)
    cyl(0.006, 0.24, 0, 48); // the shaft they sit on
    return weld(parts);
  }
  function weld(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const arrays = gs.map((g) => g.toNonIndexed().getAttribute("position").array as Float32Array);
    const n = arrays.reduce((a, b) => a + b.length, 0); const P = new Float32Array(n); let k = 0;
    for (const a of arrays) { P.set(a, k); k += a.length; }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(P, 3)); return g;
  }
  it("finds the flap roller at the rear, stops short of the corner wheels, and puts the axle at its centre", () => {
    const r = splitIntakeRoller(cadLike(), { lengthM: 0.44, widthM: 0.44, side: "rear", mouthWidthM: 0.33 });
    expect(r.roller).toBeDefined();
    const ro = r.roller!;
    expect(ro.x).toBeCloseTo(-0.15, 2); expect(ro.y).toBeCloseTo(0.09, 2); expect(ro.z).toBe(0);
    expect(ro.r).toBeGreaterThan(0.022); expect(ro.r).toBeLessThan(0.032);
    expect(ro.vMin).toBeGreaterThan(-0.13); expect(ro.vMax).toBeLessThan(0.13); // the corner wheels start at ±0.135
    const tris = ro.geometry.getAttribute("position").count / 3;
    const count = (g: THREE.BufferGeometry) => g.toNonIndexed().getAttribute("position").count / 3;
    expect(tris).toBe(7 * count(new THREE.CylinderGeometry(0.024, 0.024, 0.016, 16, 3)) + count(new THREE.CylinderGeometry(0.006, 0.006, 0.24, 16, 48))); // exactly the 7 wheels and the shaft
  });
  it("leaves a robot without a roller alone", () => {
    const g = new THREE.BoxGeometry(0.44, 0.1, 0.44, 4, 2, 4); g.translate(0, 0.25, 0);
    const r = splitIntakeRoller(g, { lengthM: 0.44, widthM: 0.44, side: "front", mouthWidthM: 0.33 });
    expect(r.roller).toBeUndefined();
  });
});
