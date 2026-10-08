import { expect, it } from 'vitest';
import * as THREE from 'three';
import { Match, type Agent } from '../src/sim/match';

function fixture() {
  const ag = { id: 'player', alliance: 'red', pose: { x: 0, z: 0, heading: 0 }, inventory: { pollen: 0, nectar: 0 }, caps: { capacity: 4, pollen: true, nectar: true }, intakeActive: false, footprint: { lengthM: .44, widthM: .44 }, intakeGeom: { side: 'front', widthM: .33 }, lastPick: -10, lastFlowerGrip: -10 } as Agent;
  const ball = { kind: 'pollen', alliance: 'red', pos: new THREE.Vector3(0, .04, -.3), vel: new THREE.Vector3(), radius: .036, settled: true, inCell: false, carried: false, launchedBy: '', launchedAt: 0 };
  const match = Object.assign(Object.create(Match.prototype), { flying: [ball], time: 0, flowerStock: [0, 0, 0, 0], field: { flowerAxis: () => new THREE.Vector3(9, 0, 9) } }) as Match;
  return { ag, ball, blocked: () => match.pickupBlockedByIntake(ag) };
}
it('warns only when intake is off and there is capacity', () => {
  const { ag, blocked } = fixture();
  expect(blocked()).toBe(true);
  ag.intakeActive = true; expect(blocked()).toBe(false);
  ag.intakeActive = false; ag.inventory.pollen = 4; expect(blocked()).toBe(false);
});
it('excludes balls behind, airborne, moving fast, carried, and own departing shots', () => {
  const { ball, blocked } = fixture();
  ball.pos.z = .3; expect(blocked()).toBe(false);
  ball.pos.z = -.3; ball.pos.y = 1; expect(blocked()).toBe(false);
  ball.pos.y = .04; ball.settled = false; ball.vel.x = 2; expect(blocked()).toBe(false);
  ball.vel.x = 0; ball.carried = true; expect(blocked()).toBe(false);
  ball.carried = false; ball.launchedBy = 'player'; expect(blocked()).toBe(false);
});
it('respects supported ball types and nectar alliance', () => {
  const { ag, ball, blocked } = fixture();
  ag.caps.pollen = false; expect(blocked()).toBe(false);
  ball.kind = 'nectar'; ball.alliance = 'blue'; expect(blocked()).toBe(false);
  ball.alliance = 'red'; expect(blocked()).toBe(true);
  ag.caps.nectar = false; expect(blocked()).toBe(false);
});
