import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildField } from "./field/buildField";
import { aimPoint, upCellFrame, type CellFrame, type Vec3 } from "./field/hive";
import { BALL, FIELD, m } from "./field/fieldSpec";
import { RobotObject, intrinsicsFor } from "./robot/robot";
import { Input } from "./sim/input";
import { commandToVelocity, stepPose, robotToWorld, headingToward, hiveFrameObstacles, type DriveParams, type Obstacle } from "./sim/drive";
import { defaultScriptedRobots, stepScripted } from "./sim/opponents";
import { Overlays } from "./ui/overlays";
import { Panel } from "./ui/panel";
import { Hud, type HudData } from "./ui/hud";
import { loadState, saveState, type AppState } from "./state";
import { evaluateShot, evaluateVelocity, scanElevations, solveSpeedForElevation, type ShotResult } from "./ballistics/solver";
import { exitSpeed, rpmForExitSpeed, spinRate } from "./ballistics/launcher";
import { computeReachability, type ReachMap } from "./ballistics/reachability";
import { monteCarlo, perturb, rng, type MonteCarlo } from "./ballistics/dispersion";
import { stepBall, insideCell, type LiveBall } from "./sim/ballPhysics";
import { RuntimeLink, type SensorPacket } from "./runtime/link";
import { createActuatorModel, stepActuators, motorSensors, feederFires } from "./runtime/actuators";
import { buildDetections } from "./runtime/apriltags";
import { analyseTags as analyseTagsFor } from "./camera/robotCamera";
import { velocityFrom } from "./ballistics/projectile";
import { analyseTags, cameraPoseOf } from "./camera/robotCamera";
import { clamp, mToIn, rad2deg, wrapAngle } from "./util/units";
import { clonePreset } from "./robot/presets";

const state: AppState = loadState();

// ---------- renderer & scenes
const canvas = document.getElementById("view") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setScissorTest(false);

// Picture-in-picture insets, one per camera (FTC allows at most two cameras).
const pipsEl = document.getElementById("pips")!;
interface Pip { el: HTMLElement; canvas: HTMLCanvasElement; label: HTMLElement; renderer: THREE.WebGLRenderer; camId?: string }
const pips: Pip[] = [];
function ensurePips(n: number) {
  while (pips.length < n) {
    const el = document.createElement("div"); el.className = "pip";
    const canvas = document.createElement("canvas");
    const label = document.createElement("div"); label.className = "label";
    el.append(canvas, label);
    pipsEl.append(el);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const pip: Pip = { el, canvas, label, renderer };
    el.addEventListener("click", () => { if (pip.camId) { state.selectedCameraId = pip.camId; panel.render(); } });
    pips.push(pip);
  }
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f27);
scene.fog = new THREE.Fog(0x1a1f27, 12, 30);

const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(4, 8, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -3;
sun.shadow.camera.right = sun.shadow.camera.top = 3;
sun.shadow.camera.far = 20;
scene.add(sun);
// venue floor
const venue = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x23282f, roughness: 1 }));
venue.rotation.x = -Math.PI / 2;
venue.position.y = -m(FIELD.tileThicknessIn) - 0.001;
venue.receiveShadow = true;
scene.add(venue);

const field = buildField(state.hive);
scene.add(field.group);

const overlays = new Overlays();
scene.add(overlays.group);

// ---------- robots
const robot = new RobotObject(state.robot, true);
scene.add(robot.group);
robot.setPose(state.pose);

const scripted = defaultScriptedRobots();
const scriptedObjs = scripted.map((s) => {
  const spec = clonePreset("custom18");
  spec.model = "box";
  spec.color = s.color;
  spec.cameras = [];
  const o = new RobotObject(spec, false);
  o.setPose(s.pose);
  scene.add(o.group);
  return o;
});

// ---------- cameras
const orbitCam = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
orbitCam.position.set(3.2, 2.6, 4.2);
const controls = new OrbitControls(orbitCam, canvas);
controls.target.set(0, 0.5, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.enableDamping = true;
const topCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50);
topCam.position.set(0, 10, 0);
topCam.up.set(0, 0, -1);
topCam.lookAt(0, 0, 0);
const chaseCam = new THREE.PerspectiveCamera(60, 1, 0.05, 100);

