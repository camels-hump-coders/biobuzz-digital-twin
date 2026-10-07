/** Live ball flight with drag, gravity and bounces off scene geometry. */
import * as THREE from "three";
import { acceleration, type BallProps } from "../ballistics/projectile";
import { type CellFrame, dot, sub, openingProfile } from "../field/hive";
import { FIELD, HIVE, m } from "../field/fieldSpec";

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
  kind: "pollen" | "nectar";
  /** nectar colour / owner; undefined for pollen */
  alliance?: "red" | "blue";
  massKg: number;
  /** set while a tipping hive is carrying this ball: disables settling for the frame */
  carried?: boolean;
  /** counted into a cell's load */
  inCell?: boolean;
  /** a ball scores at most once; after a tip releases it, it is just field debris */
  counted?: boolean;
  /** debug: description of the last surface hit */
  lastHit?: string;
  /** resting-contact bookkeeping */
  contactN: THREE.Vector3;
  contactAge: number;
  /** recent contact normals with the age at which they happened, for wedge detection */
  contacts?: { n: THREE.Vector3; at: number }[];
  /** the robot that launched it: ignored for collisions until the ball has cleared it */
  launcher?: THREE.Object3D;
  launcherIgnoreUntil?: number;
}

const G = 9.80665;
const RHO = 1.225;
const RESTITUTION = 0.45; // polyethylene ball on polycarbonate / aluminium
const REST_SPEED = 0.7; // below this normal speed a contact is treated as resting, not a bounce
const FLOOR_RESTITUTION = 0.5; // foam tiles
const FRICTION = 0.25; // tangential speed lost per bounce

const raycaster = new THREE.Raycaster();
const tmpN = new THREE.Vector3();
const tmpD = new THREE.Vector3();

