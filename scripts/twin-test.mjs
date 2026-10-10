#!/usr/bin/env node
/**
 * Headless test bed: run one or more OpModes against the twin from scenario files and write JSON reports.
 *
 *   pnpm twin-test --scenario scenarios/example-teleop.json [--scenario more.json ...] [--team <path>] [--out report.json | --out-dir dir]
 *   pnpm twin-test --opmode "Sim: StarterBot TeleOp" --duration 20
 *
 * One host and one Vite server serve every scenario in the list (each scenario gets a fresh browser page); starting the
 * host (Gradle + JVM) is the slow part, so batch scenarios instead of calling this once per file. Exit code 0 only
 * when every scenario passes. Every check carries a verdict (pass | fail | inconclusive | unsupported): a run the
 * machine could not keep at real time (simulated/wall under 0.8x, packets held for seconds, a page error) makes the
 * physical checks inconclusive instead of green or red, and a coverage the twin cannot provide (pixel decoding) is
 * reported as unsupported, never silently downgraded. A scenario can also run the robot against the profile it SAVED on
 * the hub (`persisted`, SG-001), reject bound calibration (`bindingsPolicy`), and assert world truth against telemetry
 * (`rangeConsistency`, `travelBetween`, `flywheelMaxPower`, `contacts`). The twin is served as a production build of the COMMITTED tree (HEAD), so another
 * agent's uncommitted edits never run here (--wip builds the working tree, --dev uses the dev server, --rebuild forces). Other flags: --port 5190 --host-port 8790 --headed --screenshot shot.png --host-timeout 600.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// NOT niced: the browser's 50 Hz sensor sender and the host's WebSocket ingest are latency-sensitive; at low priority
// next to a busy desktop their packets arrived in bursts and the OpMode's encoder deltas became lumpy. The Gradle
// build itself is capped in runtime/gradle.properties instead (workers, heap).
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; };
const flags = (name) => args.map((a, i) => (a === name && i + 1 < args.length ? args[i + 1] : undefined)).filter(Boolean);
const has = (name) => args.includes(name);

// ---- scenarios: every --scenario value, plus bare *.json arguments, or a single --opmode
const scenarioPaths = [...flags("--scenario"), ...args.filter((a, i) => a.endsWith(".json") && args[i - 1] !== "--scenario" && !args[i - 1]?.startsWith("--out") && args[i - 1] !== "--screenshot")];
const scenarios = scenarioPaths.map((p) => ({ path: p, scenario: JSON.parse(readFileSync(resolve(p), "utf8")) }));
if (flag("--opmode")) scenarios.push({ path: undefined, scenario: { opMode: flag("--opmode") } });
if (flag("--duration")) for (const s of scenarios) s.scenario.durationS = parseFloat(flag("--duration"));
for (const s of scenarios) if (!s.scenario.opMode) { console.error(`twin-test: ${s.path ?? "scenario"} has no opMode`); process.exit(2); }
if (!scenarios.length) { console.error("twin-test: give --scenario <file> (with opMode), scenario files, or --opmode <name>"); process.exit(2); }
const team = flag("--team");
const port = flag("--port", "5190"), hostPort = flag("--host-port", "8790");
const outDir = flag("--out-dir") ? resolve(flag("--out-dir")) : undefined;
const outSingle = resolve(flag("--out", "twin-report.json"));
const headed = has("--headed");
const reportPathFor = (s, i) => (outDir ? resolve(outDir, `${s.path ? basename(s.path, ".json") : "opmode"}.json`) : scenarios.length === 1 ? outSingle : resolve(dirname(outSingle), `${s.path ? basename(s.path, ".json") : `scenario-${i + 1}`}.json`));

let playwright;
try { playwright = await import("playwright"); } catch {
  console.error("twin-test: playwright is not installed. Run: pnpm install && pnpm exec playwright install chromium"); process.exit(2);
}

// ---- 1. host + twin
// Leftover host JVMs make the next run hang: an orphan from an interrupted run (re-parented to PID 1, its ws port long
// gone) is ended here; anything still listening on our host port belongs to someone else, so fail fast instead.
if (process.platform !== "win32") {
  const ps = (() => { try { return execSync("ps -axo pid=,ppid=,command=", { encoding: "utf8" }); } catch { return ""; } })();
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*org\.biobuzz\.sim\.host\.Main(?:\s+(\d+))?)\s*$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, , p] = m;
    if (ppid === "1") { console.log(`twin-test: ending orphaned host JVM pid ${pid}${p ? ` (port ${p})` : ""} left by an earlier run`); try { process.kill(+pid, "SIGTERM"); } catch {} }
  }
  const busy = (() => { try { return execSync(`lsof -nP -iTCP:${hostPort} -sTCP:LISTEN -t 2>/dev/null`, { encoding: "utf8" }).trim(); } catch { return ""; } })();
  if (busy) { console.error(`twin-test: something is already listening on the host port ${hostPort} (pid ${busy.split("\n").join(", ")}). A human's pnpm sim? Pass --host-port <other> (and --port) or stop it.`); process.exit(2); }
}
// built bundle by default: the dev server's hot reload would restart the page (and kill the run) whenever someone edits
// the twin's sources; --dev opts back into the dev server, --rebuild forces a fresh build
const simArgs = [resolve(root, "scripts/sim.mjs"), "--no-browser", "--no-watch", "--no-panels", "--port", port, "--host-port", hostPort]; // no Panels: its fixed ports belong to the human's session
if (!has("--dev")) simArgs.push("--built");
if (has("--wip")) simArgs.push("--wip");       // build the working tree instead of the committed tree
if (has("--rebuild")) simArgs.push("--rebuild");
if (team) simArgs.push("--team", team);
console.log(`twin-test: ${scenarios.length} scenario${scenarios.length > 1 ? "s" : ""}; starting host and twin (${simArgs.slice(1).join(" ")})`);
const sim = spawn(process.execPath, simArgs, { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let simLog = "";
const ready = { host: false, twin: false };
let progressNoted = false;
const onData = (d) => { const s = d.toString(); simLog += s; if (/listening on ws:/.test(s)) ready.host = true; if (/Local:\s+http/.test(s)) ready.twin = true; if (/error:|FAILED|Exception/.test(s)) process.stdout.write(s); };
sim.stdout.on("data", onData); sim.stderr.on("data", onData);
const killSim = () => {
  try { process.kill(-sim.pid, "SIGTERM"); } catch {} // sim.mjs ends the host JVM itself (TERM, then KILL) before it exits
  try { execSync(`lsof -nP -iTCP:${port} -iTCP:${hostPort} -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null`, { stdio: "ignore" }); } catch {}
  // belt and braces: the host JVM for our port, whatever its parent is; wait for it so a back-to-back run cannot collide
  if (process.platform !== "win32") {
    const pat = `org.biobuzz.sim.host.Main ${hostPort}$`;
    try { execSync(`pkill -TERM -f "${pat}"`, { stdio: "ignore" }); } catch {}
    try { execSync(`for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "${pat}" >/dev/null || exit 0; sleep 0.5; done; pkill -KILL -f "${pat}"`, { stdio: "ignore", shell: "/bin/sh" }); } catch {}
  }
};
process.on("exit", killSim); process.on("SIGINT", () => { killSim(); process.exit(130); });
const t0 = Date.now();
while (!(ready.host && ready.twin)) {
  if (sim.exitCode !== null) { console.error("twin-test: the host exited before it was ready. Log tail:\n" + simLog.split("\n").slice(-40).join("\n")); process.exit(1); }
  if (Date.now() - t0 > (parseFloat(flag("--host-timeout", "600")) * 1000)) { console.error("twin-test: timed out waiting for the host (first Gradle build can take minutes). Launcher output:\n" + simLog.split("\n").slice(-60).join("\n")); process.exit(1); }
  if (Date.now() - t0 > 20_000 && !ready.host && !progressNoted) { progressNoted = true; console.log("twin-test: still waiting for the host (Gradle compiling TeamCode)…"); }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`twin-test: host ready after ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// ---- 2. browser (one per run; a fresh page per scenario)
// software GL renders on every core by default; two raster threads and one renderer are plenty for the twin's
// 4-frames-a-second headless render and leave the CPU to the simulation, the host and the human
const browser = await playwright.chromium.launch({ headless: !headed, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--num-raster-threads=2", "--renderer-process-limit=2"] });
const results = [];
for (let i = 0; i < scenarios.length; i++) {
  const { path: scenarioPath, scenario } = scenarios[i];
  const out = reportPathFor(scenarios[i], i);
  if (scenarios.length > 1) console.log(`\n=== [${i + 1}/${scenarios.length}] ${scenario.name ?? scenarioPath ?? scenario.opMode}`);
  let pass = false;
  try { pass = await runScenario(scenario, scenarioPath, out); }
  catch (e) {
    // a crash before the OpMode ran (the page did not load, the host went away, Playwright timed out) says nothing
    // about the robot code: the verdict is inconclusive with an infrastructure reason, never a fail
    const infra = /page\.goto|Timeout .* exceeded|host exited|Target closed|net::ERR|waiting for the host/i.test(String(e?.message ?? e));
    console.error(`twin-test: scenario crashed${infra ? " (infrastructure: the OpMode never ran)" : ""}: ${e?.stack ?? e}`);
    writeReport(out, { scenario: scenario.name ?? scenarioPath, opMode: scenario.opMode, team, pass: false, verdict: infra ? "inconclusive" : "fail", failed: String(e), infrastructure: infra ? [`crashed before the run: ${String(e?.message ?? e).split("\n")[0]}`] : undefined, checks: [], samples: [], pageErrors: [], hostLogTail: simLog.split("\n").slice(-30), generatedAt: new Date().toISOString() });
  }
  let verdict = pass ? "pass" : "fail";
  try { verdict = JSON.parse(readFileSync(out, "utf8")).verdict ?? verdict; } catch { /* keep */ }
  results.push({ name: scenario.name ?? scenarioPath ?? scenario.opMode, pass, verdict, out });
}
await browser.close();
if (results.length > 1) {
  console.log(`\ntwin-test: ${results.filter((r) => r.pass).length}/${results.length} passed`);
  for (const r of results) console.log(`  ${{ pass: "✓", fail: "✗", inconclusive: "~", unsupported: "?" }[r.verdict] ?? "✗"} ${r.verdict !== "pass" && r.verdict !== "fail" ? `[${r.verdict}] ` : ""}${r.name}  (${r.out})`);
  const counts = results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] ?? 0) + 1; return a; }, {});
  console.log(`twin-test: verdicts ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);
}
const allPass = results.every((r) => r.pass);
console.log(allPass ? "PASS" : "FAIL");
killSim();
process.exit(allPass ? 0 : 1);

/** Run one scenario in a fresh page; prints its checks; returns pass. */
async function runScenario(scenario, scenarioPath, out) {
  const duration = scenario.durationS ?? 20;
  const sampleEvery = scenario.sampleEveryS ?? 1;
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [], pageErrorStacks = [];
  page.on("pageerror", (e) => { pageErrors.push(e.message); pageErrorStacks.push(String(e.stack ?? e.message).split("\n").slice(0, 8).join("\n")); });
  // twinSettings: run the robot the human runs. The file the Session section saves (robot preset and dimensions,
  // intake side, cameras, launcher, hardware map with free RPMs and mirrored side, calibration, asset overrides) is
  // applied first; the scenario's own fields then override, and its assetOverrides sit on top of the file's.
  const settingsFile = scenario.twinSettings === true ? findTeamFile(team, "twin-settings.json") : scenario.twinSettings ? findTeamFile(team, scenario.twinSettings) : undefined;
  let fileSettings = {};
  if (scenario.twinSettings) {
    if (!settingsFile) { console.error(`twin-test: twinSettings ${scenario.twinSettings === true ? "twin-settings.json" : scenario.twinSettings} not found under ${team ?? "(no --team)"}`); }
    else { try { fileSettings = JSON.parse(readFileSync(settingsFile, "utf8")); delete fileSettings.biobuzzTwinSettings; for (const k of ["pose", "matchPhase", "matchClock", "matchRequest", "aimRequest", "resetMatchRequest", "runtimeEnabled", "runtimeUrl", "pip", "settingsAutoLoad", "view"]) delete fileSettings[k]; console.log(`twin-test: robot and settings from ${settingsFile}`); } catch (e) { console.error(`twin-test: cannot read ${settingsFile}: ${e}`); } }
  }
  const mergedOverrides = {};
  for (const src of [fileSettings.assetOverrides ?? {}, scenario.assetOverrides ?? {}]) for (const [path, vals] of Object.entries(src)) mergedOverrides[path] = { ...(mergedOverrides[path] ?? {}), ...vals };
  // persisted (SG-001): the profile the robot SAVED on the hub, which replaces the packaged asset as the base TeamCode
  // reads. {"<asset>": {whole document}} or {"<asset>": {"base": "packaged" | "rev:<git rev>" | "file:<path>", "drop": [dotted keys], "set": {dotted: value}}}
  const persistedAssets = {}; const persistedNotes = [];
  for (const [asset, spec] of Object.entries(scenario.persisted ?? {})) {
    try {
      const recipe = spec && typeof spec === "object" && ("base" in spec || Array.isArray(spec.drop) || (spec.set && typeof spec.set === "object")) && Object.keys(spec).every((k) => ["base", "drop", "set"].includes(k));
      let doc;
      if (!recipe) doc = spec;
      else {
        const base = spec.base ?? "packaged";
        const packagedFile = findTeamFile(team, `src/main/assets/${asset}`) ?? findTeamFile(team, asset);
        if (base === "packaged") { if (!packagedFile) throw new Error(`packaged asset ${asset} not found under --team`); doc = JSON.parse(readFileSync(packagedFile, "utf8")); }
        else if (base.startsWith("rev:")) { if (!packagedFile) throw new Error(`asset ${asset} not found under --team to locate it in git`); const relPath = execSync(`git ls-files --full-name -- "${packagedFile}"`, { cwd: dirname(packagedFile), encoding: "utf8" }).trim(); doc = JSON.parse(execSync(`git show ${base.slice(4)}:${relPath}`, { cwd: dirname(packagedFile), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })); }
        else if (base.startsWith("file:")) { const f = findTeamFile(team, base.slice(5)) ?? base.slice(5); doc = JSON.parse(readFileSync(f, "utf8")); }
        else throw new Error(`persisted base "${base}" must be packaged, rev:<git rev> or file:<path>`);
        for (const key of spec.drop ?? []) { const parts = key.split("."); let o = doc; for (const q of parts.slice(0, -1)) { o = o?.[q]; if (!o || typeof o !== "object") break; } if (o && typeof o === "object") delete o[parts[parts.length - 1]]; }
        for (const [key, value] of Object.entries(spec.set ?? {})) { const parts = key.split("."); let o = doc; for (const q of parts.slice(0, -1)) { if (!o[q] || typeof o[q] !== "object") o[q] = {}; o = o[q]; } o[parts[parts.length - 1]] = value; }
        persistedNotes.push(`${asset} from ${base}${spec.drop?.length ? ` minus ${spec.drop.join(", ")}` : ""}${spec.set ? ` with ${Object.keys(spec.set).join(", ")}` : ""}`);
      }
      persistedAssets[asset] = doc;
    } catch (e) { console.error(`twin-test: persisted ${asset}: ${e.message ?? e}`); await context.close(); return reportSetupFailure(`persisted ${asset}: ${e.message ?? e}`); }
  }
  if (persistedNotes.length) console.log(`twin-test: saved hub profile: ${persistedNotes.join("; ")}`);
  const seed = {
    ...fileSettings,
    persistedAssets: Object.keys(persistedAssets).length ? persistedAssets : {},
    alliance: scenario.alliance ?? fileSettings.alliance ?? "red",
    opponents: scenario.opponents ?? true,
    opponentsScore: scenario.opponentsScore ?? true,
    pauseOpponents: false,
    runtimeEnabled: true,
    runtimeUrl: `ws://127.0.0.1:${hostPort}`,
    assetOverrides: mergedOverrides,
    overlays: { ...(fileSettings.overlays ?? {}), fan: false, dispersion: false, hitmap: false, reach: false },
    showPerf: false,
    pip: false, // camera insets are extra renders; AprilTag detections do not need them
    settingsAutoLoad: false, // the scenario is the source of truth: never let the repo's twin-settings.json replace it
  };
  if (scenario.starts) seed.starts = scenario.starts;
  // physical-fidelity knobs (docs/superpowers/specs/2026-10-09-physical-fidelity-fixtures-design.md): a profile name
  // or an object for physics, partial objects for feed and perception, ids for tag covers; absent = the saved settings
  if (scenario.physics !== undefined) seed.physics = typeof scenario.physics === "string" ? { kind: scenario.physics } : scenario.physics;
  if (scenario.feed) seed.feed = { ...(fileSettings.feed ?? {}), ...scenario.feed };
  if (scenario.perception) seed.perception = typeof scenario.perception === "string" ? { level: scenario.perception } : { ...(fileSettings.perception ?? {}), ...scenario.perception, faults: { ...(fileSettings.perception?.faults ?? {}), ...(scenario.perception.faults ?? {}) } };
  if (scenario.tagCovers) seed.tagCovers = scenario.tagCovers;
  // any other twin setting (capacity, infiniteAmmo, tipMassG, aiTier, autoTransition, …): the same keys the settings file holds
  if (scenario.twin && typeof scenario.twin === "object") Object.assign(seed, scenario.twin);
  // coverage the twin cannot provide is an UNSUPPORTED verdict before anything runs
  const caps = { perception: ["ideal", "faults", "singles"], physics: ["ideal", "tiles", "custom"] };
  const wantPerception = scenario.coverage?.perception, wantPhysics = scenario.coverage?.physics;
  const unsupported = (wantPerception && !caps.perception.includes(wantPerception) ? [`perception level "${wantPerception}" (the twin has no camera frames; supported: ${caps.perception.join(", ")})`] : []).concat(wantPhysics && !caps.physics.includes(wantPhysics) ? [`physics profile "${wantPhysics}" (supported: ${caps.physics.join(", ")})`] : []);
  if (unsupported.length) { console.error(`twin-test: unsupported coverage: ${unsupported.join("; ")}`); await context.close(); return reportUnsupported(unsupported); }
  await page.addInitScript((s) => { localStorage.setItem("biobuzz-twin", JSON.stringify(s)); }, seed);
  const noBind = scenario.ignoreBindings || scenario.bindingsPolicy === "ignore";
  await page.goto(`http://localhost:${port}/?ci=1${noBind ? "&nobind=1" : ""}`, { waitUntil: "networkidle" }); // ci=1: light rendering so the sim runs at full rate under software GL
  await page.waitForFunction(() => window.__twin && window.__twin.robot.modelStatus !== "loading", null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__twin.link.connected && window.__twin.link.opModes.length > 0, null, { timeout: 30_000 }).catch(() => {});
  // the first renders compile every shader and stall the page for up to a second under software GL; let that happen
  // before INIT so the OpMode's first seconds (spin-up, first camera frames) are not the ones that pay for it
  await page.waitForFunction(() => (window.__twinRenderCount ?? 0) >= 3, null, { timeout: 8_000 }).catch(() => {});
  const opModes = await page.evaluate(() => window.__twin.link.opModes.map((o) => o.name));
  const samples = [];
  let requireFailures = [];
  const warnings = [];
  let startSnapshot, final, simStart = 0, telemetryChanges = [], manifest, outputsAfterStop, eventsAll = [], eventsFrom = 0, hostStart, hostEnd, wallStartMs = 0, faultLog = [], timingNote;
  const hostStatus = async () => { try { const r = await fetch(`http://127.0.0.1:${+hostPort + 1}/api/status`); return await r.json(); } catch { return undefined; } };
  const snapshot = (light = false) => page.evaluate((light) => {
    const t = window.__twin, s = t.stats();
    const base = { status: t.link.status, error: t.link.statusError || undefined, telemetry: t.link.telemetry, poseIn: { x: +(t.state.pose.x / 0.0254).toFixed(1), z: +(t.state.pose.z / 0.0254).toFixed(1), headingDeg: +((t.state.pose.heading * 180) / Math.PI).toFixed(1) }, shotsFired: s.shotsFired, shotsHit: s.shotsHit, launches: s.launches, feederPulses: s.feederPulses, stalls: s.stalls, notMoving: s.notMoving, feeder: s.feeder, flywheelPeakPower: s.flywheelPeakPower, picks: t.playerAgent.picks ?? 0, events: t.recorder.events.length, truth: t.truth?.(), flywheelPower: Math.max(0, ...t.state.hardware.devices.filter((d) => d.role === "flywheel").map((d) => Math.abs(t.link.actuators[d.name]?.power ?? 0))) };
    if (light) return base;
    const inv = t.playerAgent.inventory;
    const r = t.state.robot, fly = t.state.hardware.devices.find((d) => d.role === "flywheel");
    return { ...base, robot: { preset: t.state.robotPresetId, drivetrain: r.drivetrain, intakeSide: r.intake?.side, lengthIn: +(r.lengthM / 0.0254).toFixed(1), widthIn: +(r.widthM / 0.0254).toFixed(1), cameras: r.cameras.map((c) => `${c.name} pitch ${c.pitchDeg} yaw ${c.yawDeg}`), launcher: { yawOffsetDeg: r.launcher.yawOffsetDeg, elevationDeg: r.launcher.elevationDeg, efficiency: r.launcher.efficiency }, flywheelFreeRpm: fly?.freeRpm, mirroredSide: t.state.hardware.mirroredSide }, carrying: { pollen: inv.pollen, nectar: inv.nectar }, hives: Object.fromEntries(Object.entries(t.match.hives).map(([a, h]) => [a, { upCell: h.upCell, tips: h.tips, load: t.match.cellLoad(a) }])), fouls: Object.fromEntries(t.__pins.fouls), matchClock: t.state.matchClock, matchPhase: t.state.matchPhase, score: t.score?.(), hardware: t.state.hardware.devices.map((d) => `${d.kind}:${d.name}`) };
  }, light);
  const finish = async (failed) => {
    await page.evaluate(() => window.__twin.input.clearInjected()).catch(() => {});
    final = final ?? (await snapshot().catch(() => undefined));
    await page.evaluate(() => window.__twin.link.onAgent("match", { action: "stop" })).catch(() => {});
    await page.waitForFunction(() => ["STOPPED", "IDLE", "ERROR", "DISCONNECTED"].includes(window.__twin.link.status), null, { timeout: 5_000 }).catch(() => {});
    // commanded outputs after STOP: the host must zero them within a control cycle (the simulated flywheel may still coast)
    outputsAfterStop = await page.waitForFunction(() => Object.values(window.__twin.link.actuators).every((d) => !(Math.abs(d.power ?? 0) > 1e-6) && !(Math.abs(d.targetVel ?? 0) > 1e-6)), null, { timeout: 1_000 }).then(() => ({ zero: true })).catch(async () => ({ zero: false, nonZero: await page.evaluate(() => Object.entries(window.__twin.link.actuators).filter(([, d]) => Math.abs(d.power ?? 0) > 1e-6 || Math.abs(d.targetVel ?? 0) > 1e-6).map(([n, d]) => `${n}=${d.power ?? d.targetVel}`)).catch(() => []) }));
    eventsAll = await page.evaluate((from) => window.__twin.recorder.events.slice(from).map((e) => ({ ...e })), eventsFrom).catch(() => []);
    hostEnd = await hostStatus();
    if (flag("--screenshot") && scenarios.length === 1) { await page.evaluate(() => window.__twinRenderNow?.()).catch(() => {}); await page.waitForTimeout(400); await page.screenshot({ path: resolve(flag("--screenshot")) }).catch(() => {}); }
    await context.close();
    return report(failed);
  };
  if (!opModes.includes(scenario.opMode)) { console.error(`twin-test: OpMode "${scenario.opMode}" not found. Available:\n  ${opModes.join("\n  ")}`); return finish(`OpMode "${scenario.opMode}" not found`); }
  // robot / hardware presets through the panel so the same code paths run as for a human (they override twinSettings)
  if (scenario.robotPreset) await page.evaluate((id) => { const s = [...document.querySelectorAll("#panel select")].find((x) => [...x.options].some((o) => o.value === id)); if (s) { s.value = id; s.dispatchEvent(new Event("change")); } }, scenario.robotPreset);
  if (scenario.hardwarePreset) await page.evaluate((hp) => { const label = hp === "camelsHump" ? "Camels Hump" : "StarterBot names"; [...document.querySelectorAll("#panel button")].find((b) => b.textContent.includes(label))?.click(); }, scenario.hardwarePreset);
  await page.waitForTimeout(400);
  // INIT (parks everything at the start positions), then our custom start pose if given, then START. Driver-Station
  // actions go through the agent API's "match" action (the same code the bottom bar's buttons run), not through panel
  // buttons: the workspaces hide the panel's own INIT row, and a selector on a hidden control hangs the run
  await page.evaluate((name) => window.__twin.link.onAgent("match", { action: "init", opMode: name }), scenario.opMode);
  await page.waitForFunction(() => ["INIT", "ERROR"].includes(window.__twin.link.status), null, { timeout: 20_000 }).catch(() => {});
  const status = await page.evaluate(() => ({ status: window.__twin.link.status, error: window.__twin.link.statusError }));
  if (status.status !== "INIT") return finish(`INIT did not complete: ${status.status} ${status.error}`);
  if (scenario.start) await page.evaluate((p) => { const t = window.__twin; t.state.pose = { x: p.xIn * 0.0254, z: p.zIn * 0.0254, heading: (p.headingDeg * Math.PI) / 180 }; t.robot.setPose(t.state.pose); }, scenario.start);
  // loose balls the fixture places on the floor (after INIT's board reset): world truth for contact and collection checks
  if (scenario.balls?.length) await page.evaluate((b) => window.__twin.link.onAgent("twin", { balls: b }), scenario.balls);
  // the effective configuration at INIT: robot identity, physics, perception and every TeamCode setting with provenance
  manifest = await page.evaluate(() => window.__twin.manifest()).catch(() => undefined);
  if (manifest?.profile) console.log(`twin-test: configuration: ${manifest.profile.mode}${manifest.profile.persistedAssets.length ? ` (${manifest.profile.persistedAssets.map((p) => p.replace(/^.*\//, "")).join(", ")})` : ""}, calibration ${manifest.profile.calibration}${Object.values(manifest.profile.missing).flat().length ? `, missing (parser fallback): ${Object.values(manifest.profile.missing).flat().join(", ")}` : ""}`);
  if (manifest) console.log(`twin-test: INIT with ${manifest.robot.preset} ${manifest.robot.drivetrain}, intake ${manifest.robot.intake.side}, physics ${manifest.physics.kind} (${manifest.physics.provenance}, turn breakaway ≈ ${Math.round(manifest.physics.breakaway.turn * 100)} %), camera ${manifest.perception.level}${manifest.perception.tagCovers.length ? ` covers ${manifest.perception.tagCovers.join(",")}` : ""}, twin ${manifest.twin.revision}${manifest.team?.revision ? `, TeamCode ${manifest.team.revision}${manifest.team.dirty ? "-dirty" : ""}` : ""}`);
  // requireEffective: the test is only valid if these settings are what TeamCode will read; a binding or a stale
  // profile winning over the scenario is a setup failure, not a robot result (handoff P0 BIND / CONFIG)
  if (scenario.requireEffective && manifest) {
    const bad = [];
    for (const [asset, keys] of Object.entries(scenario.requireEffective)) for (const [k, want] of Object.entries(keys)) {
      const file = Object.entries(manifest.effective).find(([p]) => p === asset || p.endsWith("/" + asset))?.[1];
      const got = file?.[k];
      // "<missing>" asserts the key reaches TeamCode absent (parser fallback), as a saved profile from an older build leaves it
      const ok = want === "<missing>" ? got?.source === "missing" || !got : !!got && got.source !== "missing" && JSON.stringify(got.value) === JSON.stringify(want);
      if (!ok) bad.push(`${asset} ${k}: expected ${JSON.stringify(want)}, effective ${got && got.source !== "missing" ? `${JSON.stringify(got.value)} (${got.source})` : "missing"}`);
    }
    if (bad.length) { requireFailures = bad; return finish(`requireEffective not met: ${bad.join("; ")}`); }
  }
  // bindingsPolicy "reject": a real-profile parity run; any key a twin binding supplies is a setup failure, not a robot result
  // "reject" refuses a bound shot calibration (the twin's solver standing in for a measurement); "reject-all" refuses any bound key
  if ((scenario.bindingsPolicy === "reject" || scenario.bindingsPolicy === "reject-all") && manifest) {
    const bound = scenario.bindingsPolicy === "reject-all"
      ? Object.entries(manifest.effective).flatMap(([p, keys]) => Object.entries(keys).filter(([, v]) => v.source === "bound").map(([k]) => `${p.replace(/^.*\//, "")} ${k}`))
      : (manifest.profile?.boundCalibration ?? []);
    if (bound.length) { const why = `bindingsPolicy ${scenario.bindingsPolicy}: ${bound.length} ${scenario.bindingsPolicy === "reject" ? "calibration " : ""}key${bound.length === 1 ? "" : "s"} come from twin bindings (${bound.map((b) => b.replace(/^\S+ /, "")).join(", ")}): a synthetic calibration, not the robot's profile; use ignoreBindings for a real-profile run`; requireFailures = [why]; return finish(why); }
  }
  // SG-007: the team's bundled profile ships practice timers ON; a fixture that does not say which clock it tests
  // cannot be compared with a match objective, so say so in the report
  if (manifest && /auto/i.test(scenario.opMode)) {
    const eff = Object.values(manifest.effective).map((f) => f["matchAuto.pauseAimTimers"]).find(Boolean);
    const explicit = Object.values(scenario.assetOverrides ?? {}).some((o) => "matchAuto.pauseAimTimers" in o) || Object.values(scenario.requireEffective ?? {}).some((o) => "matchAuto.pauseAimTimers" in o);
    if (eff?.value === true && !explicit) warnings.push(`matchAuto.pauseAimTimers is true (${eff.source}) and the scenario does not set it: aiming deadlines are PAUSED (practice clock); return-time and no-shot expectations are not match evidence`);
    if (eff) timingNote = { practiceTimers: eff.value === true, source: eff.source };
  }
  eventsFrom = await page.evaluate(() => window.__twin.recorder.events.length).catch(() => 0);
  hostStart = await hostStatus();
  startSnapshot = await snapshot();
  await page.evaluate(() => { window.__twin.resetPeaks?.(); return window.__twin.link.onAgent("match", { action: "start" }); });
  await page.waitForFunction(() => window.__twin.link.status === "RUNNING", null, { timeout: 10_000 }).catch(() => {});
  simStart = await page.evaluate(() => window.__twin.match.now());
  const wallStart = Date.now();

  // ---- 3. drive the scenario in simulated time
  const inputs = [...(scenario.inputs ?? [])].sort((a, b) => a.t - b.t);
  // event-relative faults: {at: {t: s} | {telemetry: regex}, durationS, perception, tagCovers, physics, feed}; applied
  // through the same whitelisted setter agents use (POST /api/twin), restored after durationS
  const faults = (scenario.faults ?? []).map((f) => ({ ...f, fired: false, restoreAt: undefined, restore: undefined }));
  const twinSet = (params) => page.evaluate((p) => window.__twin.link.onAgent("twin", p), params);
  const faultParams = (f) => { const p = {}; if (f.perception?.level) p["perception.level"] = f.perception.level; for (const [k, v] of Object.entries(f.perception?.faults ?? {})) p[`perception.faults.${k}`] = v; if (f.tagCovers) p.tagCovers = f.tagCovers; if (f.physics !== undefined) p.physics = typeof f.physics === "string" ? { kind: f.physics } : f.physics; if (f.feed) for (const [k, v] of Object.entries(f.feed)) p[`feed.${k}`] = v; return p; };
  const readBack = (params) => page.evaluate((keys) => { const t = window.__twin; const out = {}; for (const k of keys) { if (k === "physics") { out[k] = { ...t.state.physics }; continue; } if (k === "tagCovers") { out[k] = [...t.state.tagCovers]; continue; } let o = t.state; for (const part of k.split(".")) o = o?.[part]; out[k] = o && typeof o === "object" ? JSON.parse(JSON.stringify(o)) : o; } return out; }, Object.keys(params));
  wallStartMs = Date.now();
  let nextSample = 0, idx = 0, now = 0;
  const wallLimit = Date.now() + (60 + duration * 12) * 1000; // simulated time can run slowly headless, but never hang
  let stall;
  for (;;) {
    if (pageErrors.length) { stall = `the twin threw in the browser: ${pageErrors[0]}`; break; }
    if (Date.now() > wallLimit) { stall = "simulated time stopped advancing (frame loop stalled?)"; break; }
    now = (await page.evaluate(() => window.__twin.match.now())) - simStart;
    while (idx < inputs.length && inputs[idx].t <= now) { const inp = inputs[idx++]; await page.evaluate(({ pad, set }) => window.__twin.input.inject(pad ?? 1, set), inp); }
    if (faults.length) {
      const lines = await page.evaluate(() => window.__twin.link.telemetry).catch(() => []);
      for (const f of faults) {
        if (!f.fired && ((f.at?.t !== undefined && now >= f.at.t) || (f.at?.telemetry && lines.some((l) => new RegExp(f.at.telemetry).test(l))))) {
          const params = faultParams(f);
          f.restore = await readBack(params); f.fired = true; f.firedAt = +now.toFixed(2);
          await twinSet(params);
          if (f.durationS) f.restoreAt = now + f.durationS;
          faultLog.push({ t: f.firedAt, applied: params, trigger: f.at });
          console.log(`twin-test: fault at ${now.toFixed(1)} s (${f.at?.telemetry ? `telemetry /${f.at.telemetry}/` : `t=${f.at?.t}`}): ${Object.keys(params).join(", ")}${f.durationS ? ` for ${f.durationS} s` : ""}`);
        } else if (f.fired && f.restoreAt !== undefined && now >= f.restoreAt) {
          await twinSet(f.restore); f.restoreAt = undefined; faultLog.push({ t: +now.toFixed(2), restored: Object.keys(f.restore) });
        }
      }
    }
    if (now >= nextSample) { samples.push({ t: +now.toFixed(2), ...(await snapshot(true)) }); nextSample += sampleEvery; }
    const st = await page.evaluate(() => window.__twin.link.status);
    if (st === "ERROR" || st === "STOPPED") break;
    if (now >= duration) break;
    await page.waitForTimeout(100);
  }
  const wall = (Date.now() - wallStart) / 1000;
  console.log(`twin-test: simulated ${now.toFixed(1)} s in ${wall.toFixed(0)} s wall (${(now / Math.max(wall, 0.1)).toFixed(2)}x real time)`);
  if (stall) console.error(`twin-test: ${stall}`);
  final = await snapshot();
  // every telemetry line the twin recorded at 10 Hz during the run (states that last under a second are in here);
  // stored compactly as the moments a line changed, so the report stays small
  telemetryChanges = await page.evaluate(() => {
    const t = window.__twin; const run = t.recorder.latestRun(); const from = run ? run.start : 0;
    const out = []; let prev = "";
    for (const s of t.recorder.samples) { if (s.t < from) continue; const key = s.telemetry.join("\n"); if (key !== prev) { out.push({ t: +((s.t - from) / 1000).toFixed(1), lines: s.telemetry, pose: { xIn: +s.pose.xIn.toFixed(1), zIn: +s.pose.zIn.toFixed(1), headingDeg: +s.pose.headingDeg.toFixed(1) } }); prev = key; } }
    return out;
  }).catch(() => []);
  return finish(stall && !pageErrors.length ? stall : undefined);

  function reportSetupFailure(reason) {
    const rep = { scenario: scenario.name ?? scenarioPath ?? scenario.opMode, opMode: scenario.opMode, team, pass: false, verdict: "fail", failed: reason, checks: [{ check: "setup", pass: false, verdict: "fail", detail: reason }], samples: [], pageErrors: [], generatedAt: new Date().toISOString() };
    writeReport(out, rep);
    console.log(`\ntwin-test: ${rep.scenario}\n  ✗ setup: ${reason}\n  report: ${out}`);
    return false;
  }
  function reportUnsupported(reasons) {
    const e = scenario.expect ?? {};
    const checks = Object.keys(e).map((k) => ({ check: k, pass: false, verdict: "unsupported", detail: reasons.join("; ") }));
    const rep = { scenario: scenario.name ?? scenarioPath ?? scenario.opMode, opMode: scenario.opMode, team, pass: false, verdict: "unsupported", unsupported: reasons, checks, samples: [], pageErrors: [], generatedAt: new Date().toISOString() };
    writeReport(out, rep);
    console.log(`\ntwin-test: ${rep.scenario}\n  ? UNSUPPORTED — ${reasons.join("; ")}\n  report: ${out}`);
    return false;
  }
  function report(failed) {
    const checks = [];
    const e = scenario.expect ?? {};
    const wallS = wallStartMs ? (Date.now() - wallStartMs) / 1000 : 0;
    const simS = final && startSnapshot ? Math.max(0, now) : 0;
    const ratio = wallS > 0 ? simS / wallS : 1;
    const held = (hostEnd?.sensors?.heldFramesLive ?? hostEnd?.sensors?.heldFramesEver ?? 0) - (hostStart?.sensors?.heldFramesLive ?? hostStart?.sensors?.heldFramesEver ?? 0);
    // sensor gaps that happened under a live OpMode during this scenario (gaps while IDLE / STOPPED are page loads between
    // scenarios and touched no robot); the team's shot cycle aborts on a loop gap over 300 ms, so such a gap changes the
    // robot's behaviour and the run is not evidence either way
    const gapsBefore = hostStart?.sensors?.gapsLive?.length ?? 0;
    const liveGaps = (hostEnd?.sensors?.gapsLive ?? []).slice(gapsBefore).filter((g) => (g.status === "RUNNING" || g.status === "INIT") && g.gapMs > 300);
    // infrastructure: the machine could not keep the run at real time, so timing-dependent robot behaviour is not evidence
    const infra = [];
    if (duration > 0 && simS > 1 && ratio < 0.8) infra.push(`ran at ${ratio.toFixed(2)}x real time (under 0.8x)`);
    if (liveGaps.length > 2 || liveGaps.some((g) => g.gapMs > 1000)) infra.push(`${liveGaps.length} sensor gap${liveGaps.length === 1 ? "" : "s"} over 300 ms while the OpMode ran (longest ${Math.max(...liveGaps.map((g) => g.gapMs))} ms)`);
    if (pageErrors.length) infra.push(`the page threw: ${pageErrors[0]}`);
    if (failed && /stalled\?|did not answer|Execution context/.test(String(failed))) infra.push(String(failed));
    const physical = (c) => (infra.length && c.check !== "noErrors" && !c.verdict ? { ...c, pass: false, verdict: "inconclusive", detail: `${c.detail ? c.detail + " · " : ""}infrastructure: ${infra.join("; ")}` } : { verdict: c.pass ? "pass" : "fail", ...c });
    // 1 Hz samples plus the 10 Hz change log, so brief states count
    const allLines = samples.flatMap((s) => s.telemetry ?? []).concat(final?.telemetry ?? [], telemetryChanges.flatMap((c) => c.lines));
    // first simulated time each regex matched, for ordered checks
    const firstSeen = (re) => { const r = new RegExp(re); for (const c of telemetryChanges) if (c.lines.some((l) => r.test(l))) return c.t; for (const s of samples) if ((s.telemetry ?? []).some((l) => r.test(l))) return s.t; return undefined; };
    if (e.noErrors) checks.push({ check: "noErrors", pass: !final?.error && pageErrors.length === 0 && !failed, detail: final?.error || pageErrors[0] || failed || "" });
    if (e.shotsFired) checks.push({ check: `shotsFired ${e.shotsFired}`, pass: cmp(e.shotsFired, final?.shotsFired ?? 0), detail: `fired ${final?.shotsFired ?? 0}` });
    if (e.shotsHit) checks.push({ check: `shotsHit ${e.shotsHit}`, pass: cmp(e.shotsHit, final?.shotsHit ?? 0), detail: `hit ${final?.shotsHit ?? 0}` });
    if (e.fouls) { const n = Object.values(final?.fouls ?? {}).reduce((a, b) => a + b, 0); checks.push({ check: `fouls ${e.fouls}`, pass: cmp(e.fouls, n), detail: `${n} fouls` }); }
    for (const re of e.telemetryIncludes ?? []) checks.push({ check: `telemetry matches /${re}/ at some point`, pass: allLines.some((l) => new RegExp(re).test(l)), detail: "" });
    for (const re of e.telemetryFinalIncludes ?? []) checks.push({ check: `final telemetry matches /${re}/`, pass: (final?.telemetry ?? []).some((l) => new RegExp(re).test(l)), detail: "" });
    if (e.telemetrySequence?.length) {
      // each regex must first appear after the previous one did
      const times = e.telemetrySequence.map((re) => ({ re, t: firstSeen(re) }));
      let ok = true, last = -1, why = "";
      for (const x of times) { if (x.t === undefined) { ok = false; why = `/${x.re}/ never appeared`; break; } if (x.t < last) { ok = false; why = `/${x.re}/ appeared at ${x.t}s, before the previous step (${last}s)`; break; } last = x.t; }
      checks.push({ check: `telemetry sequence ${e.telemetrySequence.map((r) => `/${r}/`).join(" → ")}`, pass: ok, detail: ok ? times.map((x) => `${x.t}s`).join(" → ") : why });
    }
    if (e.movedAtLeastIn !== undefined && final && startSnapshot) { const d = Math.hypot(final.poseIn.x - startSnapshot.poseIn.x, final.poseIn.z - startSnapshot.poseIn.z); checks.push({ check: `moved ≥ ${e.movedAtLeastIn} in`, pass: d >= e.movedAtLeastIn, detail: `${d.toFixed(1)} in` }); }
    if (e.poseNear && final) { const d = Math.hypot(final.poseIn.x - e.poseNear.xIn, final.poseIn.z - e.poseNear.zIn); checks.push({ check: `ends within ${e.poseNear.tolIn ?? 12} in of (${e.poseNear.xIn}, ${e.poseNear.zIn})`, pass: d <= (e.poseNear.tolIn ?? 12), detail: `${d.toFixed(1)} in away` }); }
    if (e.scoreAtLeast !== undefined && final?.score) { const mine = final.score[scenario.alliance ?? "red"]?.total ?? 0; checks.push({ check: `our score ≥ ${e.scoreAtLeast}`, pass: mine >= e.scoreAtLeast, detail: `${mine} pts` }); }
    // ---- physical-outcome checks (handoff G04, G08, G09, G11): counted transfers, not visited states
    const delta = (k) => (final?.[k] ?? 0) - (startSnapshot?.[k] ?? 0);
    if (e.launches) checks.push({ check: `launches ${e.launches}`, pass: cmp(e.launches, delta("launches")), detail: `${delta("launches")} balls reached the flywheel` });
    if (e.feederPulses) checks.push({ check: `feederPulses ${e.feederPulses}`, pass: cmp(e.feederPulses, delta("feederPulses")), detail: `${delta("feederPulses")} feeder pulses commanded` });
    if (e.collectedAtLeast !== undefined) checks.push({ check: `collected ≥ ${e.collectedAtLeast} (inventory delta)`, pass: delta("picks") >= e.collectedAtLeast, detail: `${delta("picks")} game pieces entered the robot` });
    if (e.stalls) checks.push({ check: `stalls ${e.stalls}`, pass: cmp(e.stalls, delta("stalls")), detail: `${delta("stalls")} stall episodes` });
    if (e.noStall) { const st = eventsAll.filter((x) => x.kind === "stall"); checks.push({ check: "no drive stall", pass: st.length === 0, detail: st.length ? st[0].text : "" }); }
    if (e.contacts) { const ct = eventsAll.filter((x) => x.kind === "contact"); checks.push({ check: `contacts ${e.contacts}`, pass: cmp(e.contacts, ct.length), detail: ct.length ? `${ct.length}: ${ct[0].text}` : "no loose-ball contact held the chassis" }); }
    // the flywheel never commanded: "no shot was even attempted" is a claim about outputs, not about states
    if (e.flywheelMaxPower) { const peak = final?.flywheelPeakPower ?? Math.max(0, ...samples.map((x) => x.flywheelPower ?? 0)); checks.push({ check: `flywheel peak power ${e.flywheelMaxPower}`, pass: cmp(e.flywheelMaxPower, +peak.toFixed(3)), detail: `peak commanded ${Math.round(peak * 100)} %` }); }
    // telemetry range vs world truth (SG-002): the code's range to the opening against the twin's geometric distance
    if (e.rangeConsistency) {
      const re = new RegExp(e.rangeConsistency.telemetry ?? "Target / range / power.*?/ (-?\\d+(?:\\.\\d+)?) in /");
      const ref = e.rangeConsistency.reference === "exit" ? "rangeExitIn" : "rangeCentreIn";
      const pairs = samples.flatMap((x) => { const line = (x.telemetry ?? []).map((l) => re.exec(l)).find(Boolean); return line && x.truth ? [{ t: x.t, reported: parseFloat(line[1]), truth: x.truth[ref] }] : []; }).filter((p) => Number.isFinite(p.reported) && Number.isFinite(p.truth));
      const tol = e.rangeConsistency.tolIn ?? 3;
      const devs = pairs.map((p) => p.reported - p.truth);
      const worst = devs.length ? devs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0) : undefined;
      const mean = devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : undefined;
      checks.push({ check: `telemetry range within ${tol} in of the ${ref === "rangeExitIn" ? "launcher-exit" : "robot-centre"} distance to the opening`, pass: pairs.length > 0 && Math.abs(worst) <= tol, ...(pairs.length ? {} : { verdict: "inconclusive" }), detail: pairs.length ? `${pairs.length} samples, reported − truth: worst ${worst.toFixed(1)} in, mean ${mean.toFixed(1)} in (e.g. ${pairs[0].reported} vs ${pairs[0].truth} in at ${pairs[0].t}s)` : "no telemetry line with a range matched while a truth sample existed" });
    }
    // measured displacement and heading change between two telemetry moments (SG-008): not DRIVE_OUT → AIM_SHOOT, inches
    for (const tb of e.travelBetween ?? []) {
      const at = (re) => { const r = new RegExp(re); return telemetryChanges.find((c) => c.lines.some((l) => r.test(l))); };
      const a = at(tb.after), b = at(tb.until);
      if (!a || !b || !a.pose || !b.pose) { checks.push({ check: `travel /${tb.after}/ → /${tb.until}/`, pass: false, detail: !a ? `/${tb.after}/ never appeared` : !b ? `/${tb.until}/ never appeared` : "no pose recorded" }); continue; }
      const d = Math.hypot(b.pose.xIn - a.pose.xIn, b.pose.zIn - a.pose.zIn);
      const dh = Math.abs(((b.pose.headingDeg - a.pose.headingDeg + 540) % 360) - 180);
      const okD = (tb.minIn === undefined || d >= tb.minIn) && (tb.maxIn === undefined || d <= tb.maxIn);
      const okH = tb.headingChangeMaxDeg === undefined || dh <= tb.headingChangeMaxDeg;
      checks.push({ check: `travel /${tb.after}/ → /${tb.until}/${tb.minIn !== undefined || tb.maxIn !== undefined ? ` ${tb.minIn ?? 0}–${tb.maxIn ?? "∞"} in` : ""}${tb.headingChangeMaxDeg !== undefined ? `, heading change ≤ ${tb.headingChangeMaxDeg}°` : ""}`, pass: okD && okH, detail: `${d.toFixed(1)} in, heading ${dh.toFixed(1)}° (from (${a.pose.xIn}, ${a.pose.zIn}) @ ${a.t}s to (${b.pose.xIn}, ${b.pose.zIn}) @ ${b.t}s)` });
    }
    // a state reached before a deadline (SG-010): elapsed time is part of the objective
    for (const tbf of e.telemetryBefore ?? []) { const t = firstSeen(tbf.match); checks.push({ check: `/${tbf.match}/ by ${tbf.byS} s`, pass: t !== undefined && t <= tbf.byS, detail: t === undefined ? "never appeared" : `at ${t} s` }); }
    if (e.outputsZeroAfterStop) checks.push({ check: "commanded outputs zero after STOP", pass: !!outputsAfterStop?.zero, detail: outputsAfterStop?.zero ? "" : `still commanded: ${(outputsAfterStop?.nonZero ?? []).join(", ") || "unknown"}` });
    if (e.footprintInside && final) {
      const zones = { loadingRed: { xMin: -72, xMax: -61, zMin: -48, zMax: -25 }, loadingBlue: { xMin: 61, xMax: 72, zMin: 25, zMax: 48 } };
      const zoneName = typeof e.footprintInside === "string" ? e.footprintInside : e.footprintInside.zone;
      const z = zoneName ? zones[zoneName.replace(/^loading$/, (scenario.alliance ?? "red") === "red" ? "loadingRed" : "loadingBlue")] : e.footprintInside;
      const require = (typeof e.footprintInside === "object" && e.footprintInside.require) || "overlap";
      if (!z) checks.push({ check: `footprint inside ${JSON.stringify(e.footprintInside)}`, pass: false, verdict: "unsupported", detail: "unknown zone (loading, loadingRed, loadingBlue, or {xMinIn,xMaxIn,zMinIn,zMaxIn})" });
      else {
        const L = (final.robot?.lengthIn ?? 18) / 2, W = (final.robot?.widthIn ?? 18) / 2, h = (final.poseIn.headingDeg * Math.PI) / 180;
        const fx = -Math.sin(h), fz = -Math.cos(h), lx = -Math.cos(h), lz = Math.sin(h);
        const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => ({ x: final.poseIn.x + fx * L * a + lx * W * b, z: final.poseIn.z + fz * L * a + lz * W * b }));
        const xMin = z.xMinIn ?? z.xMin, xMax = z.xMaxIn ?? z.xMax, zMin = z.zMinIn ?? z.zMin, zMax = z.zMaxIn ?? z.zMax;
        const inside = (p) => p.x >= xMin && p.x <= xMax && p.z >= zMin && p.z <= zMax;
        const nIn = corners.filter(inside).length;
        const center = inside({ x: final.poseIn.x, z: final.poseIn.z });
        const rx = [Math.min(...corners.map((c) => c.x)), Math.max(...corners.map((c) => c.x))], rz = [Math.min(...corners.map((c) => c.z)), Math.max(...corners.map((c) => c.z))];
        const overlap = rx[0] <= xMax && rx[1] >= xMin && rz[0] <= zMax && rz[1] >= zMin;
        const ok = require === "all" ? nIn === 4 : require === "center" ? center : overlap;
        checks.push({ check: `footprint ${require === "all" ? "fully inside" : require === "center" ? "centre inside" : "overlaps"} ${zoneName ?? "bounds"}`, pass: ok, detail: `${nIn}/4 corners inside, centre ${center ? "inside" : "outside"}, chassis ${final.robot?.lengthIn ?? 18}×${final.robot?.widthIn ?? 18} in at (${final.poseIn.x}, ${final.poseIn.z}) @ ${final.poseIn.headingDeg}°` });
      }
    }
    const evT = (ev) => (ev.t - (wallStartMs || ev.t)) / 1000; // wall-clock events as seconds after START (the ratio is reported)
    for (const w of e.eventWithin ?? []) {
      // after the first telemetry match of `after`, an event of kind/regex `event` must occur within `withinS` (bounded fallbacks)
      const t0 = firstSeen(w.after);
      const kinds = ["status", "error", "log", "button", "shot", "foul", "note", "hardware", "stall", "feed", "launch", "fault", "manifest", "pick", "contact"];
      const match = (ev) => (kinds.includes(w.event) ? ev.kind === w.event : new RegExp(w.event).test(ev.text));
      const hit = t0 === undefined ? undefined : eventsAll.find((ev) => match(ev) && evT(ev) >= t0 - 0.5);
      const telemetryHit = t0 === undefined || kinds.includes(w.event) ? undefined : firstSeen(w.event);
      const when = hit ? evT(hit) : telemetryHit;
      const ok = t0 !== undefined && when !== undefined && when - t0 <= w.withinS;
      checks.push({ check: `/${w.after}/ → ${w.event} within ${w.withinS} s`, pass: ok, detail: t0 === undefined ? `/${w.after}/ never appeared` : when === undefined ? `${w.event} never happened after ${t0}s` : `${(when - t0).toFixed(1)} s` });
    }
    const judged = checks.map(physical);
    for (const f of requireFailures) judged.unshift({ check: "requireEffective", pass: false, verdict: "fail", detail: f });
    const pass = judged.every((c) => c.verdict === "pass") && !failed;
    const verdict = pass ? "pass" : judged.some((c) => c.verdict === "unsupported") && judged.every((c) => c.verdict !== "fail") ? "unsupported" : infra.length && judged.every((c) => c.verdict !== "fail") ? "inconclusive" : "fail";
    const events = eventsAll.map((ev) => ({ t: +evT(ev).toFixed(2), kind: ev.kind, text: ev.text, ...(ev.data ? { data: ev.data } : {}) }));
    const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
    const rep = { runId, scenario: scenario.name ?? scenarioPath ?? scenario.opMode, scenarioPath, opMode: scenario.opMode, team, twinSettings: settingsFile, seed: scenario.seed, pass, verdict, failed, infrastructure: infra.length ? infra : undefined, warnings: warnings.length ? warnings : undefined, timing: { simulatedS: +simS.toFixed(1), wallS: +wallS.toFixed(1), ratio: +ratio.toFixed(2), heldSensorPackets: held, liveGapsOver300Ms: liveGaps, clock: "wall", practiceTimers: timingNote?.practiceTimers, practiceTimersSource: timingNote?.source }, checks: judged, manifest, faults: faultLog.length ? faultLog : undefined, events, start: startSnapshot, final, samples, telemetryChanges, pageErrors, pageErrorStacks, hostLogTail: simLog.split("\n").slice(-30), generatedAt: new Date().toISOString() };
    writeReport(out, rep);
    if (pageErrorStacks.length) console.log(`  page error stack:\n    ${pageErrorStacks[0].replace(/\n/g, "\n    ")}`);
    const mark = { pass: "✓", fail: "✗", inconclusive: "~", unsupported: "?" };
    console.log(`\ntwin-test: ${rep.scenario}`);
    if (failed) console.log(`  ✗ ${failed}`);
    for (const c of judged) console.log(`  ${mark[c.verdict] ?? "✗"} ${c.check}${c.verdict !== "pass" && c.verdict !== "fail" ? ` [${c.verdict}]` : ""}${c.detail ? ` — ${c.detail}` : ""}`);
    if (infra.length) console.log(`  ~ infrastructure: ${infra.join("; ")}`);
    for (const w of warnings) console.log(`  ! ${w}`);
    if (final) {
      console.log(`  final: ${final.status}${final.error ? " " + final.error.split("\n")[0] : ""} · pose (${final.poseIn.x}, ${final.poseIn.z}) in @ ${final.poseIn.headingDeg}° · ${delta("feederPulses")} pulses, ${delta("launches")} launched, ${final.shotsHit} scored · collected ${delta("picks")} · ${delta("stalls")} stalls · carrying ${final.carrying?.pollen} pollen + ${final.carrying?.nectar} nectar · ${ratio.toFixed(2)}x real time`);
      const notable = events.filter((ev) => ["stall", "launch", "feed", "fault", "error", "pick", "contact"].includes(ev.kind)).slice(0, 14);
      if (notable.length) console.log(`  events:\n    ${notable.map((ev) => `${ev.t}s [${ev.kind}] ${ev.text}`).join("\n    ")}${events.length > notable.length ? `\n    (… ${events.length} events in the report)` : ""}`);
      console.log(`  telemetry (final):\n    ${(final.telemetry ?? []).join("\n    ")}`);
    }
    console.log(`  verdict: ${verdict.toUpperCase()} · report: ${out}`);
    return pass;
  }
}

/** A team file by relative path: under --team as given (root, TeamCode module or java folder), under its TeamCode
 * module, or up to three parents above it; absolute paths are used as they are. */
function findTeamFile(teamPath, rel) {
  if (!rel) return undefined;
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) return existsSync(rel) ? rel : undefined;
  const bases = [];
  if (teamPath) { let d = resolve(teamPath); for (let i = 0; i < 4; i++) { bases.push(d, resolve(d, "TeamCode")); d = dirname(d); } }
  for (const b of bases) { const f = resolve(b, rel); if (existsSync(f)) return f; }
  return undefined;
}

function writeReport(out, rep) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(rep, null, 2)); }

function cmp(expr, value) {
  const m = /^(>=|<=|==|!=|>|<)?\s*(-?\d+(?:\.\d+)?)$/.exec(String(expr).trim());
  if (!m) return false;
  const [, op = "==", n] = m; const x = parseFloat(n);
  return op === ">=" ? value >= x : op === "<=" ? value <= x : op === ">" ? value > x : op === "<" ? value < x : op === "!=" ? value !== x : value === x;
}