// ---------- flying balls
const flying: LiveBall[] = [];
let shotsFired = 0, shotsHit = 0;

// ---------- UI
const input = new Input();
const hud = new Hud();
let panel: Panel;

function applyRobotSpec() {
  robot.applySpec(state.robot);
  if (!state.robot.cameras.some((c) => c.id === state.selectedCameraId)) state.selectedCameraId = state.robot.cameras[0]?.id ?? "";
}
function onChange(what: Parameters<ConstructorParameters<typeof Panel>[1]>[0]) {
  if (what === "reset") { applyRobotSpec(); }
  if (what === "robot" || what === "cameras" || what === "launcher") applyRobotSpec();
  if (what === "runtime") syncRuntime();
  if (what === "hardware" && link.connected) link.sendHardware(hardwareDevices());
  if (what === "sim") { field.setHiveState({ alliance: "red", upCell: state.hive.red }); field.setHiveState({ alliance: "blue", upCell: state.hive.blue }); robot.setPose(state.pose); }
  Object.assign(overlays.show, state.overlays);
  saveState(state);
}
// ---------- virtual runtime link
const link = new RuntimeLink(state.runtimeUrl);
const actuatorModel = createActuatorModel();
let imuYawRef = 0; // IMU yaw is reported relative to the heading at connect time
function hardwareDevices() {
  return state.hardware.devices.map((d) => ({ name: d.name, kind: d.kind, ticksPerRev: d.ticksPerRev ?? 537.7 }));
}
function syncRuntime() {
  if (state.runtimeEnabled) { if ((link as any).url !== state.runtimeUrl) { link.disconnect(); (link as any).url = state.runtimeUrl; } link.connect(); }
  else link.disconnect();
}
let hardwareSent = false;
link.onChange = () => { if (link.connected && !hardwareSent) { link.sendHardware(hardwareDevices()); hardwareSent = true; } if (!link.connected) hardwareSent = false; panel.render(); };
panel = new Panel(state, onChange);
panel.link = link;
syncRuntime();
Object.assign(overlays.show, state.overlays);
window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  if (e.code === "KeyH") panel.toggle();
});

// ---------- helpers
function ballProps() {
  const b = state.ballKind === "pollen" ? BALL.pollen : BALL.nectarRed;
  return { massKg: b.massKg, diameterM: m(b.diaIn), cd: state.drag ? 0.45 : 0, cl: state.drag ? 0.2 : 0 };
}
function driveParams(): DriveParams {
  const r = state.robot;
  return { drivetrain: r.drivetrain, wheelRpm: r.wheelRpm, wheelDiameterM: r.wheelDiameterM, trackWidthM: r.widthM * 0.9, wheelbaseM: r.lengthM * 0.75, fieldCentric: state.fieldCentric };
}
function targetFrame(): CellFrame {
  return upCellFrame({ alliance: state.alliance, upCell: state.hive[state.alliance] });
}
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  orbitCam.aspect = w / h; orbitCam.updateProjectionMatrix();
  chaseCam.aspect = w / h; chaseCam.updateProjectionMatrix();
  const half = m(FIELD.sizeIn) / 2 + 0.9;
  const asp = w / h;
  if (asp >= 1) { topCam.left = -half * asp; topCam.right = half * asp; topCam.top = half; topCam.bottom = -half; }
  else { topCam.left = -half; topCam.right = half; topCam.top = half / asp; topCam.bottom = -half / asp; }
  topCam.updateProjectionMatrix();
  for (const p of pips) p.renderer.setSize(p.el.clientWidth, p.el.clientHeight, false);
}
window.addEventListener("resize", resize);
resize();

