/** three.js representation of a robot: chassis (GLB or box), camera gizmos, launcher marker. */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { RobotSpec, CameraMount } from "./robotSpec";
import { type Intrinsics, fromDiagonal, fromHorizontal } from "../camera/cameraMath";
import { presetById } from "../camera/cameraPresets";
import type { Pose } from "../sim/drive";
import { splitIntakeRoller, splitIntakeSideWheels, splitWheelGeometry, wheelAngularSpeed } from "./wheels";
import { lookOf, lookSignature } from "./look";

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
loader.setDRACOLoader(draco);
const modelCache = new Map<string, Promise<THREE.Group>>();

const MODEL_URLS: Record<string, string> = {
  "starterbot-6wd": `${import.meta.env.BASE_URL}models/starterbot-6wd.glb`,
  "starterbot-mecanum": `${import.meta.env.BASE_URL}models/starterbot-mecanum.glb`,
};

function loadModel(key: string): Promise<THREE.Group> {
  let p = modelCache.get(key);
  if (!p) {
    p = new Promise((resolve, reject) => {
      loader.load(MODEL_URLS[key], (g) => resolve(g.scene), undefined, reject);
    });
    modelCache.set(key, p);
  }
  return p;
}

export function intrinsicsFor(cam: CameraMount): Intrinsics {
  const p = presetById(cam.presetId);
  const w = cam.width ?? p.width, h = cam.height ?? p.height;
  if (cam.hfovDeg !== undefined) return fromHorizontal(cam.hfovDeg, w, h);
  if (cam.diagFovDeg !== undefined) return fromDiagonal(cam.diagFovDeg, w, h);
  if (p.hfovDeg !== undefined) return fromHorizontal(p.hfovDeg, w, h);
  return fromDiagonal(p.diagFovDeg ?? 70, w, h);
}

export class RobotObject {
  readonly group = new THREE.Group();
  readonly chassis = new THREE.Group();
  readonly cameraGizmos = new THREE.Group();
  readonly launcherMarker: THREE.Group;
  /** three.js cameras, one per mount, kept in sync with the spec */
  readonly cameras = new Map<string, THREE.PerspectiveCamera>();
  spec: RobotSpec;
  pose: Pose = { x: 0, z: 0, heading: 0 };
  private modelKey = "";
  /** 'box' | 'loading' | 'loaded' | 'failed' */
  modelStatus: "box" | "loading" | "loaded" | "failed" = "box";
  private pollenLoad: THREE.Mesh[] = [];
  /** carve the CAD's wheels out so they can spin (off by default: a one-off geometry pass per model) */
  wheelSpin = false;
  private wheels: { mesh: THREE.Mesh; x: number; z: number; r: number; angle: number }[] = [];
  private spinPrevPose?: Pose;
  /** crown clusters the last carve saw (diagnostics via window.__twin) */
  wheelClusters: { side: number; x: number; span: number; n: number; ok: boolean }[] = [];

  readonly isPlayer: boolean;

  constructor(spec: RobotSpec, isPlayer: boolean) {
    this.spec = spec;
    this.isPlayer = isPlayer;
    this.group.add(this.chassis, this.cameraGizmos);
    this.launcherMarker = this.buildLauncherMarker();
    this.group.add(this.launcherMarker);
    this.applySpec(spec);
  }

