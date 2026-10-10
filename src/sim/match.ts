/** Match dynamics: robot inventories and pickup, FLOWER stocks, NECTAR supply, both hives' loads and tipping,
 * and the behaviour of the scripted alliance partner and opponents. */
import * as THREE from "three";
import type { FieldObjects } from "../field/buildField";
import { BALL, FIELD, FLOWER, ZONES, m } from "../field/fieldSpec";
import { type Alliance, type CellSide, type CellFrame, aimPoint, cellFrames, hivePivot, upCellFrame } from "../field/hive";
import { collideBalls, insideCell, type LiveBall } from "./ballPhysics";
import type { Footprint, Pose } from "./drive";
import { FEEDER, chassisPush, feederContact, flowerInMouth, inCorridor, inIntakeMouth, intakePoint, mouthAxes, mouthFrame, type IntakeGeom } from "./intake";
import { headingToward } from "./drive";
import type { ScriptedRobot } from "./opponents";
import { solveSpeedForElevation } from "../ballistics/solver";
import { velocityFrom } from "../ballistics/projectile";
import { gaussian, rng } from "../ballistics/dispersion";
import { clamp, wrapAngle } from "../util/units";
import { type HingeState, loadTorque, remainingSwing, stepHinge } from "./hiveDynamics";
import { type AiTier, TIERS, type TierKnobs, choiceNoise } from "./aiTiers";

function hashName(s: string): number { let h = 7; for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0; return h % 1000; }

export type BallKind = "pollen" | "nectar";
export interface Inventory { pollen: number; nectar: number }
export interface Capabilities { capacity: number; pollen: boolean; nectar: boolean }

export interface HiveSim {
  alliance: Alliance;
  upCell: CellSide;
  stagedNectar: number;
  tips: number;
  /** a swing in progress: the hinge state plus `from`, the angle the tray was last drawn at (`last`) and a running
   *  estimate of the whole swing's length (`duration`, for the HUD); `load` is Σ m·rz of the balls riding last frame */
  tipping?: HingeState & { from: number; duration: number; last: number; load: { massKg: number; rz: number }[] };
}

export const TIP_DEG = 30;
const INTAKE_RANGE_M = m(7); // ball centre within this of the intake edge gets pulled in
const PUSH_SPEED_MIN = 0.25; // m/s a nudged ball leaves the chassis with, even when the robot is barely moving
const PICK_INTERVAL = 0.35; // s per ball through the feeder once it reaches the seat
const FLOWER_PICK_INTERVAL = 0.3; // s between POLLEN leaving a FLOWER's stack (bottom first, the rest drop)

export interface Agent {
  id: string;
  alliance: Alliance;
  pose: Pose;
  inventory: Inventory;
  caps: Capabilities;
  intakeActive: boolean;
  /** chassis rectangle; balls meeting a non-intake side are pushed */
  footprint: Footprint;
  /** which side collects, and how wide the mouth is */
  intakeGeom: IntakeGeom;
  /** intake point on the field (floor level), recomputed each update */
  intake: { x: number; z: number };
  /** previous pose for the chassis velocity used when pushing balls */
  prevPose?: Pose;
  /** this update: the part of the chassis motion loose balls refused (squeezed on the wall or on a wall-pinned ball),
   * world metres in the push direction, and how many balls held it (SG-005: a stalled pre-shot approach) */
  blocked?: { x: number; z: number; balls: number };
  lastPick: number;
  /** sim time the feeder last pulled a POLLEN out of a FLOWER */
  lastFlowerGrip: number;
  /** balls this robot's feeder has swallowed (audio cues only follow the player's) */
  picks?: number;
  /** the feeder touched a ball it may not take (wrong kind or the other alliance's NECTAR): what and when */
  rejected?: { kind: BallKind; alliance?: Alliance; at: number };
  carryGroup: THREE.Group;
}

/** Unit vector from a FLOWER into the field: the only side a robot can put its intake under the cage from. */
export function flowerFacing(fi: number): { x: number; z: number } {
  const w = FLOWER.positions[fi]?.wall;
  return w === "N" ? { x: 0, z: 1 } : w === "S" ? { x: 0, z: -1 } : w === "E" ? { x: -1, z: 0 } : { x: 1, z: 0 };
}

export class Match {
  hives: Record<Alliance, HiveSim>;
  nectarSupply: Record<Alliance, number> = { red: 5, blue: 5 };
  private flowerStock = [4, 4, 4, 4];
  private rnd = rng(1234);
  private time = 0;
  /** balls swallowed by any intake since construction (audio and tests edge-detect on it) */
  intakeCount = 0;
  /** POLLEN pulled out of FLOWERs since construction */
  flowerPickCount = 0;
  /** tips started / swings finished (both hives), for audio */
  tipsStarted = 0; tipsDone = 0;
  /** the last reserve NECTAR the human player entered after a tip (so the HUD can say where that ball came from) */
  lastNectarRelease?: { alliance: Alliance; at: number };

  private scene: THREE.Scene; private field: FieldObjects; private flying: LiveBall[]; private hiveState: Record<Alliance, CellSide>; private tipMassKg: () => number; private autoTip: () => boolean;
  /** difficulty of the scripted robots */
  tier: () => AiTier;
  constructor(scene: THREE.Scene, field: FieldObjects, flying: LiveBall[], hiveState: Record<Alliance, CellSide>, tipMassKg: () => number, autoTip: () => boolean, tier: () => AiTier = () => "medium") {
    this.scene = scene; this.field = field; this.flying = flying; this.hiveState = hiveState; this.tipMassKg = tipMassKg; this.autoTip = autoTip; this.tier = tier;
    this.hives = {
      red: { alliance: "red", upCell: hiveState.red, stagedNectar: 3, tips: 0 },
      blue: { alliance: "blue", upCell: hiveState.blue, stagedNectar: 3, tips: 0 },
    };
    this.convertGardenPollen();
  }

