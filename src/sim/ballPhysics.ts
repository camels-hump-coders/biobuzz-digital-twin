/** Live ball flight with drag, gravity and bounces off scene geometry. */
import * as THREE from "three";
import type { BallProps } from "../ballistics/projectile";
import { type CellFrame, dot, sub, openingProfile } from "../field/hive";
import { HIVE, m } from "../field/fieldSpec";

export interface LiveBall {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: number;
  radius: number;
  age: number;
  restFor: number;
  /** set once the ball has come to rest; true if it settled inside the target cell */
  settled?: boolean;
  scored?: boolean;
  bounces: number;
}

const G = 9.80665;
const RHO = 1.225;
const RESTITUTION = 0.45; // polyethylene ball on polycarbonate / aluminium
const FLOOR_RESTITUTION = 0.5; // foam tiles
const FRICTION = 0.25; // tangential speed lost per bounce

const raycaster = new THREE.Raycaster();
const tmpN = new THREE.Vector3();
const tmpD = new THREE.Vector3();

export function stepBall(b: LiveBall, dt: number, ball: BallProps, colliders: THREE.Object3D[]): void {
  if (b.settled) return;
  b.age += dt;
  const area = Math.PI * b.radius * b.radius;
  const kDrag = (0.5 * RHO * ball.cd * area) / ball.massKg;
  // integrate in substeps for accuracy, collide once over the whole frame displacement
  const start = b.pos.clone();
  const n = Math.max(1, Math.ceil(dt / 0.002));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const speed = b.vel.length() || 1e-9;
    b.vel.x += -kDrag * speed * b.vel.x * h;
    b.vel.y += (-G - kDrag * speed * b.vel.y) * h;
    b.vel.z += -kDrag * speed * b.vel.z * h;
    b.pos.addScaledVector(b.vel, h);
  }
  // scene collision along the swept path
  tmpD.subVectors(b.pos, start);
  const dist = tmpD.length();
  if (dist > 1e-6 && colliders.length) {
    tmpD.divideScalar(dist);
    raycaster.set(start, tmpD);
    raycaster.near = 0;
    raycaster.far = dist + b.radius;
    const hits = raycaster.intersectObjects(colliders, true);
    const hit = hits.find((hh) => hh.face && hh.object !== b.mesh);
    if (hit && hit.face) {
      tmpN.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (tmpN.dot(tmpD) > 0) tmpN.negate(); // face the incoming ball
      // place ball just off the surface and reflect
      b.pos.copy(hit.point).addScaledVector(tmpN, b.radius + 0.002);
      const vn = b.vel.dot(tmpN);
      if (vn < 0) {
        const normal = tmpN.clone().multiplyScalar(vn);
        const tangent = b.vel.clone().sub(normal);
        b.vel.copy(tangent.multiplyScalar(1 - FRICTION)).addScaledVector(tmpN, -vn * RESTITUTION);
        b.bounces++;
      }
    }
  }
  // floor
  if (b.pos.y < b.radius) {
    b.pos.y = b.radius;
    if (b.vel.y < 0) {
      b.vel.y = -b.vel.y * FLOOR_RESTITUTION;
      b.vel.x *= 1 - FRICTION;
      b.vel.z *= 1 - FRICTION;
      if (Math.abs(b.vel.y) < 0.4) b.vel.y = 0;
      b.bounces++;
    }
    // rolling friction
    const f = Math.max(0, 1 - 1.5 * dt);
    b.vel.x *= f; b.vel.z *= f;
  }
  // rest detection
  if (b.vel.lengthSq() < 0.01) b.restFor += dt; else b.restFor = 0;
  if (b.restFor > 0.5 || b.age > 8) b.settled = true;
  b.mesh.position.copy(b.pos);
}

/** Is a point inside the cell's prism (opening plane back to the back skin)? */
export function insideCell(frame: CellFrame, p: { x: number; y: number; z: number }, margin = 0.0): boolean {
  const d = sub(p, frame.floorCenterAtOpening);
  const along = dot(d, frame.normal); // 0 at the opening, negative inside
  const depth = m(HIVE.cellDepthIn);
  if (along > margin || along < -depth - margin) return false;
  const r = dot(d, frame.right), u = dot(d, frame.up);
  const poly = openingProfile();
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.u > u !== b.u > u && r < ((b.r - a.r) * (u - a.u)) / (b.u - a.u) + a.r) inside = !inside;
  }
  return inside;
}