  /** Robot local frame: +X forward, +Y up, +Z right. World heading 0 => forward = -Z world. */
  /** Green bar on the floor along the intake edge, so you can see which side collects. */
  private syncIntakeMarker(spec: RobotSpec) {
    this.group.getObjectByName("intakeMarker")?.removeFromParent();
    const g = spec.intake ?? { side: "front", widthM: 0.3 };
    const bar = new THREE.Mesh(new THREE.BoxGeometry(g.side === "front" || g.side === "rear" ? 0.012 : g.widthM, 0.004, g.side === "front" || g.side === "rear" ? g.widthM : 0.012), new THREE.MeshBasicMaterial({ color: 0x00ff88 }));
    bar.name = "intakeMarker";
    const hl = spec.lengthM / 2 + 0.01, hw = spec.widthM / 2 + 0.01;
    bar.position.set(g.side === "front" ? hl : g.side === "rear" ? -hl : 0, 0.003, g.side === "left" ? -hw : g.side === "right" ? hw : 0);
    this.group.add(bar);
    // brushes on the box chassis: a flat star-wheel disc at each end of the mouth, lying horizontally and spinning about
    // a vertical axis, counter-rotating so both sweep balls toward the mouth centre. The CAD chassis keep their own
    // intake roller instead (carved out and spun in carveWheels).
    this.group.getObjectByName("intakeBrushes")?.removeFromParent();
    this.brushes = [];
    if ((g.kind ?? "brushes") !== "brushes" || spec.model !== "box") return;
    const brushGroup = new THREE.Group(); brushGroup.name = "intakeBrushes";
    const r = 0.04, thick = 0.018;
    const edgeX = g.side === "front" ? spec.lengthM / 2 : g.side === "rear" ? -spec.lengthM / 2 : 0;
    const edgeZ = g.side === "left" ? -spec.widthM / 2 : g.side === "right" ? spec.widthM / 2 : 0;
    const out = 0.025; // the disc centre sits just outside the chassis so the bristles reach into a FLOWER's opening
    // outward unit vector of the intake edge and the mouth centre on it
    const ox = Math.sign(edgeX), oz = Math.sign(edgeZ);
    const cx = edgeX + ox * out, cz = edgeZ + oz * out;
    for (const sgn of [-1, 1]) {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(r, r, thick, 12, 1, false), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.95 }));
      for (let k = 0; k < 3; k++) { // bristle spokes so the spin reads
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(r * 2.1, thick * 1.1, 0.006), new THREE.MeshStandardMaterial({ color: 0x00ff88, roughness: 0.9 }));
        spoke.rotation.y = (k * Math.PI) / 3; disc.add(spoke);
      }
      // along the edge: for front/rear the edge runs along Z, for left/right along X
      const alongZ = edgeX !== 0;
      const off = sgn * (g.widthM / 2 - r);
      const dx = alongZ ? 0 : off, dz = alongZ ? off : 0; // disc offset from the mouth centre
      disc.position.set(cx + dx, r * 0.5 + 0.01, cz + dz);
      // spin sign: the disc's outer point (toward the ball) must move toward the mouth centre, i.e. along -d
      const inward = Math.sign(-oz * dx + ox * dz) || 1;
      brushGroup.add(disc); this.brushes.push({ mesh: disc, sign: inward, axis: "y" });
    }
    this.group.add(brushGroup);
  }
  /** spinning intake parts: the box robot's brush discs (about Y) or the CAD's carved roller (about its axle) */
  brushes: { mesh: THREE.Mesh; sign: number; axis: "x" | "y" | "z"; localAxle?: THREE.Vector3 }[] = [];
  /** Spin the intake parts while the intake runs (about 4 rev/s), slow to a stop when it is off. */
  spinIntake(dt: number, active: boolean) {
    if (!this.brushes.length) return;
    this.brushSpeed = active ? Math.min(4 * Math.PI * 2, this.brushSpeed + 30 * dt) : Math.max(0, this.brushSpeed - 20 * dt);
    if (this.brushSpeed === 0) return;
    for (const b of this.brushes) {
      if (b.localAxle) b.mesh.rotateOnAxis(b.localAxle, b.sign * this.brushSpeed * dt); // a pre-rotated cylinder: spin about its own axle
      else b.mesh.rotation[b.axis] += b.sign * this.brushSpeed * dt;
    }
  }
  private brushSpeed = 0;
  /** diagnostics for the CAD intake carve (window.__twin.robot.intakeCarve) */
  intakeCarve?: { candidates: number; vMin?: number; vMax?: number; box?: number[]; found: boolean; sideWheels: number };

  /** Green bar = intake running (balls on that side are collected); red = off (they get pushed). */
  setIntakeActive(active: boolean) {
    const bar = this.group.getObjectByName("intakeMarker") as THREE.Mesh | undefined;
    if (!bar) return;
    const mat = bar.material as THREE.MeshBasicMaterial;
    const want = active ? 0x00ff88 : 0xff4444;
    if (mat.color.getHex() !== want) mat.color.setHex(want);
  }

  applySpec(spec: RobotSpec) {
    this.syncIntakeMarker(spec);
    const lookChanged = this.lookSig !== lookSignature(lookOf(spec)) || this.spec.lengthM !== spec.lengthM || this.spec.widthM !== spec.widthM || this.spec.heightM !== spec.heightM;
    // the CAD's intake roller is carved per intake side/kind: a change there needs the chassis rebuilt from the cached model
    if (this.modelKey !== "box" && this.modelStatus === "loaded" && (this.spec.intake.side !== spec.intake.side || (this.spec.intake.kind ?? "brushes") !== (spec.intake.kind ?? "brushes"))) this.modelKey = "";
    this.spec = spec;
    this.rebuildChassis();
    if (lookChanged) this.applyLook();
    this.rebuildCameras();
    this.updateLauncherMarker();
  }

  private lookSig = "";
  /** Paint the robot: box chassis in the look's colour, CAD lightly tinted (bare aluminium when the colour is aluminium). */
  private applyLook() {
    const spec = this.spec;
    const look = lookOf(spec);
    this.lookSig = lookSignature(look);
    const color = new THREE.Color(look.color);
    if (this.modelKey === "box") {
      this.chassis.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.painted) (m.material as THREE.MeshStandardMaterial).color.copy(color); });
    } else if (this.isPlayer) {
      const bare = look.color === 0xe8e8e8;
      const tint = bare ? new THREE.Color(0xd8d8d8) : new THREE.Color(0xd8d8d8).lerp(color, 0.35);
      this.chassis.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.userData.cadTint) (m.material as THREE.MeshStandardMaterial).color.copy(tint); });
    }
  }

  /** headless test runs draw every robot as the procedural box: the CAD is a look, the footprint and mounts come from the spec */
  static forceBox = false;
  private rebuildChassis() {
    const spec = this.spec;
    const key = RobotObject.forceBox ? "box" : spec.model;
    if (key === "box" || !MODEL_URLS[key]) {
      this.chassis.clear();
      this.modelKey = "box";
      if (this.modelStatus !== "failed") this.modelStatus = "box";
      const mat = new THREE.MeshStandardMaterial({ color: lookOf(spec).color, roughness: 0.6, metalness: 0.2 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9 });
      // the intake end is a low deck (it slides under a FLOWER's mid ring); the tall body and the shooter tower sit behind it
      const side = spec.intake.side, deck = Math.min(spec.intake.deckDepthM ?? 0.1, spec.lengthM * 0.4);
      const alongX = side === "front" || side === "rear";
      const sgn = side === "front" || side === "right" ? 1 : -1; // +1: the intake is at +X (front) or +Z (right)
      const bodyL = alongX ? spec.lengthM - deck : spec.lengthM, bodyW = alongX ? spec.widthM : spec.widthM - deck;
      const bodyOff = -sgn * deck / 2;
      const box = new THREE.Mesh(new THREE.BoxGeometry(bodyL, spec.heightM * 0.5, bodyW), mat);
      box.position.set(alongX ? bodyOff : 0, spec.heightM * 0.25 + 0.02, alongX ? 0 : bodyOff);
      box.castShadow = true; box.userData.painted = true;
      this.chassis.add(box);
      // low deck: a slab 2 in high with a roller across the mouth (horizontal axle along the edge) just above it
      const deckH = 0.05;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(alongX ? deck : spec.lengthM * 0.9, deckH, alongX ? spec.widthM * 0.9 : deck), mat);
      const edgeC = sgn * ((alongX ? spec.lengthM : spec.widthM) / 2 - deck / 2);
      slab.position.set(alongX ? edgeC : 0, deckH / 2 + 0.02, alongX ? 0 : edgeC);
      slab.userData.painted = true; slab.castShadow = true;
      this.chassis.add(slab);
      const rollerR = 0.028, rollerLen = spec.intake.widthM * 0.9;
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(rollerR, rollerR, rollerLen, 14, 1), dark);
      for (let k = 0; k < 4; k++) { const fin = new THREE.Mesh(new THREE.BoxGeometry(rollerR * 2.3, rollerLen * 0.95, 0.005), new THREE.MeshStandardMaterial({ color: 0x3e8e2f, roughness: 0.9 })); fin.rotation.y = (k * Math.PI) / 4; roller.add(fin); }
      const rollerIn = sgn * ((alongX ? spec.lengthM : spec.widthM) / 2 - 0.05); // FEEDER.rollerU
      roller.position.set(alongX ? rollerIn : 0, deckH + 0.02 + rollerR + 0.01, alongX ? 0 : rollerIn);
      if (alongX) roller.rotation.x = Math.PI / 2; else roller.rotation.z = Math.PI / 2; // axle along the edge
      this.chassis.add(roller);
      // the roller pulls inward: its underside moves into the robot
      this.brushes = this.brushes.filter((b) => b.mesh.parent?.name === "intakeBrushes");
      this.brushes.push({ mesh: roller, sign: side === "rear" ? 1 : side === "front" ? -1 : side === "left" ? -1 : 1, axis: alongX ? "z" : "x", localAxle: new THREE.Vector3(0, 1, 0) });
      // shooter tower at the far end
      const tower = new THREE.Mesh(new THREE.BoxGeometry(spec.lengthM * 0.45, spec.heightM * 0.5, spec.widthM * 0.6), mat);
      tower.position.set(alongX ? -sgn * spec.lengthM * 0.15 : 0, spec.heightM * 0.75, alongX ? 0 : -sgn * spec.widthM * 0.15);
      tower.userData.painted = true;
      this.chassis.add(tower);
      // wheels
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(spec.wheelDiameterM / 2, spec.wheelDiameterM / 2, 0.04, 20), wheelMat);
        w.rotation.x = Math.PI / 2;
        w.position.set(sx * spec.lengthM * 0.35, spec.wheelDiameterM / 2, sz * (spec.widthM / 2 + 0.02));
        this.chassis.add(w);
      }
      // forward arrow
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 12), new THREE.MeshBasicMaterial({ color: 0x00ff88 }));
      arrow.rotation.z = -Math.PI / 2;
      arrow.position.set(spec.lengthM / 2 + 0.04, spec.heightM * 0.25, 0);
      this.chassis.add(arrow);
      this.updateLoad();
      this.lookSig = "";
      return;
    }
    if (this.modelKey === key) {
      const w = this.chassis.getObjectByName("cadWrapper");
      if (w) w.rotation.y = ((spec.modelYawDeg ?? 0) * Math.PI) / 180;
      return;
    }
    this.modelKey = key;
    this.modelStatus = "loading";
    this.chassis.clear();
    // placeholder footprint while loading
    const ph = new THREE.Mesh(new THREE.BoxGeometry(spec.lengthM, 0.02, spec.widthM), new THREE.MeshBasicMaterial({ color: 0x888888, wireframe: true }));
    ph.position.y = 0.01;
    this.chassis.add(ph);
    loadModel(key).then((scene) => {
      if (this.modelKey !== key) return;
      this.chassis.clear();
      const model = scene.clone(true);
      // The GLB is exported in millimetres with the CAD's own axes; normalise: scale to metres,
      // put the bottom on the floor and centre the footprint, and align the long axis with +X forward.
      model.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(model);
      const size = bb.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = maxDim > 5 ? 0.001 : 1; // mm -> m heuristic
      model.scale.setScalar(scale);
      // goBILDA STEP exports are Z-up; bring Z up to Y up.
      model.rotation.x = -Math.PI / 2;
      model.updateMatrixWorld(true);
      const bb2 = new THREE.Box3().setFromObject(model);
      const c = bb2.getCenter(new THREE.Vector3());
      model.position.sub(new THREE.Vector3(c.x, bb2.min.y, c.z));
      const wrapper = new THREE.Group();
      wrapper.add(model);
      wrapper.name = "cadWrapper";
      wrapper.rotation.y = ((spec.modelYawDeg ?? 0) * Math.PI) / 180;
      // our robot is bare aluminium; the other robots carry their alliance colour in the metal so they stay tellable apart
      const tint = this.isPlayer ? new THREE.Color(0xd8d8d8) : new THREE.Color(0xd8d8d8).lerp(new THREE.Color(spec.color), 0.55);
      model.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh;
          mesh.castShadow = true;
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (mat && !mat.map) {
            mesh.material = new THREE.MeshStandardMaterial({ color: tint, metalness: 0.5, roughness: 0.45 });
            mesh.userData.cadTint = true;
          }
        }
      });
      this.chassis.add(wrapper);
      this.wheels = [];
      this.brushes = this.brushes.filter((b) => b.mesh.parent?.name === "intakeBrushes"); // box discs only; carved parts belong to the old chassis
      // the intake parts are always carved so the feeder is seen working; the drive wheels only with wheelSpin on
      this.carveWheels(wrapper, spec, this.wheelSpin);
      this.modelStatus = "loaded";
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 12), new THREE.MeshBasicMaterial({ color: 0x00ff88 }));
      arrow.rotation.z = -Math.PI / 2;
      arrow.position.set(spec.lengthM / 2 + 0.04, 0.1, 0);
      this.chassis.add(arrow);
      this.updateLoad();
      this.lookSig = ""; this.applyLook();
    }).catch(() => {
      // fall back to a box
      this.modelStatus = "failed";
      this.spec = { ...this.spec, model: "box" };
      this.rebuildChassis();
    });
  }

  /** Turn wheel spinning on or off; the CAD is rebuilt from the cached model so the split happens (or is undone). */
  setWheelSpin(on: boolean) {
    if (this.wheelSpin === on) return;
    this.wheelSpin = on;
    if (this.modelKey !== "box" && this.modelStatus === "loaded") { this.modelKey = ""; this.rebuildChassis(); }
  }

  /** Carve the wheels out of the welded CAD mesh into separate meshes positioned on their axles (robot-local frame). */
  private carveWheels(wrapper: THREE.Group, spec: RobotSpec, driveWheels = true) {
    wrapper.updateMatrixWorld(true);
    this.chassis.updateMatrixWorld(true);
    const toLocal = new THREE.Matrix4().copy(this.chassis.matrixWorld).invert();
    const meshes: THREE.Mesh[] = [];
    wrapper.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    for (const mesh of meshes) {
      const local = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld));
      const split = driveWheels ? splitWheelGeometry(local, { widthM: spec.widthM, wheelDiameterM: spec.wheelDiameterM }) : { body: local, wheels: [], clusters: [] };
      if (split && driveWheels) this.wheelClusters = split.clusters;
      if (!split) { local.dispose(); continue; }
      let bodyGeo = split.body;
      let carvedSomething = split.wheels.length > 0;
      // the kit intake: a roller of flaps just inside the intake edge; carve it so it spins while the intake runs
      if ((spec.intake.kind ?? "brushes") === "brushes") {
        const ip = { lengthM: spec.lengthM, widthM: spec.widthM, side: spec.intake.side, mouthWidthM: spec.intake.widthM };
        const ir = splitIntakeRoller(bodyGeo, ip);
        this.intakeCarve = { ...ir.diag, found: !!ir.roller, sideWheels: 0 };
        // the side wheels: vertical-axle compliant wheels at the mouth ends, counter-rotating so both sweep inward
        const sw = splitIntakeSideWheels(ir.roller ? ir.body : bodyGeo, ip, ir.roller ? [ir.roller.vMin, ir.roller.vMax] : [0, 0]);
        if (sw.wheels.length) {
          if (ir.roller) ir.body = sw.body; else bodyGeo = sw.body;
          this.intakeCarve.sideWheels = sw.wheels.length; carvedSomething = true;
          const s = spec.intake.side;
          const [ox, oz] = s === "front" ? [1, 0] : s === "rear" ? [-1, 0] : s === "right" ? [0, 1] : [0, -1]; // outward
          const [vx, vz] = s === "front" || s === "rear" ? [0, 1] : [1, 0]; // +v along the edge
          for (const w of sw.wheels) {
            const wm = new THREE.Mesh(w.geometry, mesh.material); wm.castShadow = true;
            wm.position.set(w.x, 0, w.z);
            this.chassis.add(wm);
            // +ω about Y moves a point at offset (dx, dz) by (dz, -dx): the outer point (toward the ball, offset o) must
            // move toward the mouth centre (−side · v)
            const velX = oz, velZ = -ox;
            const sign = Math.sign(-(w.side) * (vx * velX + vz * velZ)) || 1;
            this.brushes.push({ mesh: wm, sign, axis: "y" });
          }
        }
        if (ir.roller) {
          bodyGeo = ir.body; carvedSomething = true;
          const rm = new THREE.Mesh(ir.roller.geometry, mesh.material); rm.castShadow = true;
          rm.position.set(ir.roller.x, ir.roller.y, ir.roller.z);
          this.chassis.add(rm);
          // pull inward: the roller's underside moves into the robot. About +Z, +ω moves the bottom toward +X (so a
          // rear intake, whose inside is +X, spins positive); about +X, +ω moves the bottom toward -Z.
          const s = spec.intake.side;
          const sign = s === "rear" ? 1 : s === "front" ? -1 : s === "left" ? -1 : 1;
          this.brushes.push({ mesh: rm, sign, axis: s === "front" || s === "rear" ? "z" : "x" });
        }
      }
      if (!carvedSomething) { local.dispose(); continue; } // nothing to split out of this mesh: leave the original as it is
      const body = new THREE.Mesh(bodyGeo, mesh.material); body.castShadow = true;
      this.chassis.add(body);
      for (const w of split.wheels) {
        const wm = new THREE.Mesh(w.geometry, mesh.material); wm.castShadow = true;
        wm.position.set(w.x, w.y, w.z);
        this.chassis.add(wm);
        this.wheels.push({ mesh: wm, x: w.x, z: w.z, r: w.r, angle: 0 });
      }
      mesh.visible = false; // the welded original stays in the wrapper (for bounds), hidden
      local.dispose();
    }
  }

  /** Advance the wheels for a body moving with these robot-frame speeds (m/s, rad/s CCW). */
  spinWheels(dt: number, fwd: number, left: number, yaw: number) {
    if (!this.wheels.length) return;
    for (const w of this.wheels) {
      w.angle -= wheelAngularSpeed(w.x, w.z, w.r, fwd, left, yaw, this.spec.drivetrain) * dt; // forward motion rolls the top of the wheel forward (+X)
      w.mesh.rotation.z = w.angle;
    }
  }

  /** For robots the twin moves by pose (scripted robots, replay): derive the speeds from the pose change. */
  spinFromPose(dt: number) {
    const prev = this.spinPrevPose, cur = this.pose;
    this.spinPrevPose = { ...cur };
    if (!prev || dt <= 0 || !this.wheels.length) return;
    const dx = cur.x - prev.x, dz = cur.z - prev.z;
    let dh = cur.heading - prev.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const h = cur.heading;
    const fwd = (dx * -Math.sin(h) + dz * -Math.cos(h)) / dt, left = (dx * -Math.cos(h) + dz * Math.sin(h)) / dt;
    if (Math.hypot(dx, dz) > 0.5) return; // teleport, not motion
    this.spinWheels(dt, fwd, left, dh / dt);
  }

  private updateLoad() {
    // show preloaded pollen as a hint of launcher location
    for (const p of this.pollenLoad) p.removeFromParent();
    this.pollenLoad = [];
  }

  private buildLauncherMarker(): THREE.Group {
    const g = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 16), new THREE.MeshStandardMaterial({ color: 0xff8800, emissive: 0x3a1a00 }));
    barrel.name = "barrel";
    barrel.userData.gizmo = "launcher";
    g.add(barrel);
    // drop line to the chassis so the exit height is readable
    const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 1, 6), new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.5 }));
    drop.name = "drop";
    g.add(drop);
    return g;
  }

  updateLauncherMarker() {
    const l = this.spec.launcher;
    this.launcherMarker.position.set(l.exitForwardM, l.exitHeightM, -l.exitLeftM);
    const barrel = this.launcherMarker.getObjectByName("barrel") as THREE.Mesh;
    // cylinder axis +Y -> rotate so it points along the launcher direction (+X local, then yawed) elevated by elevation
    barrel.rotation.set(0, 0, -(Math.PI / 2 - (l.elevationDeg * Math.PI) / 180));
    const drop = this.launcherMarker.getObjectByName("drop") as THREE.Mesh;
    drop.scale.y = l.exitHeightM; drop.position.y = -l.exitHeightM / 2;
    this.launcherMarker.visible = this.isPlayer;
  }

  rebuildCameras() {
    this.cameraGizmos.clear();
    const seen = new Set<string>();
    for (const cam of this.spec.cameras) {
      seen.add(cam.id);
      let c = this.cameras.get(cam.id);
      if (!c) {
        c = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 30);
        this.cameras.set(cam.id, c);
      }
      const intr = intrinsicsFor(cam);
      c.fov = (intr.vfov * 180) / Math.PI;
      c.aspect = intr.width / intr.height;
      c.updateProjectionMatrix();
      // mount: robot local (+X fwd, +Y up, +Z right). Camera looks down its -Z, so rotate -Z -> +X.
      const holder = new THREE.Group();
      holder.position.set(cam.forwardM, cam.heightM, -cam.leftM);
      const yaw = (cam.yawDeg * Math.PI) / 180, pitch = (cam.pitchDeg * Math.PI) / 180, roll = (cam.rollDeg * Math.PI) / 180;
      // base orientation: camera forward (-Z) -> +X : rotate about Y by -90deg
      holder.rotation.set(0, -Math.PI / 2, 0);
      const inner = new THREE.Group();
      inner.rotation.set(-pitch, yaw, roll, "YXZ"); // yaw about camera up, pitch down positive
      holder.add(inner);
      inner.add(c);
      // gizmo body
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.035, 0.05), new THREE.MeshStandardMaterial({ color: cam.enabled ? 0x22cc66 : 0x666666, emissive: 0x0a3a1a }));
      body.userData.camId = cam.id;
      body.name = "camGizmo";
      inner.add(body);
      // drop line to the chassis so the mount height is readable
      const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, cam.heightM, 6), new THREE.MeshBasicMaterial({ color: 0x22cc66, transparent: true, opacity: 0.5 }));
      drop.position.set(cam.forwardM, cam.heightM / 2, -cam.leftM);
      this.cameraGizmos.add(drop);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.02, 12), new THREE.MeshStandardMaterial({ color: 0x111111 }));
      lens.rotation.x = Math.PI / 2;
      lens.position.z = -0.035;
      lens.userData.camId = cam.id;
      inner.add(lens);
      this.cameraGizmos.add(holder);
    }
    for (const id of [...this.cameras.keys()]) if (!seen.has(id)) this.cameras.delete(id);
    this.group.updateMatrixWorld(true);
  }

  setPose(pose: Pose) {
    this.pose = pose;
    this.group.position.set(pose.x, 0, pose.z);
    // local +X forward must map to world forward (-sin h, 0, -cos h): rotation about Y by (h + 90deg)
    this.group.rotation.y = pose.heading + Math.PI / 2;
    this.group.updateMatrixWorld(true);
  }

  /** World-space launcher exit point. */
  exitPoint(): THREE.Vector3 {
    return this.launcherMarker.getWorldPosition(new THREE.Vector3());
  }

  worldCamera(id: string): THREE.PerspectiveCamera | undefined {
    return this.cameras.get(id);
  }

  /** Approximate occluder box for raycasts and opponent collision. */
  boundsBox(): THREE.Box3 {
    return new THREE.Box3().setFromObject(this.chassis);
  }
}