  /** Match start: flowers full, gardens staged, 3 NECTAR in each raised cell, 5 NECTAR per alliance in reserve. */
  reset(agents: Agent[]) {
    for (const b of this.flying) b.mesh.removeFromParent();
    this.flying.length = 0;
    for (const a of ["red", "blue"] as Alliance[]) {
      this.hives[a] = { alliance: a, upCell: this.hiveState[a], stagedNectar: 3, tips: 0 };
      this.field.setStagedNectar(a, true);
      this.field.setHiveState({ alliance: a, upCell: this.hiveState[a] });
    }
    this.nectarSupply = { red: 5, blue: 5 };
    this.flowerStock = [4, 4, 4, 4];
    this.field.restockFlowers();
    this.convertGardenPollen();
    for (const ag of agents) { ag.inventory = { pollen: Math.min(4, ag.caps.capacity), nectar: 0 }; }
  }

  /** Reset a single hive (T key / panel) without touching the rest of the field. */
  resetHive(alliance: Alliance) {
    const h = this.hives[alliance];
    h.tipping = undefined;
    this.releaseCell(alliance);
    h.upCell = this.hiveState[alliance];
    h.stagedNectar = 3;
    this.field.setStagedNectar(alliance, true);
    this.field.setHiveState({ alliance, upCell: h.upCell });
  }

  /** The 4 POLLEN staged in each GARDEN become live balls at their staged positions (every reset, not only the first). */
  private convertGardenPollen() {
    for (const g of this.field.gardenPollen) {
      if (g.parent) g.removeFromParent(); // the static stand-in mesh; its position is the staging spot
      this.spawnBall("pollen", undefined, g.position.clone(), new THREE.Vector3(), true);
    }
  }

  flowerStockOf(i: number) { return this.flowerStock[i]; }
  flowerStocks() { return [...this.flowerStock]; }

