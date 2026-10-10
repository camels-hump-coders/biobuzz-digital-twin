import { expect, it } from "vitest";
import * as THREE from "three";
import { Match, flowerFacing } from "../src/sim/match";

const IN = 0.0254;
/** A Match with just enough for the scripted brain's seek branch: one stocked FLOWER (index 0, north wall). */
function fixture() {
  const field = { flowerAxis: (i: number) => (i === 0 ? new THREE.Vector3(-24 * IN, 0, -68.4 * IN) : new THREE.Vector3(5, 0, 5)) };
  const match = Object.assign(Object.create(Match.prototype), { flying: [], time: 1, field, flowerStock: [4, 0, 0, 0], tier: () => "hard", rnd: () => 0.5, hives: {} });
  const ag: any = { id: "Opponent 1", alliance: "red", pose: { x: 0, z: 0, heading: 0 }, inventory: { pollen: 0, nectar: 0 }, caps: { capacity: 4, pollen: true, nectar: true }, intakeActive: false, footprint: { lengthM: 17 * IN, widthM: 17 * IN }, intakeGeom: { side: "front", widthM: 11 * IN, kind: "brushes" } };
  const r: any = { name: "Opponent 1", pose: { x: 0, z: 0, heading: 0 }, footprint: ag.footprint, speed: 1 };
  return { match, ag, r };
}

it("a scripted robot lines up in front of a FLOWER before driving in, so its intake deck meets the cage square", () => {
  const { match, ag, r } = fixture();
  expect(flowerFacing(0)).toEqual({ x: 0, z: 1 }); // the north flower faces +z, into the field
  // 14 in off the flower's axis line: the target is the staging point 16 in in front of the axis, not the axis
  r.pose = { x: -10 * IN, z: -50 * IN, heading: 0 }; ag.pose = r.pose;
  match.driveScripted(r, ag, 0.1);
  expect(r.target.x / IN).toBeCloseTo(-24, 3);
  expect(r.target.z / IN).toBeCloseTo(-68.4 + 16, 3);
  expect(ag.intakeActive).toBe(true);
  // on the axis line: the target is the axis itself (drive straight in)
  r.pose = { x: -24.5 * IN, z: -52 * IN, heading: 0 }; ag.pose = r.pose;
  match.driveScripted(r, ag, 0.1);
  expect(r.target.x / IN).toBeCloseTo(-24, 3);
  expect(r.target.z / IN).toBeCloseTo(-68.4, 3);
});
