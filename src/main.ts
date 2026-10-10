import "./posthog";
import { allianceDriveHeading } from "./sim/drive";
import * as THREE from "three";
import { camelsHumpHardwareConfig } from "./runtime/hardwareConfig";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildField } from "./field/buildField";
import { buildVenue } from "./field/buildVenue";
import { aimPoint, hiveTiltAngle, upCellFrame, type Alliance, type CellFrame, type CellSide, type Vec3 } from "./field/hive";
import { HitMapJob, hitMapLauncherKey } from "./ballistics/hitmap";
import { BallisticsOffload } from "./ballistics/offload";
import type { CameraMount } from "./robot/robotSpec";
import { resolveContact, type ContactBody } from "./sim/contact";
import { PinTracker, PIN_LIMIT_S } from "./sim/pinning";
import { startPose } from "./sim/starts";
import { computeBindings, mergeOverrides, parseBindings, twinKnobs } from "./runtime/bindings";
import { Recorder, type Run, type Sample, type SceneSnapshot } from "./runtime/recorder";
import type { ScriptedRobot } from "./sim/opponents";
import { Perf } from "./ui/perf";
import { setupUpdates } from "./pwa";
import { BALL, FIELD, m, ZONES } from "./field/fieldSpec";
import { RobotObject, intrinsicsFor } from "./robot/robot";
import { Input } from "./sim/input";
import { commandToVelocity, stepPose, robotToWorld, headingToward, fieldObstacles, forwardVector, maxYawRate, type DriveParams, type Obstacle, type Pose, WALL_MU } from "./sim/drive";
import { defaultScriptedRobots, stepScripted } from "./sim/opponents";
import type { Footprint } from "./sim/drive";
import type { RobotSpec } from "./robot/robotSpec";
import { Overlays } from "./ui/overlays";
import { Panel } from "./ui/panel";
import { MatchScoreView } from "./ui/matchScore";
import { Workspace } from "./ui/workspace";
import { Hud, type HudData } from "./ui/hud";
import { LOCAL_KEYS, hydrateState, loadState, saveState, serializeSettings, setPersistence, settingsDiffPaths, type AppState } from "./state";
import { evaluateShot, evaluateVelocity, scanElevations, type ShotResult, solveSpeedAdaptive } from "./ballistics/solver";
import { exitSpeed, rpmForExitSpeed, spinRate } from "./ballistics/launcher";
import { ReachJob } from "./ballistics/reachability";
import { perturb, rng, type MonteCarlo } from "./ballistics/dispersion";
import { drainImpacts, stepBall, type LiveBall } from "./sim/ballPhysics";
import { MatchAudio, WebAudioSynth } from "./sim/audio";
import { TIERS } from "./sim/aiTiers";
import { Match, type Agent } from "./sim/match";
import { RuntimeLink, type SensorPacket } from "./runtime/link";
import { createActuatorModel, stepActuators, motorSensors } from "./runtime/actuators";
import { createFeederState, stepFeeder, transitSeconds, type FeederState } from "./sim/feeder";
import { FrameCadence, LatencyQueue, PERCEPTION_LEVELS, UNSUPPORTED_PERCEPTION, applyFaults } from "./runtime/visionFaults";
import { GOBILDA_5203_312, PHYSICS_PROFILES, SCRUB_MU_BAND, breakawayCommands, motorSpecFor } from "./sim/drivePhysics";
import { derivePersisted, effectiveConfig } from "./runtime/effectiveConfig";
import { parseCalLines, speedForRange, type FlightModel } from "./ballistics/calibration";
import { isSchemaFile, schemaFor, schemaPathFor, validateAll } from "./runtime/assetSchema";
import { applyOverrides, exportChangedAssets } from "./runtime/assetExport";
import { Scoreboard, LOADING_ZONE, ballInGarden, describeScore, inZone, type RobotState } from "./sim/scoring";
import { inferDevice, deviceHints } from "./runtime/hardwareConfig";
import { buildDetections } from "./runtime/apriltags";
import { analyseTags as analyseTagsFor } from "./camera/robotCamera";
import { velocityFrom } from "./ballistics/projectile";
import { analyseTags, cameraPoseOf } from "./camera/robotCamera";
import { IN, clamp, mToIn, rad2deg, wrapAngle } from "./util/units";
import { clonePreset, ROBOT_PRESETS } from "./robot/presets";

// ?ci=1: headless test-bed mode (pnpm twin-test), see the block below and the render loop
const ciMode = new URLSearchParams(location.search).get("ci") === "1";
const state: AppState = loadState();
// ?ci=1 (pnpm twin-test): a bare-bones view for the test bed only. Everything that is a picture, not physics, goes:
// stadium, shadows, every overlay and the hit map, camera insets, CAD chassis (the footprint, mounts and launcher come
// from the spec either way). These are forced on this page and never saved, so the human's shared settings are untouched.
if (ciMode) {
  setPersistence(false);
  state.quality = "performance"; state.opponentsCad = false; state.showPerf = false;
  for (const k of Object.keys(state.overlays) as (keyof AppState["overlays"])[]) state.overlays[k] = false;
}
// Visual quality (a property of this machine, never of the project file): "performance" turns off everything that is a
// picture and not physics; "auto" measures the first seconds of the session and decides; the decision is remembered for
// the session only, so a fast machine never inherits a Chromebook's choice through the shared settings.
let autoQuality: "full" | "performance" | undefined;
let autoFps: number | undefined;
let qualityNotice: { text: string; untilMs: number } | undefined;
const perfMode = () => ciMode || state.quality === "performance" || (state.quality === "auto" && autoQuality === "performance");
const wheelSpinOn = () => state.wheelSpin && !perfMode();
let appliedPerf: boolean | undefined;
// `pnpm sim` opens the page with ?runtime=1 so the twin connects to the host straight away
if (new URLSearchParams(location.search).get("runtime") === "1") state.runtimeEnabled = true;
const launchedHostPort = new URLSearchParams(location.search).get('hostPort');
if (new URLSearchParams(location.search).get('sim') === '1' && launchedHostPort && /^\d+$/.test(launchedHostPort) && +launchedHostPort > 0 && +launchedHostPort <= 65535) state.runtimeUrl = `ws://127.0.0.1:${launchedHostPort}`;

// ---------- renderer & scenes
const canvas = document.getElementById("view") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
// ?ci=1: headless test-bed mode (pnpm twin-test). Software GL renders a frame in ~200 ms, which would starve the
// simulation loop; render the view only every few ticks at low resolution and drive the loop with a timer so the
// physics, sensors and the OpMode see the same cadence as on a real display.
renderer.setPixelRatio(ciMode ? 0.25 : Math.min(devicePixelRatio, 2)); // re-applied by applyQuality()
renderer.shadowMap.enabled = !ciMode;
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
    const size = document.createElement("button"); size.className = "pip-size";
    const applySize = () => {
      const large = localStorage.getItem("biobuzz-camera-large") === "true";
      pipsEl.classList.toggle("large", large);
      pipsEl.querySelectorAll<HTMLButtonElement>(".pip-size").forEach(b => { b.textContent = large ? "Smaller" : "Enlarge"; b.setAttribute("aria-label", large ? "Make camera previews smaller" : "Enlarge camera previews"); b.setAttribute("aria-pressed", String(large)); });
    };
    size.addEventListener("click", e => { e.stopPropagation(); localStorage.setItem("biobuzz-camera-large", String(!pipsEl.classList.contains("large"))); applySize(); });
    const position = document.createElement("button"); position.className = "pip-position";
    const applyPosition = () => {
      const upperRight = localStorage.getItem("biobuzz-camera-position") !== "bottom-left";
      pipsEl.classList.toggle("upper-right", upperRight);
      pipsEl.querySelectorAll<HTMLButtonElement>(".pip-position").forEach(b => {
        b.textContent = upperRight ? "↙ Bottom left" : "↗ Upper right";
        b.setAttribute("aria-label", upperRight ? "Move camera previews to bottom left" : "Move camera previews to upper right");
        b.title = upperRight ? "Currently upper right" : "Currently bottom left";
      });
    };
    position.addEventListener("click", e => {
      e.stopPropagation();
      localStorage.setItem("biobuzz-camera-position", pipsEl.classList.contains("upper-right") ? "bottom-left" : "upper-right");
      applyPosition();
    });
    el.append(canvas, label, size, position);
    pipsEl.append(el);
    applySize();
    applyPosition();
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
sun.castShadow = !ciMode;
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
const venueFx = buildVenue();
venueFx.group.visible = state.stadium && !perfMode();
scene.add(venueFx.group);

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
// saved toggles: the player's CAD is still loading at this point, so the flag is read when the load lands
robot.wheelSpin = wheelSpinOn();
applyScriptedModels();
applyQuality(true);

// ---------- match dynamics (inventories, pickup, flowers, both hives)
const flying: LiveBall[] = [];
const match = new Match(scene, field, flying, state.hive, () => state.tipMassG / 1000, () => state.autoTip, () => state.aiTier);
// competition sounds: synthesised, edge-detected from the world each frame; never created in headless (?ci=1) runs
const synth = ciMode ? undefined : new WebAudioSynth(() => state.audio);
const audio = synth ? new MatchAudio(synth, () => state.audio) : undefined;
function makeAgent(id: string, alliance: Alliance, group: THREE.Group, caps: Agent["caps"], footprint: Agent["footprint"], intakeGeom: Agent["intakeGeom"]): Agent {
  const carryGroup = new THREE.Group();
  carryGroup.name = "carry";
  group.add(carryGroup);
  return { id, alliance, pose: { x: 0, z: 0, heading: 0 }, inventory: { pollen: Math.min(4, caps.capacity), nectar: 0 }, caps, intakeActive: false, footprint: { ...footprint }, intakeGeom: { ...intakeGeom }, intake: { x: 0, z: 0 }, lastPick: 0, lastFlowerGrip: -10, carryGroup };
}
/** the chassis outline for driving and pushing: the intake end is a low deck that slides under a FLOWER's mid ring */
function footprintOf(r: RobotSpec): Footprint { return { lengthM: r.lengthM, widthM: r.widthM, notch: { side: r.intake.side, depthM: r.intake.deckDepthM ?? 0.07 } }; }
const playerAgent = makeAgent("player", state.alliance, robot.group, { capacity: state.capacity, pollen: state.canPollen, nectar: state.canNectar }, footprintOf(state.robot), state.robot.intake);
// scripted robots collect through a front mouth about two thirds of their width
const scriptedAgents = scripted.map((s, i) => makeAgent(s.name, "red", scriptedObjs[i].group, { capacity: 4, pollen: true, nectar: true }, s.footprint, { side: "front", widthM: s.footprint.widthM * 0.65, kind: "brushes" }));
const allAgents = [playerAgent, ...scriptedAgents];
const scoreboard = new Scoreboard();
const matchScoreView = new MatchScoreView();
function scoreRobots(): RobotState[] { return (state.opponents ? allAgents : [playerAgent]).map((a) => ({ id: a.id, alliance: a.alliance, pose: a.pose, footprint: a.footprint })); }
function allianceScore(a: Alliance) {
  let cell = match.hives[a].stagedNectar, garden = 0;
  for (const f of flying) { if (f.inCell && (f as any).cellOf === a) cell++; else if (!f.carried && f.pos.y - f.radius <= 0.05 && ballInGarden(f.pos.x, f.pos.z, f.radius, a)) garden++; }
  return scoreboard.score(a, scoreRobots(), match.hives[a].tips, cell, garden);
}
/** Partner is on our alliance, the two opponents on the other; colours and starting corners follow. */
function assignAlliances() {
  const ours: Alliance = state.alliance, theirs: Alliance = ours === "red" ? "blue" : "red";
  scripted.forEach((s, i) => {
    const a: Alliance = s.name === "Partner" ? ours : theirs;
    scriptedAgents[i].alliance = a;
    const spec = scriptedObjs[i].spec;
    const color = a === "red" ? (s.name === "Partner" ? 0xd44a4a : 0xc83a3a) : s.name === "Partner" ? 0x4a6ad4 : 0x6a8ae8;
    if (spec.color !== color || spec.look?.color !== color) { spec.color = color; spec.look = { color }; scriptedObjs[i].applySpec({ ...spec, color, look: { color } }); }
  });
  // when we play blue, the field is mirrored for the scripted robots: start corners and patrol loops flip
  if (ours !== scriptedSide) {
    scriptedSide = ours;
    for (const s of scripted) {
      s.pose = { x: -s.pose.x, z: -s.pose.z, heading: s.pose.heading + Math.PI };
      s.waypoints = s.waypoints.map((w) => ({ x: -w.x, z: -w.z }));
      s.target = undefined; (s as any).brain = undefined;
    }
  }
}
let scriptedSide: Alliance = "red";
assignAlliances();

// ---------- match flow: setup (parked at start) -> running (clock, scripted robots act) -> stopped
const MATCH_SECONDS = 150; // 0:30 auto + 2:00 teleop
const AUTO_SECONDS = 30;
const TRANSITION_SECONDS = 8; // AUTO→TELEOP transition, its own countdown (does not consume the 2:30)
state.matchPhase = "setup"; state.matchClock = MATCH_SECONDS;
function startKeyOf(s: ScriptedRobot): "partner" | "opp1" | "opp2" { return s.name === "Partner" ? "partner" : s.name === "Opponent 1" ? "opp1" : "opp2"; }
function parkScripted() {
  for (const s of scripted) { s.pose = startPose(state.starts, startKeyOf(s), state.alliance, state.hive); s.prevPose = { ...s.pose }; s.target = undefined; (s as any).brain = undefined; s.backoff = undefined; s.index = 0; s.dwellLeft = 0; }
  scriptedObjs.forEach((o, i) => o.setPose(scripted[i].pose));
}
/** Everything back to match start as the rules set the field (Event Field Setup Guide §11.1): red hive with its
 * audience cell up, blue hive with its scoring cell up, 3 NECTAR staged in each raised cell, flowers and gardens full,
 * 4 POLLEN preloaded, every robot on its starting mark, clock at 2:30, fouls cleared. */
function resetBoard() {
  if (recorder.cursor !== undefined) { recorder.cursor = undefined; panel.refreshTimeline(); }
  state.hive.red = "audience"; state.hive.blue = "scoring"; // mutate in place: the Match holds this object
  match.reset(allAgents);
  shotsFired = 0; shotsHit = 0;
  pins.reset();
  scoreboard.reset();
  state.pose = startPose(state.starts, "you", state.alliance, state.hive);
  robot.setPose(state.pose);
  parkScripted();
  state.matchPhase = "setup"; state.matchClock = MATCH_SECONDS; state.matchTransition = undefined;
}
function startMatch() { if (recorder.cursor !== undefined) { recorder.cursor = undefined; panel.refreshTimeline(); } if (state.matchPhase === "setup" || state.matchPhase === "stopped") { if (state.matchPhase === "stopped" && (state.matchClock ?? 0) <= 0) resetBoard(); state.matchPhase = "running"; } }
function stopMatch() { if (state.matchPhase === "running") state.matchPhase = "stopped"; }
parkScripted();

// ---------- cameras
const orbitCam = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
orbitCam.position.set(state.alliance === "red" ? -5.28 : 5.28, 2.6, 0);
const controls = new OrbitControls(orbitCam, canvas);
controls.target.set(0, 0.5, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.enableDamping = true;
const topCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50);
topCam.position.set(0, 10, 0);
topCam.up.set(state.alliance === "red" ? 1 : -1, 0, 0);
topCam.lookAt(0, 0, 0);
const chaseCam = new THREE.PerspectiveCamera(60, 1, 0.05, 100);
let cameraAlliance = state.alliance;
function orientToAlliance() {
  cameraAlliance = state.alliance;
  controls.target.set(0, 0.5, 0);
  orbitCam.position.set(state.alliance === "red" ? -5.28 : 5.28, 2.6, 0);
  controls.update();
  topCam.up.set(state.alliance === "red" ? 1 : -1, 0, 0);
  topCam.lookAt(0, 0, 0);
}
orientToAlliance();

// ---------- flying balls
let shotsFired = 0, shotsHit = 0;

// ---------- UI
const input = new Input();
const hud = new Hud();
let panel: Panel;

/** Other robots: box or the CAD chassis (the player's model, or the mecanum StarterBot when the player is a box). */
function applyScriptedModels() {
  robot.setWheelSpin(wheelSpinOn()); // the toggle arrives as a "view" change, not a robot change
  const model = state.opponentsCad ? (state.robot.model === "box" ? "starterbot-mecanum" : state.robot.model) : "box";
  scriptedObjs.forEach((o) => {
    o.setWheelSpin(wheelSpinOn());
    const preset = Object.values(ROBOT_PRESETS).find((p) => p.model === model);
    if (o.spec.model !== model) o.applySpec({ ...o.spec, model, modelYawDeg: model === "box" ? 0 : (preset?.modelYawDeg ?? state.robot.modelYawDeg ?? 0) });
  });
}
/** Push the visual-quality mode into everything it touches: pixel ratio, shadows, CAD vs box, wheel spin. Idempotent. */
function applyQuality(force = false) {
  const perf = perfMode();
  if (!force && appliedPerf === perf) return;
  appliedPerf = perf;
  renderer.setPixelRatio(ciMode ? 0.25 : perf ? Math.min(devicePixelRatio, 1) : Math.min(devicePixelRatio, 2));
  sun.castShadow = !perf;
  const cadBefore = RobotObject.renderCad;
  RobotObject.renderCad = !perf;
  if (cadBefore !== RobotObject.renderCad) { robot.applySpec(state.robot); scriptedObjs.forEach((o) => o.applySpec({ ...o.spec })); }
  applyScriptedModels();
}
function applyRobotSpec() {
  robot.setWheelSpin(wheelSpinOn());
  robot.applySpec(state.robot);
  applyScriptedModels();
  if (!state.robot.cameras.some((c) => c.id === state.selectedCameraId)) state.selectedCameraId = state.robot.cameras[0]?.id ?? "";
}
function onChange(what: Parameters<ConstructorParameters<typeof Panel>[1]>[0]) {
  if (cameraAlliance !== state.alliance) orientToAlliance();
  if (what === "reset") { applyRobotSpec(); if (link.connected) link.sendHardware(hardwareDevices(), hardwareHints()); playerAgent.caps = { capacity: state.capacity, pollen: state.canPollen, nectar: state.canNectar }; }
  if (what === "robot" || what === "cameras" || what === "launcher") applyRobotSpec();
  if ((what === "launcher" || what === "robot" || what === "reset") && !knobsFlushing) {
    // the Commanded RPM field or a preset wrote a new speed straight into the launcher: take it as the command and let
    // the wheel spin there from where it actually is (a preset change starts from rest)
    const l = state.robot.launcher;
    if (l.rpm !== lastActualRpm) { rpmCmd = l.rpm; l.rpm = what === "launcher" ? lastActualRpm : 0; }
  }
  if (what === "runtime") syncRuntime();
  if (what === "hardware" && link.connected) link.sendHardware(hardwareDevices(), hardwareHints());
  if (what === "assets" && link.connected) link.sendAssetOverrides(mergeOverrides(state.assetOverrides, link.bound.overrides), state.persistedAssets);
  if (what === "robot" || what === "cameras" || what === "launcher" || what === "hardware" || what === "sim" || what === "reset") syncBindings();
  if (what === "view") { applyQuality(); venueFx.group.visible = state.stadium && !perfMode(); }
  if (what === "sim" || what === "view") applyScriptedModels();
  if (what === "sim" || what === "reset") syncTagCovers();
  if (what === "sim") {
    for (const a of ["red", "blue"] as Alliance[]) if (match.hives[a].upCell !== state.hive[a] && !match.hives[a].tipping) match.resetHive(a);
    playerAgent.alliance = state.alliance;
    assignAlliances();
    playerAgent.caps = { capacity: state.capacity, pollen: state.canPollen, nectar: state.canNectar };
    if (state.resetMatchRequest) { state.resetMatchRequest = false; resetBoard(); }
    if (state.placeAtStartRequest) { // quick-bar start buttons: back on the mark, field and clock untouched
      state.placeAtStartRequest = false;
      state.pose = startPose(state.starts, "you", state.alliance, state.hive);
      if (state.matchPhase !== "running") parkScripted();
    }
    if (state.matchRequest === "start") startMatch(); else if (state.matchRequest === "stop") stopMatch();
    state.matchRequest = undefined;
    robot.setPose(state.pose);
  }
  Object.assign(overlays.show, state.overlays);
  saveState(state);
}
// ---------- virtual runtime link
const link = new RuntimeLink(state.runtimeUrl);
const actuatorModel = createActuatorModel();
/** feeder transit per feeder-role device (ball position in the throat, pulse and launch counts) */
const feeders = new Map<string, FeederState>();
let feederPulses = 0;
/** stall watchdog: how long each drive motor has been commanded without its shaft turning */
const stallFor = new Map<string, number>();
let stallActive = false, stallCount = 0, notMoving: string | undefined;
/** highest |power| TeamCode has commanded on a flywheel-role motor since INIT (or resetPeaks): "the flywheel never spun" is a physical claim */
let flywheelPeak = 0;
/** World truth the harness compares telemetry against (SG-002): horizontal distance from the robot centre and from the
 * launcher exit to the target cell's opening centre, and the bearing of the opening from the launcher's line. */