export function stepBall(b: LiveBall, dt: number, ball: BallProps, colliders: THREE.Object3D[]): void {
  if (b.settled) return;
  b.age += dt;
  const carried = b.carried; b.carried = false;
  // integrate in substeps for accuracy (same acceleration model as the predictor), collide once per frame
  const start = b.pos.clone();
  const n = Math.max(1, Math.ceil(dt / 0.002));
  const h = dt / n;
  const props = { ...ball, diameterM: b.radius * 2, massKg: b.massKg };
  const resting = b.contactAge < 0.1;
  for (let i = 0; i < n; i++) {
    let { ax, ay, az } = acceleration(props, b.vel.x, b.vel.y, b.vel.z, b.spin, RHO, G);
    if (resting) {
      // supported by a surface: drop the acceleration component into it (normal force)
      const into = ax * b.contactN.x + ay * b.contactN.y + az * b.contactN.z;
      if (into < 0) { ax -= into * b.contactN.x; ay -= into * b.contactN.y; az -= into * b.contactN.z; }
    }
    b.vel.x += ax * h; b.vel.y += ay * h; b.vel.z += az * h;
    b.pos.addScaledVector(b.vel, h);
  }
  // spin decays on every bounce (handled below) and slowly in flight
  b.spin *= Math.max(0, 1 - 0.3 * dt);
  // scene collision along the swept path
  tmpD.subVectors(b.pos, start);
  const dist = tmpD.length();
  if (dist > 1e-6 && colliders.length) {
    tmpD.divideScalar(dist);
    raycaster.set(start, tmpD);
    raycaster.near = 0;
    raycaster.far = dist + b.radius;
    const ignoreOwn = b.launcher && b.age < (b.launcherIgnoreUntil ?? 0);
    const hits = raycaster.intersectObjects(colliders, true);
    const hit = hits.find((hh) => hh.face && hh.object !== b.mesh && !(ignoreOwn && isDescendant(hh.object, b.launcher!)));
    if (hit && hit.face) {
      b.lastHit = `${hit.object.name || (hit.object as THREE.Mesh).geometry?.type} in ${hit.object.parent?.name || hit.object.parent?.type} @ (${hit.point.x.toFixed(2)},${hit.point.y.toFixed(2)},${hit.point.z.toFixed(2)}) d=${hit.distance.toFixed(3)}/${dist.toFixed(3)}`;
      tmpN.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (tmpN.dot(tmpD) > 0) tmpN.negate(); // face the incoming ball
      // place ball just off the surface and reflect
      b.pos.copy(hit.point).addScaledVector(tmpN, b.radius + 0.002);
      const vn = b.vel.dot(tmpN);
      if (vn < 0) {
        const normal = tmpN.clone().multiplyScalar(vn);
        const tangent = b.vel.clone().sub(normal);
        (b.contacts ??= []).push({ n: tmpN.clone(), at: b.age });
        if (b.contacts.length > 12) b.contacts.shift();
        if (-vn < REST_SPEED) {
          // resting contact: no rebound, sliding friction bleeds the tangential speed
          b.vel.copy(tangent.multiplyScalar(0.75));
          b.contactN.copy(tmpN); b.contactAge = 0;
        } else {
          b.vel.copy(tangent.multiplyScalar(1 - FRICTION)).addScaledVector(tmpN, -vn * RESTITUTION);
          b.spin *= 0.3;
          b.bounces++;
        }
      }
    }
  }
  // The perimeter is only as tall as the visible wall. A shot that clears it
  // must remain outside, including when it later descends below wall height.
  const half = m(FIELD.sizeIn) / 2;
  const lim = half - b.radius;
  const startedInside = Math.abs(start.x) <= half && Math.abs(start.z) <= half;
  if (startedInside && Math.min(start.y, b.pos.y) - b.radius < m(FIELD.wallHeightIn)) {
    if (Math.abs(b.pos.x) > lim) { b.pos.x = Math.sign(b.pos.x) * lim; if (Math.sign(b.vel.x) === Math.sign(b.pos.x)) b.vel.x *= -RESTITUTION; }
    if (Math.abs(b.pos.z) > lim) { b.pos.z = Math.sign(b.pos.z) * lim; if (Math.sign(b.vel.z) === Math.sign(b.pos.z)) b.vel.z *= -RESTITUTION; }
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
  // while in resting contact, cancel the velocity component pushing into the surface (gravity on a slope)
  if (b.contactAge < 0.1) {
    b.contactAge += dt;
    const into = b.vel.dot(b.contactN);
    if (into < 0) b.vel.addScaledVector(b.contactN, -into);
  }
  // rest detection on net displacement, so a ball wedged in a corner (falling 1 cm and being pushed back
  // every frame) still counts as resting
  const moved = b.pos.distanceTo(start) / Math.max(dt, 1e-3);
  // wedged: two non-parallel surfaces touched within the last 0.2 s at low speed -> it has stopped
  const recent = (b.contacts ?? []).filter((c) => b.age - c.at < 0.2);
  const wedged = recent.some((c1) => recent.some((c2) => c1.n.dot(c2.n) < 0.7));
  if ((moved < 0.15 && b.vel.lengthSq() < 0.8 * 0.8) || (wedged && b.vel.lengthSq() < 1.0)) b.restFor += dt * (wedged ? 3 : 1); else b.restFor = 0;
  if (carried) b.restFor = 0;
  // long-lived jitter guard: an old ball that is slow and touching something (floor or a recent surface contact) is
  // declared at rest. It must never apply to a ball in the air, e.g. one just thrown out of a tipping cell.
  const touching = b.pos.y <= b.radius + 0.01 || (b.contacts ?? []).some((c) => b.age - c.at < 0.3) || b.contactAge < 0.3;
  const oldAndSlow = b.age > 8 && !carried && touching && b.vel.lengthSq() < 0.6 * 0.6;
  if (b.restFor > 0.4 || oldAndSlow) { b.settled = true; b.vel.set(0, 0, 0); }
  b.mesh.position.copy(b.pos);
}

function isDescendant(o: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === ancestor) return true;
  return false;
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
