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

it('rolling balls slow with a constant deceleration and snap to rest', () => {
  const b = ball(0.045); b.pos.x = 0; b.vel.set(0.3, 0, 0);
  let t = 0; while (b.vel.x > 0 && t < 5) { stepBall(b, 0.01, props, []); t += 0.01; }
  expect(t).toBeGreaterThan(0.3); expect(t).toBeLessThan(0.8); // 0.3 m/s at ~0.6 m/s² plus the 5 cm/s snap
  expect(b.vel.x).toBe(0);
});
it('ball-ball contact separates overlapping balls and exchanges momentum, in 3D', async () => {
  const { collideBalls } = await import('../src/sim/ballPhysics');
  const a = ball(0.5), c = ball(0.5); a.pos.set(0, 0.5, 0); c.pos.set(0.06, 0.5, 0); a.vel.set(2, 0, 0); c.vel.set(0, 0, 0);
  collideBalls([a, c], 1.8);
  expect(c.pos.x - a.pos.x).toBeCloseTo(0.09, 6);
  expect(a.vel.x).toBeLessThan(0.5); expect(c.vel.x).toBeGreaterThan(1.4);
  // a settled ball is only knocked awake by a real hit
  const r = ball(0.045), s = ball(0.045); r.pos.set(0, 0.045, 0); s.pos.set(0.08, 0.045, 0); s.settled = true; s.vel.set(0, 0, 0); r.vel.set(0.1, 0, 0);
  collideBalls([r, s], 1.8);
  expect(s.settled).toBe(true); expect(s.pos.x).toBe(0.08); expect(r.pos.x).toBeCloseTo(-0.01, 6);
  r.vel.set(2, 0, 0); r.pos.set(0, 0.045, 0);
  collideBalls([r, s], 1.8);
  expect(s.settled).toBe(false);
});