function worldTruth() {
  const f = targetFrame(), ex = robot.exitPoint();
  const dx = f.openingCenter.x - state.pose.x, dz = f.openingCenter.z - state.pose.z;
  const ex2 = f.openingCenter.x - ex.x, ez2 = f.openingCenter.z - ex.z;
  const fwd = forwardVector(state.pose.heading), launchDir = ((state.robot.launcher.yawOffsetDeg) * Math.PI) / 180;
  const lx = fwd.x * Math.cos(launchDir) - fwd.z * Math.sin(launchDir), lz = fwd.x * Math.sin(launchDir) + fwd.z * Math.cos(launchDir);
  const bearing = Math.atan2(lx * dz - lz * dx, lx * dx + lz * dz);
  return { rangeCentreIn: +(Math.hypot(dx, dz) / IN).toFixed(1), rangeExitIn: +(Math.hypot(ex2, ez2) / IN).toFixed(1), openingHeightIn: +(f.openingCenter.y / IN).toFixed(1), bearingDeg: +rad2deg(bearing).toFixed(1), pose: { xIn: +(state.pose.x / IN).toFixed(1), zIn: +(state.pose.z / IN).toFixed(1), headingDeg: +rad2deg(state.pose.heading).toFixed(1) } };
}
let feederNote: string | undefined;
/** camera-latency fault: delivery queues per webcam device */
const latencyQueues = new Map<string, LatencyQueue>();
const frameCadences = new Map<string, FrameCadence>();
let lastFaultsApplied = "";
/** A loose-ball contact that held the chassis last frame(s): which way is blocked (route forward +1 / back −1) and until
 * when the latch holds (a quarter second after the last refused push, so one free frame cannot creep through it). */
let contactBlock: { fwdSign: 1 | -1; balls: number; untilMs: number; episode: boolean; at: Pose } | undefined;
let lastContactEvent: { fwdSign: 1 | -1; atMs: number } | undefined;
/** The block holds while the chassis is still where the contact held it (it has not backed off 5 mm or turned 10°):
 * otherwise one free frame every quarter second lets the drive creep and the encoders count against a pile that, on
 * the robot, stops the wheels dead. */
const contactHolds = () => !!contactBlock && (performance.now() < contactBlock.untilMs || (Math.hypot(state.pose.x - contactBlock.at.x, state.pose.z - contactBlock.at.z) < 0.005 && Math.abs(wrapAngle(state.pose.heading - contactBlock.at.heading)) < (10 * Math.PI) / 180));
const physicsInput = () => ({ profile: state.physics, massKg: state.robot.massKg ?? 11, block: (contactHolds() ? contactBlock!.fwdSign : 0) as -1 | 0 | 1 });
let imuYawRef = 0; // IMU yaw is reported relative to the heading at connect time
function hardwareDevices() {
  return state.hardware.devices.map((d) => ({ name: d.name, kind: d.kind, ticksPerRev: d.ticksPerRev ?? 537.7, port: d.port ?? 0 }));
}
function hardwareHints() {
  const out: Record<string, { kind: string; port: number; ticksPerRev: number }> = {};
  for (const [name, d] of Object.entries(deviceHints())) out[name] = { kind: d.kind, port: d.port ?? 0, ticksPerRev: d.ticksPerRev ?? 537.7 };
  return out;
}
function syncRuntime() {
  if (state.runtimeEnabled) { if ((link as any).url !== state.runtimeUrl) { link.disconnect(); (link as any).url = state.runtimeUrl; } link.connect(); }
  else link.disconnect();
}
let hardwareSent = false;
link.onMissingDevice = (name, requested) => {
  if (state.hardware.devices.some((d) => d.name === name)) return;
  // the code uses the Camels Hump tank bot's names while the map is another preset (e.g. after a session reset):
  // switch to that preset wholesale, since names, ports, drive polarity and the tank drivetrain go together
  const ch = camelsHumpHardwareConfig();
  const chDrive = ["Left Drive", "Right Drive"];
  if (chDrive.includes(name) && !state.hardware.devices.some((d) => chDrive.includes(d.name))) {
    state.hardware = ch;
    if (state.robotPresetId !== "starterbot6wd") { state.robotPresetId = "starterbot6wd"; state.robot = clonePreset("starterbot6wd"); state.selectedCameraId = state.robot.cameras[0]?.id ?? ""; applyRobotSpec(); }
    if (state.robot.drivetrain !== "tank") state.robot.drivetrain = "tank";
    link.notes.push(`Your code asked for "${name}": loaded the Camels Hump tank bot hardware preset (names, ports, right side mirrored) and set the drivetrain to tank.`);
    if (link.notes.length > 6) link.notes.shift();
    link.sendHardware(hardwareDevices(), hardwareHints());
    saveState(state);
    panel.render();
    return;
  }
  const dev = inferDevice(name, requested, state.hardware.devices);
  state.hardware.devices.push(dev);
  recorder.event(Date.now(), "hardware", `added ${dev.kind} "${name}" because the code asked for it`);
  link.notes.push(`Added "${name}" as ${dev.kind}${dev.role ? ` (role ${dev.role})` : ""}${dev.port !== undefined ? `, port ${dev.port}` : ""} because your code asked for it. Check its role and port in the Hardware map panel.`);
  if (link.notes.length > 6) link.notes.shift();
  link.sendHardware(hardwareDevices(), hardwareHints());
  saveState(state);
  panel.render();
};
/** Re-evaluate TeamCode/twin-bindings.json against the twin's knobs and push the merged overrides to the host. */
let lastBindingsText: string | undefined;
let lastBoundJson = "";
const ignoreBindings = new URLSearchParams(location.search).get("nobind") === "1"; // twin-test "ignoreBindings": run with the asset files as committed
function syncBindings() {
  const text = ignoreBindings ? undefined : link.bindings?.text;
  if (!text) { if (lastBindingsText !== undefined) { lastBindingsText = undefined; link.bound = { overrides: {}, sources: {}, errors: [] }; } return; }
  try { link.bound = computeBindings(parseBindings(text), twinKnobs(state)); }
  catch (e) { link.bound = { overrides: {}, sources: {}, errors: [`twin-bindings.json: ${(e as Error).message}`] }; }
  lastBindingsText = text;
  const json = JSON.stringify(link.bound.overrides);
  if (json !== lastBoundJson) { lastBoundJson = json; if (link.connected) link.sendAssetOverrides(mergeOverrides(state.assetOverrides, link.bound.overrides), state.persistedAssets); panel.render(); }
}
link.onLog = (level, text, millis) => {
  // stack-trace continuation lines belong to the exception line before them
  const last = recorder.events[recorder.events.length - 1];
  if (last && /^\s+at |^Caused by: |^\s*\.\.\. \d+ more/.test(text)) { if (last.text.length < 2000) last.text += "\n" + text.trim(); return; }
  recorder.event(millis, level === "err" || /Exception|Error:/.test(text) ? "error" : "log", text);
  if (text.includes("CAL ")) {
    const recs = parseCalLines(text);
    if (recs.length) {
      const inbox = state.calibration.inbox;
      for (const r of recs) { const i = inbox.findIndex((x) => x.id === r.id); if (i >= 0) inbox[i] = r; else inbox.push(r); }
      saveState(state); panel.render();
    }
    const d = /CAL discard shot=(\d+)/.exec(text);
    if (d) { const i = state.calibration.inbox.findIndex((x) => x.id === +d[1]); if (i >= 0) { state.calibration.inbox.splice(i, 1); saveState(state); panel.render(); } }
  }
};
// ---------- run manifest: the effective robot, physics, perception and TeamCode settings with provenance (handoff G01/G02)
declare const __TWIN_REV__: string;
function buildManifest() {
  // every TeamCode setting with where it came from: bound > manual > persisted (the profile saved on the hub) >
  // packaged, and the keys no source carries (the code's parser fallback decides them), see effectiveConfig.ts
  const { effective, profile } = effectiveConfig(link.assets, state.persistedAssets, state.assetOverrides, link.bound.overrides);
  const r = state.robot;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    twin: { revision: typeof __TWIN_REV__ === "string" ? __TWIN_REV__ : "dev", url: location.href },
    team: link.hostInfo ?? undefined,
    opMode: link.currentOpMode || undefined, runtimeStatus: link.status,
    robot: {
      preset: state.robotPresetId, name: r.name, drivetrain: r.drivetrain, model: r.model, lengthIn: +(r.lengthM / IN).toFixed(2), widthIn: +(r.widthM / IN).toFixed(2), heightIn: +(r.heightM / IN).toFixed(2), massKg: r.massKg,
      wheelDiameterIn: +(r.wheelDiameterM / IN).toFixed(3), wheelRpm: r.wheelRpm, trackWidthIn: +((r.widthM * 0.9) / IN).toFixed(2), wheelbaseIn: +((r.lengthM * 0.75) / IN).toFixed(2),
      intake: { side: r.intake.side, kind: r.intake.kind, widthIn: +(r.intake.widthM / IN).toFixed(2) },
      launcher: { yawOffsetDeg: r.launcher.yawOffsetDeg, elevationDeg: r.launcher.elevationDeg, exitHeightIn: +(r.launcher.exitHeightM / IN).toFixed(2), exitForwardIn: +(r.launcher.exitForwardM / IN).toFixed(2), efficiency: r.launcher.efficiency, maxRpm: r.launcher.maxRpm },
      cameras: r.cameras.map((c) => { const i = intrinsicsFor(c); return { id: c.id, name: c.name, preset: c.presetId, enabled: c.enabled, forwardIn: +(c.forwardM / IN).toFixed(2), leftIn: +(c.leftM / IN).toFixed(2), heightIn: +(c.heightM / IN).toFixed(2), pitchDegDown: c.pitchDeg, yawDeg: c.yawDeg, rollDeg: c.rollDeg, width: i.width, height: i.height, hfovDeg: +rad2deg(i.hfov).toFixed(1), vfovDeg: +rad2deg(i.vfov).toFixed(1), fxPx: +(i.width / 2 / Math.tan(i.hfov / 2)).toFixed(1), fyPx: +(i.height / 2 / Math.tan(i.vfov / 2)).toFixed(1) }; }),
      hardware: { mirroredSide: state.hardware.mirroredSide, devices: state.hardware.devices.map((d) => ({ name: d.name, kind: d.kind, role: d.role, port: d.port, ticksPerRev: d.ticksPerRev, freeRpm: d.freeRpm, fireThreshold: d.fireThreshold, cameraId: d.cameraId })) },
      alliance: state.alliance, startPose: { xIn: +(state.pose.x / IN).toFixed(1), zIn: +(state.pose.z / IN).toFixed(1), headingDeg: +rad2deg(state.pose.heading).toFixed(1) },
    },
    physics: { ...state.physics, breakaway: breakawayNow(), scrubMuBand: state.physics.kind === "tiles" ? SCRUB_MU_BAND : undefined, note: state.physics.kind === "ideal" ? "kinematic drive: no friction, no stall; a command always moves the robot" : `estimated surface model: a turn command below ${Math.round(actuatorModel.breakaway.turn * 100)} % does not move this robot`.replace(/below \d+ %/, `below ${Math.round(breakawayNow().turn * 100)} %`) },
    feed: { ...state.feed, transitAt20PercentS: +transitSeconds(state.feed, 0.2).toFixed(2) },
    perception: { level: state.perception.level, faults: state.perception.level === "faults" ? state.perception.faults : undefined, tagCovers: state.tagCovers, tagNoiseIn: state.tagNoiseIn, note: PERCEPTION_LEVELS.find((l) => l.id === state.perception.level)?.note, unsupported: UNSUPPORTED_PERCEPTION },
    render: ciMode ? "bare-bones (?ci=1): no stadium, shadows, overlays, hit map, camera insets or CAD chassis; physics and sensors unchanged" : `${perfMode() ? "performance" : "full"} visuals (quality ${state.quality}${autoFps !== undefined ? `, ${autoFps} fps measured` : ""}); physics and sensors unchanged`,
    clock: { mode: "wall", note: "TeamCode timers are JVM wall clock; the twin steps physics per browser frame and sends sensors at 50 Hz. Check the run's simulated/wall ratio and packet holds before trusting a timing result." },
    bindings: { file: link.bindings?.path, errors: link.bound.errors, ignored: new URLSearchParams(location.search).get("nobind") === "1" },
    warnings: manifestWarnings(),
    /** persisted vs clean install, missing keys, and whether bindings supply the shot calibration (synthetic) */
    profile,
    effective,
  };
}
/** Configuration smells worth a line in the manifest: a role carried by several devices (a saved map that holds both a
 * stock preset's names and the robot's real names), so a reader knows which device the twin's role lookups may pick. */
