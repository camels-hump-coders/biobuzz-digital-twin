import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildField } from "./field/buildField";
import { aimPoint, upCellFrame, type CellFrame, type Vec3 } from "./field/hive";
import { BALL, FIELD, m } from "./field/fieldSpec";
import { RobotObject, intrinsicsFor } from "./robot/robot";
import { Input } from "./sim/input";
import { commandToVelocity, stepPose, robotToWorld, headingToward, type DriveParams, type Obstacle } from "./sim/drive";
import { defaultScriptedRobots, stepScripted } from "./sim/opponents";
import { Overlays } from "./ui/overlays";
import { Panel } from "./ui/panel";
import { Hud, type HudData } from "./ui/hud";
import { loadState, saveState, type AppState } from "./state";
import { evaluateShot, evaluateVelocity, scanElevations, solveSpeedForElevation, type ShotResult } from "./ballistics/solver";
import { exitSpeed, rpmForExitSpeed, spinRate } from "./ballistics/launcher";
import { computeReachability, type ReachMap } from "./ballistics/reachability";
import { simulate, velocityFrom } from "./ballistics/projectile";
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

const pipCanvas = document.getElementById("pipcanvas") as HTMLCanvasElement;
const pipRenderer = new THREE.WebGLRenderer({ canvas: pipCanvas, antialias: true });
pipRenderer.setPixelRatio(1);
pipRenderer.outputColorSpace = THREE.SRGBColorSpace;
const pipEl = document.getElementById("pip")!;
const pipLabel = document.getElementById("piplabel")!;

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
interface FlyingBall { mesh: THREE.Mesh; samples: ReturnType<typeof simulate>; t0: number; hit: boolean; }
const flying: FlyingBall[] = [];
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
  if (what === "sim") { field.setHiveState({ alliance: "red", upCell: state.hive.red }); field.setHiveState({ alliance: "blue", upCell: state.hive.blue }); robot.setPose(state.pose); }
  Object.assign(overlays.show, state.overlays);
  saveState(state);
}
panel = new Panel(state, onChange);
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
  const pw = pipEl.clientWidth, ph = pipEl.clientHeight;
  pipRenderer.setSize(pw, ph, false);
}
window.addEventListener("resize", resize);
resize();

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
  const vel = velocityFrom(exitSpeed(l), (l.elevationDeg * Math.PI) / 180, dirXZ);
  const bp = ballProps();
  const samples = simulate(bp, { pos: exit, vel, spin: spinRate(l) }, { maxTime: 4 });
  const frame = targetFrame();
  const r = evaluateVelocity({ ball: bp, launchPos: exit, target: aimPoint(frame), frame, spin: spinRate(l) }, vel);
  const color = state.ballKind === "pollen" ? BALL.pollen.color : state.alliance === "red" ? BALL.nectarRed.color : BALL.nectarBlue.color;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(bp.diameterM / 2, 20, 14), new THREE.MeshStandardMaterial({ color, roughness: 0.45 }));
  mesh.castShadow = true;
  scene.add(mesh);
  // stop the ball at the opening plane if it hits, so it visibly lands in the cell
  let cut = samples;
  if (r.hit && r.crossing) {
    const idx = samples.findIndex((s) => { const d = (s.pos.x - frame.openingCenter.x) * frame.normal.x + (s.pos.y - frame.openingCenter.y) * frame.normal.y + (s.pos.z - frame.openingCenter.z) * frame.normal.z; return d <= 0; });
    if (idx > 0) cut = samples.slice(0, idx + 1);
  }
  flying.push({ mesh, samples: cut, t0: performance.now() / 1000, hit: r.hit });
  shotsFired++;
  if (r.hit) shotsHit++;
}

