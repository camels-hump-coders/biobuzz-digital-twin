import * as THREE from "three";
import { camelsHumpHardwareConfig } from "./runtime/hardwareConfig";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildField } from "./field/buildField";
import { aimPoint, hiveTiltAngle, upCellFrame, type Alliance, type CellFrame, type CellSide, type Vec3 } from "./field/hive";
import { HitMapJob } from "./ballistics/hitmap";
import type { CameraMount } from "./robot/robotSpec";
import { resolveContact, type ContactBody } from "./sim/contact";
import { PinTracker, PIN_LIMIT_S } from "./sim/pinning";
import { startPose } from "./sim/starts";
import { computeBindings, mergeOverrides, parseBindings, twinKnobs } from "./runtime/bindings";
import { Recorder, type Run, type Sample, type SceneSnapshot } from "./runtime/recorder";
import type { ScriptedRobot } from "./sim/opponents";
import { Perf } from "./ui/perf";
import { setupUpdates } from "./pwa";
import { BALL, FIELD, m } from "./field/fieldSpec";
import { RobotObject, intrinsicsFor } from "./robot/robot";
import { Input } from "./sim/input";
import { commandToVelocity, stepPose, robotToWorld, headingToward, fieldObstacles, type DriveParams, type Obstacle, type Pose } from "./sim/drive";
import { defaultScriptedRobots, stepScripted } from "./sim/opponents";
import { Overlays } from "./ui/overlays";
import { Panel } from "./ui/panel";
import { Hud, type HudData } from "./ui/hud";
import { loadState, saveState, type AppState } from "./state";
import { evaluateShot, evaluateVelocity, scanElevations, solveSpeedForElevation, type ShotResult } from "./ballistics/solver";
import { exitSpeed, rpmForExitSpeed, spinRate } from "./ballistics/launcher";
import { computeReachability, type ReachMap } from "./ballistics/reachability";
import { monteCarlo, perturb, rng, type MonteCarlo } from "./ballistics/dispersion";
import { stepBall, type LiveBall } from "./sim/ballPhysics";
import { Match, type Agent } from "./sim/match";
import { RuntimeLink, type SensorPacket } from "./runtime/link";
import { createActuatorModel, stepActuators, motorSensors, feederFires } from "./runtime/actuators";
import { parseCalLines } from "./ballistics/calibration";
import { isSchemaFile, schemaFor, schemaPathFor, validateAll } from "./runtime/assetSchema";
import { applyOverrides } from "./runtime/assetExport";
import { Scoreboard, LOADING_ZONE, ballInGarden, describeScore, inZone, type RobotState } from "./sim/scoring";
import { inferDevice, deviceHints } from "./runtime/hardwareConfig";
import { buildDetections } from "./runtime/apriltags";
import { analyseTags as analyseTagsFor } from "./camera/robotCamera";
import { velocityFrom } from "./ballistics/projectile";
import { analyseTags, cameraPoseOf } from "./camera/robotCamera";
import { IN, clamp, mToIn, rad2deg, wrapAngle } from "./util/units";
import { clonePreset } from "./robot/presets";

const state: AppState = loadState();
// `pnpm sim` opens the page with ?runtime=1 so the twin connects to the host straight away
if (new URLSearchParams(location.search).get("runtime") === "1") state.runtimeEnabled = true;

// ---------- renderer & scenes
const canvas = document.getElementById("view") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// ?ci=1: headless test-bed mode (pnpm twin-test). Software GL renders a frame in ~200 ms, which would starve the
// simulation loop; render the view only every few ticks at low resolution and drive the loop with a timer so the
// physics, sensors and the OpMode see the same cadence as on a real display.
const ciMode = new URLSearchParams(location.search).get("ci") === "1";
renderer.setPixelRatio(ciMode ? 0.5 : Math.min(devicePixelRatio, 2));
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

