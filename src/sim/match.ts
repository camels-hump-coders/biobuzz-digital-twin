/** Match dynamics: robot inventories and pickup, FLOWER stocks, NECTAR supply, both hives' loads and tipping,
 * and the behaviour of the scripted alliance partner and opponents. */
import * as THREE from "three";
import type { FieldObjects } from "../field/buildField";
import { BALL, FIELD, HIVE, ZONES, m } from "../field/fieldSpec";
import { type Alliance, type CellSide, type CellFrame, aimPoint, cellFrames, hivePivot, upCellFrame } from "../field/hive";
import { insideCell, type LiveBall } from "./ballPhysics";
import type { Footprint, Pose } from "./drive";
import { chassisPush, inIntakeMouth, intakePoint, type IntakeGeom } from "./intake";
import { headingToward } from "./drive";
import type { ScriptedRobot } from "./opponents";
import { solveSpeedForElevation } from "../ballistics/solver";
import { velocityFrom } from "../ballistics/projectile";
import { gaussian, rng } from "../ballistics/dispersion";
import { clamp, wrapAngle } from "../util/units";

export type BallKind = "pollen" | "nectar";
export interface Inventory { pollen: number; nectar: number }
export interface Capabilities { capacity: number; pollen: boolean; nectar: boolean }

export interface HiveSim {
  alliance: Alliance;
  upCell: CellSide;
  stagedNectar: number;
  tips: number;
  tipping?: { from: number; to: number; t: number; duration: number; last: number };
}

export const TIP_DEG = 30;
const INTAKE_RANGE_M = m(7); // ball centre within this of the intake edge gets pulled in
const PUSH_SPEED_MIN = 0.25; // m/s a nudged ball leaves the chassis with, even when the robot is barely moving
const FLOWER_REACH_M = m(9); // intake point within this of a FLOWER axis can pull POLLEN from its retrieval opening
const PICK_INTERVAL = 0.45; // s per ball through an intake

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
  lastPick: number;
  carryGroup: THREE.Group;
}

export class Match {
  hives: Record<Alliance, HiveSim>;
  nectarSupply: Record<Alliance, number> = { red: 5, blue: 5 };
  private flowerStock = [4, 4, 4, 4];
  private rnd = rng(1234);
  private time = 0;