function updateFlying() {
  const now = performance.now() / 1000;
  for (let i = flying.length - 1; i >= 0; i--) {
    const f = flying[i];
    const t = Math.max(0, now - f.t0);
    const last = f.samples[f.samples.length - 1];
    if (t > last.t + 2.5) { f.mesh.removeFromParent(); flying.splice(i, 1); continue; }
    const idx = Math.min(f.samples.length - 1, Math.floor(t / 0.002));
    const s = f.samples[idx];
    f.mesh.position.set(s.pos.x, s.pos.y, s.pos.z);
    if (idx === f.samples.length - 1 && !f.hit) f.mesh.position.y = Math.max(f.mesh.position.y, (f.mesh.geometry as THREE.SphereGeometry).parameters.radius);
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
  if (actions.aim || state.aimRequest) {
    state.aimRequest = false;
    const ex = robot.exitPoint();
    const tfr = targetFrame();
    const ap = aimPoint(tfr, 0.05);
    // heading such that the launcher (at its turret centre) points at the target
    const mid = (state.robot.launcher.turretMinDeg + state.robot.launcher.turretMaxDeg) / 2;
    state.pose = { ...state.pose, heading: headingToward({ x: ex.x, z: ex.z }, ap) - (mid * Math.PI) / 180 };
    robot.setPose(state.pose);
  }
  const dp = driveParams();
  const vel = commandToVelocity(cmd, state.pose, dp);
  const others: Obstacle[] = state.opponents ? scripted.map((s) => ({ xMin: s.pose.x - s.footprint.widthM / 2, xMax: s.pose.x + s.footprint.widthM / 2, zMin: s.pose.z - s.footprint.lengthM / 2, zMax: s.pose.z + s.footprint.lengthM / 2 })) : [];
  state.pose = stepPose(state.pose, vel, dt, { lengthM: state.robot.lengthM, widthM: state.robot.widthM }, [ { xMin: -m(49.46) / 2, xMax: m(49.46) / 2, zMin: -m(38.95) / 2, zMax: m(38.95) / 2 }, ...others ]);
  robot.setPose(state.pose);

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
  const bearingErr = wrapAngle(wantHeading - state.pose.heading); // + means target is to the left
  const turretOk = rad2deg(bearingErr) >= l.turretMinDeg - 0.5 && rad2deg(bearingErr) <= l.turretMaxDeg + 0.5;
  // launcher yaw: if turret can cover, aim exactly; otherwise fire along robot heading (+ turret limit)
  const turretYaw = clamp(bearingErr, (l.turretMinDeg * Math.PI) / 180, (l.turretMaxDeg * Math.PI) / 180);
  const fireHeading = state.pose.heading + turretYaw;
  const fireDir = { x: -Math.sin(fireHeading), z: -Math.cos(fireHeading) };
  // the analysed arc is always toward the target (what the robot would do if aimed); the fired ball goes where the launcher points
  const { shot, scan, required } = computeShot(exit, tf);
  robot.launcherMarker.rotation.y = -turretYaw * 0 + turretYaw; // local +Y rotation = yaw left
  if (actions.launch) launch(exit, fireDir);
  updateFlying();

  // overlays
  updateReachMap(tf);
  overlays.setTrajectory(shot, ballProps().diameterM / 2, turretOk);
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
    shotsFired, shotsHit,
    tags: lastTags,
    cameraName: selected?.mount.name ?? "none",
    modelStatus: { box: "procedural box", loading: "loading goBILDA CAD…", loaded: "goBILDA CAD", failed: "CAD not found → box (see README)" }[robot.modelStatus],
  });

  // render main view
  let cam: THREE.Camera = orbitCam;
  controls.enabled = state.view === "orbit";
  if (state.view === "orbit") { controls.update(); }
  else if (state.view === "top") cam = topCam;
  else if (state.view === "chase") {
    const back = robotToWorld(state.pose, -1.6, 0);
    chaseCam.position.lerp(new THREE.Vector3(back.x, 1.1, back.z), 0.15);
    const ahead = robotToWorld(state.pose, 1.0, 0);
    chaseCam.lookAt(ahead.x, 0.3, ahead.z);
    cam = chaseCam;
  } else if (state.view === "robot" && selected) cam = selected.cam;
  const showGizmos = cam !== selected?.cam;
  robot.cameraGizmos.visible = showGizmos;
  renderer.render(scene, cam);

  // PiP
  const showPip = state.pip && !!selected && state.view !== "robot";
  pipEl.classList.toggle("hidden", !showPip);
  if (showPip && selected) {
    robot.cameraGizmos.visible = false;
    overlays.group.visible = false;
    pipRenderer.render(scene, selected.cam);
    overlays.group.visible = true;
    pipLabel.textContent = `${selected.mount.name} · ${selected.intr.width}x${selected.intr.height} · ${(selected.intr.hfov * 180 / Math.PI).toFixed(0)}°x${(selected.intr.vfov * 180 / Math.PI).toFixed(0)}°`;
  }

  if (analysisTick % 120 === 0) saveState(state);
  requestAnimationFrame(frame);
}
let lastTags: HudData["tags"] = [];
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