function manifestWarnings(): string[] {
  const out: string[] = [];
  const byRole = new Map<string, string[]>();
  for (const d of state.hardware.devices) if (d.role && d.role !== "other") byRole.set(d.role, [...(byRole.get(d.role) ?? []), d.name]);
  for (const [role, names] of byRole) if (names.length > 1) {
    const live = names.filter((n) => actuatorModel.touched.has(n) || Math.abs(link.actuators[n]?.power ?? 0) > 0);
    out.push(`role ${role} is on ${names.length} devices (${names.join(", ")})${live.length ? `; the OpMode drives ${live.join(", ")}` : ""}: remove the ones this robot does not have`);
  }
  return out;
}
/** The breakaway the current robot and profile imply, without waiting for a TeamCode step (panel readout, manifest). */
function breakawayNow(): { straight: number; turn: number } {
  const r = state.robot, dp = driveParams();
  // the drive motors the OpMode actually commands when one is live; otherwise the roles that fit the chassis (a saved
  // hardware map can carry both a tank pair and a stock preset's four corner motors)
  const sides = ["left", "right"], corners = ["frontLeft", "frontRight", "backLeft", "backRight"];
  let drive = state.hardware.devices.filter((d) => d.kind === "motor" && [...sides, ...corners].includes(d.role ?? "") && actuatorModel.touched.has(d.name));
  if (!drive.length) { const pair = state.hardware.devices.filter((d) => d.kind === "motor" && sides.includes(d.role ?? "")); const four = state.hardware.devices.filter((d) => d.kind === "motor" && corners.includes(d.role ?? "")); drive = r.drivetrain === "tank" ? (pair.length ? pair : four) : (four.length ? four : pair); }
  const perSide = Math.max(1, Math.ceil(drive.length / 2));
  const b = breakawayCommands({ massKg: r.massKg ?? 11, trackWidthM: dp.trackWidthM, wheelbaseM: dp.wheelbaseM, wheelRadiusM: r.wheelDiameterM / 2, motorsPerSide: perSide, motor: motorSpecFor(drive[0]?.freeRpm ?? r.wheelRpm, GOBILDA_5203_312) }, state.physics);
  // a mecanum chassis gets the straight breakaway in every direction (no skid-steer scrub is modelled for it)
  return r.drivetrain === "mecanum" ? { straight: b.straight, turn: b.straight } : b;
}
function manifestSummary(): string {
  const r = state.robot; const man = buildManifest(); const n = Object.values(man.effective).reduce((acc, f) => { for (const v of Object.values(f)) acc[v.source] = (acc[v.source] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  return `${state.robotPresetId} ${r.drivetrain} ${(r.lengthM / IN).toFixed(1)}×${(r.widthM / IN).toFixed(1)} in, intake ${r.intake.side}, launcher yaw ${r.launcher.yawOffsetDeg}°, physics ${state.physics.kind} (${state.physics.provenance}), camera ${state.perception.level}${state.tagCovers.length ? ` covers ${state.tagCovers.join(",")}` : ""} · settings: ${n.packaged ?? 0} packaged${n.persisted ? `, ${n.persisted} from the saved hub profile` : ""}, ${n.manual ?? 0} overridden, ${n.bound ?? 0} bound${n.missing ? `, ${n.missing} missing (parser fallback)` : ""} · calibration ${man.profile.calibration}`;
}
function capabilities() {
  return {
    schemaVersion: 1,
    perception: { levels: PERCEPTION_LEVELS.map((l) => l.id), unsupported: UNSUPPORTED_PERCEPTION, faults: ["dropoutProb", "latencyMs", "poseNoiseIn", "misreadIds", "duplicateIds", "blurAboveDps", "minPixels", "fpsCap"], tagCovers: true, timestamps: "frameAcquisitionNanoTime is the frame's true acquisition time (cadence + latency); there is no preview JPEG in the twin, so no second, throttled age exists" },
    physics: { profiles: Object.keys(PHYSICS_PROFILES).concat("custom"), current: true, batterySag: true, stallWatchdog: true, mecanumScrub: false, ballContact: "loose balls squeezed on the wall hold the chassis; tractionMu decides stall vs wheel spin (estimate, not a measured garden pile)", jams: false },
    feed: { transit: true, positionalStroke: true, jams: false },
    clock: { mode: "wall", fixedStep: false, pauseUnderOpMode: false },
    assertions: ["noErrors", "shotsFired", "shotsHit", "launches", "feederPulses", "collectedAtLeast", "footprintInside", "outputsZeroAfterStop", "eventWithin", "noStall", "fouls", "telemetryIncludes", "telemetryFinalIncludes", "telemetrySequence", "movedAtLeastIn", "poseNear", "scoreAtLeast"],
    events: ["status", "error", "log", "button", "shot", "foul", "note", "hardware", "stall", "feed", "launch", "fault", "manifest", "pick", "contact"],
    api: ["manifest", "capabilities", "twin(physics, feed, perception, tagCovers)"],
  };
}
/** Tag covers as world objects: a grey plate over the sticker (the id stays installed underneath). */
function syncTagCovers() {
  for (const mesh of field.tagMeshes) {
    const id = mesh.userData.tagId as number;
    const want = state.tagCovers.includes(id);
    let cover = mesh.getObjectByName("tag-cover") as THREE.Mesh | undefined;
    if (want && !cover) {
      const size = (mesh.geometry as THREE.PlaneGeometry).parameters.width * 1.05;
      cover = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.9, side: THREE.DoubleSide }));
      cover.name = "tag-cover"; cover.position.z = 0.003; mesh.add(cover);
    } else if (!want && cover) { mesh.remove(cover); cover.geometry.dispose(); (cover.material as THREE.Material).dispose(); }
  }
}
// ---------- agent API (host AgentApi.java -> link.onAgent): what only the browser session knows or can do
link.onAgent = async (action, params) => {
  const num = (k: string, d: number) => { const v = params[k]; const n = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : d; };
  switch (action) {
    case "snapshot": {
      const seconds = num("seconds", 30); const to = Date.now(), from = to - seconds * 1000;
      return { contentType: "text/markdown", result: recorder.snapshot({ from, to, context: snapshotContext(), title: `BIOBUZZ twin snapshot · ${link.currentOpMode || "no OpMode"} · last ${seconds} s` }) };
    }
    case "timeline": {
      const seconds = num("seconds", 30); const to = Date.now(), from = to - seconds * 1000;
      return { result: { from, to, samples: recorder.samples.filter((x) => x.t >= from && x.t <= to), events: recorder.eventsBetween(from, to) } };
    }
    case "state": return { result: {
      ...snapshotContext(),
      pose: { xIn: +(state.pose.x / IN).toFixed(2), zIn: +(state.pose.z / IN).toFixed(2), headingDeg: +((state.pose.heading * 180) / Math.PI).toFixed(1) },
      match: { phase: state.matchPhase, clock: +(state.matchClock ?? 0).toFixed(1), transition: state.matchTransition === undefined ? undefined : +state.matchTransition.toFixed(1) },
      score: { red: allianceScore("red"), blue: allianceScore("blue") },
      inventory: playerAgent.inventory, shots: { fired: shotsFired, hit: shotsHit }, launches: shotsFired, feederPulses, feeder: feederNote, stalls: stallCount, notMoving, battery: actuatorModel.volts, currents: Object.fromEntries(actuatorModel.currents), physics: state.physics.kind, perception: state.perception.level, tagCovers: state.tagCovers, shot: lastShotInfo, cellLoad: { red: match.cellLoad("red"), blue: match.cellLoad("blue") },
      hives: { red: { upCell: match.hives.red.upCell, tips: match.hives.red.tips }, blue: { upCell: match.hives.blue.upCell, tips: match.hives.blue.tips } },
      selectedOpMode: panel.selectedOpMode, telemetry: link.telemetry, runtimeStatus: link.status, notice: launchBlockedUntil > performance.now() ? launchBlockedMsg : undefined,
      scripted: scripted.map((r, i) => ({ name: r.name, alliance: scriptedAgents[i].alliance, xIn: +(r.pose.x / IN).toFixed(1), zIn: +(r.pose.z / IN).toFixed(1) })),
    } };
    case "knobs": return { result: twinKnobs(state) };
    case "manifest": return { result: buildManifest() };
    case "capabilities": return { result: capabilities() };
    case "settings": { // the twin's settings file: read, save the browser's settings, load the file, or apply given JSON
      if (params.text !== undefined) { const j = typeof params.text === "string" ? JSON.parse(params.text) : params.text; applySettingsJson(j); recorder.event(Date.now(), "note", "agent applied settings JSON"); }
      if (params.load) { const r = loadSettingsFromFile(); if (!r.ok) throw new Error(r.error); }
      if (params.save) { const r = await saveSettingsToFile(); if (!r.ok) throw new Error(r.error); }
      return { result: { path: link.settings?.path, exists: !!link.settings?.exists, modified: link.settings?.modified, differsFromBrowser: settingsDiffer(), browserHasUnsavedChanges: localUnsaved(), autoLoad: state.settingsAutoLoad, settings: JSON.parse(serializeSettings(state)) } };
    }
    case "shot": {
      // required exit speed / RPM / power to drop into the up cell at a horizontal range (drag + Magnus model, descending
      // arc through the opening's aim height), for one range or a table: ?rangeIn=68 or ?rangesIn=48,60,72,84
      const l = state.robot.launcher, bp = ballProps();
      const flyDev = state.hardware.devices.find((d) => d.kind === "motor" && d.role === "flywheel");
      const model: FlightModel = { ball: bp, wheelDiameterM: l.wheelDiameterM, freeRpm: flyDev?.freeRpm ?? l.maxRpm, exitHeightM: l.exitHeightM };
      const prm = { efficiency: l.efficiency, elevationDeg: num("hoodDeg", l.elevationDeg), spinFraction: l.spinFraction };
      const targetHeightM = aimPoint(targetFrame()).y;
      const ranges = params.rangesIn !== undefined ? String(params.rangesIn).split(/[,\s]+/).map(Number).filter((x) => x > 0) : [num("rangeIn", NaN)];
      if (!ranges.length || ranges.some((r) => !Number.isFinite(r))) throw new Error("give rangeIn=<inches> or rangesIn=48,60,72");
      // two answers per range: the twin's full solver (any entry that moves into the tilted opening, rising or falling,
      // inside the opening polygon shrunk by the ball) and the descending-only arc that TeamCode's ShotPower assumes
      const frame = targetFrame(), aim = aimPoint(frame);
      const sideSign = String(params.side ?? "front") === "behind" ? -1 : 1; // behind = on the pivot side, lobbing over the cell
      const nh = Math.hypot(frame.normal.x, frame.normal.z) || 1, nx = (frame.normal.x / nh) * sideSign, nz = (frame.normal.z / nh) * sideSign; // toward the shooter
      const elevRad = (prm.elevationDeg * Math.PI) / 180;
      const rows = ranges.map((rangeIn) => {
        const rangeM = rangeIn * IN;
        const ad = solveSpeedAdaptive(bp, { x: aim.x + nx * rangeM, y: l.exitHeightM, z: aim.z + nz * rangeM }, frame, elevRad, exitSpeed(l, l.maxRpm) * 1.5, spinRate(l));
        const sol = ad.result;
        const twin = sol && sol.hit ? { exitSpeedMps: +sol.speed.toFixed(2), rpm: Math.round(rpmForExitSpeed(l, sol.speed)), power: +(rpmForExitSpeed(l, sol.speed) / model.freeRpm).toFixed(3), entryAngleDeg: sol.entryAngleRad !== undefined ? +((sol.entryAngleRad * 180) / Math.PI).toFixed(1) : undefined, aimInsideIn: +(ad.insideM / IN).toFixed(2), aimHeightIn: +(ad.target.y / IN).toFixed(2), reachable: rpmForExitSpeed(l, sol.speed) <= l.maxRpm } : { reachable: false };
        const v = speedForRange(model, prm, rangeM, targetHeightM);
        const desc = v === undefined ? { reachable: false } : (() => { const rpm = rpmForExitSpeed(l, v); return { reachable: rpm <= l.maxRpm, exitSpeedMps: +v.toFixed(2), rpm: Math.round(rpm), power: +(rpm / model.freeRpm).toFixed(3) }; })();
        return { rangeIn, twinSolver: twin, descendingArc: desc };
      });
      return { result: { target: `${state.alliance} hive, ${state.hive[state.alliance]} cell`, side: sideSign === 1 ? "front" : "behind", targetHeightIn: +(targetHeightM / IN).toFixed(1), hoodDeg: prm.elevationDeg, exitHeightIn: +(l.exitHeightM / IN).toFixed(1), flywheelFreeRpm: model.freeRpm, launcher: { efficiency: l.efficiency, wheelDiameterMm: Math.round(l.wheelDiameterM * 1000), maxRpm: l.maxRpm }, rows, note: "power = rpm / flywheel free RPM (Hardware map), i.e. the setPower a no-load motor needs. twinSolver: lowest speed whose arc crosses the opening polygon moving into the cell (rising entries count, as on the tilted opening); descendingArc: the stricter model TeamCode's ShotPower uses (apex before the opening). The live value for the current pose is in /api/state → shot" } };
    }
    case "save": { // write the merged asset(s) back into the team repo: {file} or {all:true}
      const targets = params.all ? exportChangedAssets(link.assets, state.assetOverrides, link.bound.overrides).map((c) => c.path) : [String(params.file ?? "")].map((f) => link.assets.find((a) => a.path === f || a.path.endsWith("/" + f))?.path ?? f);
      if (!targets.length) return { result: { saved: [], note: "nothing differs from the committed files" } };
      const results = [];
      for (const t of targets) results.push({ path: t, ...(await saveAssetToRepo(t)) });
      if (results.some((r) => !r.ok)) throw new Error(results.filter((r) => !r.ok).map((r) => `${r.path}: ${r.error}`).join("; "));
      return { result: { saved: results } };
    }
    case "schema": { // the JSON Schema sidecar of an asset (descriptions, enums, ranges) and the current violations
      const file = String(params.file ?? "");
      const files = link.assets.filter((a) => !isSchemaFile(a.path) && a.path.endsWith(".json"));
      const mergedJson = (a: typeof files[number]) => { try { return JSON.parse(applyOverrides(a, state.assetOverrides[a.path], link.bound.overrides[a.path]).text); } catch { return JSON.parse(a.text); } };
      if (!file) return { result: { files: files.map((a) => ({ path: a.path, schema: !!schemaFor(link.assets, a.path), invalid: validateAll(mergedJson(a), schemaFor(link.assets, a.path)) })) } };
      const asset = files.find((a) => a.path === file || a.path.endsWith("/" + file) || a.path.endsWith(file));
      if (!asset) throw new Error(`unknown asset ${file}; known: ${files.map((a) => a.path).join(", ")}`);
      const schema = schemaFor(link.assets, asset.path);
      const merged = applyOverrides(asset, state.assetOverrides[asset.path], link.bound.overrides[asset.path]);
      return { result: { path: asset.path, schemaPath: schemaPathFor(asset.path), schema: schema ?? null, invalid: validateAll(JSON.parse(merged.text), schema) } };
    }
    case "run": return { result: { runs: recorder.runs.map((r) => ({ ...r, durationS: +(((r.end ?? Date.now()) - r.start) / 1000).toFixed(1), samples: recorder.samples.filter((x) => x.t >= r.start && x.t <= (r.end ?? Infinity)).length })), latest: recorder.latestRun(), cursor: recorder.cursor, recordedFrom: recorder.start, recordedTo: recorder.end, sampleMs: 100 } };
    case "replay": {
      // GET: the sample at a moment. POST with the same parameters scrubs the human's view there (live sim paused).
      // t = wall-clock ms; offset = seconds into the latest run (negative = before its end); step = ±n samples from the cursor; live = back to live
      const run = recorder.latestRun();
      let t: number | undefined;
      if (params.live) { recorder.cursor = undefined; panel.refreshTimeline(); return { result: { live: true } }; }
      if (params.t !== undefined) t = num("t", NaN);
      else if (params.offset !== undefined) { if (!run) throw new Error("no run recorded yet"); const o = num("offset", 0); t = o >= 0 ? run.start + o * 1000 : (run.end ?? recorder.end ?? Date.now()) + o * 1000; }
      else if (params.step !== undefined) t = recorder.step(recorder.cursor ?? recorder.end ?? Date.now(), Math.round(num("step", 0)))?.t;
      else t = recorder.cursor ?? recorder.end;
      if (t === undefined || !Number.isFinite(t)) throw new Error("give t (ms), offset (s into the latest run), step (samples) or live");
      const smp = recorder.at(t);
      if (!smp) throw new Error("nothing recorded");
      if (params.scrub !== undefined ? !!params.scrub : true) { recorder.cursor = smp.t; if (recorder.end !== undefined && recorder.end - smp.t < 300) recorder.cursor = undefined; panel.refreshTimeline(); }
      const r = recorder.runAt(smp.t);
      return { result: { t: smp.t, iso: new Date(smp.t).toISOString(), runOffsetS: r ? +((smp.t - r.start) / 1000).toFixed(1) : undefined, index: recorder.indexAt(smp.t), total: recorder.samples.length, cursor: recorder.cursor, sample: smp, events: recorder.eventsBetween(smp.t - 1000, smp.t + 100) } };
    }
    case "overrides": {
      const clear = params.clear as string | undefined;
      const incoming = Object.fromEntries(Object.entries(params).filter(([k, v]) => k.endsWith(".json") && v && typeof v === "object" && !Array.isArray(v))) as Record<string, Record<string, unknown>>;
      if (clear) delete state.assetOverrides[clear];
      for (const [path, vals] of Object.entries(incoming)) {
        if (!link.assets.some((a) => a.path === path)) throw new Error(`unknown asset ${path}; known: ${link.assets.map((a) => a.path).join(", ")}`);
        state.assetOverrides[path] = { ...(state.assetOverrides[path] ?? {}), ...vals };
      }
      if (clear || Object.keys(incoming).length) { onChange("assets"); panel.render(); recorder.event(Date.now(), "note", `agent set overrides: ${Object.entries(incoming).map(([p, v]) => `${p} ${Object.keys(v).join(", ")}`).join("; ")}${clear ? ` · cleared ${clear}` : ""}`); }
      return { result: { manual: state.assetOverrides, bound: link.bound.overrides, effective: mergeOverrides(state.assetOverrides, link.bound.overrides), note: "applied at the next INIT" } };
    }
    case "twin": {
      // whitelisted paths only: everything the panel exposes as a plain setting, nothing structural
      const allowed = /^(alliance|ballKind|infiniteAmmo|autoRpm|autoHood|drag|fieldCentric|opponents|pauseOpponents|opponentsScore|aiTier|autoTip|autoIntake|autoTransition|audio\.(master|cues|effects|voice)|tipMassG|capacity|canPollen|canNectar|tagNoiseIn|monteCarloN|view|hive\.(red|blue)|overlays\.\w+|noise\.\w+|starts\.(you|partner|opp1|opp2)\.(xIn|zIn|headingDeg)|starts\.followUpCell|robot\.(lengthM|widthM|heightM|massKg|wheelDiameterM|wheelRpm|drivetrain|intake\.(side|widthM|kind)|look\.color)|robot\.launcher\.\w+|hardware\.mirroredSide|physics(\.\w+)?|feed\.\w+|perception\.level|perception\.faults\.\w+|tagCovers|persistedAssets|balls|quality)$/;
      const set: string[] = [], rejected: string[] = [];
      for (const [path, value] of Object.entries(params)) {
        if (!allowed.test(path)) { rejected.push(path); continue; }
        // a named physics profile loads all of its knobs; editing one knob of a named profile makes it custom
        if (path === "physics.kind" || path === "physics") { const k = String(typeof value === "object" && value ? (value as any).kind : value); if (k in PHYSICS_PROFILES) state.physics = { ...PHYSICS_PROFILES[k as "ideal" | "tiles"], ...(typeof value === "object" && value ? value as object : {}) }; else if (typeof value === "object" && value) state.physics = { ...state.physics, ...(value as object), kind: "custom", provenance: "user" }; else { rejected.push(path); continue; } set.push(path); continue; }
        if (path.startsWith("physics.")) { (state.physics as any)[path.slice(8)] = value; state.physics.kind = "custom"; state.physics.provenance = "user"; set.push(path); continue; }
        if (path.startsWith("feed.")) { (state.feed as any)[path.slice(5)] = value; state.feed.provenance = "user"; set.push(path); continue; }
        if (path === "perception.level" && !["ideal", "faults", "singles"].includes(String(value))) { rejected.push(`${path} (${UNSUPPORTED_PERCEPTION.includes(String(value)) ? "unsupported in the twin: no camera frames exist" : "unknown level"})`); continue; }
        if (path === "balls") {
          // loose game pieces placed on the floor (world truth for contact / collection fixtures): [{xIn, zIn, kind?: pollen|nectar, alliance?}]
          const list = Array.isArray(value) ? value as { xIn: number; zIn: number; kind?: string; alliance?: string }[] : [];
          for (const b of list) { const kind = b.kind === "nectar" ? "nectar" : "pollen"; const dia = kind === "pollen" ? BALL.pollen.diaIn : BALL.nectarRed.diaIn; match.spawnBall(kind, kind === "nectar" ? ((b.alliance === "red" ? "red" : "blue") as "red" | "blue") : undefined, new THREE.Vector3(b.xIn * IN, m(dia) / 2, b.zIn * IN), new THREE.Vector3(), true); }
          recorder.event(Date.now(), "note", `placed ${list.length} loose ball${list.length === 1 ? "" : "s"}: ${list.map((b) => `${b.kind ?? "pollen"} (${b.xIn}, ${b.zIn})`).join(", ")}`);
          set.push(path); continue;
        }
        if (path === "persistedAssets") {
          // {"<asset>": {whole saved document}} or {"<asset>": {"drop": [dotted keys], "set": {dotted: value}}} derived from the packaged file; {} = clean install
          const next: Record<string, Record<string, unknown>> = {};
          for (const [asset, doc] of Object.entries((value && typeof value === "object" ? value : {}) as Record<string, any>)) {
            const file = link.assets.find((a) => a.path === asset || a.path.endsWith("/" + asset)); if (!file) { rejected.push(`${path}: unknown asset ${asset}`); continue; }
            const recipe = doc && typeof doc === "object" && (Array.isArray(doc.drop) || (doc.set && typeof doc.set === "object")) && Object.keys(doc).every((k) => ["drop", "set", "base"].includes(k));
            next[file.path] = recipe ? derivePersisted(JSON.parse(file.text), doc.drop ?? [], doc.set ?? {}) : doc;
          }
          state.persistedAssets = next; onChange("assets");
          recorder.event(Date.now(), "note", `saved hub profile: ${Object.keys(next).length ? Object.keys(next).map((p) => p.replace(/^.*\//, "")).join(", ") + " replace the packaged assets at the next INIT" : "none (clean install)"}`);
          set.push(path); continue;
        }
        if (path === "tagCovers") { state.tagCovers = Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : []; syncTagCovers(); recorder.event(Date.now(), "fault", `tag covers: ${state.tagCovers.length ? state.tagCovers.join(", ") : "none"}`, { tagCovers: state.tagCovers }); set.push(path); continue; }
        const parts = path.split("."); let o: any = state;
        for (const k of parts.slice(0, -1)) o = o[k];
        if (o === undefined) { rejected.push(path); continue; }
        o[parts[parts.length - 1]] = value; set.push(path);
      }
      if (set.length) { onChange("reset"); onChange("sim"); panel.render(); recorder.event(Date.now(), "note", `agent set ${set.join(", ")}`); }
      if (rejected.length && !set.length) throw new Error(`not settable: ${rejected.join(", ")} (GET /api/knobs lists readable values; settable paths: alliance, hive.red/blue, robot.*, robot.launcher.*, noise.*, starts.*, overlays.*, opponents, ...)`);
      return { result: { set, rejected } };
    }
    case "match": {
      const a = String(params.action ?? "");
      if (a === "init") { const name = String(params.opMode ?? panel.selectedOpMode); if (!link.connected) throw new Error("runtime not connected"); if (!link.opModes.some((o) => o.name === name)) throw new Error(`unknown OpMode ${name}; available: ${link.opModes.map((o) => o.name).join(", ")}`); panel.selectedOpMode = name; link.init(name); }
      else if (a === "start") { if (link.status === "INIT") link.start(); else startMatch(); }
      else if (a === "stop") { if (link.status === "RUNNING" || link.status === "INIT") link.stop(); else stopMatch(); }
      else if (a === "reset") resetBoard();
      else throw new Error(`action must be init|start|stop|reset, got ${a}`);
      // the host processes init/start/stop asynchronously: give the status a moment to change so the reply is current
      const want = a === "init" ? "INIT" : a === "start" ? "RUNNING" : a === "stop" ? "STOPPED" : undefined;
      const until = performance.now() + 2500;
      while (want && link.connected && link.status !== want && link.status !== "ERROR" && performance.now() < until) await new Promise((r) => setTimeout(r, 50));
      panel.render();
      return { result: { runtimeStatus: link.status, error: link.statusError || undefined, matchPhase: state.matchPhase, opMode: link.currentOpMode || undefined } };
    }
    case "gamepad": {
      const pad = (num("pad", 1) === 2 ? 2 : 1) as 1 | 2; const values = (params.values ?? {}) as Record<string, unknown>;
      input.inject(pad, values as any);
      const hold = num("holdMs", 0);
      if (hold > 0) setTimeout(() => { const off: Record<string, unknown> = {}; for (const k of Object.keys(values)) off[k] = typeof values[k] === "boolean" ? false : 0; input.inject(pad, off as any); }, hold);
      return { result: { pad, values, holdMs: hold || undefined } };
    }
    case "pose": {
      state.pose = { x: num("xIn", state.pose.x / IN) * IN, z: num("zIn", state.pose.z / IN) * IN, heading: (num("headingDeg", (state.pose.heading * 180) / Math.PI) * Math.PI) / 180 };
      robot.setPose(state.pose);
      return { result: { xIn: state.pose.x / IN, zIn: state.pose.z / IN, headingDeg: (state.pose.heading * 180) / Math.PI } };
    }
    default: throw new Error(`unknown action ${action}; GET / on the agent API lists them`);
  }
};
// ---------- the twin's settings file (server mode): <team repo>/twin-settings.json, versioned with the code
const SYNC_KEY = "biobuzz-twin-synced"; // the file text last loaded or saved by this browser, to tell "unsaved local changes" apart
let settingsPending: ((r: { ok: boolean; path?: string; error?: string }) => void) | undefined;
/** Replace the live settings with saved ones, keeping the objects other modules hold (state itself, state.hive). */
function applySettingsJson(json: unknown) {
  const h = hydrateState(JSON.parse(JSON.stringify(json)));
  for (const k of Object.keys(h) as (keyof AppState)[]) {
    if (k === "hive") Object.assign(state.hive, h.hive);
    else if (!(["pose", "matchPhase", "matchClock", "matchRequest", "aimRequest", "resetMatchRequest", ...LOCAL_KEYS] as string[]).includes(k)) (state as any)[k] = h[k];
  }
  onChange("reset"); onChange("sim"); onChange("runtime"); onChange("hardware"); onChange("assets");
  panel.render();
}
function normalizedSettings(text: string | null | undefined): string | undefined {
  try { return text ? serializeSettings(hydrateState(JSON.parse(text))) : undefined; } catch { return undefined; }
}
function settingsDiffer(): boolean { return !!link.settings?.exists && link.settings.text !== undefined && normalizedSettings(link.settings.text) !== serializeSettings(state); }
function localUnsaved(): boolean { const synced = localStorage.getItem(SYNC_KEY); return serializeSettings(state) !== normalizedSettings(synced); }
function loadSettingsFromFile(): { ok: boolean; error?: string } {
  const f = link.settings;
  if (!f?.exists || !f.text) return { ok: false, error: "no settings file on the host yet" };
  try { applySettingsJson(JSON.parse(f.text)); } catch (e) { return { ok: false, error: `settings file is not valid: ${e}` }; }
  localStorage.setItem(SYNC_KEY, f.text);
  recorder.event(Date.now(), "note", `settings loaded from ${f.path}`);
  panel.flashSession(`Loaded ${new Date().toLocaleTimeString()}`);
  panel.toast(`Settings loaded from ${f.path.split("/").pop()}`);
  return { ok: true };
}
function saveSettingsToFile(): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!link.connected) return Promise.resolve({ ok: false, error: "not connected to the host (server mode only)" });
  const text = serializeSettings(state);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { settingsPending = undefined; resolve({ ok: false, error: "host did not answer" }); }, 5000);
    settingsPending = (r) => { clearTimeout(timer); if (r.ok) { localStorage.setItem(SYNC_KEY, text); link.settings = { path: r.path ?? link.settings?.path ?? "", exists: true, text, modified: Date.now() }; } resolve(r); };
    link.saveSettings(text);
  });
}
link.onSettingsSaved = (r) => {
  recorder.event(Date.now(), r.ok ? "note" : "error", r.ok ? `settings saved to ${r.path}` : `settings not saved: ${r.error}`);
  settingsPending?.(r); settingsPending = undefined;
  panel.render();
  panel.flashSession(r.ok ? `Saved ${new Date().toLocaleTimeString()}` : `Not saved: ${r.error}`, !r.ok);
  panel.toast(r.ok ? `Settings saved to ${r.path?.split("/").pop()}` : `Settings not saved: ${r.error}`, !r.ok);
};
let settingsAutoLoaded = false;
link.onSettings = (f) => {
  // first report after a connect: apply the repo file unless this browser has changes it never saved
  if (!settingsAutoLoaded && state.settingsAutoLoad && f.exists && f.text) {
    settingsAutoLoaded = true;
    if (f.text === serializeSettings(state)) { localStorage.setItem(SYNC_KEY, f.text); }
    else if (!localUnsaved() || localStorage.getItem(SYNC_KEY) === null) loadSettingsFromFile();
    else recorder.event(Date.now(), "note", `settings file ${f.path} differs from this browser's unsaved settings; not applied (Session: Load from file / Save to file)`);
  }
  panel.render();
};
// the host wrote a settings file back to the repo: the manual overrides for it are now in the file, so drop them
const pendingWrites = new Map<string, (r: { ok: boolean; file?: string; error?: string }) => void>();
link.onAssetWritten = (r) => {
  if (r.ok) { delete state.assetOverrides[r.path]; saveState(state); if (link.connected) link.sendAssetOverrides(mergeOverrides(state.assetOverrides, link.bound.overrides), state.persistedAssets); }
  recorder.event(Date.now(), r.ok ? "note" : "error", r.ok ? `saved ${r.path} to the repo (${r.file})` : `could not save ${r.path}: ${r.error}`);
  pendingWrites.get(r.path)?.(r); pendingWrites.delete(r.path);
  panel.render(); // rebuilds the panel (new flash element), so flash afterwards
  panel.flashAssets(r.ok ? `Saved ${r.path.split("/").pop()} to ${r.file}` : `Not saved: ${r.error}`, !r.ok);
  panel.toast(r.ok ? `${r.path.split("/").pop()} written to the repo` : `${r.path.split("/").pop()} not written: ${r.error}`, !r.ok);
};
/** Write an asset with the current overrides applied; resolves with the host's answer. */
/** Write an asset back into the team repo with the browser's values merged in; `boundOnly` writes just the values the
 * twin's bindings supply (its measurements), leaving any browser edits as overrides. */