  private scene: THREE.Scene; private field: FieldObjects; private flying: LiveBall[]; private hiveState: Record<Alliance, CellSide>; private tipMassKg: () => number; private autoTip: () => boolean;
  constructor(scene: THREE.Scene, field: FieldObjects, flying: LiveBall[], hiveState: Record<Alliance, CellSide>, tipMassKg: () => number, autoTip: () => boolean) {
    this.scene = scene; this.field = field; this.flying = flying; this.hiveState = hiveState; this.tipMassKg = tipMassKg; this.autoTip = autoTip;
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

  private convertGardenPollen() {
    for (const g of this.field.gardenPollen) {
      if (!g.parent) continue;
      g.removeFromParent();
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
    for (const f of this.flying) if (f.inCell && (f as any).cellOf === alliance) { f.inCell = false; f.settled = false; f.restFor = 0; f.age = 0; f.contacts = []; f.contactAge = 1; }
  }

  private startTip(alliance: Alliance) {
    const h = this.hives[alliance];
    const load = this.cellLoad(alliance);
    const excess = load.massKg / this.tipMassKg();
    const duration = clamp(2.6 / Math.sqrt(Math.max(1, excess)), 0.9, 2.6);
    const from = h.upCell === "audience" ? TIP_DEG : -TIP_DEG;
    h.tipping = { from: (from * Math.PI) / 180, to: (-from * Math.PI) / 180, t: 0, duration, last: (from * Math.PI) / 180 };
    // the staged NECTAR become live balls riding in the cell
    for (const p of this.field.stagedNectar(alliance)) {
      const b = this.spawnBall("nectar", alliance, p, new THREE.Vector3(), true);
      b.counted = true; b.inCell = true; (b as any).cellOf = alliance; b.settled = false; b.restFor = 0;
    }
    h.stagedNectar = 0;
    this.field.setStagedNectar(alliance, false);
    // the scored balls stay "in the cell" for the swing so the carry logic moves them, then roll out under gravity
    for (const f of this.flying) if (f.inCell && (f as any).cellOf === alliance) { f.settled = false; f.restFor = 0; f.contacts = []; f.contactAge = 1; }
    h.tips++;
    // a tip unlocks a NECTAR: the human player drops one into the LOADING ZONE
    if (this.nectarSupply[alliance] > 0) {
      this.nectarSupply[alliance]--;
      const z = alliance === "red" ? ZONES.loadingRed : ZONES.loadingBlue;
      const pos = new THREE.Vector3(m((z.xMin + z.xMax) / 2), m(BALL.nectarRed.diaIn) / 2 + 0.3, m((z.zMin + z.zMax) / 2));
      this.spawnBall("nectar", alliance, pos, new THREE.Vector3());
    }
  }

  /** Call every frame. */
  update(dt: number, agents: Agent[]) {
    this.time += dt;
    // --- scoring: settled balls inside a raised cell
    const frames: Record<Alliance, CellFrame> = { red: this.upFrame("red"), blue: this.upFrame("blue") };
    for (const f of this.flying) {
      if (!f.settled || f.counted) continue;
      for (const a of ["red", "blue"] as Alliance[]) {
        if (this.hives[a].tipping) continue;
        if (insideCell(frames[a], f.pos, 0.02)) { f.counted = true; f.inCell = true; (f as any).cellOf = a; f.scored = true; break; }
      }
    }
    // --- tipping
    for (const a of ["red", "blue"] as Alliance[]) {
      const h = this.hives[a];
      if (h.tipping) {
        h.tipping.t += dt;
        const k = Math.min(1, h.tipping.t / h.tipping.duration);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const angle = h.tipping.from + (h.tipping.to - h.tipping.from) * e;
        const dAngle = angle - h.tipping.last;
        h.tipping.last = angle;
        this.field.setHiveTilt(a, angle);
        this.carryBalls(a, dAngle, dt);
        if (k >= 1) {
          h.tipping = undefined;
          h.upCell = h.upCell === "audience" ? "scoring" : "audience";
          this.hiveState[a] = h.upCell;
          this.field.setHiveState({ alliance: a, upCell: h.upCell });
          for (const f of this.flying) if ((f as any).cellOf === a) { f.inCell = false; f.settled = false; f.restFor = 0; f.contacts = []; f.contactAge = 1; f.carried = true; }
        }
      } else if (this.autoTip() && this.cellLoad(a).massKg >= this.tipMassKg() - 1e-6) {
        this.startTip(a);
      }
    }
    // --- nothing rests in a lowered cell: its floor slopes toward the opening, so wake anything that settled there
    for (const a of ["red", "blue"] as Alliance[]) {
      if (this.hives[a].tipping) continue;
      const down = cellFrames({ alliance: a, upCell: this.hives[a].upCell }).find((c) => !c.isUp)!;
      for (const f of this.flying) {
        if (!f.settled || f.inCell) continue;
        if (!insideCell(down, f.pos, 0.03)) continue;
        f.settled = false; f.restFor = 0; f.contacts = []; f.contactAge = 1; f.carried = true;
        // a nudge toward the opening so it does not just re-wedge against the back skin
        f.vel.addScaledVector(new THREE.Vector3(down.normal.x, down.normal.y, down.normal.z), 0.4);
      }
    }
    // --- chassis vs loose balls: intake side collects, every other side (or a full robot) pushes
    for (const ag of agents) {
      ag.intake = intakePoint(ag.pose, ag.footprint, ag.intakeGeom.side);
      const vx = ag.prevPose && dt > 0 ? (ag.pose.x - ag.prevPose.x) / dt : 0, vz = ag.prevPose && dt > 0 ? (ag.pose.z - ag.prevPose.z) / dt : 0;
      ag.prevPose = { ...ag.pose };
      this.pushBalls(ag, vx, vz);
    }
    for (const ag of agents) this.pickup(ag);
  }

  /** Balls riding in a swinging cell: rotate them with the hive about the pivot so they slide out as the floor steepens. */
  private carryBalls(alliance: Alliance, dAngle: number, dt: number) {
    const pivot = hivePivot(alliance);
    const pv = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dAngle); // field.setHiveTilt uses rotation.x = -tilt
    const bothCells = cellFrames({ alliance, upCell: this.hives[alliance].upCell });
    for (const f of this.flying) {
      if (f.settled && !((f as any).cellOf === alliance)) continue;
      // inside either cell of this hive (generous margin: the cell is moving)
      const inside = (f as any).cellOf === alliance || bothCells.some((c) => insideCell(c, f.pos, 0.06));
      if (!inside) continue;
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

  /** Could this agent swallow this ball right now (ignoring position)? */
  private canCollect(ag: Agent, b: LiveBall): boolean {
    if (!ag.intakeActive) return false;
    if (ag.inventory.pollen + ag.inventory.nectar >= ag.caps.capacity) return false;
    if (b.kind === "pollen" && !ag.caps.pollen) return false;
    if (b.kind === "nectar" && (!ag.caps.nectar || b.alliance !== ag.alliance)) return false;
    return true;
  }

  /** Move floor balls out of the chassis rectangle and give them the chassis velocity, except balls the intake is about to take. */
  private pushBalls(ag: Agent, vx: number, vz: number) {
    for (const b of this.flying) {
      if (b.inCell || b.carried || b.pos.y > 0.25) continue;
      if ((b as any).launchedBy === ag.id && this.time - ((b as any).launchedAt ?? -Infinity) < 2) continue; // our own shot leaving
      const push = chassisPush(ag.pose, ag.footprint, { x: b.pos.x, z: b.pos.z }, b.radius);
      if (!push) continue;
      if (this.canCollect(ag, b) && inIntakeMouth(ag.pose, ag.footprint, ag.intakeGeom, { x: b.pos.x, z: b.pos.z }, b.radius, INTAKE_RANGE_M)) continue;
      b.pos.x += push.dx; b.pos.z += push.dz;
      // leave with at least the chassis speed along the push normal, plus the chassis's sideways motion
      const vn = Math.max(vx * push.nx + vz * push.nz, 0);
      const speed = Math.max(vn + 0.1, PUSH_SPEED_MIN);
      b.vel.x = push.nx * speed + vx * 0.3; b.vel.z = push.nz * speed + vz * 0.3;
      b.settled = false; b.restFor = 0; b.contactAge = 1;
      b.mesh.position.copy(b.pos);
    }
  }

  private pickup(ag: Agent) {
    if (!ag.intakeActive) return;
    const held = ag.inventory.pollen + ag.inventory.nectar;
    if (held >= ag.caps.capacity) return;
    if (this.time - ag.lastPick < PICK_INTERVAL) return;
    const ix = ag.intake.x, iz = ag.intake.z;
    // loose balls on the floor
    for (let i = 0; i < this.flying.length; i++) {
      const b = this.flying[i];
      if (b.inCell || b.pos.y > 0.25) continue;
      if (!b.settled && b.vel.length() > 0.6) continue; // flying or rolling fast: cannot be swallowed
      if ((b as any).launchedBy === ag.id && this.time - ((b as any).launchedAt ?? -Infinity) < 2) continue; // our own shot leaving
      if (b.kind === "pollen" && !ag.caps.pollen) continue;
      if (b.kind === "nectar" && (!ag.caps.nectar || b.alliance !== ag.alliance)) continue;
      if (!inIntakeMouth(ag.pose, ag.footprint, ag.intakeGeom, { x: b.pos.x, z: b.pos.z }, b.radius, INTAKE_RANGE_M)) continue;
      b.mesh.removeFromParent();
      this.flying.splice(i, 1);
      ag.inventory[b.kind]++;
      ag.lastPick = this.time;
      return;
    }
    // FLOWER retrieval openings
    if (ag.caps.pollen) for (let fi = 0; fi < 4; fi++) {
      if (this.flowerStock[fi] <= 0) continue;
      const ax = this.field.flowerAxis(fi);
      if (Math.hypot(ax.x - ix, ax.z - iz) > FLOWER_REACH_M) continue;
      this.flowerStock[fi]--;
      const stack = this.field.flowerPollen[fi];
      const top = stack.shift(); // bottom one leaves, the rest drop
      top?.removeFromParent();
      for (const b of stack) b.position.y -= m(BALL.pollen.diaIn) * 0.92;
      ag.inventory.pollen++;
      ag.lastPick = this.time;
      return;
    }
  }

  // ---------------- scripted robots: pick up, drive to a launch spot, shoot their own hive
  /** Decide the scripted robot's target and actions. Returns true if it fired this frame (ball spawned). */
  driveScripted(r: ScriptedRobot, ag: Agent, dt: number): boolean {
    const brain = ((r as any).brain ??= { mode: "seek", timer: 0, shots: 0, launchSpot: undefined as { x: number; z: number } | undefined, spotAlt: 0, progress: undefined as { d: number; t: number } | undefined, avoid: [] as { x: number; z: number; until: number }[] });
    const held = ag.inventory.pollen + ag.inventory.nectar;
    brain.timer += dt;
    // watchdog: no progress toward the current target for 3 s means we are wedged against something or someone
    if (r.target && (brain.mode === "seek" || brain.mode === "travel")) {
      const d = Math.hypot(r.target.x - r.pose.x, r.target.z - r.pose.z);
      if (!brain.progress || d < brain.progress.d - 0.05) brain.progress = { d, t: this.time };
      else if (this.time - brain.progress.t > 3) {
        brain.progress = undefined;
        if (brain.mode === "travel") { brain.spotAlt++; brain.launchSpot = undefined; }
        else brain.avoid.push({ x: r.target.x, z: r.target.z, until: this.time + 10 });
      }
    } else brain.progress = undefined;
    brain.avoid = brain.avoid.filter((a: { until: number }) => a.until > this.time);
    if (brain.mode === "seek") {
      ag.intakeActive = true;
      if (held >= ag.caps.capacity) { brain.mode = "travel"; brain.launchSpot = undefined; return false; }
      // nearest source: flower with stock, or loose ball
      let best: { x: number; z: number } | undefined, bestD = Infinity;
      for (let fi = 0; fi < 4; fi++) if (this.flowerStock[fi] > 0) {
        const ax = this.field.flowerAxis(fi);
        const d = Math.hypot(ax.x - r.pose.x, ax.z - r.pose.z);
        if (d < bestD) { bestD = d; best = { x: ax.x, z: ax.z }; }
      }
      for (const b of this.flying) {
        if (b.inCell || b.pos.y > 0.25 || !b.settled) continue;
        if (b.kind === "nectar" && b.alliance !== ag.alliance) continue;
        if (brain.avoid.some((a: { x: number; z: number }) => Math.hypot(a.x - b.pos.x, a.z - b.pos.z) < 0.15)) continue; // could not reach it last time
        const d = Math.hypot(b.pos.x - r.pose.x, b.pos.z - r.pose.z);
        if (d < bestD) { bestD = d; best = { x: b.pos.x, z: b.pos.z }; }
      }
      if (!best) { if (held > 0) { brain.mode = "travel"; return false; } r.target = undefined; return false; }
      r.target = best;
      // once near a source, wait while the intake works
      if (bestD < m(12) && brain.timer > 6) { brain.mode = held > 0 ? "travel" : "seek"; brain.timer = 0; }
      return false;
    }
    if (brain.mode === "travel") {
      ag.intakeActive = false;
      if (!brain.launchSpot) brain.launchSpot = this.launchSpotFor(ag.alliance, r, brain.spotAlt);
      r.target = brain.launchSpot;
      if (Math.hypot(brain.launchSpot.x - r.pose.x, brain.launchSpot.z - r.pose.z) < m(8)) { brain.mode = "aim"; brain.timer = 0; }
      return false;
    }
    if (brain.mode === "aim") {
      r.target = undefined;
      const target = aimPoint(this.upFrame(ag.alliance), 0.05);
      const want = headingToward(r.pose, target);
      const err = wrapAngle(want - r.pose.heading);
      r.pose = { ...r.pose, heading: r.pose.heading + clamp(err, -2.5 * dt, 2.5 * dt) };
      if (Math.abs(err) < 0.03) { brain.mode = "fire"; brain.timer = 0; brain.shots = 0; }
      return false;
    }
    if (brain.mode === "fire") {
      r.target = undefined;
      if (held === 0 || this.hives[ag.alliance].tipping) { brain.mode = "seek"; brain.timer = 0; return false; }
      if (brain.timer < 0.8) return false;
      brain.timer = 0;
      // shot: 55-degree hood, solver speed, modest noise
      const frame = this.upFrame(ag.alliance);
      const target = aimPoint(frame, 0.05);
      const exit = new THREE.Vector3(r.pose.x - Math.sin(r.pose.heading) * 0.1, 0.33, r.pose.z - Math.cos(r.pose.heading) * 0.1);
      const kind: BallKind = ag.inventory.nectar > 0 ? "nectar" : "pollen";
      const props = kind === "pollen" ? BALL.pollen : BALL.nectarRed;
      const ball = { massKg: props.massKg, diameterM: m(props.diaIn), cd: 0.45, cl: 0 };
      const sol = solveSpeedForElevation({ ball, launchPos: exit, target, frame, spin: 0 }, (55 * Math.PI) / 180, 12);
      if (!sol) { brain.mode = "travel"; brain.launchSpot = undefined; return false; }
      const speed = sol.speed * (1 + 0.03 * gaussian(this.rnd));
      const yaw = (1.5 * Math.PI / 180) * gaussian(this.rnd);
      const dir = { x: target.x - exit.x, z: target.z - exit.z };
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const vel = velocityFrom(speed, (55 * Math.PI) / 180 + (0.8 * Math.PI / 180) * gaussian(this.rnd), { x: dir.x * c - dir.z * s, z: dir.x * s + dir.z * c });
      this.launch(ag, kind, exit, new THREE.Vector3(vel.x, vel.y, vel.z), 0);
      return true;
    }
    return false;
  }

  /** A spot in front of the alliance's raised cell, about 60 in out, nudged sideways per robot so partners do not stack. */
  private launchSpotFor(alliance: Alliance, r: ScriptedRobot, alt = 0): { x: number; z: number } {
    const up = this.hives[alliance].upCell;
    const sideZ = up === "audience" ? 1 : -1;
    const hx = (alliance === "red" ? -1 : 1) * m(HIVE.hiveSpacingIn / 2);
    // alternatives when the usual spot is blocked: swap sides, then step further out
    const lateral = (r.name.endsWith("2") ? 1 : -1) * (alt % 2 ? -1 : 1) * m(14 + 10 * Math.floor(alt / 2)) * (alliance === "red" ? -1 : 1);
    const half = m(FIELD.sizeIn) / 2 - m(12);
    return { x: clamp(hx + lateral, -half, half), z: clamp(sideZ * m(62 + 6 * Math.floor(alt / 2)), -half, half) };
  }

  /** Visual: carried balls stacked above the chassis. Hidden from camera renders by the caller. */
  static renderCarry(group: THREE.Group, inv: Inventory, alliance: Alliance, heightM: number) {
    const want = `${inv.pollen}/${inv.nectar}/${alliance}`;
    if (group.userData.sig === want) return;
    group.userData.sig = want;
    group.clear();
    let i = 0;
    // small translucent markers in a row just above the chassis: an inventory readout, not physical balls
    const add = (color: number, r: number) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }));
      mesh.position.set(-0.09 + i * 0.06, heightM + 0.03, 0);
      group.add(mesh); i++;
    };
    for (let k = 0; k < inv.pollen; k++) add(BALL.pollen.color, 0.02);
    for (let k = 0; k < inv.nectar; k++) add(alliance === "red" ? BALL.nectarRed.color : BALL.nectarBlue.color, 0.024);
  }
}