// ---------- match dynamics (inventories, pickup, flowers, both hives)
const flying: LiveBall[] = [];
const match = new Match(scene, field, flying, state.hive, () => state.tipMassG / 1000, () => state.autoTip);
function makeAgent(id: string, alliance: Alliance, group: THREE.Group, caps: Agent["caps"], footprint: Agent["footprint"], intakeGeom: Agent["intakeGeom"]): Agent {
  const carryGroup = new THREE.Group();
  carryGroup.name = "carry";
  group.add(carryGroup);
  return { id, alliance, pose: { x: 0, z: 0, heading: 0 }, inventory: { pollen: Math.min(4, caps.capacity), nectar: 0 }, caps, intakeActive: false, footprint: { ...footprint }, intakeGeom: { ...intakeGeom }, intake: { x: 0, z: 0 }, lastPick: 0, carryGroup };
}
const playerAgent = makeAgent("player", state.alliance, robot.group, { capacity: state.capacity, pollen: state.canPollen, nectar: state.canNectar }, state.robot, state.robot.intake);
// scripted robots collect through a front mouth about two thirds of their width
const scriptedAgents = scripted.map((s, i) => makeAgent(s.name, "red", scriptedObjs[i].group, { capacity: 4, pollen: true, nectar: true }, s.footprint, { side: "front", widthM: s.footprint.widthM * 0.65 }));
const allAgents = [playerAgent, ...scriptedAgents];
const scoreboard = new Scoreboard();
function scoreRobots(): RobotState[] { return (state.opponents ? allAgents : [playerAgent]).map((a) => ({ id: a.id, alliance: a.alliance, pose: a.pose, footprint: a.footprint })); }
function allianceScore(a: Alliance) {
  let cell = 0, garden = 0;
  for (const f of flying) { if (f.inCell && (f as any).cellOf === a) cell++; else if (ballInGarden(f.pos.x, f.pos.z, f.radius, a)) garden++; }
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
    if (spec.color !== color) { spec.color = color; scriptedObjs[i].applySpec({ ...spec, color }); }
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
  state.pose = startPose(state.starts, "you", state.alliance, state.hive);
  robot.setPose(state.pose);
  parkScripted();
  state.matchPhase = "setup"; state.matchClock = MATCH_SECONDS;
}
function startMatch() { if (recorder.cursor !== undefined) { recorder.cursor = undefined; panel.refreshTimeline(); } if (state.matchPhase === "setup" || state.matchPhase === "stopped") { if (state.matchPhase === "stopped" && (state.matchClock ?? 0) <= 0) state.matchClock = MATCH_SECONDS; state.matchPhase = "running"; } }
function stopMatch() { if (state.matchPhase === "running") state.matchPhase = "stopped"; }
parkScripted();

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
  if (what === "reset") { applyRobotSpec(); if (link.connected) link.sendHardware(hardwareDevices(), hardwareHints()); playerAgent.caps = { capacity: state.capacity, pollen: state.canPollen, nectar: state.canNectar }; }
  if (what === "robot" || what === "cameras" || what === "launcher") applyRobotSpec();
  if (what === "runtime") syncRuntime();
  if (what === "hardware" && link.connected) link.sendHardware(hardwareDevices(), hardwareHints());
  if (what === "assets" && link.connected) link.sendAssetOverrides(mergeOverrides(state.assetOverrides, link.bound.overrides));
  if (what === "robot" || what === "cameras" || what === "launcher" || what === "hardware" || what === "sim" || what === "reset") syncBindings();
  if (what === "sim") {
    for (const a of ["red", "blue"] as Alliance[]) if (match.hives[a].upCell !== state.hive[a] && !match.hives[a].tipping) match.resetHive(a);
    playerAgent.alliance = state.alliance;
    assignAlliances();
    playerAgent.caps = { capacity: state.capacity, pollen: state.canPollen, nectar: state.canNectar };
    if (state.resetMatchRequest) { state.resetMatchRequest = false; resetBoard(); }
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
  if (json !== lastBoundJson) { lastBoundJson = json; if (link.connected) link.sendAssetOverrides(mergeOverrides(state.assetOverrides, link.bound.overrides)); panel.render(); }
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
      match: { phase: state.matchPhase, clock: +(state.matchClock ?? 0).toFixed(1) },
      score: { red: allianceScore("red"), blue: allianceScore("blue") },
      inventory: playerAgent.inventory, shots: { fired: shotsFired, hit: shotsHit }, cellLoad: { red: match.cellLoad("red"), blue: match.cellLoad("blue") },
      hives: { red: { upCell: match.hives.red.upCell, tips: match.hives.red.tips }, blue: { upCell: match.hives.blue.upCell, tips: match.hives.blue.tips } },
      selectedOpMode: panel.selectedOpMode, telemetry: link.telemetry, runtimeStatus: link.status, notice: launchBlockedUntil > performance.now() ? launchBlockedMsg : undefined,
      scripted: scripted.map((r, i) => ({ name: r.name, alliance: scriptedAgents[i].alliance, xIn: +(r.pose.x / IN).toFixed(1), zIn: +(r.pose.z / IN).toFixed(1) })),
    } };
    case "knobs": return { result: twinKnobs(state) };
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
      const allowed = /^(alliance|ballKind|autoRpm|autoHood|drag|fieldCentric|opponents|pauseOpponents|opponentsScore|autoTip|tipMassG|capacity|canPollen|canNectar|tagNoiseIn|monteCarloN|view|hive\.(red|blue)|overlays\.\w+|noise\.\w+|starts\.(you|partner|opp1|opp2)\.(xIn|zIn|headingDeg)|starts\.followUpCell|robot\.(lengthM|widthM|heightM|massKg|wheelDiameterM|wheelRpm|drivetrain|intake\.(side|widthM))|robot\.launcher\.\w+|hardware\.mirroredSide)$/;
      const set: string[] = [], rejected: string[] = [];
      for (const [path, value] of Object.entries(params)) {
        if (!allowed.test(path)) { rejected.push(path); continue; }
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
let lastLinkStatus = link.status;
link.onChange = () => {
  if (link.statusError && link.status === "ERROR") recorder.event(Date.now(), "error", link.statusError.split("\n")[0]);
  if (link.connected && !hardwareSent) { link.sendHardware(hardwareDevices(), hardwareHints()); link.sendAssetOverrides(mergeOverrides(state.assetOverrides, link.bound.overrides)); hardwareSent = true; }
  if (link.bindings?.text !== lastBindingsText) syncBindings();
  if (!link.connected) hardwareSent = false;
  // Driver-Station flow: INIT parks everything at the start positions, START releases the match clock and the other
  // robots together with the OpMode, STOP freezes them
  if (link.status !== lastLinkStatus) {
    if ((link.status === "INIT" || link.status === "RUNNING") && recorder.cursor !== undefined) { recorder.cursor = undefined; panel.refreshTimeline(); } // a new run: back to live
    if (link.status === "INIT") resetBoard();
    else if (link.status === "RUNNING") startMatch();
    else if (lastLinkStatus === "RUNNING") stopMatch();
    lastLinkStatus = link.status;
  }
  panel.render();
};
panel = new Panel(state, onChange);
panel.link = link;
syncRuntime();
Object.assign(overlays.show, state.overlays);
window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["checkbox", "radio", "button", "range"].includes((t as HTMLInputElement).type)))) return;
  if (e.code === "KeyH") panel.toggle();
});
// clicking anything in the panel should not leave the keyboard captured by a form control
document.getElementById("panel")!.addEventListener("click", (e) => { const t = e.target as HTMLElement; if (t.tagName === "BUTTON") setTimeout(() => t.blur(), 0); });

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
let analysisTick = 0;