function saveAssetToRepo(path: string, opts: { boundOnly?: boolean } = {}): Promise<{ ok: boolean; file?: string; error?: string }> {
  const asset = link.assets.find((a) => a.path === path);
  if (!asset) return Promise.resolve({ ok: false, error: `unknown asset ${path}` });
  if (!link.connected) return Promise.resolve({ ok: false, error: "not connected to the host (server mode only)" });
  const merged = applyOverrides(asset, opts.boundOnly ? {} : state.assetOverrides[path], link.bound.overrides[path]);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingWrites.delete(path); resolve({ ok: false, error: "host did not answer" }); }, 5000);
    pendingWrites.set(path, (r) => { clearTimeout(timer); resolve(r); });
    link.writeAsset(path, merged.text);
  });
}
let lastLinkStatus = link.status;
link.onChange = () => {
  if (link.statusError && link.status === "ERROR") recorder.event(Date.now(), "error", link.statusError.split("\n")[0]);
  if (link.connected && !hardwareSent) { link.sendHardware(hardwareDevices(), hardwareHints()); link.sendAssetOverrides(mergeOverrides(state.assetOverrides, link.bound.overrides), state.persistedAssets); hardwareSent = true; }
  if (link.bindings?.text !== lastBindingsText) syncBindings();
  if (!link.connected) { hardwareSent = false; settingsAutoLoaded = false; }
  // Driver-Station flow: INIT parks everything at the start positions, START releases the match clock and the other
  // robots together with the OpMode, STOP freezes them
  if (link.status !== lastLinkStatus) {
    // START on TeamCode: the keyboard drives gamepad1 straight away, no click on the field needed first
    if (link.status === "RUNNING") workspace.focusKeyboard("TeamCode started: keyboard is gamepad1. Press Tab for gamepad2.");
    if ((link.status === "INIT" || link.status === "RUNNING") && recorder.cursor !== undefined) { recorder.cursor = undefined; panel.refreshTimeline(); } // a new run: back to live
    if (link.status === "INIT") { resetBoard(); for (const [name, f] of feeders) { f.ballPosM = undefined; f.strokeLeftS = 0; f.reason = undefined; const dev = state.hardware.devices.find((d) => d.name === name); f.last = dev?.kind === "servo" ? (link.actuators[name]?.position ?? 0.5) : 0; } stallFor.clear(); stallActive = false; latencyQueues.clear(); frameCadences.clear(); actuatorModel.touched.clear(); flywheelPeak = 0; contactBlock = undefined; recorder.event(Date.now(), "manifest", `INIT ${link.currentOpMode}: ${manifestSummary()}`, buildManifest()); }
    else if (link.status === "RUNNING") startMatch();
    else if (lastLinkStatus === "RUNNING") stopMatch();
    lastLinkStatus = link.status;
  }
  panel.render();
};
panel = new Panel(state, onChange);
panel.saveAssetToRepo = saveAssetToRepo;
panel.settingsFile = { save: saveSettingsToFile, load: loadSettingsFromFile, differs: settingsDiffer, unsaved: localUnsaved,
  unsavedPaths: () => settingsDiffPaths(localStorage.getItem(SYNC_KEY), serializeSettings(state)),
  filePaths: () => settingsDiffPaths(link.settings?.text, serializeSettings(state)) };
panel.link = link;
panel.manifest = buildManifest;
panel.breakaway = () => breakawayNow();
panel.audition = (kind, name) => { if (!synth) return; if (kind === "cue") synth.cue(name as any); else synth.effect(name as any, 1); };
syncRuntime();
Object.assign(overlays.show, state.overlays);
const workspace = new Workspace(state, panel, link, input, onChange);
hud.onAction = (action) => {
  if (action === "aim" && !link.running && recorder.cursor === undefined) { state.aimRequest = true; workspace.focusKeyboard(); }
  if (action === "intake" && !link.running && recorder.cursor === undefined) { intakeOn = true; workspace.focusKeyboard(); }
  if (action === "focus") workspace.focusKeyboard();
  if (action === "analyze") workspace.navigate("analyze", "shots");
  if (action === "hood") workspace.focusExperiment("hood");
  if (action === "shoot" && !link.running && recorder.cursor === undefined) { state.shootRequest = true; workspace.focusKeyboard(); }
  if (action === "detail") workspace.toggleVisualDetail();
};
const DRIVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
window.addEventListener("keydown", (e) => {
  if (document.activeElement === canvas && e.code === "KeyH") panel.toggle();
  // drive keys typed somewhere else (a button, the page body): the robot will not move, so say why and offer the fix
  if (document.activeElement !== canvas && DRIVE_KEYS.has(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector("dialog[open]")) {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable);
    if (!typing) workspace.hintFocus();
  }
});
new ResizeObserver(() => resize()).observe(canvas);

// ---------- helpers
function ballProps() {
  const b = state.ballKind === "pollen" ? BALL.pollen : BALL.nectarRed;
  return { massKg: b.massKg, diameterM: m(b.diaIn), cd: state.drag ? 0.45 : 0, cl: state.drag ? 0.2 : 0 };
}
function driveParams(): DriveParams {
  const r = state.robot;
  return { drivetrain: r.drivetrain, wheelRpm: r.wheelRpm, wheelDiameterM: r.wheelDiameterM, trackWidthM: r.widthM * 0.9, wheelbaseM: r.lengthM * 0.75, fieldCentric: state.fieldCentric, fieldHeading: allianceDriveHeading(state.alliance) };
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
  aimSnapRequest = true; // face the target from the new spot (a teleport: no need to turn there)
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
const perf = new Perf();
const pins = new PinTracker();
// ---------- timeline recorder: 10 Hz samples of telemetry/status/pose/buttons plus events, for scrubbing and snapshots
const recorder = new Recorder();
panel.recorder = recorder; panel.snapshotContext = snapshotContext; panel.render();
let lastSampleAt = 0;
function captureScene(): SceneSnapshot {
  const balls: number[] = [];
  for (const f of flying) { if (!f.mesh.visible && !replayPool.active) continue; balls.push(+f.pos.x.toFixed(3), +f.pos.y.toFixed(3), +f.pos.z.toFixed(3), f.kind === "pollen" ? 0 : f.alliance === "blue" ? 2 : 1); }
  const g = input.gamepads().g1;
  return {
    scripted: scripted.map((r) => [+r.pose.x.toFixed(3), +r.pose.z.toFixed(3), +r.pose.heading.toFixed(3)]),
    balls,
    hive: [-field.hives.red.pivotGroup.rotation.x, -field.hives.blue.pivotGroup.rotation.x],
    carry: allAgents.map((a) => [a.inventory.pollen, a.inventory.nectar]),
    score: [allianceScore("red").total, allianceScore("blue").total],
    clock: +(state.matchClock ?? 0).toFixed(1), phase: state.matchPhase ?? "setup",
    sticks: [+g.lx.toFixed(2), +g.ly.toFixed(2), +g.rx.toFixed(2), +g.ry.toFixed(2)],
  };
}
// ---------- replay: draw a recorded sample instead of the live field while the timeline is scrubbed
const replayPool = { meshes: [] as THREE.Mesh[], active: false, mats: [] as THREE.MeshStandardMaterial[] };
function replayMesh(i: number): THREE.Mesh {
  while (replayPool.meshes.length <= i) {
    if (!replayPool.mats.length) replayPool.mats = [BALL.pollen.color, BALL.nectarRed.color, BALL.nectarBlue.color].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, transparent: true, opacity: 0.9 }));
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), replayPool.mats[0]); mesh.visible = false; scene.add(mesh); replayPool.meshes.push(mesh);
  }
  return replayPool.meshes[i];
}
function applyReplay(smp: Sample) {
  const sc = smp.scene;
  robot.setPose({ x: smp.pose.xIn * IN, z: smp.pose.zIn * IN, heading: (smp.pose.headingDeg * Math.PI) / 180 });
  if (!sc) return;
  if (!replayPool.active) { replayPool.active = true; for (const f of flying) f.mesh.visible = false; for (const a of allAgents) a.carryGroup.visible = false; }
  sc.scripted.forEach((p, i) => scriptedObjs[i]?.setPose({ x: p[0], z: p[1], heading: p[2] }));
  field.setHiveTilt("red", sc.hive[0]); field.setHiveTilt("blue", sc.hive[1]);
  const n = sc.balls.length / 4;
  for (let i = 0; i < n; i++) {
    const mesh = replayMesh(i); const code = sc.balls[i * 4 + 3];
    mesh.material = replayPool.mats[code]; const r = m(code === 0 ? BALL.pollen.diaIn : BALL.nectarRed.diaIn) / 2;
    mesh.scale.setScalar(r); mesh.position.set(sc.balls[i * 4], sc.balls[i * 4 + 1], sc.balls[i * 4 + 2]); mesh.visible = true;
  }
  for (let i = n; i < replayPool.meshes.length; i++) replayPool.meshes[i].visible = false;
}
function restoreLive() {
  if (!replayPool.active) return;
  replayPool.active = false;
  for (const mesh of replayPool.meshes) mesh.visible = false;
  for (const f of flying) f.mesh.visible = true;
  robot.setPose(state.pose);
  scripted.forEach((r, i) => scriptedObjs[i].setPose(r.pose));
  for (const a of ["red", "blue"] as Alliance[]) field.setHiveTilt(a, match.hives[a].tipping?.last ?? hiveTiltAngle({ alliance: a, upCell: match.hives[a].upCell }));
}
let lastSentRun: Run | undefined;
/** When a run closes, hand it to the host (server mode) so it is kept under runtime/runs/ for agents and later sessions. */
function maybeSendRun() {
  const r = recorder.latestRun();
  if (!r || r.end === undefined || r === lastSentRun || !link.connected) return;
  lastSentRun = r;
  const samples = recorder.samples.filter((x) => x.t >= r.start - 1000 && x.t <= r.end! + 1000);
  link.sendRun({ opMode: r.opMode || undefined, start: r.start, end: r.end, startIso: new Date(r.start).toISOString(), durationS: +((r.end - r.start) / 1000).toFixed(1), context: snapshotContext(), samples, events: recorder.eventsBetween(r.start - 1000, r.end + 1000) });
  recorder.event(Date.now(), "note", `run saved to the host (${samples.length} samples)`);
}
function recordSample(now: number) {
  if (now - lastSampleAt < 100) return;
  lastSampleAt = now;
  const g = input.gamepads();
  const held = (p: typeof g.g1, n: number) => (["a", "b", "x", "y", "lb", "rb", "back", "start", "guide", "du", "dd", "dl", "dr", "ls", "rs"] as const).filter((k) => p[k]).map((k) => `${n}:${k}`).join(" ");
  const buttons = [held(g.g1, 1), held(g.g2, 2)].filter(Boolean).join(" ");
  recorder.push({
    scene: captureScene(),
    t: Date.now(), sim: match.now(),
    status: link.connected ? link.status : "no runtime", opMode: link.currentOpMode,
    telemetry: link.connected ? link.telemetry : [],
    pose: { xIn: state.pose.x / 0.0254, zIn: state.pose.z / 0.0254, headingDeg: (state.pose.heading * 180) / Math.PI },
    match: `${state.matchPhase ?? "setup"}${state.matchPhase === "running" ? ` ${Math.floor((state.matchClock ?? 0) / 60)}:${String(Math.floor((state.matchClock ?? 0) % 60)).padStart(2, "0")}` : ""}`,
    carrying: `${playerAgent.inventory.pollen}P+${playerAgent.inventory.nectar}N`,
    shots: { fired: shotsFired, hit: shotsHit },
    buttons,
  });
  maybeSendRun();
}
/** Everything an agent needs to reproduce the moment: OpMode, presets, overrides, bound values, start pose. */
function snapshotContext() {
  return {
    opMode: link.currentOpMode || undefined, runtimeStatus: link.status, statusError: link.statusError || undefined,
    alliance: state.alliance, robotPreset: state.robotPresetId, drivetrain: state.robot.drivetrain, mirroredSide: state.hardware.mirroredSide,
    hardware: state.hardware.devices.map((d) => `${d.kind}:${d.name}${d.role ? `(${d.role})` : ""}${d.port !== undefined ? `@${d.port}` : ""}`),
    assetOverrides: state.assetOverrides, boundOverrides: link.bound.overrides, bindingErrors: link.bound.errors,
    cameras: state.robot.cameras.map((c) => ({ name: c.name, forwardIn: +(c.forwardM / 0.0254).toFixed(2), leftIn: +(c.leftM / 0.0254).toFixed(2), heightIn: +(c.heightM / 0.0254).toFixed(2), pitchDeg: c.pitchDeg, yawDeg: c.yawDeg })),
    launcher: { yawOffsetDeg: state.robot.launcher.yawOffsetDeg, elevationDeg: state.robot.launcher.elevationDeg, rpm: Math.round(state.robot.launcher.rpm) },
    hive: state.hive, matchPhase: state.matchPhase, startPositions: state.starts, keyboardPad: input.keyboardPad,
    score: { red: allianceScore("red"), blue: allianceScore("blue"), robots: Object.fromEntries([...scoreboard.robots].map(([k, v]) => [k, { leave: v.leave, autoPark: v.autoPark, teleopPark: v.teleopPark }])) },
  };
}
setupUpdates();
let shotCache: { key: string; shot?: ShotResult; scan?: ReturnType<typeof scanElevations>; required?: number } = { key: "" };
/** flywheel under manual control: the commanded speed (keys - / =, the Commanded RPM field) and, with Auto-RPM, the
 *  speed the solver asks for; the launcher's rpm is the wheel's actual speed, which spins up at FLYWHEEL_UP and
 *  coasts down at FLYWHEEL_DOWN (a 6000 RPM goBILDA motor with a flywheel takes about a second to reach 4000). */