  spawnBall(kind: BallKind, alliance: Alliance | undefined, pos: THREE.Vector3, vel: THREE.Vector3, settled = false, spin = 0): LiveBall {
    const props = kind === "pollen" ? BALL.pollen : alliance === "blue" ? BALL.nectarBlue : BALL.nectarRed;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(m(props.diaIn) / 2, 20, 14), new THREE.MeshStandardMaterial({ color: props.color, roughness: 0.45 }));
    mesh.castShadow = true;
    mesh.position.copy(pos);
    this.scene.add(mesh);
    const ball: LiveBall = { mesh, pos: pos.clone(), vel: vel.clone(), spin, radius: m(props.diaIn) / 2, age: 0, restFor: 0, bounces: 0, kind, alliance, massKg: props.massKg, contactN: new THREE.Vector3(0, 1, 0), contactAge: 1, settled };
    this.flying.push(ball);
    return ball;
  }

  /** Try to launch one ball from an agent's inventory. Prefers the requested kind, falls back to the other.
   * `launcherObj` is the firing robot's scene object; the ball passes through it for its first half second. */
  launch(agent: Agent, preferred: BallKind, exit: THREE.Vector3, vel: THREE.Vector3, spin: number, launcherObj?: THREE.Object3D): LiveBall | undefined {
    let kind: BallKind | undefined;
    if (preferred === "nectar" && agent.inventory.nectar > 0) kind = "nectar";
    else if (preferred === "pollen" && agent.inventory.pollen > 0) kind = "pollen";
    else if (agent.inventory.pollen > 0) kind = "pollen";
    else if (agent.inventory.nectar > 0) kind = "nectar";
    if (!kind) return undefined;
    agent.inventory[kind]--;
    const b = this.spawnBall(kind, kind === "nectar" ? agent.alliance : undefined, exit, vel, false, spin);
    b.launcher = launcherObj; b.launcherIgnoreUntil = 0.5; (b as any).launchedBy = agent.id; (b as any).launchedAt = this.time;
    return b;
  }

  upFrame(alliance: Alliance): CellFrame { return upCellFrame({ alliance, upCell: this.hives[alliance].upCell }); }

  cellLoad(alliance: Alliance): { pollen: number; nectar: number; massKg: number } {
    const h = this.hives[alliance];
    let pollen = 0, nectar = 0, massKg = h.stagedNectar * BALL.nectarRed.massKg;
    for (const f of this.flying) if (f.inCell && (f as any).cellOf === alliance) { if (f.kind === "pollen") pollen++; else nectar++; massKg += f.massKg; }
    return { pollen, nectar: nectar + h.stagedNectar, massKg };
  }

  private releaseCell(alliance: Alliance) {
    for (const f of this.flying) if (f.inCell && (f as any).cellOf === alliance) { f.inCell = false; (f as any).cellOf = undefined; f.settled = false; f.restFor = 0; f.age = 0; f.contacts = []; f.contactAge = 1; }
  }

  private startTip(alliance: Alliance) {
    const h = this.hives[alliance];
    const from = ((h.upCell === "audience" ? TIP_DEG : -TIP_DEG) * Math.PI) / 180;
    // the detent lets go: from here the swing is physical (hiveDynamics), driven by the balls riding in the cell
    h.tipping = { from, to: -from, angle: from, omega: 0, t: 0, duration: 3, last: from, load: [] };
    // the staged NECTAR become live balls riding in the cell
    for (const p of this.field.stagedNectar(alliance)) {
      const b = this.spawnBall("nectar", alliance, p, new THREE.Vector3(), true);
      b.counted = true; b.inCell = true; (b as any).cellOf = alliance; b.settled = false; b.restFor = 0;
    }
    h.stagedNectar = 0;
    this.field.setStagedNectar(alliance, false);
    // the scored balls stay "in the cell" for the swing so the carry logic moves them, then roll out under gravity
    for (const f of this.flying) if (f.inCell && (f as any).cellOf === alliance) { f.settled = false; f.restFor = 0; f.contacts = []; f.contactAge = 1; }
    h.tips++; this.tipsStarted++;
    // a tip unlocks a NECTAR: the human player drops one into the LOADING ZONE
    if (this.nectarSupply[alliance] > 0) {
      this.lastNectarRelease = { alliance, at: this.time };
      this.nectarSupply[alliance]--;
      const z = alliance === "red" ? ZONES.loadingRed : ZONES.loadingBlue;
      const pos = new THREE.Vector3(m((z.xMin + z.xMax) / 2), m(BALL.nectarRed.diaIn) / 2 + 0.3, m((z.zMin + z.zMax) / 2));
      this.spawnBall("nectar", alliance, pos, new THREE.Vector3());
    }
  }

  /** simulated seconds since start */
  now(): number { return this.time; }

  /** Call every frame. */
  update(dt: number, agents: Agent[]) {
    this.time += dt;
    // --- scoring: settled balls inside a raised cell
    const frames: Record<Alliance, CellFrame> = { red: this.upFrame("red"), blue: this.upFrame("blue") };
    for (const f of this.flying) {
      if (!f.settled || f.counted) continue;
      for (const a of ["red", "blue"] as Alliance[]) {
        if (this.hives[a].tipping) continue;
        if (insideCell(frames[a], f.pos, 0.06)) { f.counted = true; f.inCell = true; (f as any).cellOf = a; f.scored = true; break; }
      }
    }
    // --- tipping
    for (const a of ["red", "blue"] as Alliance[]) {
      const h = this.hives[a];
      if (h.tipping) {
        const tip = h.tipping;
        // balls riding in the cells drive the hinge; their inertia at the cell radius adds to the tray's
        const extraI = tip.load.reduce((acc, b) => acc + b.massKg * b.rz * b.rz, 0);
        let done = false;
        const n = Math.max(1, Math.ceil(dt / 0.01));
        for (let i = 0; i < n && !done; i++) done = stepHinge(tip, loadTorque(tip.load), dt / n, extraI);
        tip.duration = tip.t + remainingSwing(tip);
        const angle = tip.angle;
        const dAngle = angle - tip.last;
        tip.last = angle;
        this.field.setHiveTilt(a, angle);
        this.carryBalls(a, dAngle, dt);
        if (done) {
          h.tipping = undefined; this.tipsDone++;
          h.upCell = h.upCell === "audience" ? "scoring" : "audience";
          this.hiveState[a] = h.upCell;
          this.field.setHiveState({ alliance: a, upCell: h.upCell });
          const cells = cellFrames({ alliance: a, upCell: h.upCell });
          const px = hivePivot(a).x;
          for (const f of this.flying) {
            const riding = (f as any).cellOf === a || cells.some((c) => insideCell(c, f.pos, 0.1));
            // anything settled up in this hive's volume lost its support when the cells swung: let it fall (or re-settle
            // on the structure it is actually touching)
            const aloft = f.settled && !f.inCell && f.pos.y > f.radius + 0.02 && Math.abs(f.pos.x - px) < 0.5 && Math.abs(f.pos.z) < 1.0;
            if (riding || aloft) { f.inCell = false; (f as any).cellOf = undefined; f.settled = false; f.restFor = 0; f.age = 0; f.contacts = []; f.contactAge = 1; f.carried = riding; }
            else if ((f as any).cellOf === a) (f as any).cellOf = undefined; // never let a past score tag a ball into the next swing
          }
        }
      } else if (this.autoTip() && this.cellLoad(a).massKg >= this.tipMassKg() - 1e-6) {
        this.startTip(a);
      }
    }
    // --- nothing rests in a lowered cell: its floor slopes toward the opening, so wake anything that settled there
    for (const a of ["red", "blue"] as Alliance[]) {
      if (this.hives[a].tipping) continue;
      const down = cellFrames({ alliance: a, upCell: this.hives[a].upCell }).find((c) => !c.isUp)!;
      const up = this.upFrame(a);
      const pivot = hivePivot(a);
      for (const f of this.flying) {
        if (!f.settled || f.inCell) continue;
        if (insideCell(down, f.pos, 0.03)) {
          f.settled = false; f.restFor = 0; f.contacts = []; f.contactAge = 1; f.carried = true;
          // a nudge toward the opening so it does not just re-wedge against the back skin
          f.vel.addScaledVector(new THREE.Vector3(down.normal.x, down.normal.y, down.normal.z), 0.4);
          continue;
        }
        // the V between the two cells' back skins (around the pivot) is open framework on the real hive, not a shelf:
        // a ball wedged there slides off the end of the hive
        const rx = f.pos.x - pivot.x, ry = f.pos.y - pivot.y, rz = f.pos.z - pivot.z;
        const along = ry * up.normal.y + rz * up.normal.z, u = ry * up.up.y + rz * up.up.z;
        if (Math.abs(along) < 0.3 && u > -0.25 && u < 0.35 && Math.abs(rx) < 0.32) {
          f.settled = false; f.restFor = 0; f.contacts = []; f.contactAge = 1;
          f.vel.set((rx >= 0 ? 1 : -1) * 0.6, 0, 0);
        }
      }
    }
    // --- chassis vs loose balls: intake side collects, every other side (or a full robot) pushes
    for (const ag of agents) {
      ag.intake = intakePoint(ag.pose, ag.footprint, ag.intakeGeom.side);
      const vx = ag.prevPose && dt > 0 ? (ag.pose.x - ag.prevPose.x) / dt : 0, vz = ag.prevPose && dt > 0 ? (ag.pose.z - ag.prevPose.z) / dt : 0;
      ag.prevPose = { ...ag.pose };
      ag.blocked = undefined;
      this.pushBalls(ag, vx, vz);
    }
    this.separateBalls();
    for (const ag of agents) this.pickup(ag, dt);
  }

  /** Balls do not overlap, anywhere: on the floor, stacked in a cell, in flight. Sphere–sphere separation and an impulse
   *  exchange along the contact normal (restitution 0.55, by mass). A settled ball hit by a moving one is woken only
   *  by a real knock, so a stack in the cell is not jittered apart by a ball settling against it. */
  private separateBalls() { collideBalls(this.flying, m(FIELD.sizeIn) / 2); }

  /** Balls riding in a swinging cell: rotate them with the hive about the pivot so they slide out as the floor steepens. */
  private carryBalls(alliance: Alliance, dAngle: number, dt: number) {
    const h = this.hives[alliance];
    const tip = h.tipping!;
    const pivot = hivePivot(alliance);
    const pv = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
    const X = new THREE.Vector3(1, 0, 0);
    const q = new THREE.Quaternion().setFromAxisAngle(X, -dAngle); // field.setHiveTilt uses rotation.x = -tilt
    // the cell frames are known at the rest angle the swing started from; a ball rides only while it is inside the
    // *moving* cell, so test its position rotated back to that rest configuration. (Testing against the static prisms
    // dropped balls the moment the cell swung away from them, and the lowered cell's prism reaches down to the mat.)
    const restCells = cellFrames({ alliance, upCell: h.upCell }); // upCell flips only when the swing completes
    const toRest = new THREE.Quaternion().setFromAxisAngle(X, tip.last - tip.from);
    const probe = new THREE.Vector3();
    tip.load = [];
    for (const f of this.flying) {
      probe.copy(f.pos).sub(pv).applyQuaternion(toRest).add(pv);
      const inside = restCells.some((c) => insideCell(c, probe, 0.03));
      if (!inside) { if (f.carried && (f as any).cellOf === alliance) { (f as any).cellOf = undefined; f.inCell = false; } continue; } // rolled out: it is a free ball now
      tip.load.push({ massKg: f.massKg, rz: f.pos.z - pv.z });
      const rel = f.pos.clone().sub(pv);
      const moved = rel.clone().applyQuaternion(q).add(pv);
      const carryVel = moved.clone().sub(f.pos).divideScalar(Math.max(dt, 1e-3));
      f.pos.copy(moved);
      f.mesh.position.copy(moved);
      // let gravity and the slope take over: keep the carry velocity but no settling this frame
      f.vel.lerp(carryVel, 0.5);
      f.settled = false; f.restFor = 0; f.carried = true;
    }
  }

  /** Move floor balls out of the chassis rectangle and give them the chassis velocity, except balls the intake is about to take. */
  private pushBalls(ag: Agent, vx: number, vz: number) {
    for (const b of this.flying) {
      if (b.inCell || b.carried || b.pos.y > 0.25) continue;
      if ((b as any).launchedBy === ag.id && this.time - ((b as any).launchedAt ?? -Infinity) < 2) continue; // our own shot leaving
      if ((b as any).gripBy === ag.id) continue; // the feeder has it
      const mf = mouthFrame(ag.pose, ag.footprint, ag.intakeGeom, { x: b.pos.x, z: b.pos.z });
      if (inCorridor(ag.intakeGeom, mf.u, mf.v, b.radius)) {
        // the mouth is open: the ball is not pushed by the chassis edge, it stops against the roller line
        const line = FEEDER.rollerU + FEEDER.rollerR + b.radius;
        if (mf.u >= line) continue;
        const ax = mouthAxes(ag.pose, ag.intakeGeom);
        const pen = line - mf.u;
        b.pos.x += ax.u.x * pen; b.pos.z += ax.u.z * pen;
        // a running intake with room swallows a ball squeezed against the wall; a stopped or full one is held by it
        const canTake = ag.intakeActive && ag.inventory.pollen + ag.inventory.nectar < ag.caps.capacity && (b.kind === "pollen" ? ag.caps.pollen : ag.caps.nectar && b.alliance === ag.alliance);
        let held = false;
        if (canTake) { const lim = m(FIELD.sizeIn) / 2 - b.radius; b.pos.x = clamp(b.pos.x, -lim, lim); b.pos.z = clamp(b.pos.z, -lim, lim); }
        else held = this.refuse(ag, b, ax.u.x, ax.u.z);
        const vn = Math.max(vx * ax.u.x + vz * ax.u.z, 0);
        b.vel.x = ax.u.x * Math.max(vn + 0.05, 0.1) + vx * 0.3; b.vel.z = ax.u.z * Math.max(vn + 0.05, 0.1) + vz * 0.3;
        b.settled = false; b.restFor = 0; b.contactAge = 1;
        if (held) { b.vel.set(0, 0, 0); b.settled = true; } // squeezed, not rolling: it must not knock the chain loose
        b.mesh.position.copy(b.pos);
        continue;
      }
      const push = chassisPush(ag.pose, ag.footprint, { x: b.pos.x, z: b.pos.z }, b.radius);
      if (!push) continue;
      b.pos.x += push.dx; b.pos.z += push.dz;
      const held = this.refuse(ag, b, push.nx, push.nz); // the wall is solid: a ball squeezed between chassis and wall stays inside, and holds the chassis
      // the ball is inside the chassis volume right now: the sweep must not collide with the chassis's own interior faces
      const group = ag.carryGroup.parent as THREE.Object3D | null;
      if (group) { b.launcher = group; b.launcherIgnoreUntil = b.age + 0.15; }
      // leave with at least the chassis speed along the push normal, plus the chassis's sideways motion
      const vn = Math.max(vx * push.nx + vz * push.nz, 0);
      const speed = Math.max(vn + 0.1, PUSH_SPEED_MIN);
      b.vel.x = push.nx * speed + vx * 0.3; b.vel.z = push.nz * speed + vz * 0.3;
      b.settled = false; b.restFor = 0; b.contactAge = 1;
      if (held) { b.vel.set(0, 0, 0); b.settled = true; } // squeezed against the wall or a pinned chain: it stays put instead of knocking the chain apart
      b.mesh.position.copy(b.pos);
    }
  }

  /** A ball the chassis just pushed along (nx, nz) may have nowhere to go: the perimeter wall, or another floor ball
   *  that is itself against the wall. Clamp it there and charge the refused travel to the agent, which the drive model
   *  turns into a blocked chassis (stalled shafts or spinning wheels by traction), not a ball through the wall. */
  private refuse(ag: Agent, b: LiveBall, nx: number, nz: number): boolean {
    const lim = m(FIELD.sizeIn) / 2 - b.radius;
    const bx = b.pos.x, bz = b.pos.z;
    b.pos.x = clamp(b.pos.x, -lim, lim); b.pos.z = clamp(b.pos.z, -lim, lim);
    let refused = (bx - b.pos.x) * nx + (bz - b.pos.z) * nz; // the push the wall took back, along the push normal
    // a chain of balls ahead: the pushed ball can only travel as far as the balls in front of it can, down to the wall
    const free = this.freeAlong(b, nx, nz, 0);
    if (free < 0) { refused = Math.max(refused, -free); b.pos.x += nx * free; b.pos.z += nz * free; }
    if (refused <= 1e-4) return false;
    const cur = ag.blocked, mag = Math.hypot(cur?.x ?? 0, cur?.z ?? 0);
    ag.blocked = { x: refused > mag ? nx * refused : cur!.x, z: refused > mag ? nz * refused : cur!.z, balls: (cur?.balls ?? 0) + 1 };
    return true;
  }
  /** How far ball `b` can still move along (nx, nz) before the perimeter or a ball already in its way stops it;
   *  negative when it is already overlapping something that cannot give way (the amount it must come back). */
  private freeAlong(b: LiveBall, nx: number, nz: number, depth: number): number {
    const lim = m(FIELD.sizeIn) / 2 - b.radius;
    let free = Math.min(nx > 0 ? lim - b.pos.x : nx < 0 ? b.pos.x + lim : Infinity, nz > 0 ? lim - b.pos.z : nz < 0 ? b.pos.z + lim : Infinity);
    if (depth >= 4) return free;
    for (const o of this.flying) {
      if (o === b || o.inCell || o.carried || o.pos.y > 0.25) continue;
      const dx = o.pos.x - b.pos.x, dz = o.pos.z - b.pos.z, along = dx * nx + dz * nz, perp = Math.abs(dx * nz - dz * nx);
      const touch = b.radius + o.radius;
      if (along <= 0 || perp >= touch * 0.9 || along >= touch + 0.08) continue; // balls directly ahead within a small gap: the gap is free travel, the rest is theirs
      free = Math.min(free, along - touch + Math.max(0, this.freeAlong(o, nx, nz, depth + 1)));
    }
    return free;
  }

  /** Detect before chassis pushing moves the missed ball away. Also true at a stocked FLOWER the brushes could reach. */
  pickupBlockedByIntake(ag: Agent): boolean {
    return !ag.intakeActive && ag.inventory.pollen + ag.inventory.nectar < ag.caps.capacity
      && (this.flying.some(b => this.atCollectibleBall(ag, b)) || this.atStockedFlower(ag) !== undefined);
  }
  /** The intake is at a ball or a stocked FLOWER but the robot already carries its capacity (e.g. the 4 preloads). */
  pickupBlockedByCapacity(ag: Agent): boolean {
    return ag.inventory.pollen + ag.inventory.nectar >= ag.caps.capacity
      && (this.flying.some(b => this.atCollectibleBall(ag, b)) || this.atStockedFlower(ag) !== undefined);
  }

  /** Can this intake pull POLLEN out of FLOWERs at all? Only brushes reach past the lower ring plate into the opening. */
  static reachesFlower(geom: IntakeGeom): boolean { return (geom.kind ?? "brushes") === "brushes"; }

  /** Index of a FLOWER with stock whose axis sits in this agent's intake mouth, if its intake kind can retrieve. */
  atStockedFlower(ag: Agent): number | undefined {
    if (!ag.caps.pollen || !Match.reachesFlower(ag.intakeGeom)) return undefined;
    for (let fi = 0; fi < 4; fi++) {
      if (this.flowerStock[fi] <= 0) continue;
      const ax = this.field.flowerAxis(fi);
      if (flowerInMouth(ag.pose, ag.footprint, ag.intakeGeom, { x: ax.x, z: ax.z })) return fi;
    }
    return undefined;
  }

  private atCollectibleBall(ag: Agent, b: LiveBall): boolean {
    if (b.inCell || b.carried || b.pos.y > 0.25) return false;
    if (!b.settled && b.vel.length() > 0.6) return false;
    if ((b as any).launchedBy === ag.id && this.time - ((b as any).launchedAt ?? -Infinity) < 2) return false;
    if (b.kind === "pollen" && !ag.caps.pollen) return false;
    if (b.kind === "nectar" && (!ag.caps.nectar || b.alliance !== ag.alliance)) return false;
    return inIntakeMouth(ag.pose, ag.footprint, ag.intakeGeom, { x: b.pos.x, z: b.pos.z }, b.radius, INTAKE_RANGE_M);
  }

  /** The feeder: balls are collected by contact, not by proximity. A ball the side wheels or the roller touch while
   *  the intake runs (and there is room) is pulled toward the seat inside the mouth; once it reaches the seat it is
   *  swallowed, one per PICK_INTERVAL. Balls in the mouth corridor are not pushed by the chassis (the mouth is open),
   *  but with the intake off they stop against the roller line instead of entering. */
  private pickup(ag: Agent, dt: number) {
    const held = ag.inventory.pollen + ag.inventory.nectar;
    const room = held < ag.caps.capacity;
    const axes = mouthAxes(ag.pose, ag.intakeGeom);
    const edge = intakePoint(ag.pose, ag.footprint, ag.intakeGeom.side);
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const b = this.flying[i];
      if (b.inCell || b.carried || b.pos.y > 0.2) continue;
      const { u, v } = mouthFrame(ag.pose, ag.footprint, ag.intakeGeom, { x: b.pos.x, z: b.pos.z });
      if (!inCorridor(ag.intakeGeom, u, v, b.radius) && Math.abs(v) > ag.intakeGeom.widthM / 2 + b.radius) continue;
      const kindOk = (b.kind === "pollen" && ag.caps.pollen) || (b.kind === "nectar" && ag.caps.nectar && b.alliance === ag.alliance);
      const touching = feederContact(ag.intakeGeom, u, v, b.radius);
      if (touching && ag.intakeActive && room && !kindOk) ag.rejected = { kind: b.kind, alliance: b.alliance, at: this.time }; // the wheels spin against a ball this robot may not take: it gets pushed, not pulled
      const gripping = ag.intakeActive && room && kindOk && (!!touching || (b as any).gripBy === ag.id);
      if (!gripping) { if ((b as any).gripBy === ag.id) (b as any).gripBy = undefined; continue; }
      (b as any).gripBy = ag.id;
      // at the seat: swallow (paced), otherwise hold it there
      if (u <= FEEDER.seatU && Math.abs(v) <= 0.08) {
        if (this.time - ag.lastPick >= PICK_INTERVAL) {
          b.mesh.removeFromParent(); this.flying.splice(i, 1);
          ag.inventory[b.kind]++; ag.lastPick = this.time; this.intakeCount++; ag.picks = (ag.picks ?? 0) + 1;
          if ((b as any).fromFlower !== undefined) this.flowerPickCount++;
        } else { b.vel.set(0, 0, 0); b.settled = false; b.restFor = 0; }
        continue;
      }
      // pull toward the seat (a point FEEDER.seatU inside the edge on the mouth centre line), centring as it goes
      const sx = edge.x + axes.u.x * FEEDER.seatU, sz = edge.z + axes.u.z * FEEDER.seatU;
      const dx = sx - b.pos.x, dz = sz - b.pos.z, d = Math.hypot(dx, dz) || 1e-6;
      const tx = (dx / d) * FEEDER.pullMps, tz = (dz / d) * FEEDER.pullMps;
      const k = Math.min(1, FEEDER.pullAccel * dt / Math.max(0.05, Math.hypot(tx - b.vel.x, tz - b.vel.z)));
      b.vel.x += (tx - b.vel.x) * k; b.vel.z += (tz - b.vel.z) * k;
      b.settled = false; b.restFor = 0; b.contactAge = 1;
      // the ball is entering the chassis volume: the sweep must not collide with the chassis's own faces
      const group = ag.carryGroup.parent as THREE.Object3D | null;
      if (group) { b.launcher = group; b.launcherIgnoreUntil = b.age + 0.2; }
    }
    // FLOWER: the bottom POLLEN leaves the stack only when a feeder part actually touches it (G418.B, bottom only);
    // from then on it is a live ball the feeder pulls in like any other
    if (!ag.intakeActive || !room || !ag.caps.pollen || !Match.reachesFlower(ag.intakeGeom)) return;
    if (this.time - ag.lastFlowerGrip < FLOWER_PICK_INTERVAL) return;
    for (let fi = 0; fi < 4; fi++) {
      if (this.flowerStock[fi] <= 0) continue;
      const ax = this.field.flowerAxis(fi);
      const { u, v } = mouthFrame(ag.pose, ag.footprint, ag.intakeGeom, { x: ax.x, z: ax.z });
      const r = m(BALL.pollen.diaIn) / 2;
      if (!feederContact(ag.intakeGeom, u, v, r)) continue;
      // a live ball that is already being pulled from this FLOWER blocks the next one until it is in
      if (this.flying.some((b) => (b as any).fromFlower === fi)) continue;
      this.flowerStock[fi]--;
      const stack = this.field.flowerPollen[fi];
      const bottom = stack.shift();
      bottom?.removeFromParent();
      for (const b of stack) b.position.y -= m(BALL.pollen.diaIn) * 0.92;
      const ball = this.spawnBall("pollen", undefined, new THREE.Vector3(ax.x, m(FLOWER.bottomRingThickIn) + r, ax.z), new THREE.Vector3(), false);
      (ball as any).fromFlower = fi; (ball as any).gripBy = ag.id;
      ball.contactAge = 1;
      ag.lastFlowerGrip = this.time;
      return;
    }
  }

  // ---------------- scripted robots: pick up, drive to a launch spot, shoot their own hive. One policy for every
  // difficulty tier (src/sim/aiTiers.ts); the tier only changes how well it is executed.
  /** Decide the scripted robot's target and actions. Returns true if it fired this frame (ball spawned). */
  driveScripted(r: ScriptedRobot, ag: Agent, dt: number): boolean {
    const T = TIERS[this.tier()];
    const brain = ((r as any).brain ??= { mode: "seek", timer: 0, shots: 0, launchSpot: undefined as { x: number; z: number } | undefined, spotAlt: 0, progress: undefined as { d: number; t: number } | undefined, avoid: [] as { x: number; z: number; until: number }[], avoidFlowers: [] as { i: number; until: number }[], pending: undefined as { mode: string; at: number } | undefined, nextDecision: 0, frozenUntil: -1, seed: hashName(r.name), sourceSince: undefined as number | undefined, heldAtSource: 0, recentShots: [] as number[] });
    const held = ag.inventory.pollen + ag.inventory.nectar;
    const cap = ag.caps.capacity;
    brain.timer += dt;
    // G421: we are about to be called for pinning; back away before continuing (every tier)
    if (r.backoff) { if (this.time < r.backoff.until) { r.target = r.backoff.target; return false; } r.backoff = undefined; brain.progress = undefined; }
    // reaction lag: a decided mode change takes effect after the tier's delay
    const setMode = (mode: string) => {
      if (brain.mode === mode || brain.pending?.mode === mode) return;
      if (T.reactS <= 0) { brain.mode = mode; brain.timer = 0; brain.pending = undefined; } else brain.pending = { mode, at: this.time + T.reactS };
    };
    if (brain.pending && this.time >= brain.pending.at) { brain.mode = brain.pending.mode; brain.timer = 0; brain.pending = undefined; }
    // decisions every 0.1 s (offset per robot); hesitation freezes the robot for that decision
    if (this.time >= brain.nextDecision) {
      brain.nextDecision = this.time + 0.1;
      if (T.hesitate > 0 && brain.mode !== "fire" && this.rnd() < T.hesitate) brain.frozenUntil = this.time + 0.1;
    }
    if (this.time < brain.frozenUntil) { r.target = undefined; return false; }
    // watchdog (every tier): no progress toward the current target for 3 s means we are wedged against something
    if (r.target && (brain.mode === "seek" || brain.mode === "travel" || brain.mode === "defend")) {
      const d = Math.hypot(r.target.x - r.pose.x, r.target.z - r.pose.z);
      if (!brain.progress || d < brain.progress.d - 0.05) brain.progress = { d, t: this.time };
      else if (this.time - brain.progress.t > 3) {
        brain.progress = undefined;
        if (brain.mode === "travel") { brain.spotAlt++; brain.launchSpot = undefined; }
        else brain.avoid.push({ x: r.target.x, z: r.target.z, until: this.time + 12 });
      }
    } else brain.progress = undefined;
    brain.avoid = brain.avoid.filter((a: { until: number }) => a.until > this.time);
    brain.avoidFlowers = brain.avoidFlowers.filter((a: { until: number }) => a.until > this.time);
    brain.recentShots = brain.recentShots.filter((t: number) => this.time - t < 2.5);
    const volleyAt = Math.min(T.volleyAt, cap);
    if (brain.mode === "seek") {
      ag.intakeActive = true;
      if (held >= volleyAt) { setMode("travel"); brain.launchSpot = undefined; return false; }
      // the cheapest source in seconds of travel, plus the tier's stable choice noise: flowers with stock, loose balls
      const cost = (x: number, z: number) => Math.hypot(x - r.pose.x, z - r.pose.z) / T.speedMps + T.choiceNoiseS * choiceNoise(x, z, this.time, brain.seed);
      let best: { x: number; z: number; flower?: number } | undefined, bestC = Infinity, bestD = Infinity;
      for (let fi = 0; fi < 4; fi++) if (this.flowerStock[fi] > 0 && ag.caps.pollen && !brain.avoidFlowers.some((a: { i: number }) => a.i === fi)) {
        const ax = this.field.flowerAxis(fi);
        const c = cost(ax.x, ax.z);
        if (c < bestC) { bestC = c; best = { x: ax.x, z: ax.z, flower: fi }; bestD = Math.hypot(ax.x - r.pose.x, ax.z - r.pose.z); }
      }
      for (const b of this.flying) {
        if (b.inCell || b.pos.y > 0.25 || !b.settled) continue;
        if (b.kind === "nectar" && (b.alliance !== ag.alliance || !ag.caps.nectar)) continue;
        if (b.kind === "pollen" && !ag.caps.pollen) continue;
        if (brain.avoid.some((a: { x: number; z: number }) => Math.hypot(a.x - b.pos.x, a.z - b.pos.z) < 0.2)) continue; // could not reach it last time
        const c = cost(b.pos.x, b.pos.z);
        if (c < bestC) { bestC = c; best = { x: b.pos.x, z: b.pos.z }; bestD = Math.hypot(b.pos.x - r.pose.x, b.pos.z - r.pose.z); }
      }
      if (!best) {
        if (held > 0) { setMode("travel"); return false; }
        if (T.defends) { setMode("defend"); return false; }
        r.target = undefined; return false;
      }
      r.target = { x: best.x, z: best.z };
      if (best.flower !== undefined) {
        // enter the cage square to the wall: line up on the flower's axis in front of it, then drive straight in. A
        // diagonal approach parks a chassis corner on the cage with the axis about 3 in outside the intake edge, where
        // no feeder part can touch the bottom POLLEN and the robot just stands there until its patience runs out.
        const n = flowerFacing(best.flower);
        const dx = r.pose.x - best.x, dz = r.pose.z - best.z;
        const lateral = Math.abs(dx * n.z - dz * n.x);
        if (lateral > m(2.5)) r.target = { x: best.x + n.x * m(16), z: best.z + n.z * m(16) };
      }
      // at the source: the intake works; give up after the tier's patience if nothing comes in
      if (bestD < m(12)) {
        if (brain.sourceSince === undefined || held !== brain.heldAtSource) { brain.sourceSince = this.time; brain.heldAtSource = held; }
        else if (this.time - brain.sourceSince > T.patienceS) {
          if (best.flower !== undefined) brain.avoidFlowers.push({ i: best.flower, until: this.time + 12 }); else brain.avoid.push({ x: best.x, z: best.z, until: this.time + 12 });
          brain.sourceSince = undefined;
          if (held > 0) setMode("travel");
        }
      } else brain.sourceSince = undefined;
      return false;
    }
    if (brain.mode === "defend") {
      // Hard with nothing to do: stand on the other alliance's shooting spot (a position, never a chase: no pinning)
      ag.intakeActive = false;
      const other: Alliance = ag.alliance === "red" ? "blue" : "red";
      const f = this.upFrame(other);
      const a = aimPoint(f, 0);
      const spot = { x: a.x + f.normal.x * m(40), z: a.z + f.normal.z * m(40) };
      const half = m(FIELD.sizeIn) / 2 - m(12);
      r.target = { x: clamp(spot.x, -half, half), z: clamp(spot.z, -half, half) };
      if (brain.timer > 2) { brain.timer = 0; setMode("seek"); } // look for new sources every couple of seconds
      return false;
    }
    if (brain.mode === "travel") {
      ag.intakeActive = false;
      if (!brain.launchSpot) brain.launchSpot = this.launchSpotFor(ag.alliance, r, brain.spotAlt, T, brain.seed);
      r.target = brain.launchSpot;
      if (Math.hypot(brain.launchSpot.x - r.pose.x, brain.launchSpot.z - r.pose.z) < m(8)) { setMode("aim"); }
      return false;
    }
    if (brain.mode === "aim") {
      r.target = undefined;
      // like the StarterBot: the intake is at the front and the launcher fires out over the back, so turn the back
      // toward the cell (the robot drives in forwards to collect, then spins round to shoot)
      const target = aimPoint(this.upFrame(ag.alliance), 0.05);
      const want = headingToward(r.pose, target) + Math.PI;
      const err = wrapAngle(want - r.pose.heading);
      r.pose = { ...r.pose, heading: r.pose.heading + clamp(err, -2.5 * dt, 2.5 * dt) };
      if (Math.abs(err) < 0.03) { brain.mode = "fire"; brain.timer = 0; brain.shots = 0; }
      return false;
    }
    if (brain.mode === "fire") {
      r.target = undefined;
      const h = this.hives[ag.alliance];
      if (held === 0) { setMode("seek"); return false; }
      if (T.tipSense) {
        // count to the tip: stop once what is in the cell plus what is in the air will tip it, and never shoot into a swinging tray
        if (h.tipping) { brain.mode = "seek"; brain.timer = 0; brain.launchSpot = undefined; return false; }
        const inflight = brain.recentShots.length * BALL.pollen.massKg;
        if (this.cellLoad(ag.alliance).massKg + inflight >= this.tipMassKg() - 1e-6) { brain.mode = "seek"; brain.timer = 0; brain.launchSpot = undefined; return false; }
      } else if (h.tipping && h.tipping.t > 1.5) { brain.mode = "seek"; brain.timer = 0; brain.launchSpot = undefined; return false; } // Easy notices late
      if (brain.timer < T.fireIntervalS) return false;
      brain.timer = 0;
      // shot: 55-degree hood, solver speed, the tier's aim noise
      const frame = this.upFrame(ag.alliance);
      const target = aimPoint(frame, 0.05);
      const exit = new THREE.Vector3(r.pose.x + Math.sin(r.pose.heading) * 0.1, 0.33, r.pose.z + Math.cos(r.pose.heading) * 0.1); // 0.1 m behind the centre: the ramp end
      const kind: BallKind = ag.inventory.nectar > 0 ? "nectar" : "pollen";
      const props = kind === "pollen" ? BALL.pollen : BALL.nectarRed;
      const ball = { massKg: props.massKg, diameterM: m(props.diaIn), cd: 0.45, cl: 0 };
      const sol = solveSpeedForElevation({ ball, launchPos: exit, target, frame, spin: 0 }, (55 * Math.PI) / 180, 12);
      if (!sol) { setMode("travel"); brain.launchSpot = undefined; brain.spotAlt++; return false; }
      const speed = sol.speed * (1 + T.speedSigma * gaussian(this.rnd));
      const yaw = (T.yawSigmaDeg * Math.PI / 180) * gaussian(this.rnd);
      const dir = { x: target.x - exit.x, z: target.z - exit.z };
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      const vel = velocityFrom(speed, (55 * Math.PI) / 180 + (0.8 * Math.PI / 180) * gaussian(this.rnd), { x: dir.x * c - dir.z * sn, z: dir.x * sn + dir.z * c });
      this.launch(ag, kind, exit, new THREE.Vector3(vel.x, vel.y, vel.z), 0);
      brain.recentShots.push(this.time);
      return true;
    }
    return false;
  }

  /** The tier's shooting spot: a distance from the up cell's opening inside [standMin, standMax] at an angle off the
   *  mouth normal within ±standAngle (both picked by a stable hash per robot and attempt), nudged sideways per robot so
   *  partners do not stack. Alternatives (`alt`) step outward and swap sides when a spot is blocked. */
  private launchSpotFor(alliance: Alliance, r: ScriptedRobot, alt: number, T: TierKnobs, seed: number): { x: number; z: number } {
    const f = this.upFrame(alliance);
    const a = aimPoint(f, 0);
    const u1 = choiceNoise(seed, alt, 0, 1), u2 = choiceNoise(alt, seed, 0, 2);
    const dist = m(T.standMinIn + (T.standMaxIn - T.standMinIn) * u1 + 6 * Math.floor(alt / 2));
    const lean = (r.name.endsWith("2") ? 1 : -1) * (alt % 2 ? -1 : 1);
    const ang = ((T.standAngleDeg * (2 * u2 - 1)) * Math.PI) / 180 + lean * (8 * Math.PI) / 180;
    const nx = f.normal.x, nz = f.normal.z;
    const dx = nx * Math.cos(ang) - nz * Math.sin(ang), dz = nx * Math.sin(ang) + nz * Math.cos(ang);
    const half = m(FIELD.sizeIn) / 2 - m(12);
    return { x: clamp(a.x + dx * dist, -half, half), z: clamp(a.z + dz * dist, -half, half) };
  }

  /** Visual: carried balls stacked above the chassis. Hidden from camera renders by the caller. */
  static renderCarry(group: THREE.Group, inv: Inventory, alliance: Alliance, heightM: number) {
    const want = `${inv.pollen}/${inv.nectar}/${alliance}`;
    if (group.userData.sig === want) return;
    group.userData.sig = want;
    group.clear();
    let i = 0;
    // small translucent markers in a row floating above the robot's tallest point: an inventory readout, not physical
    // balls. Drawn without a depth test so the tower or hood never hides them.
    const add = (color: number, r: number) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthTest: false }));
      mesh.renderOrder = 10;
      mesh.position.set(-0.09 + i * 0.06, heightM + 0.09, 0);
      group.add(mesh); i++;
    };
    for (let k = 0; k < inv.pollen; k++) add(BALL.pollen.color, 0.02);
    for (let k = 0; k < inv.nectar; k++) add(alliance === "red" ? BALL.nectarRed.color : BALL.nectarBlue.color, 0.024);
  }
}
