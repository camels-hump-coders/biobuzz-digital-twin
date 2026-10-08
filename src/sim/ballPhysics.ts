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
const ROLL_DECEL = 0.5; // m/s², rolling resistance of a polyethylene ball on foam tile
const ROLL_VISCOUS = 0.4; // 1/s, extra loss that grows with speed (tile seams, air)
const ROLL_SNAP = 0.05; // m/s, below this a rolling ball is stopped outright
const BALL_RESTITUTION = 0.55; // ball on ball

/** normal impact speeds (m/s) of bounces since the last drain, for audio */
export const recentImpacts: number[] = [];
export function drainImpacts(): number[] { const out = recentImpacts.slice(); recentImpacts.length = 0; return out; }

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
          if (recentImpacts.length < 32) recentImpacts.push(-vn);
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
      const impact = -b.vel.y;
      if (impact > 0.4) {
        // a real bounce: rebound and scrub tangential speed
        b.vel.y = impact * FLOOR_RESTITUTION;
        b.vel.x *= 1 - FRICTION;
        b.vel.z *= 1 - FRICTION;
        b.bounces++;
        if (recentImpacts.length < 32) recentImpacts.push(impact);
      } else b.vel.y = 0; // rolling contact: the floor just carries it (the old per-frame scrub killed every roll in a few frames)
    }
    // rolling resistance on the foam tiles: a constant (Coulomb) deceleration plus a little speed-proportional loss,
    // and a hard snap to rest below 5 cm/s so slow balls stop instead of creeping
    const speed = Math.hypot(b.vel.x, b.vel.z);
    const dec = ROLL_DECEL * dt + speed * ROLL_VISCOUS * dt;
    if (speed <= dec + ROLL_SNAP) { b.vel.x = 0; b.vel.z = 0; }
    else { const k = (speed - dec) / speed; b.vel.x *= k; b.vel.z *= k; }
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

/** Sphere–sphere contact for every pair that is not both at rest. Positions are corrected (a settled ball holds
 *  its ground unless knocked), velocities exchange an impulse along the normal with BALL_RESTITUTION, and balls on
 *  the floor stay inside the perimeter (`halfField`). */
export function collideBalls(balls: LiveBall[], halfField: number): void {
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    for (let j = i + 1; j < balls.length; j++) {
      const b = balls[j];
      if (a.settled && b.settled) continue;
      const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z;
      const min = a.radius + b.radius;
      if (Math.abs(dx) >= min || Math.abs(dz) >= min || Math.abs(dy) >= min) continue;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= min || d < 1e-6) continue;
      const nx = dx / d, ny = dy / d, nz = dz / d, pen = min - d;
      const rel = (a.vel.x - b.vel.x) * nx + (a.vel.y - b.vel.y) * ny + (a.vel.z - b.vel.z) * nz; // closing speed
      // a resting ball is only woken by a real knock; otherwise the moving ball is pushed off it
      const knock = rel > 0.5;
      const aFixed = a.settled && !knock, bFixed = b.settled && !knock;
      const wa = aFixed ? 0 : bFixed ? 1 : 0.5, wb = 1 - wa;
      if (aFixed && bFixed) continue;
      a.pos.x -= nx * pen * wa; a.pos.y -= ny * pen * wa; a.pos.z -= nz * pen * wa;
      b.pos.x += nx * pen * wb; b.pos.y += ny * pen * wb; b.pos.z += nz * pen * wb;
      for (const k of [a, b]) {
        if (k.pos.y < k.radius) k.pos.y = k.radius;
        if (k.pos.y < 0.3) { k.pos.x = Math.min(halfField - k.radius, Math.max(-halfField + k.radius, k.pos.x)); k.pos.z = Math.min(halfField - k.radius, Math.max(-halfField + k.radius, k.pos.z)); }
        k.mesh.position.copy(k.pos);
      }
      if (rel > 0) {
        const ma = aFixed ? Infinity : a.massKg, mb = bFixed ? Infinity : b.massKg;
        const inv = (ma === Infinity ? 0 : 1 / ma) + (mb === Infinity ? 0 : 1 / mb);
        if (inv > 0) {
          const jImp = ((1 + BALL_RESTITUTION) * rel) / inv;
          if (ma !== Infinity) { a.vel.x -= (jImp / ma) * nx; a.vel.y -= (jImp / ma) * ny; a.vel.z -= (jImp / ma) * nz; }
          if (mb !== Infinity) { b.vel.x += (jImp / mb) * nx; b.vel.y += (jImp / mb) * ny; b.vel.z += (jImp / mb) * nz; }
        }
      }
      if (knock) { for (const k of [a, b]) if (k.settled) { k.settled = false; k.restFor = 0; k.age = Math.min(k.age, 1); } }
    }
  }
}