let rpmCmd = state.robot.launcher.rpm;
let autoRpmTarget: number | undefined;
const FLYWHEEL_UP = 4000, FLYWHEEL_DOWN = 1500; // RPM/s
function slewRpm(cur: number, target: number, dt: number): number {
  const d = target - cur;
  return d > 0 ? Math.min(target, cur + FLYWHEEL_UP * dt) : Math.max(target, cur - FLYWHEEL_DOWN * dt);
}
/** R / Aim: the heading at which the launcher points at the target; the robot turns there at its own yaw rate */
let aimHeading: number | undefined;
let knobsDirty = false, knobsFlushing = false;
/** the wheel's actual speed as of the last frame, so a panel edit of the launcher can be told apart from the slew */
let lastActualRpm = state.robot.launcher.rpm;
function aimHeadingFor(): number {
  const ap = aimPoint(targetFrame(), 0.05);
  const mid = (state.robot.launcher.turretMinDeg + state.robot.launcher.turretMaxDeg) / 2;
  const e = robot.exitPoint(); // the exit point moves as the robot turns; re-evaluated every frame while aiming
  return headingToward({ x: e.x, z: e.z }, ap) - ((mid + state.robot.launcher.yawOffsetDeg) * Math.PI) / 180;
}
let aimSnapRequest = false;
let analysisTick = 0;
let lastRenderAt = 0;
let lastSlowNote = 0;
let lastShotInfo: Record<string, unknown> = {};
let lastAimInsideM = 0.05;
let renderCount = 0;
let renderRequested = false; // the first render compiles every shader (a 0.5-1 s stall under software GL); test harnesses wait for it before INIT

function computeShot(exit: Vec3, frame: CellFrame): { shot?: ShotResult; scan?: ReturnType<typeof scanElevations>; required?: number } {
  const l = state.robot.launcher;
  const key = JSON.stringify([exit.x.toFixed(3), exit.y.toFixed(3), exit.z.toFixed(3), l, state.ballKind, state.drag, state.autoRpm, state.autoHood, state.alliance, state.hive]);
  if (key === shotCache.key) return shotCache;
  const scanReq = { ball: ballProps(), launchPos: exit, target: aimPoint(frame, 0.05), frame, spin: spinRate(l) };
  const scan = scanElevations(scanReq, Math.min(l.elevationMinDeg, l.elevationMaxDeg), Math.max(l.elevationMinDeg, l.elevationMaxDeg), 2.5, exitSpeed(l, l.maxRpm));
  if (state.autoHood && scan.best && !link.running) l.elevationDeg = rad2deg(scan.best.elevationRad);
  // aim depth follows the entry angle: steep arcs aim at the opening's centre, flat ones deeper into the cell
  const adaptive = solveSpeedAdaptive(ballProps(), exit, frame, (l.elevationDeg * Math.PI) / 180, exitSpeed(l, l.maxRpm) * 1.5, spinRate(l));
  lastAimInsideM = adaptive.insideM;
  const req = { ball: ballProps(), launchPos: exit, target: adaptive.target, frame, spin: spinRate(l) };
  const fixed = adaptive.result;
  const required = fixed?.speed;
  // Auto-RPM: the flywheel is *commanded* to the required speed; the real wheel spins up in the frame loop (slewRpm)
  if (state.autoRpm && required !== undefined && !link.running) autoRpmTarget = clamp(rpmForExitSpeed(l, required), 0, l.maxRpm);
  const shot = evaluateShot(req, (l.elevationDeg * Math.PI) / 180, exitSpeed(l));
  shotCache = { key, shot, scan, required };
  return shotCache;
}

function launch(exit: Vec3, dirXZ: { x: number; z: number }) {
  const l = state.robot.launcher;
  // make sure auto-RPM / auto-hood reflect the current pose even if no frame ran since the robot last moved
  if (!link.running) computeShot(exit, targetFrame());
  const nominal = { speed: exitSpeed(l), elevationRad: (l.elevationDeg * Math.PI) / 180, dirXZ, spin: spinRate(l) };
  const draw = perturb(nominal, state.noise, rng((Math.random() * 2 ** 32) >>> 0));
  const vel = draw.vel;
  // practice mode: top the magazine up so the launch always has a ball of the selected kind (the field's supply is untouched)
  if (state.infiniteAmmo && playerAgent.inventory[state.ballKind] < 1) playerAgent.inventory[state.ballKind] = 1;
  const ball = match.launch(playerAgent, state.ballKind, new THREE.Vector3(exit.x, exit.y, exit.z), new THREE.Vector3(vel.x, vel.y, vel.z), draw.spin, robot.group);
  if (state.infiniteAmmo && ball && playerAgent.inventory[state.ballKind] < 1) playerAgent.inventory[state.ballKind] = 1; // stays loaded
  if (!ball) { launchBlockedUntil = performance.now() + 5000; launchBlockedMsg = "No balls loaded — shot not fired. Collect balls before shooting."; return; }
  launchBlockedUntil = 0;
  if (nominal.speed < 1.5) { launchBlockedUntil = performance.now() + 3000; launchBlockedMsg = `flywheel at ${Math.round(l.rpm)} RPM — ball just dropped out (${link.running ? "your code must spin the flywheel first" : "turn on Auto-RPM or set a commanded RPM"})`; }
  (ball as any).owner = "player";
  (ball as any).cal = { exit: { x: exit.x, y: exit.y, z: exit.z }, dir: { x: dirXZ.x / (Math.hypot(dirXZ.x, dirXZ.z) || 1), z: dirXZ.z / (Math.hypot(dirXZ.x, dirXZ.z) || 1) }, power: flywheelPowerCmd(), rpm: l.rpm };
  shotsFired++;
}
let roleWarning: string | undefined;
let lastFoulLogged = -1;
let intakeBlockedUntil = 0;
let fullBlockedUntil = 0;
/** manual intake toggle (I / LB); K / LT runs it while held */
let intakeOn = false;
/** what the driver has done this session (the HUD guide moves on from shooting to these) */
const guide = { moved: false, turned: false, intakeUsed: false, startPose: undefined as Pose | undefined, travelled: 0, rotated: 0 };
let launchBlockedUntil = 0;
let launchBlockedMsg = "";

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
  for (const f of flying) {
    const props = { ...bp, diameterM: f.radius * 2, massKg: f.massKg };
    if (!f.settled) {
      if ((f as any).cal && !(f as any).calDone) {
        // a calibration shot: step finely and catch the exact wall/floor crossing, whatever the frame rate
        const n = Math.max(1, Math.ceil(dt / 0.005));
        for (let i = 0; i < n; i++) { calPrev.copy(f.pos); stepBall(f, dt / n, props, colliders); if (noteCalibrationImpact(f, calPrev)) break; }
      } else stepBall(f, dt, props, colliders);
    }
    if ((f as any).owner === "player" && f.counted && !(f as any).tallied) { (f as any).tallied = true; shotsHit++; }
  }
}
const calPrev = new THREE.Vector3();
/** Where our last shot first hit the perimeter wall or the floor, in the calibration wizard's terms (distance along
 * the shot line, height, sideways offset). Lets the wizard be exercised against the sim and lets agents read it. */
export interface SimImpact { kind: "wall" | "floor"; distanceM: number; heightM: number; lateralM: number; power: number; rpm: number; t: number }
let lastImpact: SimImpact | undefined;
/** The perimeter counts as an infinitely tall wall here (the real one is 12 in; a gym wall is not). Returns true once
 * the impact has been recorded. `prev` is the position before the last sub-step, for interpolating the crossing. */
function noteCalibrationImpact(f: LiveBall, prev: THREE.Vector3): boolean {
  const cal = (f as any).cal as { exit: Vec3; dir: { x: number; z: number }; power: number; rpm: number } | undefined;
  if (!cal || (f as any).calDone) return false;
  if (f.age < 0.03) return false;
  const half = m(FIELD.sizeIn) / 2 - f.radius - 0.02;
  const floorY = f.radius + 0.01;
  let s = -1, kind: "wall" | "floor" | undefined;
  for (const c of ["x", "z"] as const) {
    const a = Math.abs(prev[c]), b = Math.abs(f.pos[c]);
    if (b >= half && b > a) { const t = (half - a) / (b - a); if (kind === undefined || t < s) { s = Math.max(0, Math.min(1, t)); kind = "wall"; } }
  }
  if (kind === undefined && f.pos.y <= floorY && f.vel.y <= 0) { s = prev.y > f.pos.y ? Math.max(0, Math.min(1, (prev.y - floorY) / (prev.y - f.pos.y))) : 1; kind = "floor"; }
  if (kind === undefined) return false;
  (f as any).calDone = true;
  const px = prev.x + s * (f.pos.x - prev.x), py = prev.y + s * (f.pos.y - prev.y), pz = prev.z + s * (f.pos.z - prev.z);
  const dx = px - cal.exit.x, dz = pz - cal.exit.z;
  const along = dx * cal.dir.x + dz * cal.dir.z;
  const lateral = dx * -cal.dir.z + dz * cal.dir.x; // positive = left of the shot line (Y up, right-handed)
  lastImpact = { kind, distanceM: along, heightM: kind === "wall" ? py : 0, lateralM: lateral, power: cal.power, rpm: cal.rpm, t: Date.now() };
  panel.renderCalibrationImpact?.(lastImpact);
  return true;
}
/** The flywheel power TeamCode is commanding (0..1), or the keyboard-mode equivalent of the commanded RPM. */
function flywheelPowerCmd(): number {
  const dev = state.hardware.devices.find((d) => d.kind === "motor" && d.role === "flywheel");
  const c = dev ? link.actuators[dev.name] : undefined;
  if (link.running && c) {
    if (c.mode === "RUN_USING_ENCODER" && c.targetVel) return Math.min(1, Math.abs(c.targetVel) / ((dev!.ticksPerRev ?? 28) * (dev!.freeRpm ?? 6000) / 60));
    return Math.abs(c.power ?? 0);
  }
  return dev?.freeRpm ? state.robot.launcher.rpm / dev.freeRpm : state.robot.launcher.rpm / state.robot.launcher.maxRpm;
}

let frameInterval = 1 / 60; // EMA of the real time between frames, for the frame-rate / time-dilation readout
/** Auto quality: once the robot model has settled, average the frame time over 4 s (after a 3 s warm-up for shader
 * compilation) and decide once per session; below 30 fps the page switches itself to performance visuals and says so. */