function computeShot(exit: Vec3, frame: CellFrame): { shot?: ShotResult; scan?: ReturnType<typeof scanElevations>; required?: number } {
  const l = state.robot.launcher;
  const target = aimPoint(frame, 0.05);
  const key = JSON.stringify([exit.x.toFixed(3), exit.y.toFixed(3), exit.z.toFixed(3), l, state.ballKind, state.drag, state.autoRpm, state.autoHood, state.alliance, state.hive]);
  if (key === shotCache.key) return shotCache;
  const req = { ball: ballProps(), launchPos: exit, target, frame, spin: spinRate(l) };
  const scan = scanElevations(req, Math.min(l.elevationMinDeg, l.elevationMaxDeg), Math.max(l.elevationMinDeg, l.elevationMaxDeg), 2.5, exitSpeed(l, l.maxRpm));
  if (state.autoHood && scan.best && !link.running) l.elevationDeg = rad2deg(scan.best.elevationRad);
  const fixed = solveSpeedForElevation(req, (l.elevationDeg * Math.PI) / 180, exitSpeed(l, l.maxRpm) * 1.5);
  const required = fixed?.speed;
  if (state.autoRpm && required !== undefined && !link.running) l.rpm = clamp(rpmForExitSpeed(l, required), 0, l.maxRpm);
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
  const ball = match.launch(playerAgent, state.ballKind, new THREE.Vector3(exit.x, exit.y, exit.z), new THREE.Vector3(vel.x, vel.y, vel.z), draw.spin, robot.group);
  if (!ball) { launchBlockedUntil = performance.now() + 1500; launchBlockedMsg = "nothing to launch — pick up balls"; return; }
  if (nominal.speed < 1.5) { launchBlockedUntil = performance.now() + 3000; launchBlockedMsg = `flywheel at ${Math.round(l.rpm)} RPM — ball just dropped out (${link.running ? "your code must spin the flywheel first" : "turn on Auto-RPM or set a commanded RPM"})`; }
  (ball as any).owner = "player";
  (ball as any).cal = { exit: { x: exit.x, y: exit.y, z: exit.z }, dir: { x: dirXZ.x / (Math.hypot(dirXZ.x, dirXZ.z) || 1), z: dirXZ.z / (Math.hypot(dirXZ.x, dirXZ.z) || 1) }, power: flywheelPowerCmd(), rpm: l.rpm };
  shotsFired++;
}
let roleWarning: string | undefined;
let lastFoulLogged = -1;
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
function frame(now: number) {
  const real = (now - last) / 1000;
  last = now;
  frameInterval = real > 1 ? frameInterval : frameInterval * 0.9 + real * 0.1;
  // simulate the real elapsed time, capped so a background tab or a hitch does not teleport things. Below 10 fps the
  // simulation therefore runs slower than real time; the HUD says so.
  // scrubbing the timeline freezes the live simulation (dt 0) and draws the recorded moment instead
  let replaying = recorder.cursor !== undefined;
  const dt = replaying ? 0 : Math.min(0.1, real);
  const fps = 1 / Math.max(frameInterval, 1e-3);
  const slowdown = frameInterval > 0.1 ? 0.1 / frameInterval : 1;

  // input & drive
  perf.begin();
  const { cmd, actions } = input.poll();
  // driving while replaying means "I want the live robot": drop back to live
  if (replaying && !link.running && (Math.abs(cmd.forward) > 0.2 || Math.abs(cmd.left) > 0.2 || Math.abs(cmd.turn) > 0.2)) { recorder.cursor = undefined; panel.refreshTimeline(); replaying = false; }
  if (actions.view) { state.view = (["orbit", "top", "chase", "robot"] as const)[actions.view - 1] ?? state.view; panel.render(); }
  if (actions.toggleTarget) { state.hive[state.alliance] = state.hive[state.alliance] === "audience" ? "scoring" : "audience"; match.resetHive(state.alliance); panel.render(); }
  if (actions.toggleFieldCentric) { state.fieldCentric = !state.fieldCentric; panel.render(); }
  const dp = driveParams();
  const runtimeActive = link.running;
  let vel = commandToVelocity(runtimeActive ? { forward: 0, left: 0, turn: 0 } : cmd, state.pose, dp);
  if (runtimeActive) {
    const act = stepActuators(actuatorModel, state.hardware, link.actuators, dt, state.robot.drivetrain, state.pose.heading, state.robot.wheelDiameterM, dp.trackWidthM, dp.wheelbaseM);
    vel = act.vel;
    playerAgent.intakeActive = Math.abs(act.intakePower) > 0.2;
    // motors your code is powering that the sim does not know what to do with (no role): say so instead of standing still
    const unroled = state.hardware.devices.filter((d) => d.kind === "motor" && (!d.role || d.role === "other") && Math.abs(link.actuators[d.name]?.power ?? 0) > 0.05).map((d) => d.name);
    roleWarning = unroled.length ? `⚠ powered motor${unroled.length > 1 ? "s" : ""} without a role in the Hardware map: ${unroled.join(", ")} — set the role (left/right/frontLeft… flywheel, intake) or load a names preset` : undefined;
    const l = state.robot.launcher;
    l.rpm = clamp(act.flywheelRpm, 0, l.maxRpm);
    if (act.hoodPos !== undefined && l.elevationMinDeg !== l.elevationMaxDeg) l.elevationDeg = l.elevationMinDeg + act.hoodPos * (l.elevationMaxDeg - l.elevationMinDeg);
    pendingFires += feederFires(state.hardware, link.takeServoTransitions());
    void 0;
  } else {
    playerAgent.intakeActive = true; // keyboard driving: the intake always runs
    link.takeServoTransitions();
    // keep encoders moving sensibly when the keyboard drives, so init_loop telemetry is not frozen
    stepActuators(actuatorModel, state.hardware, {}, dt, state.robot.drivetrain, state.pose.heading, state.robot.wheelDiameterM, dp.trackWidthM, dp.wheelbaseM);
  }
  // other robots are not static obstacles: contact with them is a pushing contest, resolved below
  const others: Obstacle[] = [];
  const prevPose = state.pose;
  state.pose = stepPose(state.pose, vel, dt, { lengthM: state.robot.lengthM, widthM: state.robot.widthM }, fieldObstacles());
  robot.setPose(state.pose);
  perf.mark("drive");

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
      state.pose = stepPose(state.pose, { vx: 0, vz: 0, yawRate: 0 }, 0.001, { lengthM: state.robot.lengthM, widthM: state.robot.widthM }, [...fieldObstacles(), ...others]);
      robot.setPose(state.pose);
    }
    void ex;
  }

  // match clock
  if (state.matchPhase === "running") { state.matchClock = Math.max(0, (state.matchClock ?? MATCH_SECONDS) - dt); if (state.matchClock <= 0) state.matchPhase = "stopped"; }
  // scripted robots (only while the match runs)
  if (state.opponents && !state.pauseOpponents && state.matchPhase === "running") {
    const me: Obstacle = { xMin: state.pose.x - state.robot.widthM / 2, xMax: state.pose.x + state.robot.widthM / 2, zMin: state.pose.z - state.robot.lengthM / 2, zMax: state.pose.z + state.robot.lengthM / 2 };
    scripted.forEach((s, i) => {
      s.brainDriven = state.opponentsScore;
      const ag = scriptedAgents[i];
      ag.pose = s.pose;
      ag.footprint = s.footprint;
      if (state.opponentsScore) { if (match.driveScripted(s, ag, dt)) { /* fired */ } } else ag.intakeActive = false;
      // the last seconds: head for the LOADING ZONE for TELEOP PARK (5 pts), like a real drive team
      if ((state.matchClock ?? 0) < 12) {
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
    const meBody: ContactBody = { pose: state.pose, fp: { lengthM: state.robot.lengthM, widthM: state.robot.widthM }, drivetrain: state.robot.drivetrain, massKg: state.robot.massKg ?? 12, vx: vel.vx, vz: vel.vz };
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
  scriptedObjs.forEach((o, i) => { o.group.visible = state.opponents; o.setPose(scripted[i].pose); Match.renderCarry(scriptedAgents[i].carryGroup, scriptedAgents[i].inventory, scriptedAgents[i].alliance, 0.3); });
  // our agent
  playerAgent.pose = state.pose;
  playerAgent.footprint = { lengthM: state.robot.lengthM, widthM: state.robot.widthM };
  playerAgent.intakeGeom = state.robot.intake;
  robot.setIntakeActive(playerAgent.intakeActive);
  Match.renderCarry(playerAgent.carryGroup, playerAgent.inventory, playerAgent.alliance, state.robot.heightM);
  perf.mark("robots");
  match.update(dt, state.opponents ? allAgents : [playerAgent]);
  scoreboard.update(state.matchPhase ?? "setup", state.matchClock ?? MATCH_SECONDS, MATCH_SECONDS, scoreRobots(), { red: match.hives.red.tips, blue: match.hives.blue.tips });
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
  robot.launcherMarker.rotation.y = (l.yawOffsetDeg * Math.PI) / 180 + turretYaw; // local +Y rotation = yaw left
  if (actions.launch && !runtimeActive) launch(exit, fireDir);
  while (pendingFires > 0) { pendingFires--; launch(exit, fireDir); }
  perf.mark("shot");
  updateFlying(dt);
  perf.mark("balls");

  // overlays
  perf.mark("analysis");
  updateReachMap(tf);
  updateHitMap(tf);
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
    tags = analyseTags(selected.cam, selected.intr, field.tagMeshes, occluders);
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
  hud.update({
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
    cellLoad: (() => { const c = match.cellLoad(state.alliance); return `${c.nectar} nectar + ${c.pollen} pollen = ${(c.massKg * 1000).toFixed(0)} g / ${state.tipMassG} g to tip`; })(),
    tips: match.hives[state.alliance].tips,
    score: (() => {
      const ours = allianceScore(state.alliance), theirs = allianceScore(state.alliance === "red" ? "blue" : "red");
      const n = scoreRobots().filter((r) => r.alliance === state.alliance).length;
      const you = scoreboard.robots.get(playerAgent.id);
      const inAuto = state.matchPhase === "running" && (state.matchClock ?? 0) > MATCH_SECONDS - 30;
      const mine = you ? `you: LEAVE ${you.leave ? "✓" : "✗"} · AUTO PARK ${you.autoPark ? "✓" : "✗"} · PARK ${you.teleopPark ? "✓" : "✗"}${you.inZoneNow ? " · in LOADING ZONE" : ""}${inAuto ? " (AUTO, assessed at 0:30)" : ""}` : "";
      return `${state.alliance.toUpperCase()} ${ours.total} (auto ${ours.auto}) vs ${theirs.total} (auto ${theirs.auto}) · ${describeScore(ours, n)}${mine ? " · " + mine : ""}`;
    })(),
    tipping: match.hives[state.alliance].tipping ? `TIPPING… ${(match.hives[state.alliance].tipping!.duration - match.hives[state.alliance].tipping!.t).toFixed(1)} s` : undefined,
    carrying: `${playerAgent.inventory.pollen} pollen + ${playerAgent.inventory.nectar} nectar (${playerAgent.inventory.pollen + playerAgent.inventory.nectar}/${playerAgent.caps.capacity})`,
    launchBlocked: performance.now() < launchBlockedUntil ? launchBlockedMsg : undefined,
    supply: `flowers ${match.flowerStocks().join("/")} · nectar reserve red ${match.nectarSupply.red} blue ${match.nectarSupply.blue}`,
    theirHive: (() => { const o: Alliance = state.alliance === "red" ? "blue" : "red"; const c = match.cellLoad(o); const h = match.hives[o]; return `${h.upCell} cell up · ${(c.massKg * 1000).toFixed(0)} g · ${h.tips} tips${h.tipping ? " · TIPPING" : ""}`; })(),
    match: replayBanner ?? (state.matchPhase === "running" ? `RUNNING · ${Math.floor((state.matchClock ?? 0) / 60)}:${String(Math.floor((state.matchClock ?? 0) % 60)).padStart(2, "0")} left` : state.matchPhase === "stopped" ? `STOPPED${(state.matchClock ?? 1) <= 0 ? " · time" : ""} · Reset to start, or START again` : `SETUP · robots on their marks · Start match (or INIT → START your OpMode)`),
    matchClass: replayBanner ? "warn" : (state.matchPhase === "running" ? "ok" : state.matchPhase === "stopped" ? "bad" : "warn"),
    contact: contactText, contactBad,
    tags: lastTags,
    cameraName: selected?.mount.name ?? "none",
    modelStatus: { box: "procedural box", loading: "loading goBILDA CAD…", loaded: "goBILDA CAD", failed: "CAD not found → box (see README)" }[robot.modelStatus],
    runtime: link.connected ? `${link.status}${link.currentOpMode ? " · " + link.currentOpMode : ""}${link.status === "INIT" ? " · press START to drive" : ""} · keyboard = gamepad${input.keyboardPad}${input.keyboardPad === 2 ? " ⚠ (Tab switches back)" : ""}` : "not connected",
    notice: [performance.now() < launchBlockedUntil ? launchBlockedMsg : undefined, roleWarning, runtimeActive && !playerAgent.intakeActive ? "intake OFF: your code must power the intake motor to collect; balls get pushed instead" : undefined, fps < 20 ? `${fps.toFixed(0)} fps${slowdown < 1 ? `, sim at ${Math.round(slowdown * 100)}% of real time` : ""}: turn off camera insets or the hit map` : undefined].filter(Boolean).join(" · ") || undefined,
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
  const showGizmos = cam !== selected?.cam;
  robot.cameraGizmos.visible = showGizmos;
  robot.launcherMarker.visible = showGizmos;
  for (const a of allAgents) a.carryGroup.visible = showGizmos;
  const renderThisFrame = !ciMode || analysisTick % 6 === 0;
  if (renderThisFrame) renderer.render(scene, cam);
  perf.mark("render");

  // PiP: every enabled camera gets an inset (except the one filling the main view)
  const pipCams = state.pip && renderThisFrame ? camInfos.filter((c) => c.enabled && !(state.view === "robot" && c.selected)).slice(0, 2) : [];
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
    if (pipCams.length > 1 && (analysisTick + i) % 2 === 1) return;
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
  if (ciMode) setTimeout(() => frame(performance.now()), 8); else requestAnimationFrame(frame);
}
// debugging hook for scripts / console
(window as any).__twin = { state, orbitCam, controls, robot, scene, flying, link, overlays, recorder, snapshotContext, knobs: () => twinKnobs(state), actuatorModel, input, match, playerAgent, scripted, stats: () => ({ shotsFired, shotsHit }), predicted: () => actualCache.shot, ifAimed: () => shotCache.shot, dbg: () => ({ fireDir: lastFireDir, exit: lastExit }), hitmap: () => hitJob, hitmapDone: () => !!hitJob && hitJob.done, __pins: pins, calibration: { lastImpact: () => lastImpact, session: () => state.calibration }, score: () => ({ red: allianceScore("red"), blue: allianceScore("blue") }), scoreboard };
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
    const vis = analyseTagsFor(ci.cam, ci.intr, field.tagMeshes, occluders);
    tagsByCam[dev.name] = buildDetections(ci.cam, ci.intr, vis, field.tagMeshes, state.pose, state.tagNoiseIn);
  }
  lastTagsByCam = tagsByCam;
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
// ---- hit-probability map: incremental job, re-created whenever anything it depends on changes
let hitKey = "";
let hitJob: HitMapJob | undefined;
let hitLastDraw = 0;
/** Would the selected camera see one of the target cell's tags if the robot stood at (x,z) aimed at the target? */
function cellCameraVisibility(x: number, z: number, frameSide: CellSide): boolean {
  const camMount = state.robot.cameras.find((c) => c.id === state.selectedCameraId) ?? state.robot.cameras[0];
  if (!camMount || !camMount.enabled) return true; // no camera to check against: do not dim
  const l = state.robot.launcher;
  const ap = aimPoint(targetFrame(), 0.05);
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
  if (!state.overlays.hitmap) { if (hitKey) { hitKey = ""; hitJob = undefined; overlays.setHitMap(undefined); } return; }
  const l = state.robot.launcher;
  const camMount = state.robot.cameras.find((c) => c.id === state.selectedCameraId) ?? state.robot.cameras[0];
  const key = JSON.stringify([l, state.ballKind, state.drag, state.alliance, state.hive, state.noise, camMount, state.robot.lengthM, state.robot.widthM, state.robot.modelYawDeg]);
  if (key !== hitKey) { hitKey = key; hitJob = new HitMapJob(frame, l, ballProps(), state.noise, 6, 40); overlays.setHitMap(hitJob); }
  if (!hitJob || hitJob.done) return;
  const side = state.hive[state.alliance];
  const saved = state.pose;
  const k = hitJob.step(5, (x, z) => cellCameraVisibility(x, z, side));
  robot.setPose(saved); // visibility probing moved the robot object around
  const now = performance.now();
  if (k && (hitJob.done || now - hitLastDraw > 150)) { hitLastDraw = now; overlays.setHitMap(hitJob); }
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
