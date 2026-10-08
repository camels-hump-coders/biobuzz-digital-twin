import { expect, it } from "vitest";
import * as THREE from "three";
import { Match, type Agent } from "../src/sim/match";

/** A Match with only the FLOWER model: one stocked FLOWER at (0, -0.5) on the floor. */
function fixture(kind: "brushes" | "roller" = "brushes") {
  const ag = { id: "player", alliance: "red", pose: { x: 0, z: -0.26, heading: 0 }, inventory: { pollen: 0, nectar: 0 }, caps: { capacity: 4, pollen: true, nectar: true }, intakeActive: false, footprint: { lengthM: 0.45, widthM: 0.45 }, intakeGeom: { side: "front", widthM: 0.33, kind }, intake: { x: 0, z: 0 }, lastPick: -10 } as Agent;
  const stacks = [[mesh(), mesh(), mesh(), mesh()], [], [], []];
  const field = { flowerAxis: (i: number) => new THREE.Vector3(i === 0 ? 0 : 5, 0, -0.5), flowerPollen: stacks };
  const match = Object.assign(Object.create(Match.prototype), { flying: [], time: 0, field, flowerStock: [4, 0, 0, 0], intakeCount: 0, flowerPickCount: 0 }) as Match;
  return { ag, match, pick: () => (match as any).pickup(ag) };
}
function mesh() { const m = new THREE.Mesh(); m.position.y = 0.05; return m; }

it("pulls POLLEN out of a FLOWER only while the intake runs, bottom first, paced", () => {
  const { ag, match, pick } = fixture();
  pick(); expect(ag.inventory.pollen).toBe(0); // intake off
  expect(match.pickupBlockedByIntake(ag)).toBe(true); // and the HUD says so
  ag.intakeActive = true;
  pick(); expect(ag.inventory.pollen).toBe(1); expect(match.flowerStockOf(0)).toBe(3); expect(match.flowerPickCount).toBe(1);
  pick(); expect(ag.inventory.pollen).toBe(1); // 0.3 s pacing
  (match as any).time = 0.31; pick(); expect(ag.inventory.pollen).toBe(2);
});
it("a plain roller cannot retrieve from a FLOWER, and the mouth must face it", () => {
  const roller = fixture("roller");
  roller.ag.intakeActive = true; roller.pick(); expect(roller.ag.inventory.pollen).toBe(0);
  expect(roller.match.pickupBlockedByIntake(roller.ag)).toBe(false);
  const side = fixture();
  side.ag.intakeActive = true; side.ag.pose = { x: 0, z: -0.26, heading: Math.PI / 2 }; // mouth points -X
  side.pick(); expect(side.ag.inventory.pollen).toBe(0);
});