let measureFrom: number | undefined, measureN = 0, measureSum = 0;
function measureQuality(now: number, real: number) {
  if (autoQuality !== undefined || ciMode || robot.modelStatus === "loading" || document.hidden) return;
  if (measureFrom === undefined) { measureFrom = now + 3000; return; }
  if (now < measureFrom) return;
  measureN++; measureSum += real;
  if (now - measureFrom < 4000) return;
  autoFps = Math.round(measureN / Math.max(measureSum, 1e-3));
  autoQuality = autoFps < 30 ? "performance" : "full";
  if (state.quality === "auto" && autoQuality === "performance") {
    applyQuality();
    qualityNotice = { text: `${autoFps} fps measured: switched to performance visuals (no stadium, shadows, hit map, insets, CAD or spinning wheels). View & overlays → Visual quality to change; this choice stays in this browser.`, untilMs: performance.now() + 20000 };
    recorder.event(Date.now(), "note", `auto quality: ${autoFps} fps measured, performance visuals on`);
    panel.render();
  } else recorder.event(Date.now(), "note", `auto quality: ${autoFps} fps measured, full visuals kept`);
}
function frame(now: number) {
  const real = (now - last) / 1000;
  last = now;
  frameInterval = real > 1 ? frameInterval : frameInterval * 0.9 + real * 0.1;
  // simulate the real elapsed time, capped so a background tab or a hitch does not teleport things. Below 10 fps the
  // simulation therefore runs slower than real time; the HUD says so.
  // scrubbing the timeline freezes the live simulation (dt 0) and draws the recorded moment instead
  let replaying = recorder.cursor !== undefined;
  // one step never covers more than 100 ms: longer steps make encoder deltas jump beyond what wheels can do in one
  // OpMode loop (team dead-reckoning rejects them). Headless renders are lean enough (4 fps, low resolution) to fit.
  const dt = replaying ? 0 : Math.min(0.1, real);
  const fps = 1 / Math.max(frameInterval, 1e-3);
  const slowdown = frameInterval > 0.1 ? 0.1 / frameInterval : 1;
  measureQuality(now, real);

  // input & drive
  perf.begin();
  const { cmd, actions } = input.poll();
  const manual = !link.running && recorder.cursor === undefined;
  if (manual) {
    const l = state.robot.launcher;
    // hood and flywheel knobs on the keys: touching them takes the knob off automatic
    if (actions.hoodUp || actions.hoodDown) {
      const fixed = l.elevationMinDeg === l.elevationMaxDeg;
      const v = clamp(l.elevationDeg + (actions.hoodUp ? 1 : -1) * 20 * dt, fixed ? 0 : l.elevationMinDeg, fixed ? 89 : l.elevationMaxDeg);
      l.elevationDeg = v; if (fixed) { l.elevationMinDeg = l.elevationMaxDeg = v; }
      if (state.autoHood) { state.autoHood = false; }
      knobsDirty = true;
    }
    if (actions.rpmUp || actions.rpmDown || actions.rpmOff) {
      if (state.autoRpm) { state.autoRpm = false; (state as any).autoRpmUserSet = true; rpmCmd = l.rpm; }
      rpmCmd = actions.rpmOff ? 0 : clamp(rpmCmd + (actions.rpmUp ? 1 : -1) * 2000 * dt, 0, l.maxRpm);
      knobsDirty = true;
    }
    if (knobsDirty && !(actions.hoodUp || actions.hoodDown || actions.rpmUp || actions.rpmDown)) { knobsDirty = false; knobsFlushing = true; onChange("launcher"); knobsFlushing = false; panel.render(); }
    // R / Aim: turn toward the target at the drivetrain's own rate instead of snapping; any turn key cancels
    if (actions.aim || state.aimRequest) { state.aimRequest = false; aimHeading = aimHeadingFor(); }
    if (aimHeading !== undefined) {
      if (cmd.turn !== 0) aimHeading = undefined;
      else {
        aimHeading = aimHeadingFor();
        const err = wrapAngle(aimHeading - state.pose.heading);
        if (Math.abs(err) < (0.3 * Math.PI) / 180) { state.pose = { ...state.pose, heading: aimHeading }; robot.setPose(state.pose); aimHeading = undefined; }
        else cmd.turn = clamp(err * 2.5 / Math.max(0.5, maxYawRate(driveParams())), -1, 1);
      }
    }
  } else { aimHeading = undefined; state.aimRequest = false; }
  // Replay is explicit: driving cannot silently resume a recorded scene.
  if (replaying) { cmd.forward = cmd.left = cmd.turn = 0; actions.launch = false; actions.aim = false; actions.toggleTarget = false; }
  if (actions.aim) workspace.tutorialAction("aim");
  if (actions.launch) workspace.tutorialAction("shoot");
  workspace.update(now);
  if (actions.view) { state.view = (["orbit", "top", "chase", "robot"] as const)[actions.view - 1] ?? state.view; panel.render(); }
  if (actions.toggleTarget) { state.hive[state.alliance] = state.hive[state.alliance] === "audience" ? "scoring" : "audience"; match.resetHive(state.alliance); panel.render(); }
  if (actions.toggleFieldCentric) { state.fieldCentric = !state.fieldCentric; panel.render(); }
  const dp = driveParams();
  const runtimeActive = link.running;
  // tank drive cannot strafe: let A/D turn like Q/E so the usual hand position still works (no turn key held)
  if (state.matchTransition !== undefined) { cmd.forward = cmd.left = cmd.turn = 0; actions.launch = false; } // G403: no powered movement in the transition
  const driveCmd = state.robot.drivetrain === "tank" && cmd.turn === 0 && cmd.left !== 0 ? { ...cmd, turn: cmd.left, left: 0 } : cmd;
  let vel = commandToVelocity(runtimeActive ? { forward: 0, left: 0, turn: 0 } : driveCmd, state.pose, dp);
  const vel0 = vel;
  if (runtimeActive) {
    const act = stepActuators(actuatorModel, state.hardware, link.actuators, dt, state.robot.drivetrain, state.pose.heading, state.robot.wheelDiameterM, dp.trackWidthM, dp.wheelbaseM, physicsInput());
    vel = act.vel;
    for (const d of state.hardware.devices) if (d.kind === "motor" && d.role === "flywheel") flywheelPeak = Math.max(flywheelPeak, Math.abs(link.actuators[d.name]?.power ?? 0));
    updateStallWatchdog(dt);
    playerAgent.intakeActive = Math.abs(act.intakePower) > 0.2;
    // motors your code is powering that the sim does not know what to do with (no role): say so instead of standing still
    const unroled = state.hardware.devices.filter((d) => d.kind === "motor" && (!d.role || d.role === "other") && Math.abs(link.actuators[d.name]?.power ?? 0) > 0.05).map((d) => d.name);
    roleWarning = unroled.length ? `⚠ powered motor${unroled.length > 1 ? "s" : ""} without a role in the Hardware map: ${unroled.join(", ")} — set the role (left/right/frontLeft… flywheel, intake) or load a names preset` : undefined;
    const l = state.robot.launcher;
    l.rpm = clamp(act.flywheelRpm, 0, l.maxRpm);
    if (act.hoodPos !== undefined && l.elevationMinDeg !== l.elevationMaxDeg) l.elevationDeg = l.elevationMinDeg + act.hoodPos * (l.elevationMaxDeg - l.elevationMinDeg);
    stepFeeders(dt);
  } else {
    // manual driving: the intake runs while K / LT is held, after I / LB switched it on, or with the Auto intake assist
    if (actions.intakeToggle && !replaying) intakeOn = !intakeOn;
    playerAgent.intakeActive = !replaying && (state.autoIntake || intakeOn || actions.intakeHold);
    if (playerAgent.intakeActive && (intakeOn || actions.intakeHold)) guide.intakeUsed = true;
    if (!replaying) {
      // what the keys have done so far: 30 cm of travel or 25° of turning count as "done"
      if (cmd.forward || cmd.left) guide.travelled += Math.hypot(vel0.vx, vel0.vz) * dt;
      if (cmd.turn) guide.rotated += Math.abs(vel0.yawRate) * dt;
      if (guide.travelled > 0.3) guide.moved = true;
      if (guide.rotated > 0.44) guide.turned = true;
    }
    link.takeServoTransitions();
    // keep encoders moving sensibly when the keyboard drives, so init_loop telemetry is not frozen
    stepActuators(actuatorModel, state.hardware, {}, dt, state.robot.drivetrain, state.pose.heading, state.robot.wheelDiameterM, dp.trackWidthM, dp.wheelbaseM, physicsInput());
    stallFor.clear(); stallActive = false; notMoving = undefined;
  }
  // other robots are not static obstacles: contact with them is a pushing contest, resolved below
  const others: Obstacle[] = [];
  const prevPose = state.pose;
  if (contactHolds()) { // kinematic drive (ideal profile, keyboard): no travel into the contact either
    const f = forwardVector(state.pose.heading), into = vel.vx * f.x + vel.vz * f.z;
    if (Math.sign(into) === contactBlock!.fwdSign) vel = { ...vel, vx: vel.vx - f.x * into, vz: vel.vz - f.z * into };
  }
  state.pose = stepPose(state.pose, vel, dt, footprintOf(state.robot), fieldObstacles(), WALL_MU[state.robot.drivetrain]);
  robot.setPose(state.pose);
  if (wheelSpinOn()) { // world velocity -> robot frame (+X forward, +left)
    const h = state.pose.heading;
    robot.spinWheels(dt, vel.vx * -Math.sin(h) + vel.vz * -Math.cos(h), vel.vx * -Math.cos(h) + vel.vz * Math.sin(h), vel.yawRate);
  }
  perf.mark("drive");

  // aim after the collision push-out so a teleport into the frame still ends up pointed at the target
  if (aimSnapRequest) {
    aimSnapRequest = false;
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
      state.pose = stepPose(state.pose, { vx: 0, vz: 0, yawRate: 0 }, 0.001, footprintOf(state.robot), [...fieldObstacles(), ...others]);
      robot.setPose(state.pose);
    }
    void ex;
  }

  // match clock
  if (state.matchPhase === "running") {
    if (state.matchTransition !== undefined) {
      // the 8 s AUTO→TELEOP transition: the 2:30 clock holds at 2:00 (§10.4), robots sit still, drivers pick up controllers
      state.matchTransition -= dt;
      if (state.matchTransition <= 0) state.matchTransition = undefined;
    } else {
      const before = state.matchClock ?? MATCH_SECONDS;
      state.matchClock = Math.max(0, before - dt);
      if (state.autoTransition && before > MATCH_SECONDS - AUTO_SECONDS && state.matchClock <= MATCH_SECONDS - AUTO_SECONDS) { state.matchClock = MATCH_SECONDS - AUTO_SECONDS; state.matchTransition = TRANSITION_SECONDS; }
      if (state.matchClock <= 0) state.matchPhase = "stopped";
    }
  } else state.matchTransition = undefined;
  const inTransition = state.matchTransition !== undefined;
  // scripted robots (only while the match runs, and not during the transition)
  if (state.opponents && !state.pauseOpponents && state.matchPhase === "running" && !inTransition) {
    const me: Obstacle = { xMin: state.pose.x - state.robot.widthM / 2, xMax: state.pose.x + state.robot.widthM / 2, zMin: state.pose.z - state.robot.lengthM / 2, zMax: state.pose.z + state.robot.lengthM / 2 };
    scripted.forEach((s, i) => {
      s.brainDriven = state.opponentsScore;
      const ag = scriptedAgents[i];
      ag.pose = s.pose;
      ag.footprint = s.footprint;
      const T = TIERS[state.aiTier];
      s.speed = T.speedMps;
      if (state.opponentsScore) match.driveScripted(s, ag, dt); else ag.intakeActive = false;
      // parking, per tier: Medium and Hard head for the LOADING ZONE when the time left is about the drive time plus a
      // margin (TELEOP PARK 5 pts); Hard does the same at the end of AUTO (AUTO PARK); Easy never parks
      const zone = LOADING_ZONE[ag.alliance];
      const driveS = Math.hypot((zone.xMin + zone.xMax) / 2 - s.pose.x, (zone.zMin + zone.zMax) / 2 - s.pose.z) / (0.8 * T.speedMps) + 0.4;
      const clock = state.matchClock ?? 0;
      const parkEnd = T.parksEnd && clock < Math.max(driveS + 1.6, 6);
      const parkAuto = T.parksAuto && clock > MATCH_SECONDS - AUTO_SECONDS && clock - (MATCH_SECONDS - AUTO_SECONDS) < driveS + 1.6;
      if (parkEnd || parkAuto) {
        const z = LOADING_ZONE[ag.alliance];
        s.brainDriven = true;
        if (inZone(s.pose, s.footprint, z)) s.target = { x: s.pose.x, z: s.pose.z }; // partially in: hold, do not shove the partner
        else {
          // two spots along the zone (it is 23 in long): take the one farther from every other robot so both partners fit
          const x = (z.xMin + z.xMax) / 2 + (z.xMin < 0 ? 0.12 : -0.12);
          const spots = [{ x, z: (z.zMin + z.zMax) / 2 - 0.2 }, { x, z: (z.zMin + z.zMax) / 2 + 0.2 }];
          const others = allAgents.filter((o) => o !== ag).map((o) => o.pose);
          const room = (p: { x: number; z: number }) => Math.min(...others.map((o) => Math.hypot(o.x - p.x, o.z - p.z)), 9);
          s.target = spots.sort((a, b) => room(b) - room(a))[0];
        }
      }
      // other scripted robots are obstacles too, so they route around and push off each other instead of overlapping
      const peers: Obstacle[] = scripted.filter((o) => o !== s).map((o) => ({ xMin: o.pose.x - o.footprint.widthM / 2, xMax: o.pose.x + o.footprint.widthM / 2, zMin: o.pose.z - o.footprint.lengthM / 2, zMax: o.pose.z + o.footprint.lengthM / 2 }));
      stepScripted(s, dt, peers, [me], match.now());
    });
  }
  // robot-vs-robot pushing (player vs each scripted robot) and the G421 pin count
  let contactText: string | undefined, contactBad = false;
  if (state.opponents) {
    const meBody: ContactBody = { pose: state.pose, fp: footprintOf(state.robot), drivetrain: state.robot.drivetrain, massKg: state.robot.massKg ?? 12, vx: vel.vx, vz: vel.vz };
    for (const s of scripted) {
      const sBody: ContactBody = { pose: s.pose, fp: s.footprint, drivetrain: "tank", massKg: 12, vx: s.cmdVel?.vx ?? 0, vz: s.cmdVel?.vz ?? 0 };
      const res = resolveContact(meBody, sBody, prevPose, s.prevPose ?? s.pose, dt);
      if (res.contact) { state.pose = res.a; meBody.pose = res.a; s.pose = res.b; robot.setPose(state.pose); }
      pins.update(dt, { a: "You", b: s.name, poseA: state.pose, poseB: s.pose, pushing: res.contact && res.pusher ? { pinner: res.pusher, held: res.held } : undefined });
      if (res.contact && res.pusher) contactText = res.pusher === "b" ? `${s.name} is pushing you${res.held ? " — you are holding" : ""}` : `you are pushing ${s.name}${res.held ? " — they are holding" : ""}`;
      // a scripted pinner backs off before the 3-count (a human driver would too)
      const pin = pins.current(s.name);
      if (pin && pin.pinner === s.name && pin.count > PIN_LIMIT_S * 0.7 && !s.backoff) {
        const dx = s.pose.x - state.pose.x, dz = s.pose.z - state.pose.z, d = Math.hypot(dx, dz) || 1;
        s.backoff = { until: match.now() + 3, target: { x: clamp(s.pose.x + (dx / d) * 0.9, -1.6, 1.6), z: clamp(s.pose.z + (dz / d) * 0.9, -1.6, 1.6) } };
      }
    }
    const myPin = pins.current("You");
    if (myPin) { contactText = `${myPin.pinner === "You" ? `you are pinning ${myPin.pinned}` : `${myPin.pinner} is pinning you`} · ${myPin.count.toFixed(1)} s of ${PIN_LIMIT_S}`; contactBad = myPin.count >= PIN_LIMIT_S; }
    const fouls = [...pins.fouls.entries()].map(([n, k]) => `${n} ${k}`).join(", ");
    if (fouls) contactText = `${contactText ?? "no contact"} · fouls: ${fouls}`;
    if (pins.lastCall && pins.lastCall.at !== lastFoulLogged) { lastFoulLogged = pins.lastCall.at; recorder.event(Date.now(), "foul", pins.lastCall.text); }
    if (pins.lastCall && match.now() - pins.lastCall.at < 4) { contactText = `${pins.lastCall.text}${contactText ? " · " + contactText : ""}`; contactBad = true; }
  }
  scriptedObjs.forEach((o, i) => { o.group.visible = state.opponents; o.setPose(scripted[i].pose); if (wheelSpinOn()) o.spinFromPose(dt); Match.renderCarry(scriptedAgents[i].carryGroup, scriptedAgents[i].inventory, scriptedAgents[i].alliance, o.spec.heightM); });
  // our agent
  playerAgent.pose = state.pose;
  playerAgent.footprint = footprintOf(state.robot);
  playerAgent.intakeGeom = state.robot.intake;
  robot.setIntakeActive(playerAgent.intakeActive);
  Match.renderCarry(playerAgent.carryGroup, playerAgent.inventory, playerAgent.alliance, state.robot.heightM);
  perf.mark("robots");
  if (!replaying && match.pickupBlockedByIntake(playerAgent)) intakeBlockedUntil = performance.now() + 4000;
  if (!replaying && match.pickupBlockedByCapacity(playerAgent)) fullBlockedUntil = performance.now() + 4000;
  if (replaying || playerAgent.inventory.pollen + playerAgent.inventory.nectar < playerAgent.caps.capacity) fullBlockedUntil = 0;
  if (replaying || playerAgent.intakeActive || playerAgent.inventory.pollen + playerAgent.inventory.nectar >= playerAgent.caps.capacity) intakeBlockedUntil = 0;
  robot.spinIntake(dt, playerAgent.intakeActive);
  match.update(dt, state.opponents ? allAgents : [playerAgent]);
  applyBallContact();
  audio?.update({ phase: state.matchPhase ?? "setup", clock: state.matchClock ?? MATCH_SECONDS, transition: state.matchTransition, shots: shotsFired, intakes: playerAgent.picks ?? 0, /* only our robot's shots and swallows sound: the cue tells the driver what their robot did */ tipsStarted: match.tipsStarted, tipsDone: match.tipsDone, bounces: drainImpacts() }, dt);
  scoreboard.update(state.matchPhase ?? "setup", state.matchClock ?? MATCH_SECONDS, MATCH_SECONDS, scoreRobots(), { red: match.hives.red.tips, blue: match.hives.blue.tips });
  matchScoreView.update(allianceScore(state.alliance), state.alliance, state.matchPhase ?? "setup", state.matchClock ?? MATCH_SECONDS,
    scoreRobots().filter(r => r.alliance === state.alliance).length, replaying, state.infiniteAmmo, { massKg: match.cellLoad(state.alliance).massKg, thresholdKg: state.tipMassG / 1000, tipping: !!match.hives[state.alliance].tipping, autoTip: state.autoTip });
  perf.mark("match");

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
  lastFireDir = fireDir; lastExit = exit;
  // arc along the direction the launcher points right now, plus Monte Carlo dispersion
  const actualShot = computeActual(exit, tf, fireDir);
  const mc = computeMonteCarlo(exit, tf, fireDir);
  // the analysed arc is always toward the target (what the robot would do if aimed); the fired ball goes where the launcher points
  const { shot, scan, required } = computeShot(exit, tf);
  if (!runtimeActive && !replaying) {
    const l = state.robot.launcher;
    const target = state.autoRpm ? (autoRpmTarget ?? l.rpm) : rpmCmd;
    const next = slewRpm(l.rpm, target, dt);
    if (next !== l.rpm) { l.rpm = next; shotCache.key = ""; } // the cache key folds the launcher in; a changed rpm must re-evaluate "as fired now"
    lastActualRpm = l.rpm;
  } else lastActualRpm = state.robot.launcher.rpm;
  void required;
  // hit chance from this spot once aimed and spun up (what the hit map shows); equals mc when the robot already is
  const spunUp = required !== undefined && Math.abs(exitSpeed(l) - required) <= 0.02 * required;
  const mcIdeal = required === undefined ? undefined : turretOk && spunUp ? mc : computeMonteCarloIdeal(exit, tf, required);
  robot.launcherMarker.rotation.y = (l.yawOffsetDeg * Math.PI) / 180 + turretYaw; // local +Y rotation = yaw left
  if ((actions.launch || state.shootRequest) && !runtimeActive && !replaying) launch(exit, fireDir);
  state.shootRequest = false;
  while (pendingFires > 0) { pendingFires--; launch(exit, fireDir); }
  perf.mark("shot");
  updateFlying(dt);
  perf.mark("balls");

  // overlays
  perf.mark("analysis");
  updateReachMap(tf);
  updateHitMap(tf);
  // a tip flips the up cell inside the Match; the panel's hive selectors and section hints only re-render on user changes
  const hiveNow = `${state.hive.red}/${state.hive.blue}`;
  if (hiveNow !== lastHiveShown) { lastHiveShown = hiveNow; panel.render(); }
  perf.mark("hitmap");
  overlays.setTrajectory(shot, ballProps().diameterM / 2, turretOk);
  overlays.setActualTrajectory(actualShot, ballProps().diameterM / 2);
  overlays.setDispersion(mc?.points);
  overlays.setFan(scan?.solutions ?? []);
  overlays.setTarget(tf, target);
  overlays.setAim(exit, target, turretOk);

  perf.mark("overlays");
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
    tags = analyseTags(selected.cam, selected.intr, field.tagMeshes, occluders).map((v) => state.tagCovers.includes(v.id) ? { ...v, occluded: true, visible: false } : v);
    lastTags = tags;
  }

  // runtime sensors
  if (link.connected) {
    lastCamInfos = camInfos; // the sensor timer computes the detections at camera rate, independent of the render rate
    lastYawRate = vel.yawRate;
    if (!link.running) imuYawRef = 0;
    panel.updateTelemetry(link.telemetry, `${link.status}${link.currentOpMode ? " · " + link.currentOpMode : ""}`);
  }

  perf.mark("tags+link");
  // HUD
  const speed = Math.hypot(vel.vx, vel.vz);
  const apex = shot ? Math.max(...shot.samples.map((s) => s.pos.y)) : undefined;
  const flight = shot?.crossing ? shot.samples.find((s) => { const d = (s.pos.x - tf.openingCenter.x) * tf.normal.x + (s.pos.y - tf.openingCenter.y) * tf.normal.y + (s.pos.z - tf.openingCenter.z) * tf.normal.z; return d <= 0; })?.t : undefined;
  const replaySample = replaying ? recorder.at(recorder.cursor!) : undefined;
  if (replaySample) applyReplay(replaySample); else restoreLive();
  const replayRun = replaySample ? recorder.runAt(replaySample.t) : undefined;
  const replayBanner = replaySample ? `⏪ REPLAY ${replayRun ? `run +${((replaySample.t - replayRun.start) / 1000).toFixed(1)} s${replayRun.opMode ? " · " + replayRun.opMode : ""}` : new Date(replaySample.t).toLocaleTimeString()} · ${((recorder.end ?? replaySample.t) - replaySample.t) / 1000 > 0 ? `${(((recorder.end ?? replaySample.t) - replaySample.t) / 1000).toFixed(1)} s ago` : "now"} · ${replaySample.status}${replaySample.scene ? ` · ${replaySample.scene.phase} ${replaySample.scene.clock.toFixed(0)} s · score ${replaySample.scene.score[0]}–${replaySample.scene.score[1]}` : ""} · live sim paused` : undefined;
  // what the HUD shows about the shot, kept for the agent API (/api/state → shot)
  const flyDev = state.hardware.devices.find((d) => d.kind === "motor" && d.role === "flywheel");
  const freeRpm = flyDev?.freeRpm ?? l.maxRpm;
  lastShotInfo = {
    target: `${state.alliance} hive, ${state.hive[state.alliance]} cell`,
    rangeIn: +mToIn(Math.hypot(target.x - exit.x, target.z - exit.z)).toFixed(1), bearingErrDeg: +rad2deg(bearingErr).toFixed(1), aimed: turretOk,
    hoodDeg: l.elevationDeg, exitHeightIn: +mToIn(l.exitHeightM).toFixed(1), aimInsideIn: +mToIn(lastAimInsideM).toFixed(2),
    requiredSpeedMps: required !== undefined ? +required.toFixed(2) : undefined, requiredRpm: required !== undefined ? Math.round(rpmForExitSpeed(l, required)) : undefined,
    requiredPower: required !== undefined ? +(rpmForExitSpeed(l, required) / freeRpm).toFixed(3) : undefined, flywheelFreeRpm: freeRpm,
    currentRpm: Math.round(l.rpm), currentPower: +(l.rpm / freeRpm).toFixed(3), currentSpeedMps: +exitSpeed(l).toFixed(2),
    predictedHit: shot?.hit, heightErrorIn: shot ? +mToIn(shot.heightError).toFixed(1) : undefined, asPointedHit: actualShot?.hit,
    bestAngleDeg: scan?.best ? +rad2deg(scan.best.elevationRad).toFixed(1) : undefined,
    launcher: { efficiency: l.efficiency, wheelDiameterMm: Math.round(l.wheelDiameterM * 1000), maxRpm: l.maxRpm, spinFraction: l.spinFraction },
    note: "requiredPower = required RPM / the flywheel motor's free RPM in the Hardware map (what setPower needs with no load); heightErrorIn is for the current commanded RPM",
  };
  notePicks();
  hud.update({
    notMoving, feeder: feederNote, feederPulses, launches: shotsFired,
    poseIn: replaySample ? { x: replaySample.pose.xIn, z: replaySample.pose.zIn, headingDeg: replaySample.pose.headingDeg } : { x: mToIn(state.pose.x), z: mToIn(state.pose.z), headingDeg: rad2deg(state.pose.heading) },
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
    requiredPower: required !== undefined && freeRpm > 0 ? rpmForExitSpeed(l, required) / freeRpm : undefined,
    currentPower: freeRpm > 0 ? l.rpm / freeRpm : undefined,
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
    pIdeal: mcIdeal?.pHit, pIdealLo: mcIdeal?.lo, pIdealHi: mcIdeal?.hi, idealMissIn: mcIdeal ? mToIn(mcIdeal.meanMissM) : undefined,
    nowReason: mcIdeal && mc && mcIdeal !== mc ? [turretOk ? undefined : "not aimed", spunUp ? undefined : `flywheel at ${Math.round(l.rpm)} RPM`].filter(Boolean).join(", ") : undefined,
    actualHit: actualShot?.hit,
    shotsFired, shotsHit,
    cellLoad: (() => { const c = match.cellLoad(state.alliance); return `${c.nectar} nectar + ${c.pollen} pollen = ${(c.massKg * 1000).toFixed(0)} g / ${state.tipMassG} g to tip`; })(),
    tips: match.hives[state.alliance].tips,
    score: (() => {
      const ours = allianceScore(state.alliance);
      const n = scoreRobots().filter((r) => r.alliance === state.alliance).length;
      const you = scoreboard.robots.get(playerAgent.id);
      const inAuto = state.matchPhase === "running" && (state.matchClock ?? 0) > MATCH_SECONDS - 30;
      const mine = you ? `you: LEAVE ${you.leave ? "✓" : "✗"} · AUTO PARK ${you.autoPark ? "✓" : "✗"} · PARK ${you.teleopPark ? "✓" : "✗"}${you.inZoneNow ? " · in LOADING ZONE" : ""}${inAuto ? " (AUTO, assessed at 0:30)" : ""}` : "";
      return `${state.alliance.toUpperCase()} ${ours.total} (auto ${ours.auto}) · ${ours.bonusRp} bonus RP · ${describeScore(ours, n)}${mine ? " · " + mine : ""}`;
    })(),
    tipping: match.hives[state.alliance].tipping ? `TIPPING… ${(match.hives[state.alliance].tipping!.duration - match.hives[state.alliance].tipping!.t).toFixed(1)} s` : undefined,
    carrying: state.infiniteAmmo ? `∞ ${state.ballKind} (practice: infinite ammo)` : `${playerAgent.inventory.pollen} pollen + ${playerAgent.inventory.nectar} nectar (${playerAgent.inventory.pollen + playerAgent.inventory.nectar}/${playerAgent.caps.capacity})`,
    pickupBlocked: performance.now() < intakeBlockedUntil,
    pickupFull: performance.now() < fullBlockedUntil ? `${playerAgent.inventory.pollen + playerAgent.inventory.nectar}/${playerAgent.caps.capacity}` : undefined,
    intake: playerAgent.intakeActive ? (runtimeActive ? "running (TeamCode)" : state.autoIntake ? "running (auto)" : "running") : runtimeActive ? "off · power the intake motor" : "off · I toggles, K runs",
    intakeOn: playerAgent.intakeActive,
    intakeManual: !runtimeActive,
    guide: { moved: guide.moved, turned: guide.turned, intakeUsed: guide.intakeUsed },
    rpmTarget: runtimeActive ? undefined : state.autoRpm ? autoRpmTarget : rpmCmd,
    rejected: playerAgent.rejected && match.now() - playerAgent.rejected.at < 3 ? (playerAgent.rejected.kind === "nectar" ? (playerAgent.rejected.alliance !== playerAgent.alliance ? `the other alliance's NECTAR (G408: never yours to take)` : `NECTAR (Can intake NECTAR is off in Field & target)`) : `POLLEN (Can intake POLLEN is off in Field & target)`) : undefined,
    nectarReleased: match.lastNectarRelease && match.lastNectarRelease.alliance === state.alliance && match.now() - match.lastNectarRelease.at < 6,
    aimingDeg: aimHeading === undefined ? undefined : Math.abs(wrapAngle(aimHeading - state.pose.heading)) * 180 / Math.PI,
    autoRpm: state.autoRpm, autoHood: state.autoHood,
    launchBlocked: performance.now() < launchBlockedUntil ? launchBlockedMsg : undefined,
    supply: `flowers ${match.flowerStocks().join("/")} · nectar reserve red ${match.nectarSupply.red} blue ${match.nectarSupply.blue}`,
    theirHive: (() => { const o: Alliance = state.alliance === "red" ? "blue" : "red"; const c = match.cellLoad(o); const h = match.hives[o]; return `${h.upCell} cell up · ${(c.massKg * 1000).toFixed(0)} g · ${h.tips} tips${h.tipping ? " · TIPPING" : ""}`; })(),
    match: replayBanner ?? (state.matchPhase === "running" ? (state.matchTransition !== undefined ? `TRANSITION · drivers pick up your controllers · TELEOP in ${Math.ceil(state.matchTransition)} s` : `RUNNING · ${Math.floor((state.matchClock ?? 0) / 60)}:${String(Math.floor((state.matchClock ?? 0) % 60)).padStart(2, "0")} left`) : state.matchPhase === "stopped" ? `STOPPED${(state.matchClock ?? 1) <= 0 ? " · time" : ""} · Reset to start, or START again` : `SETUP · robots on their marks · Start match (or INIT → START your OpMode)`),
    matchClass: replayBanner ? "warn" : (state.matchPhase === "running" ? "ok" : state.matchPhase === "stopped" ? "bad" : "warn"),
    contact: contactText, contactBad,
    tags: lastTags,
    cameraName: selected?.mount.name ?? "none",
    modelStatus: { box: "procedural box", loading: "loading goBILDA CAD…", loaded: "goBILDA CAD", failed: "CAD not found → box (see README)" }[robot.modelStatus],
    runtime: link.connected ? `${link.status}${link.currentOpMode ? " · " + link.currentOpMode : ""}${link.status === "INIT" ? " · press START to drive" : ""} · keyboard = gamepad${input.keyboardPad}${input.keyboardPad === 2 ? " (select Gamepad 1 in the control bar to switch)" : ""}` : "not connected",
    notice: [performance.now() < launchBlockedUntil ? launchBlockedMsg : undefined, roleWarning, qualityNotice && performance.now() < qualityNotice.untilMs ? qualityNotice.text : undefined, fps < 20 && !perfMode() ? `${fps.toFixed(0)} fps${slowdown < 1 ? `, sim at ${Math.round(slowdown * 100)}% of real time` : ""}: View & overlays → Visual quality → Performance` : undefined].filter(Boolean).join(" · ") || undefined,
    noticeBad: performance.now() < launchBlockedUntil || !!roleWarning,
  });

  perf.mark("hud");
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
  const viewRect = canvas.getBoundingClientRect();
  const markerPoint = (point: THREE.Vector3) => {
    const p = point.project(cam);
    return { x: viewRect.left + (p.x + 1) * viewRect.width / 2, y: viewRect.top + (1 - p.y) * viewRect.height / 2, visible: p.z >= -1 && p.z <= 1 && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.95 };
  };
  workspace.projectMarkers(markerPoint(new THREE.Vector3(robot.group.position.x, 0.6, robot.group.position.z)), markerPoint(new THREE.Vector3(target.x, target.y + 0.2, target.z)));
  const upHeading = state.fieldCentric ? allianceDriveHeading(state.alliance) : state.pose.heading;
  const compassOrigin = state.fieldCentric ? { x: 0, z: 0 } : state.pose;
  const compassBase = markerPoint(new THREE.Vector3(compassOrigin.x, 0.3, compassOrigin.z));
  const compassTip = markerPoint(new THREE.Vector3(compassOrigin.x - Math.sin(upHeading), 0.3, compassOrigin.z - Math.cos(upHeading)));
  workspace.updateCompass(compassTip.x - compassBase.x, compassTip.y - compassBase.y);
  const showGizmos = cam !== selected?.cam;
  robot.cameraGizmos.visible = showGizmos;
  robot.launcherMarker.visible = showGizmos;
  for (const a of allAgents) a.carryGroup.visible = showGizmos;
  // headless: rendering is pure overhead for a test (nobody watches), and a software-GL render of the field can block
  // the main thread, and with it the 50 Hz sensor sender, for a second on a loaded machine. Render the first frames
  // (shader compilation, so it does not land inside a run), then one frame a second; scripts call __twin.renderNow()
  // before a screenshot.
  const renderThisFrame = !ciMode || renderCount < 3 || now - lastRenderAt >= 1000 || renderRequested;
  renderRequested = false;
  if (renderThisFrame) { lastRenderAt = now; renderCount++; }
  venueFx.group.visible = state.stadium && !perfMode() && state.view !== "top"; // the top-down view is for analysis: no truss fixtures in the way
  if (renderThisFrame && venueFx.group.visible) venueFx.update(real, now);
  if (renderThisFrame) renderer.render(scene, cam);
  perf.mark("render");

  // PiP: every enabled camera gets an inset (except the one filling the main view)
  const pipCams = state.pip && !perfMode() ? camInfos.filter((c) => c.enabled && !(state.view === "robot" && c.selected)).slice(0, 2) : [];
  ensurePips(pipCams.length);
  pips.forEach((p, i) => {
    const c = pipCams[i];
    p.el.classList.toggle("hidden", !c);
    if (!c) { p.camId = undefined; return; }
    p.camId = c.mount.id;
    p.el.classList.toggle("selected", c.selected);
    if (p.el.clientWidth && (p.canvas.width !== p.el.clientWidth || p.canvas.height !== p.el.clientHeight)) p.renderer.setSize(p.el.clientWidth, p.el.clientHeight, false);
    // two insets: refresh each on alternate frames; the scene is rendered three times per frame otherwise and the
    // GPU, not the JS, is what limits the frame rate with the CAD loaded
    if (!renderThisFrame || (pipCams.length > 1 && (analysisTick + i) % 2 === 1)) return;
    robot.cameraGizmos.visible = false;
    robot.launcherMarker.visible = false;
    for (const a of allAgents) a.carryGroup.visible = false;
    overlays.group.visible = false;
    p.renderer.render(scene, c.cam);
    overlays.group.visible = true;
    robot.launcherMarker.visible = true;
    for (const a of allAgents) a.carryGroup.visible = true;
    p.label.textContent = `${c.mount.name} · ${c.intr.width}x${c.intr.height} · ${(c.intr.hfov * 180 / Math.PI).toFixed(0)}°x${(c.intr.vfov * 180 / Math.PI).toFixed(0)}°`;
  });

  perf.mark("insets");
  recordSample(now);
  perf.end(state.showPerf, fps);
  if (analysisTick % 120 === 0) saveState(state);
  const frameMs = performance.now() - now;
  if (frameMs > 150 && now - lastSlowNote > 1000) { lastSlowNote = now; recorder.event(Date.now(), "note", `slow frame ${frameMs.toFixed(0)} ms (${link.status}, render ${renderThisFrame ? "yes" : "no"}, dt ${(dt * 1000).toFixed(0)} ms)`); }
  if (ciMode) setTimeout(() => frame(performance.now()), 8); else requestAnimationFrame(frame);
}
// debugging hook for scripts / console
Object.defineProperty(window, "__twinRenderCount", { get: () => renderCount });
(window as any).__twinRenderNow = () => { renderRequested = true; };
(window as any).__twin = { state, workspace, orbitCam, controls, robot, scene, flying, link, overlays, recorder, snapshotContext, knobs: () => twinKnobs(state), actuatorModel, input, match, playerAgent, scripted, stats: () => ({ shotsFired, shotsHit, launches: shotsFired, feederPulses, stalls: stallCount, notMoving, feeder: feederNote, flywheelPeakPower: +flywheelPeak.toFixed(3) }), truth: worldTruth, resetPeaks: () => { flywheelPeak = 0; }, manifest: buildManifest, capabilities: () => capabilities(), syncTagCovers, predicted: () => actualCache.shot, ifAimed: () => shotCache.shot, dbg: () => ({ fireDir: lastFireDir, exit: lastExit }), perf, get offload() { return offload; }, hitmap: () => hitShown, hitmapOther: () => hitJobs[state.hive[state.alliance] === "audience" ? "scoring" : "audience"], hitmapDone: () => !!hitShown && hitShown.done, __pins: pins, calibration: { lastImpact: () => lastImpact, session: () => state.calibration }, score: () => ({ red: allianceScore("red"), blue: allianceScore("blue") }), scoreboard, get panel() { return panel; } };
let lastTags: HudData["tags"] = [];
let pendingFires = 0;
let lastFireDir = { x: 0, z: -1 };
let lastExit: Vec3 = { x: 0, y: 0, z: 0 };