// Shift+click (or double-click) on the mat teleports the robot there, keeping its heading.
const pickRay = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function teleportAt(ev: MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  const cam = activeCamera();
  pickRay.setFromCamera(ndc, cam);
  const hit = new THREE.Vector3();
  if (!pickRay.ray.intersectPlane(floorPlane, hit)) return;
  const half = m(FIELD.sizeIn) / 2;
  if (Math.abs(hit.x) > half || Math.abs(hit.z) > half) return;
  state.pose = { ...state.pose, x: hit.x, z: hit.z };
  robot.setPose(state.pose);
  state.aimRequest = true; // face the target from the new spot
}
// ---- camera mount dragging (orbit view): drag the green body to move it on the robot; Alt-drag changes height.
let dragCam: { id: string; alt: boolean; plane: THREE.Plane } | undefined; // id "__launcher" drags the orange exit marker
function pickGizmo(ev: PointerEvent): string | undefined {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  pickRay.setFromCamera(ndc, activeCamera());
  const hits = pickRay.intersectObjects([robot.cameraGizmos, robot.launcherMarker], true);
  const h = hits.find((x) => x.object.userData.camId || x.object.userData.gizmo === "launcher");
  if (!h) return undefined;
  return h.object.userData.camId ?? "__launcher";
}
canvas.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0) return;
  if (ev.shiftKey) { teleportAt(ev); return; }
  if (state.view !== "robot") {
    const id = pickGizmo(ev);
    if (id) {
      const lch = state.robot.launcher;
      const mount = id === "__launcher" ? { forwardM: lch.exitForwardM, leftM: lch.exitLeftM, heightM: lch.exitHeightM } : state.robot.cameras.find((c) => c.id === id)!;
      const world = robotToWorld(state.pose, mount.forwardM, mount.leftM);
      const camPose = activeCamera().getWorldDirection(new THREE.Vector3());
      // horizontal plane at the mount height, or a vertical plane facing the viewer for Alt (height) drags
      const plane = ev.altKey
        ? new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(camPose.x, 0, camPose.z).normalize().negate(), new THREE.Vector3(world.x, mount.heightM, world.z))
        : new THREE.Plane(new THREE.Vector3(0, 1, 0), -mount.heightM);
      dragCam = { id, alt: ev.altKey, plane };
      controls.enabled = false;
      if (id !== "__launcher") state.selectedCameraId = id;
      canvas.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }
  }
});
canvas.addEventListener("pointermove", (ev) => {
  if (!dragCam) { canvas.style.cursor = state.view !== "robot" && pickGizmo(ev) ? "grab" : ""; return; }
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  pickRay.setFromCamera(ndc, activeCamera());
  const hit = new THREE.Vector3();
  if (!pickRay.ray.intersectPlane(dragCam.plane, hit)) return;
  const isLauncher = dragCam.id === "__launcher";
  const lch = state.robot.launcher;
  const mount = isLauncher ? { forwardM: lch.exitForwardM, leftM: lch.exitLeftM, heightM: lch.exitHeightM } : state.robot.cameras.find((c) => c.id === dragCam!.id);
  if (!mount) { dragCam = undefined; return; }
  if (dragCam.alt) {
    mount.heightM = clamp(hit.y, 0.02, m(29));
  } else {
    // world -> robot local (forward, left)
    const dx = hit.x - state.pose.x, dz = hit.z - state.pose.z;
    const f = { x: -Math.sin(state.pose.heading), z: -Math.cos(state.pose.heading) };
    const lv = { x: -Math.cos(state.pose.heading), z: Math.sin(state.pose.heading) };
    const lim = Math.max(state.robot.lengthM, state.robot.widthM) / 2 + 0.05;
    mount.forwardM = clamp(dx * f.x + dz * f.z, -lim, lim);
    mount.leftM = clamp(dx * lv.x + dz * lv.z, -lim, lim);
  }
  if (isLauncher) { lch.exitForwardM = mount.forwardM; lch.exitLeftM = mount.leftM; lch.exitHeightM = mount.heightM; robot.updateLauncherMarker(); }
  else robot.rebuildCameras();
  canvas.style.cursor = "grabbing";
});
function endDrag() {
  if (!dragCam) return;
  dragCam = undefined;
  controls.enabled = state.view === "orbit";
  canvas.style.cursor = "";
  panel.render();
  saveState(state);
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("dblclick", (ev) => teleportAt(ev));
let currentCamera: THREE.Camera = orbitCam;
function activeCamera(): THREE.Camera { return currentCamera; }

// ---------- main loop
let last = performance.now();
let shotCache: { key: string; shot?: ShotResult; scan?: ReturnType<typeof scanElevations>; required?: number } = { key: "" };
let analysisTick = 0;

function computeShot(exit: Vec3, frame: CellFrame): { shot?: ShotResult; scan?: ReturnType<typeof scanElevations>; required?: number } {
  const l = state.robot.launcher;
  const target = aimPoint(frame, 0.05);
  const key = JSON.stringify([exit.x.toFixed(3), exit.y.toFixed(3), exit.z.toFixed(3), l, state.ballKind, state.drag, state.autoRpm, state.autoHood, state.alliance, state.hive]);
  if (key === shotCache.key) return shotCache;
  const req = { ball: ballProps(), launchPos: exit, target, frame, spin: spinRate(l) };
  const scan = scanElevations(req, Math.min(l.elevationMinDeg, l.elevationMaxDeg), Math.max(l.elevationMinDeg, l.elevationMaxDeg), 2.5, exitSpeed(l, l.maxRpm));
  if (state.autoHood && scan.best) l.elevationDeg = rad2deg(scan.best.elevationRad);
  const fixed = solveSpeedForElevation(req, (l.elevationDeg * Math.PI) / 180, exitSpeed(l, l.maxRpm) * 1.5);
  const required = fixed?.speed;
  if (state.autoRpm && required !== undefined) l.rpm = clamp(rpmForExitSpeed(l, required), 0, l.maxRpm);
  const shot = evaluateShot(req, (l.elevationDeg * Math.PI) / 180, exitSpeed(l));
  shotCache = { key, shot, scan, required };
  return shotCache;
}

function launch(exit: Vec3, dirXZ: { x: number; z: number }) {
  const l = state.robot.launcher;
  const nominal = { speed: exitSpeed(l), elevationRad: (l.elevationDeg * Math.PI) / 180, dirXZ, spin: spinRate(l) };
  const draw = perturb(nominal, state.noise, rng((Math.random() * 2 ** 32) >>> 0));
  const vel = draw.vel;
  const bp = ballProps();
  const color = state.ballKind === "pollen" ? BALL.pollen.color : state.alliance === "red" ? BALL.nectarRed.color : BALL.nectarBlue.color;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(bp.diameterM / 2, 20, 14), new THREE.MeshStandardMaterial({ color, roughness: 0.45 }));
  mesh.castShadow = true;
  mesh.position.set(exit.x, exit.y, exit.z);
  scene.add(mesh);
  flying.push({ mesh, pos: new THREE.Vector3(exit.x, exit.y, exit.z), vel: new THREE.Vector3(vel.x, vel.y, vel.z), spin: draw.spin, radius: bp.diameterM / 2, age: 0, restFor: 0, bounces: 0 });
  shotsFired++;
}

