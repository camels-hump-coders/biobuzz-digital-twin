import { expect, it } from "vitest";
import * as THREE from "three";
import { Match, type Agent } from "../src/sim/match";
import { FEEDER } from "../src/sim/intake";

/** A Match with only the FLOWER model and a stub scene: one stocked FLOWER at (0, -0.5) on the floor. */
function fixture(kind: "brushes" | "roller" = "brushes", edgePastAxisM = 0.014) {
  // front intake at heading 0 faces -Z: front edge at z = pose.z - 0.225; put it `edgePastAxisM` past the axis (z = -0.5)
  const ag = { id: "player", alliance: "red", pose: { x: 0, z: -0.5 + 0.225 - edgePastAxisM, heading: 0 }, inventory: { pollen: 0, nectar: 0 }, caps: { capacity: 4, pollen: true, nectar: true }, intakeActive: false, footprint: { lengthM: 0.45, widthM: 0.45 }, intakeGeom: { side: "front", widthM: 0.33, kind }, intake: { x: 0, z: 0 }, lastPick: -10, lastFlowerGrip: -10, carryGroup: new THREE.Group() } as Agent;
  const stacks = [[mesh(), mesh(), mesh(), mesh()], [], [], []];
  const field = { flowerAxis: (i: number) => new THREE.Vector3(i === 0 ? 0 : 5, 0, -0.5), flowerPollen: stacks };
  const flying: any[] = [];
  const match = Object.assign(Object.create(Match.prototype), { flying, time: 0, field, scene: { add() {} }, flowerStock: [4, 0, 0, 0], intakeCount: 0, flowerPickCount: 0 }) as Match;
  const step = (dt = 0.02) => { (match as any).time += dt; (match as any).pickup(ag, dt); for (const b of flying) { b.pos.addScaledVector(b.vel, dt); b.mesh.position.copy(b.pos); } };
  return { ag, match, flying, step };
}
function mesh() { const m = new THREE.Mesh(); m.position.y = 0.05; return m; }

it("a FLOWER's bottom POLLEN leaves only on contact with a running feeder, then travels to the seat before it counts", () => {
  const { ag, match, flying, step } = fixture();
  step(); expect(flying.length).toBe(0); expect(match.flowerStockOf(0)).toBe(4); // intake off: nothing happens
  ag.intakeActive = true;
  step(); expect(flying.length).toBe(1); expect(match.flowerStockOf(0)).toBe(3); // gripped: now a live ball at the axis
  expect(ag.inventory.pollen).toBe(0);
  let t = 0; while (ag.inventory.pollen === 0 && t < 2) { step(); t += 0.02; }
  expect(ag.inventory.pollen).toBe(1); expect(t).toBeGreaterThan(0.05); expect(t).toBeLessThan(1.0); // pulled ~10 cm at the feeder speed
  expect(flying.length).toBe(0); expect(match.flowerPickCount).toBe(1);
  // the stack feeds the next one, paced
  let t2 = 0; while (ag.inventory.pollen < 2 && t2 < 3) { step(); t2 += 0.02; }
  expect(ag.inventory.pollen).toBe(2);
});
it("no feeder contact, no POLLEN: too far out, a plain roller, or the mouth pointing elsewhere", () => {
  const far = fixture("brushes", -0.08); far.ag.intakeActive = true; far.step(); expect(far.flying.length).toBe(0); // 8 cm short of the axis
  const roller = fixture("roller"); roller.ag.intakeActive = true; roller.step(); expect(roller.flying.length).toBe(0);
  const side = fixture(); side.ag.intakeActive = true; side.ag.pose = { x: 0, z: -0.26, heading: Math.PI / 2 }; side.step(); expect(side.flying.length).toBe(0);
});
it("a loose ball is pulled in only once a feeder part touches it, and held at the seat while the feeder is paced", () => {
  const { ag, match, flying, step } = fixture();
  ag.intakeActive = true; (match as any).flowerStock = [0, 0, 0, 0];
  const b = match.spawnBall("pollen", undefined, new THREE.Vector3(0, 0.036, -0.5 + 0.225 - 0.014 - 0.225 - 0.12), new THREE.Vector3(), true); // 12 cm in front of the edge
  step(); expect(b.vel.length()).toBe(0); // out of reach: the feeder does not act at a distance
  b.pos.z += 0.11; // drive it to the roller line (1.4 cm past the edge is where the roller grips)
  step(); expect(b.vel.length()).toBeGreaterThan(0.1);
  let t = 0; while (ag.inventory.pollen === 0 && t < 2) { step(); t += 0.02; }
  expect(ag.inventory.pollen).toBe(1); expect(flying.length).toBe(0);
  expect(FEEDER.seatU).toBeLessThan(FEEDER.rollerU);
});