let lastTagsByCam: SensorPacket["tags"] = {};
let lastYawRate = 0;
let lastCamInfos: { mount: CameraMount; cam: THREE.PerspectiveCamera; intr: ReturnType<typeof intrinsicsFor>; enabled: boolean; selected: boolean }[] = [];
let lastTagScan = 0;
/** AprilTag detections for every webcam device, timestamped now: a real camera delivers frames at its own rate, so the
 * OpMode's freshness checks must not depend on how fast this page renders. Runs on the sensor timer at 20 Hz. */
function scanTagsForRuntime() {
  const nowMs = performance.now();
  if (nowMs - lastTagScan < 50 || !lastCamInfos.length) return;
  lastTagScan = nowMs;
  const occluders = [...field.occluders, ...scriptedObjs.filter((o) => o.group.visible).map((o) => o.chassis)];
  const tagsByCam: SensorPacket["tags"] = {};
  for (const dev of state.hardware.devices) if (dev.kind === "webcam") {
    const ci = lastCamInfos.find((c) => c.mount.id === (dev.cameraId ?? lastCamInfos[0]?.mount.id)) ?? lastCamInfos[0];
    if (!ci) { tagsByCam[dev.name] = []; continue; }
    // world truth first: a covered sticker is occluded whatever the decoder would do
    const vis = analyseTagsFor(ci.cam, ci.intr, field.tagMeshes, occluders).map((v) => state.tagCovers.includes(v.id) ? { ...v, occluded: true, visible: false } : v);
    let packets = buildDetections(ci.cam, ci.intr, vis, field.tagMeshes, state.pose, state.tagNoiseIn);
    // then the observation faults, downstream of the geometry
    if (state.perception.level === "faults") {
      const pixelsById: Record<number, number> = {}; for (const v of vis) pixelsById[v.id] = v.pixels;
      const r = applyFaults(packets, state.perception.faults, { yawRateDps: Math.abs(rad2deg(lastYawRate)), pixelsById });
      packets = r.out;
      const key = r.applied.join(",");
      if (key !== lastFaultsApplied) { if (key) recorder.event(Date.now(), "fault", `camera faults engaged on ${dev.name}: ${key}`, { camera: dev.name, applied: r.applied }); lastFaultsApplied = key; }
    }
    // the detector's frame rate (acquisition) and then the delivery latency; both keep the frame's true acquisition
    // time, which the host writes into frameAcquisitionNanoTime, so the OpMode's freshness gates see real ages
    const latency = state.perception.level === "faults" ? state.perception.faults.latencyMs : 0;
    const fps = state.perception.level === "faults" ? state.perception.faults.fpsCap : 0;
    let acquiredMs = nowMs, fresh = true;
    if (fps > 0) { let c = frameCadences.get(dev.name); if (!c) { c = new FrameCadence(); frameCadences.set(dev.name, c); } const held = c.next(nowMs, packets, fps); acquiredMs = held.t; packets = held.packets; fresh = held.fresh; }
    else frameCadences.get(dev.name)?.clear();
    if (latency > 0) {
      let q = latencyQueues.get(dev.name); if (!q) { q = new LatencyQueue(); latencyQueues.set(dev.name, q); }
      packets = (fresh ? q.push(acquiredMs, packets, latency, nowMs) : q.poll(nowMs, latency)) ?? [];
    } else { latencyQueues.get(dev.name)?.clear(); if (!fresh) packets = packets.map((p) => ({ ...p, ageMs: nowMs - acquiredMs })); }
    tagsByCam[dev.name] = packets;
  }
  lastTagsByCam = tagsByCam;
}
/** Feeder-role servos move balls through the throat; a ball reaching the flywheel becomes a launch. */
function stepFeeders(dt: number) {
  const transitions = link.takeServoTransitions();
  feederNote = undefined;
  for (const dev of state.hardware.devices) {
    if ((dev.kind !== "crservo" && dev.kind !== "servo") || dev.role !== "feeder") continue;
    const a = link.actuators[dev.name];
    let fs = feeders.get(dev.name);
    if (!fs) { fs = createFeederState(); feeders.set(dev.name, fs); if (dev.kind === "servo") fs.last = a?.position ?? 0.5; } // a servo's resting position is not a rising edge
    const hopper = state.infiniteAmmo ? 99 : playerAgent.inventory.pollen + playerAgent.inventory.nectar;
    const th = dev.fireThreshold ?? 0.5;
    let value = dev.kind === "crservo" ? (a?.power ?? 0) : (a?.position ?? fs.last);
    if (dev.kind === "crservo") {
      // which way feeds is a wiring fact (device "feedDirection"); without it, either direction carries the ball forward
      const dir = (dev as { feedDirection?: number }).feedDirection ?? 0;
      value = dir && Math.sign(value) !== dir && value !== 0 ? -Math.abs(value) : Math.abs(value);
    } else if (transitions.some((t) => t.name === dev.name && t.from < th && t.to >= th)) { fs.last = 0; value = Math.max(value, th); } // a pulse shorter than a frame still counts
    const pulsesBefore = fs.pulses, posBefore = fs.ballPosM;
    const r = stepFeeder(fs, state.feed, { kind: dev.kind, value, threshold: th, hopper, dt });
    if (fs.pulses !== pulsesBefore) {
      feederPulses++;
      const need = dev.kind === "crservo" ? transitSeconds(state.feed, value) : state.feed.strokeS;
      recorder.event(Date.now(), "feed", `feeder pulse #${feederPulses} on ${dev.name}${dev.kind === "crservo" ? ` at ${Math.round(Math.abs(value) * 100)} %` : ""} · hopper ${hopper}${posBefore !== undefined ? ` · ball ${Math.round((posBefore / state.feed.throatM) * 100)} % along the throat` : ""} · needs ${Number.isFinite(need) ? need.toFixed(2) + " s" : "more power"}`, { device: dev.name, power: value, hopper, ballPosM: posBefore, transitS: need, pulses: feederPulses });
    }
    if (r.launch) {
      pendingFires++;
      const fly = state.hardware.devices.find((d) => d.kind === "motor" && d.role === "flywheel");
      const ms = fly && actuatorModel.motors.get(fly.name);
      if (ms) ms.revPerSec *= 1 - state.feed.rpmDropFrac; // the ball takes energy out of the wheel
      recorder.event(Date.now(), "launch", `ball reached the flywheel from ${dev.name} (pulse ${fs.pulses}, launch ${fs.launches}) at ${Math.round(state.robot.launcher.rpm)} RPM`, { device: dev.name, launches: fs.launches, pulses: fs.pulses, rpm: Math.round(state.robot.launcher.rpm) });
    }
    if (fs.ballPosM !== undefined) feederNote = `${dev.name}: ball ${Math.round((fs.ballPosM / state.feed.throatM) * 100)} % along the throat`;
    else if (fs.reason) feederNote = `${dev.name}: ${fs.reason}`;
  }
}
/** A game piece entered our robot: record what and where (the garden corner, a FLOWER, or the open floor / zone), so a
 *  collection check can ask for a POLLEN picked in the garden rather than any transfer (handoff G08). */
