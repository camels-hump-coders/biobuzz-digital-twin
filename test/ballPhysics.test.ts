import { expect, it } from 'vitest';
import * as THREE from 'three';
import { stepBall, type LiveBall } from '../src/sim/ballPhysics';
import { FIELD, m } from '../src/field/fieldSpec';
const props = { massKg: 0.025, diameterM: 0.09, cd: 0, cl: 0 };
function ball(y: number): LiveBall {
  return { mesh: new THREE.Mesh(), pos: new THREE.Vector3(m(FIELD.sizeIn)/2 - 0.1, y, 0), vel: new THREE.Vector3(5,0,0), radius: 0.045, spin: 0, age: 0, restFor: 0, bounces: 0, kind: 'pollen', massKg: props.massKg, contactN: new THREE.Vector3(0,1,0), contactAge: 1 };
}
it('shots clearing the visible perimeter fly out without reflecting and stay out as they fall', () => {
  const b = ball(1);
  stepBall(b, 0.05, props, []);
  expect(b.pos.x).toBeGreaterThan(m(FIELD.sizeIn)/2);
  expect(b.vel.x).toBeGreaterThan(0);
  for (let i=0;i<30;i++) stepBall(b,0.05,props,[]);
  expect(b.pos.x).toBeGreaterThan(m(FIELD.sizeIn)/2);
  expect(b.vel.x).toBeGreaterThanOrEqual(0);
});
it('low shots still bounce off the perimeter', () => {
  const b=ball(0.15); stepBall(b,0.05,props,[]);
  expect(b.pos.x).toBeLessThan(m(FIELD.sizeIn)/2);
  expect(b.vel.x).toBeLessThan(0);
});
it('an outside low ball is not teleported back inside', () => {
  const b=ball(0.1); b.pos.x=3; stepBall(b,0.02,props,[]);
  expect(b.pos.x).toBeGreaterThan(3);
});
