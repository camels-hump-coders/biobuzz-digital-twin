/** three.js representation of a robot: chassis (GLB or box), camera gizmos, launcher marker. */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { RobotSpec, CameraMount } from "./robotSpec";
import { type Intrinsics, fromDiagonal, fromHorizontal } from "../camera/cameraMath";
import { presetById } from "../camera/cameraPresets";
import type { Pose } from "../sim/drive";

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
  applySpec(spec: RobotSpec) {
    this.spec = spec;
    this.rebuildChassis();
    this.rebuildCameras();
    this.updateLauncherMarker();
  }

  private rebuildChassis() {
    const spec = this.spec;
    const key = spec.model;
    if (key === "box" || !MODEL_URLS[key]) {
      this.chassis.clear();
      this.modelKey = "box";
      if (this.modelStatus !== "failed") this.modelStatus = "box";
      const geo = new THREE.BoxGeometry(spec.lengthM, spec.heightM * 0.5, spec.widthM);
      const mat = new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.6, metalness: 0.2 });
      const box = new THREE.Mesh(geo, mat);
      box.position.y = spec.heightM * 0.25 + 0.02;
      box.castShadow = true;
      this.chassis.add(box);
      // upper structure
      const tower = new THREE.Mesh(new THREE.BoxGeometry(spec.lengthM * 0.5, spec.heightM * 0.5, spec.widthM * 0.6), mat);
      tower.position.set(-spec.lengthM * 0.1, spec.heightM * 0.75, 0);
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
      model.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh;
          mesh.castShadow = true;
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (mat && !mat.map) {
            mesh.material = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.5, roughness: 0.45 });
          }
        }
      });
      this.chassis.add(wrapper);
      this.modelStatus = "loaded";
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 12), new THREE.MeshBasicMaterial({ color: 0x00ff88 }));
      arrow.rotation.z = -Math.PI / 2;
      arrow.position.set(spec.lengthM / 2 + 0.04, 0.1, 0);
      this.chassis.add(arrow);
      this.updateLoad();
    }).catch(() => {
      // fall back to a box
      this.modelStatus = "failed";
      this.spec = { ...this.spec, model: "box" };
      this.rebuildChassis();
    });
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