let lastPickInv = { pollen: -1, nectar: -1 };
function notePicks() {
  const inv = playerAgent.inventory;
  if (lastPickInv.pollen < 0) { lastPickInv = { ...inv }; return; }
  for (const kind of ["pollen", "nectar"] as const) {
    const gained = inv[kind] - lastPickInv[kind];
    if (gained <= 0) continue;
    const xIn = state.pose.x / IN, zIn = state.pose.z / IN;
    const g = state.alliance === "red" ? ZONES.gardenRedTape : ZONES.gardenBlueTape;
    const nearGarden = xIn >= g.xMin - 14 && xIn <= g.xMax + 14 && zIn >= g.zMin - 14 && zIn <= g.zMax + 14;
    const where = nearGarden ? "in the garden" : "on the floor";
    for (let i = 0; i < gained; i++) recorder.event(Date.now(), "pick", `picked ${kind.toUpperCase()} ${where} at (${xIn.toFixed(0)}, ${zIn.toFixed(0)}) in · carrying ${inv.pollen} + ${inv.nectar}`, { kind, where: nearGarden ? "garden" : "floor", xIn: +xIn.toFixed(1), zIn: +zIn.toFixed(1), inventory: { ...inv } });
  }
  lastPickInv = { ...inv };
}
/** Loose balls the chassis squeezed against the wall (match.pushBalls) held it: take the refused travel back out of the
 * pose and tell the drive model which way is blocked, so the shafts stall (or the wheels spin, by traction) instead of
 * the robot driving through a pile of game pieces (SG-005). One `contact` event per episode. */
function applyBallContact() {
  const bp = playerAgent.blocked;
  const nowMs = performance.now();
  if (bp && Math.hypot(bp.x, bp.z) > 2e-4) {
    state.pose = { ...state.pose, x: state.pose.x - bp.x, z: state.pose.z - bp.z };
    robot.setPose(state.pose); playerAgent.pose = state.pose;
    const f = forwardVector(state.pose.heading), along = f.x * bp.x + f.z * bp.z;
    const fwdSign: 1 | -1 = along >= 0 ? 1 : -1;
    if (fwdSign === contactBlock?.fwdSign && contactBlock.episode) { contactBlock.untilMs = nowMs + 250; contactBlock.at = { ...state.pose }; contactBlock.balls = Math.max(contactBlock.balls, bp.balls); }
    else {
      const sameEpisode = lastContactEvent && lastContactEvent.fwdSign === fwdSign && nowMs - lastContactEvent.atMs < 2000; // one event per episode, not per frame the watchdog lets go
      contactBlock = { fwdSign, balls: bp.balls, untilMs: nowMs + 250, episode: true, at: { ...state.pose } };
      if (sameEpisode) return;
      lastContactEvent = { fwdSign, atMs: nowMs };
      if (Math.sign(actuatorModel.body.vFwd) === fwdSign) actuatorModel.body.vFwd = 0;
      const t = worldTruth();
      recorder.event(Date.now(), "contact", `chassis held by ${bp.balls} loose ball${bp.balls === 1 ? "" : "s"} against the wall while driving ${fwdSign > 0 ? "forward" : "backward"} at (${t.pose.xIn}, ${t.pose.zIn}) in · physics ${state.physics.kind}: ${state.physics.kind === "ideal" ? "kinematic stop (encoders keep counting)" : `grip ${state.physics.tractionMu ?? 1.2} decides stall vs wheel spin`}`, { balls: bp.balls, fwdSign, pose: t.pose, physics: state.physics.kind });
    }
  } else if (contactBlock && !contactHolds()) contactBlock = undefined;
}
/** Drive motors commanded without progress for half a second: say so (HUD) and record it (events), once per episode. */
function updateStallWatchdog(dt: number) {
  for (const name of actuatorModel.stalled) stallFor.set(name, (stallFor.get(name) ?? 0) + dt);
  for (const name of [...stallFor.keys()]) if (!actuatorModel.stalled.has(name)) stallFor.delete(name);
  const held = [...stallFor].filter(([, t]) => t >= 0.5);
  if (!held.length) { stallActive = false; notMoving = undefined; return; }
  const names = held.map(([n]) => n);
  const cmd = Math.max(...names.map((n) => Math.abs(link.actuators[n]?.power ?? 0)));
  const amps = Math.max(...names.map((n) => actuatorModel.currents.get(n) ?? 0));
  const b = actuatorModel.breakaway;
  notMoving = `Not moving: ${names.join(" + ")} at ${Math.round(cmd * 100)} % for ${Math.max(...held.map(([, t]) => t)).toFixed(1)} s, shafts still, ${amps.toFixed(1)} A each · breakaway on "${state.physics.kind}" ≈ ${Math.round(b.turn * 100)} % turning / ${Math.round(b.straight * 100)} % straight (${state.physics.provenance})`;
  if (!stallActive) {
    stallActive = true; stallCount++;
    recorder.event(Date.now(), "stall", notMoving, { motors: names, command: cmd, amps, breakaway: b, profile: state.physics.kind, volts: actuatorModel.volts });
  }
}
// Sensors go out on a fixed timer, not per render frame, so gamepad presses and encoder updates reach the
// OpMode at 50 Hz even when the page renders slowly (background tab, software GL).
window.setInterval(() => {
  if (!link.connected) return;
  scanTagsForRuntime();
  const g = input.gamepads();
  link.sendSensors({
    type: "sensors",
    motors: motorSensors(actuatorModel, state.hardware),
    imu: { yaw: rad2deg(wrapAngle(state.pose.heading - imuYawRef)), pitch: 0, roll: 0, yawRate: rad2deg(lastYawRate) },
    distances: {},
    tags: lastTagsByCam,
    gamepad1: g.g1,
    gamepad2: g.g2,
    battery: +actuatorModel.volts.toFixed(2),
    perception: { singles: state.perception.level === "singles" },
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
let mcIdealCache: { key: string; mc?: MonteCarlo; at: number } = { key: "", at: 0 };
/** Monte Carlo for the shot the robot would take from here once aimed at the target and spun up to the required speed. */
function computeMonteCarloIdeal(exit: Vec3, frame: CellFrame, required: number): MonteCarlo | undefined {
  const l = state.robot.launcher;
  const q = (v: number) => Math.round(v * 50) / 50; // 2 cm
  const key = JSON.stringify([q(exit.x), q(exit.y), q(exit.z), Math.round(required * 50), l.elevationDeg, l.wheelDiameterM, l.efficiency, l.spinFraction, state.ballKind, state.drag, state.alliance, state.hive, state.noise, state.monteCarloN]);
  const now = performance.now();
  if (key !== mcIdealCache.key && now - mcIdealCache.at < 120) return mcIdealCache.mc; // throttle while driving
  const ap = aimPoint(frame, 0.05);
  const dx = ap.x - exit.x, dz = ap.z - exit.z, d = Math.hypot(dx, dz) || 1;
  const speed = Math.min(required, exitSpeed(l, l.maxRpm));
  const nominal = { speed, elevationRad: (l.elevationDeg * Math.PI) / 180, dirXZ: { x: dx / d, z: dz / d }, spin: spinRate(l, rpmForExitSpeed(l, speed)) };
  const mc = offload.monteCarlo(key, { ball: ballProps(), launchPos: exit, target: ap, frame, spin: nominal.spin }, nominal, state.noise, state.monteCarloN, 7, mcIdealCache.mc);
  if (key !== mcIdealCache.key) mcIdealCache = { key, mc, at: now }; else mcIdealCache.mc = mc;
  return mc;
}
function computeMonteCarlo(exit: Vec3, frame: CellFrame, dir: { x: number; z: number }): MonteCarlo | undefined {
  const l = state.robot.launcher;
  const q = (v: number) => Math.round(v * 50) / 50; // 2 cm
  const key = JSON.stringify([q(exit.x), q(exit.y), q(exit.z), Math.round(Math.atan2(dir.x, dir.z) * 57.3), l.rpm | 0, l.elevationDeg, l.wheelDiameterM, l.efficiency, l.spinFraction, state.ballKind, state.drag, state.alliance, state.hive, state.noise, state.monteCarloN]);
  const now = performance.now();
  if (key !== mcCache.key && now - mcCache.at < 120) return mcCache.mc; // throttle while driving
  const nominal = { speed: exitSpeed(l), elevationRad: (l.elevationDeg * Math.PI) / 180, dirXZ: dir, spin: spinRate(l) };
  const mc = offload.monteCarlo(key, { ball: ballProps(), launchPos: exit, target: aimPoint(frame, 0.05), frame, spin: spinRate(l) }, nominal, state.noise, state.monteCarloN, 7, mcCache.mc);
  if (key !== mcCache.key) mcCache = { key, mc, at: now }; else mcCache.mc = mc;
  return mc;
}
// ---- hit-probability map: one incremental job per cell side. The side that is up now is computed first and drawn as it
// fills in; the other side is then computed in the background so that when the hive tips (or you press T) the map
// swaps instantly instead of starting over. Both are re-created when anything they depend on changes.
const offload = new BallisticsOffload(); // Monte Carlo + map maths in a Web Worker when available
let lastHiveShown = "";
let hitKey = "";
let hitJobs: Partial<Record<CellSide, HitMapJob>> = {};
let hitBatchIds: number[] = [];
let hitShown: HitMapJob | undefined;
let hitLastDraw = 0;
/** Would the selected camera see one of the target cell's tags if the robot stood at (x,z) aimed at that cell? */
function cellCameraVisibility(x: number, z: number, frame: CellFrame, frameSide: CellSide): boolean {
  const camMount = state.robot.cameras.find((c) => c.id === state.selectedCameraId) ?? state.robot.cameras[0];
  if (!camMount || !camMount.enabled) return true; // no camera to check against: do not dim
  const l = state.robot.launcher;
  const ap = aimPoint(frame, 0.05);
  const mid = (l.turretMinDeg + l.turretMaxDeg) / 2;
  let pose: Pose = { x, z, heading: 0 };
  for (let i = 0; i < 3; i++) {
    const e = robotToWorld(pose, l.exitForwardM, l.exitLeftM);
    pose = { ...pose, heading: headingToward(e, ap) - ((mid + l.yawOffsetDeg) * Math.PI) / 180 };
  }
  robot.setPose(pose);
  const cam = robot.worldCamera(camMount.id);
  if (!cam) return true;
  const vis = analyseTags(cam, intrinsicsFor(camMount), field.tagMeshes, field.occluders);
  return vis.some((t) => t.visible && t.alliance === state.alliance && t.side === frameSide);
}
function updateHitMap(frame: CellFrame) {
  if (!state.overlays.hitmap || perfMode()) { if (hitKey) { hitKey = ""; for (const id of hitBatchIds) offload.cancel(id); hitBatchIds = []; hitJobs = {}; hitShown = undefined; overlays.setHitMap(undefined); } return; }
  const l = state.robot.launcher;
  const camMount = state.robot.cameras.find((c) => c.id === state.selectedCameraId) ?? state.robot.cameras[0];
  // deliberately not keyed on which cell is up: both sides are kept, and a tip only changes which one is shown
  const key = JSON.stringify([hitMapLauncherKey(l), state.ballKind, state.drag, state.alliance, state.noise, camMount, state.robot.lengthM, state.robot.widthM, state.robot.modelYawDeg]);
  const side = state.hive[state.alliance], otherSide: CellSide = side === "audience" ? "scoring" : "audience";
  if (key !== hitKey) {
    hitKey = key;
    for (const id of hitBatchIds) offload.cancel(id);
    hitBatchIds = [];
    hitJobs = {
      [side]: new HitMapJob(frame, l, ballProps(), state.noise, 6, 40),
      [otherSide]: new HitMapJob(upCellFrame({ alliance: state.alliance, upCell: otherSide }), l, ballProps(), state.noise, 6, 40),
    };
    hitShown = undefined;
    // the probability maths goes to the worker (up cell first, then the other); the main thread keeps the visibility probe
    for (const sd of [side, otherSide]) {
      const job = hitJobs[sd]!;
      const id = offload.startBatch({ kind: "hitmap", ...job.batch() }, (from, results) => job.accept(from, results));
      if (id !== undefined) { job.offloaded = true; hitBatchIds.push(id); }
    }
  }
  const current = hitJobs[side]!;
  if (hitShown !== current) { hitShown = current; overlays.setHitMap(current); } // instant swap after a tip
  // work on the side that is up first, then the other one in the background (same per-frame budget)
  const other = hitJobs[otherSide]!;
  const work = !current.done ? current : !other.done ? other : undefined;
  if (!work) return;
  if (work.offloaded && work.computed >= (work as any).arrived) { // waiting on the worker: nothing to probe yet
    const now0 = performance.now();
    if (work === current && now0 - hitLastDraw > 150) { hitLastDraw = now0; overlays.setHitMap(current); }
    return;
  }
  const workSide = work === current ? side : otherSide;
  const workFrame = work === current ? frame : upCellFrame({ alliance: state.alliance, upCell: otherSide });
  const saved = state.pose;
  const k = work.step(5, (x, z) => cellCameraVisibility(x, z, workFrame, workSide));
  robot.setPose(saved); // visibility probing moved the robot object around
  const now = performance.now();
  if (work === current && k && (current.done || now - hitLastDraw > 150)) { hitLastDraw = now; overlays.setHitMap(current); }
}

let reachKey = "";
let reachJob: ReachJob | undefined;
let reachBatchId: number | undefined;
let reachLastDraw = 0;
let reachDrawnAt = -1;
function updateReachMap(frame: CellFrame) {
  if (!state.overlays.reach) { if (reachKey) { reachKey = ""; offload.cancel(reachBatchId); reachBatchId = undefined; reachJob = undefined; overlays.setReachMap(undefined); } return; }
  const l = state.robot.launcher;
  const key = JSON.stringify([l.wheelDiameterM, l.maxRpm, l.efficiency, l.elevationDeg, l.elevationMinDeg, l.elevationMaxDeg, l.exitHeightM, l.spinFraction, state.ballKind, state.drag, state.alliance, state.hive]);
  if (key !== reachKey) {
    reachKey = key;
    offload.cancel(reachBatchId);
    reachJob = new ReachJob(frame, l, ballProps(), 6);
    const job = reachJob;
    reachBatchId = offload.startBatch({ kind: "reach", ...job.batch() }, (from, results) => job.accept(from, results));
    reachLastDraw = 0; reachDrawnAt = -1;
  }
  if (!reachJob || reachDrawnAt === reachJob.computed) return; // nothing new since the last draw
  if (!reachJob.done && reachBatchId === undefined) reachJob.step(4); // no worker: a few squares per frame instead of a 600 ms freeze
  const now = performance.now();
  if (reachJob.done || now - reachLastDraw > 150) { reachLastDraw = now; reachDrawnAt = reachJob.computed; overlays.setReachMap(reachJob); }
}
requestAnimationFrame(frame);