function ballColliders(): THREE.Object3D[] {
  const list: THREE.Object3D[] = [...field.occluders];
  for (const o of scriptedObjs) if (o.group.visible) list.push(o.chassis);
  list.push(robot.chassis);
  return list;
}
function updateFlying(dt: number) {
  if (!flying.length) return;
  const colliders = ballColliders();
  const bp = ballProps();
  const tf = targetFrame();
  for (let i = flying.length - 1; i >= 0; i--) {
    const f = flying[i];
    if (!f.settled) {
      stepBall(f, dt, bp, colliders);
      if (f.settled) {
        f.scored = insideCell(tf, f.pos, 0.02);
        if (f.scored) shotsHit++;
      }
    } else if ((f.age += dt) > 12) {
      f.mesh.removeFromParent();
      flying.splice(i, 1);
    }
  }
}

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // input & drive
  const { cmd, actions } = input.poll();
  if (actions.view) { state.view = (["orbit", "top", "chase", "robot"] as const)[actions.view - 1] ?? state.view; panel.render(); }
  if (actions.toggleTarget) { state.hive[state.alliance] = state.hive[state.alliance] === "audience" ? "scoring" : "audience"; field.setHiveState({ alliance: state.alliance, upCell: state.hive[state.alliance] }); panel.render(); }
  if (actions.toggleFieldCentric) { state.fieldCentric = !state.fieldCentric; panel.render(); }
  const dp = driveParams();
  const runtimeActive = link.running;
  let vel = commandToVelocity(runtimeActive ? { forward: 0, left: 0, turn: 0 } : cmd, state.pose, dp);
  if (runtimeActive) {
    const act = stepActuators(actuatorModel, state.hardware, link.actuators, dt, state.robot.drivetrain, state.pose.heading, state.robot.wheelDiameterM, dp.trackWidthM, dp.wheelbaseM);
    vel = act.vel;
    const l = state.robot.launcher;
    l.rpm = clamp(act.flywheelRpm, 0, l.maxRpm);
    if (act.hoodPos !== undefined && l.elevationMinDeg !== l.elevationMaxDeg) l.elevationDeg = l.elevationMinDeg + act.hoodPos * (l.elevationMaxDeg - l.elevationMinDeg);
    state.autoRpm = false;
    pendingFires += feederFires(state.hardware, link.takeServoTransitions());
  } else {
    link.takeServoTransitions();
    // keep encoders moving sensibly when the keyboard drives, so init_loop telemetry is not frozen
    stepActuators(actuatorModel, state.hardware, {}, dt, state.robot.drivetrain, state.pose.heading, state.robot.wheelDiameterM, dp.trackWidthM, dp.wheelbaseM);
  }
  const others: Obstacle[] = state.opponents ? scripted.map((s) => ({ xMin: s.pose.x - s.footprint.widthM / 2, xMax: s.pose.x + s.footprint.widthM / 2, zMin: s.pose.z - s.footprint.lengthM / 2, zMax: s.pose.z + s.footprint.lengthM / 2 })) : [];
  state.pose = stepPose(state.pose, vel, dt, { lengthM: state.robot.lengthM, widthM: state.robot.widthM }, [...hiveFrameObstacles(), ...others]);
  robot.setPose(state.pose);

  // aim after the collision push-out so a teleport into the frame still ends up pointed at the target
  if (actions.aim || state.aimRequest) {
    state.aimRequest = false;
    const ex = robot.exitPoint();
    const tfr = targetFrame();
    const ap = aimPoint(tfr, 0.05);
    // heading such that the launcher (at its turret centre) points at the target
    const mid = (state.robot.launcher.turretMinDeg + state.robot.launcher.turretMaxDeg) / 2;
    // the exit point moves when the robot turns, so iterate a few times
    for (let i = 0; i < 6; i++) {
      const e = robot.exitPoint();
      state.pose = { ...state.pose, heading: headingToward({ x: e.x, z: e.z }, ap) - ((mid + state.robot.launcher.yawOffsetDeg) * Math.PI) / 180 };
      // the rotated footprint may now overlap a frame leg; push out and aim again
      state.pose = stepPose(state.pose, { vx: 0, vz: 0, yawRate: 0 }, 0.001, { lengthM: state.robot.lengthM, widthM: state.robot.widthM }, [...hiveFrameObstacles(), ...others]);
      robot.setPose(state.pose);
    }
    void ex;
  }

  // scripted robots
  if (state.opponents && !state.pauseOpponents) {
    const me: Obstacle = { xMin: state.pose.x - state.robot.widthM / 2, xMax: state.pose.x + state.robot.widthM / 2, zMin: state.pose.z - state.robot.lengthM / 2, zMax: state.pose.z + state.robot.lengthM / 2 };
    scripted.forEach((s) => stepScripted(s, dt, [me]));
  }
  scriptedObjs.forEach((o, i) => { o.group.visible = state.opponents; o.setPose(scripted[i].pose); });

  // shot analysis
  const tf = targetFrame();
  const exitV = robot.exitPoint();
  const exit = { x: exitV.x, y: exitV.y, z: exitV.z };
  const target = aimPoint(tf, 0.05);
  const l = state.robot.launcher;
  const wantHeading = headingToward(exit, target);
  const launcherHeading = state.pose.heading + (l.yawOffsetDeg * Math.PI) / 180; // where the launcher points with the turret centred
  const bearingErr = wrapAngle(wantHeading - launcherHeading); // + means target is to the left of the launcher
  const turretOk = rad2deg(bearingErr) >= l.turretMinDeg - 0.5 && rad2deg(bearingErr) <= l.turretMaxDeg + 0.5;
  // launcher yaw: if turret can cover, aim exactly; otherwise fire along robot heading (+ turret limit)
  const turretYaw = clamp(bearingErr, (l.turretMinDeg * Math.PI) / 180, (l.turretMaxDeg * Math.PI) / 180);
  const fireHeading = launcherHeading + turretYaw;
  const fireDir = { x: -Math.sin(fireHeading), z: -Math.cos(fireHeading) };
  // arc along the direction the launcher points right now, plus Monte Carlo dispersion
  const actualShot = computeActual(exit, tf, fireDir);
  const mc = computeMonteCarlo(exit, tf, fireDir);
  // the analysed arc is always toward the target (what the robot would do if aimed); the fired ball goes where the launcher points
  const { shot, scan, required } = computeShot(exit, tf);
  robot.launcherMarker.rotation.y = (l.yawOffsetDeg * Math.PI) / 180 + turretYaw; // local +Y rotation = yaw left
  if (actions.launch && !runtimeActive) launch(exit, fireDir);
  while (pendingFires > 0) { pendingFires--; launch(exit, fireDir); }
  updateFlying(dt);

  // overlays
  updateReachMap(tf);
  overlays.setTrajectory(shot, ballProps().diameterM / 2, turretOk);
  overlays.setActualTrajectory(actualShot, ballProps().diameterM / 2);
  overlays.setDispersion(mc?.points);
  overlays.setFan(scan?.solutions ?? []);
  overlays.setTarget(tf, target);
  overlays.setAim(exit, target, turretOk);

  // cameras analysis (throttled)
  analysisTick++;
  const camInfos = state.robot.cameras.map((c) => {
    const cam = robot.worldCamera(c.id)!;
    return { mount: c, cam, intr: intrinsicsFor(c), pose: cameraPoseOf(cam), enabled: c.enabled, selected: c.id === state.selectedCameraId };
  });
  overlays.setCameras(camInfos);
  const selected = camInfos.find((c) => c.selected) ?? camInfos[0];
  let tags: HudData["tags"] = [];
  if (selected && analysisTick % 3 === 0) {
    const occluders = [...field.occluders, ...scriptedObjs.filter((o) => o.group.visible).map((o) => o.chassis)];
    tags = analyseTags(selected.cam, selected.intr, field.tagMeshes, occluders);
    lastTags = tags;
  }

  // runtime sensors
  if (link.connected) {
    const tagsByCam: SensorPacket["tags"] = {};
    for (const dev of state.hardware.devices) if (dev.kind === "webcam") {
      const ci = camInfos.find((c) => c.mount.id === (dev.cameraId ?? camInfos[0]?.mount.id)) ?? camInfos[0];
      if (!ci) { tagsByCam[dev.name] = []; continue; }
      const vis = ci === selected && lastTags.length ? lastTags : analyseTagsFor(ci.cam, ci.intr, field.tagMeshes, [...field.occluders, ...scriptedObjs.filter((o) => o.group.visible).map((o) => o.chassis)]);
      tagsByCam[dev.name] = buildDetections(ci.cam, ci.intr, vis, field.tagMeshes, state.pose, state.tagNoiseIn);
    }
    lastTagsByCam = tagsByCam;
    lastYawRate = vel.yawRate;
    if (!link.running) imuYawRef = 0;
    panel.updateTelemetry(link.telemetry, `${link.status}${link.currentOpMode ? " · " + link.currentOpMode : ""}`);
  }

  // HUD
  const speed = Math.hypot(vel.vx, vel.vz);
  const apex = shot ? Math.max(...shot.samples.map((s) => s.pos.y)) : undefined;
  const flight = shot?.crossing ? shot.samples.find((s) => { const d = (s.pos.x - tf.openingCenter.x) * tf.normal.x + (s.pos.y - tf.openingCenter.y) * tf.normal.y + (s.pos.z - tf.openingCenter.z) * tf.normal.z; return d <= 0; })?.t : undefined;
  hud.update({
    poseIn: { x: mToIn(state.pose.x), z: mToIn(state.pose.z), headingDeg: rad2deg(state.pose.heading) },
    speedMps: speed,
    drivetrain: state.robot.drivetrain,
    fieldCentric: state.fieldCentric,
    target: `${state.alliance} hive, ${state.hive[state.alliance]} cell`,
    rangeIn: mToIn(Math.hypot(target.x - exit.x, target.z - exit.z)),
    bearingErrDeg: rad2deg(bearingErr),
    turretOk,
    hoodDeg: l.elevationDeg,
    requiredSpeed: required,
    requiredRpm: required !== undefined ? rpmForExitSpeed(l, required) : undefined,
    rpmOk: required !== undefined && rpmForExitSpeed(l, required) <= l.maxRpm,
    currentRpm: l.rpm,
    currentSpeed: exitSpeed(l),
    hit: shot?.hit,
    aimed: turretOk,
    heightErrorIn: shot ? mToIn(shot.heightError) : undefined,
    entryAngleDeg: shot?.entryAngleRad !== undefined ? rad2deg(shot.entryAngleRad) : undefined,
    bestAngleDeg: scan?.best ? rad2deg(scan.best.elevationRad) : undefined,
    bestSpeed: scan?.best?.speed,
    bestRpm: scan?.best ? rpmForExitSpeed(l, scan.best.speed) : undefined,
    flightTime: flight,
    apexIn: apex !== undefined ? mToIn(apex) : undefined,
    pHit: mc?.pHit, pLo: mc?.lo, pHi: mc?.hi, mcN: mc?.n, meanMissIn: mc ? mToIn(mc.meanMissM) : undefined,
    actualHit: actualShot?.hit,
    shotsFired, shotsHit,
    tags: lastTags,
    cameraName: selected?.mount.name ?? "none",
    modelStatus: { box: "procedural box", loading: "loading goBILDA CAD…", loaded: "goBILDA CAD", failed: "CAD not found → box (see README)" }[robot.modelStatus] + (link.connected ? ` · runtime ${link.status}${link.currentOpMode ? " " + link.currentOpMode : ""}` : ""),
  });

  // render main view
  let cam: THREE.Camera = orbitCam;
  controls.enabled = state.view === "orbit" && !dragCam;
  if (state.view === "orbit") { controls.update(); }
  else if (state.view === "top") cam = topCam;
  else if (state.view === "chase") {
    const back = robotToWorld(state.pose, -1.6, 0);
    chaseCam.position.lerp(new THREE.Vector3(back.x, 1.1, back.z), 0.15);
    const ahead = robotToWorld(state.pose, 1.0, 0);
    chaseCam.lookAt(ahead.x, 0.3, ahead.z);
    cam = chaseCam;
  } else if (state.view === "robot" && selected) cam = selected.cam;
  currentCamera = cam;
  const showGizmos = cam !== selected?.cam;
  robot.cameraGizmos.visible = showGizmos;
  robot.launcherMarker.visible = showGizmos;
  renderer.render(scene, cam);

  // PiP: every enabled camera gets an inset (except the one filling the main view)
  const pipCams = state.pip ? camInfos.filter((c) => c.enabled && !(state.view === "robot" && c.selected)).slice(0, 2) : [];
  ensurePips(pipCams.length);
  pips.forEach((p, i) => {
    const c = pipCams[i];
    p.el.classList.toggle("hidden", !c);
    if (!c) { p.camId = undefined; return; }
    p.camId = c.mount.id;
    p.el.classList.toggle("selected", c.selected);
    if (p.el.clientWidth && (p.canvas.width !== p.el.clientWidth || p.canvas.height !== p.el.clientHeight)) p.renderer.setSize(p.el.clientWidth, p.el.clientHeight, false);
    robot.cameraGizmos.visible = false;
    robot.launcherMarker.visible = false;
    overlays.group.visible = false;
    p.renderer.render(scene, c.cam);
    overlays.group.visible = true;
    robot.launcherMarker.visible = true;
    p.label.textContent = `${c.mount.name} · ${c.intr.width}x${c.intr.height} · ${(c.intr.hfov * 180 / Math.PI).toFixed(0)}°x${(c.intr.vfov * 180 / Math.PI).toFixed(0)}°`;
  });

  if (analysisTick % 120 === 0) saveState(state);
  requestAnimationFrame(frame);
}
// debugging hook for scripts / console
(window as any).__twin = { state, orbitCam, controls, robot, scene, flying, link, actuatorModel, input, stats: () => ({ shotsFired, shotsHit }) };
let lastTags: HudData["tags"] = [];
let pendingFires = 0;
let lastTagsByCam: SensorPacket["tags"] = {};
let lastYawRate = 0;
// Sensors go out on a fixed timer, not per render frame, so gamepad presses and encoder updates reach the
// OpMode at 50 Hz even when the page renders slowly (background tab, software GL).
window.setInterval(() => {
  if (!link.connected) return;
  const g = input.gamepads();
  link.sendSensors({
    type: "sensors",
    motors: motorSensors(actuatorModel, state.hardware),
    imu: { yaw: rad2deg(wrapAngle(state.pose.heading - imuYawRef)), pitch: 0, roll: 0, yawRate: rad2deg(lastYawRate) },
    distances: {},
    tags: lastTagsByCam,
    gamepad1: g.g1,
    gamepad2: g.g2,
    battery: 12.6,
  });
}, 20);
let actualCache: { key: string; shot?: ShotResult } = { key: "" };
function computeActual(exit: Vec3, frame: CellFrame, dir: { x: number; z: number }): ShotResult | undefined {
  const l = state.robot.launcher;
  const key = JSON.stringify([exit.x.toFixed(3), exit.y.toFixed(3), exit.z.toFixed(3), dir.x.toFixed(4), dir.z.toFixed(4), l.rpm, l.elevationDeg, l.wheelDiameterM, l.efficiency, l.spinFraction, state.ballKind, state.drag, state.alliance, state.hive]);
  if (key === actualCache.key) return actualCache.shot;
  const vel = velocityFrom(exitSpeed(l), (l.elevationDeg * Math.PI) / 180, dir);
  const shot = evaluateVelocity({ ball: ballProps(), launchPos: exit, target: aimPoint(frame, 0.05), frame, spin: spinRate(l) }, vel);
  actualCache = { key, shot };
  return shot;
}
let mcCache: { key: string; mc?: MonteCarlo; at: number } = { key: "", at: 0 };
function computeMonteCarlo(exit: Vec3, frame: CellFrame, dir: { x: number; z: number }): MonteCarlo | undefined {
  const l = state.robot.launcher;
  const q = (v: number) => Math.round(v * 50) / 50; // 2 cm
  const key = JSON.stringify([q(exit.x), q(exit.y), q(exit.z), Math.round(Math.atan2(dir.x, dir.z) * 57.3), l.rpm | 0, l.elevationDeg, l.wheelDiameterM, l.efficiency, l.spinFraction, state.ballKind, state.drag, state.alliance, state.hive, state.noise, state.monteCarloN]);
  if (key === mcCache.key) return mcCache.mc;
  const now = performance.now();
  if (now - mcCache.at < 120) return mcCache.mc; // throttle while driving
  const nominal = { speed: exitSpeed(l), elevationRad: (l.elevationDeg * Math.PI) / 180, dirXZ: dir, spin: spinRate(l) };
  const mc = monteCarlo({ ball: ballProps(), launchPos: exit, target: aimPoint(frame, 0.05), frame, spin: spinRate(l) }, nominal, state.noise, state.monteCarloN, 7);
  mcCache = { key, mc, at: now };
  return mc;
}
let reachKey = "";
let reachMap: ReachMap | undefined;
function updateReachMap(frame: CellFrame) {
  if (!state.overlays.reach) { if (reachKey) { reachKey = ""; overlays.setReachMap(undefined); } return; }
  const l = state.robot.launcher;
  const key = JSON.stringify([l.wheelDiameterM, l.maxRpm, l.efficiency, l.elevationDeg, l.elevationMinDeg, l.elevationMaxDeg, l.exitHeightM, l.spinFraction, state.ballKind, state.drag, state.alliance, state.hive]);
  if (key === reachKey) return;
  reachKey = key;
  reachMap = computeReachability(frame, l, ballProps(), 6);
  overlays.setReachMap(reachMap);
}
requestAnimationFrame(frame);
