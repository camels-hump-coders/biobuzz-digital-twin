#!/usr/bin/env node
/**
 * Headless test bed: run one or more OpModes against the twin from scenario files and write JSON reports.
 *
 *   pnpm twin-test --scenario scenarios/example-teleop.json [--scenario more.json ...] [--team <path>] [--out report.json | --out-dir dir]
 *   pnpm twin-test --opmode "Sim: StarterBot TeleOp" --duration 20
 *
 * One host and one Vite server serve every scenario in the list (each scenario gets a fresh browser page); starting the
 * host (Gradle + JVM) is the slow part, so batch scenarios instead of calling this once per file. Exit code 0 only
 * when every scenario passes. The twin is served as a production build of the COMMITTED tree (HEAD), so another
 * agent's uncommitted edits never run here (--wip builds the working tree, --dev uses the dev server, --rebuild forces). Other flags: --port 5190 --host-port 8790 --headed --screenshot shot.png --host-timeout 600.
 */
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// a headless run is background work: lower our own priority so the launcher, Vite and the browser we spawn inherit it
// and the human's session (and the desktop) stay responsive; the Gradle daemon gets --priority=low separately
try { os.setPriority(process.pid, 10); } catch {}
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
simArgs.push("--low-priority");
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
const browser = await playwright.chromium.launch({ headless: !headed, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--num-raster-threads=2", "--renderer-process-limit=2", "--disable-gpu-compositing"] });
const results = [];
for (let i = 0; i < scenarios.length; i++) {
  const { path: scenarioPath, scenario } = scenarios[i];
  const out = reportPathFor(scenarios[i], i);
  if (scenarios.length > 1) console.log(`\n=== [${i + 1}/${scenarios.length}] ${scenario.name ?? scenarioPath ?? scenario.opMode}`);
  let pass = false;
  try { pass = await runScenario(scenario, scenarioPath, out); }
  catch (e) { console.error(`twin-test: scenario crashed: ${e?.stack ?? e}`); writeReport(out, { scenario: scenario.name ?? scenarioPath, opMode: scenario.opMode, team, pass: false, failed: String(e), checks: [], samples: [], pageErrors: [], hostLogTail: simLog.split("\n").slice(-30), generatedAt: new Date().toISOString() }); }
  results.push({ name: scenario.name ?? scenarioPath ?? scenario.opMode, pass, out });
}
await browser.close();
if (results.length > 1) {
  console.log(`\ntwin-test: ${results.filter((r) => r.pass).length}/${results.length} passed`);
  for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}  (${r.out})`);
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
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
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
  const seed = {
    ...fileSettings,
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
  await page.addInitScript((s) => { localStorage.setItem("biobuzz-twin", JSON.stringify(s)); }, seed);
  await page.goto(`http://localhost:${port}/?ci=1${scenario.ignoreBindings ? "&nobind=1" : ""}`, { waitUntil: "networkidle" }); // ci=1: light rendering so the sim runs at full rate under software GL
  await page.waitForFunction(() => window.__twin && window.__twin.robot.modelStatus !== "loading", null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__twin.link.connected && window.__twin.link.opModes.length > 0, null, { timeout: 30_000 }).catch(() => {});
  // the first renders compile every shader and stall the page for up to a second under software GL; let that happen
  // before INIT so the OpMode's first seconds (spin-up, first camera frames) are not the ones that pay for it
  await page.waitForFunction(() => (window.__twinRenderCount ?? 0) >= 3, null, { timeout: 8_000 }).catch(() => {});
  const opModes = await page.evaluate(() => window.__twin.link.opModes.map((o) => o.name));
  const samples = [];
  let startSnapshot, final, simStart = 0, telemetryChanges = [];
  const snapshot = (light = false) => page.evaluate((light) => {
    const t = window.__twin, s = t.stats();
    const base = { status: t.link.status, error: t.link.statusError || undefined, telemetry: t.link.telemetry, poseIn: { x: +(t.state.pose.x / 0.0254).toFixed(1), z: +(t.state.pose.z / 0.0254).toFixed(1), headingDeg: +((t.state.pose.heading * 180) / Math.PI).toFixed(1) }, shotsFired: s.shotsFired, shotsHit: s.shotsHit };
    if (light) return base;
    const inv = t.playerAgent.inventory;
    const r = t.state.robot, fly = t.state.hardware.devices.find((d) => d.role === "flywheel");
    return { ...base, robot: { preset: t.state.robotPresetId, drivetrain: r.drivetrain, intakeSide: r.intake?.side, cameras: r.cameras.map((c) => `${c.name} pitch ${c.pitchDeg} yaw ${c.yawDeg}`), launcher: { yawOffsetDeg: r.launcher.yawOffsetDeg, elevationDeg: r.launcher.elevationDeg, efficiency: r.launcher.efficiency }, flywheelFreeRpm: fly?.freeRpm, mirroredSide: t.state.hardware.mirroredSide }, carrying: { pollen: inv.pollen, nectar: inv.nectar }, hives: Object.fromEntries(Object.entries(t.match.hives).map(([a, h]) => [a, { upCell: h.upCell, tips: h.tips, load: t.match.cellLoad(a) }])), fouls: Object.fromEntries(t.__pins.fouls), matchClock: t.state.matchClock, matchPhase: t.state.matchPhase, score: t.score?.(), hardware: t.state.hardware.devices.map((d) => `${d.kind}:${d.name}`) };
  }, light);
  const finish = async (failed) => {
    await page.evaluate(() => window.__twin.input.clearInjected()).catch(() => {});
    final = final ?? (await snapshot().catch(() => undefined));
    await page.click('#panel button:has-text("STOP")').catch(() => {});
    await page.waitForFunction(() => ["STOPPED", "IDLE", "ERROR", "DISCONNECTED"].includes(window.__twin.link.status), null, { timeout: 5_000 }).catch(() => {});
    if (flag("--screenshot") && scenarios.length === 1) await page.screenshot({ path: resolve(flag("--screenshot")) }).catch(() => {});
    await context.close();
    return report(failed);
  };
  if (!opModes.includes(scenario.opMode)) { console.error(`twin-test: OpMode "${scenario.opMode}" not found. Available:\n  ${opModes.join("\n  ")}`); return finish(`OpMode "${scenario.opMode}" not found`); }
  // robot / hardware presets through the panel so the same code paths run as for a human (they override twinSettings)
  if (scenario.robotPreset) await page.evaluate((id) => { const s = [...document.querySelectorAll("#panel select")].find((x) => [...x.options].some((o) => o.value === id)); if (s) { s.value = id; s.dispatchEvent(new Event("change")); } }, scenario.robotPreset);
  if (scenario.hardwarePreset) await page.evaluate((hp) => { const label = hp === "camelsHump" ? "Camels Hump" : "StarterBot names"; [...document.querySelectorAll("#panel button")].find((b) => b.textContent.includes(label))?.click(); }, scenario.hardwarePreset);
  await page.waitForTimeout(400);
  // INIT (parks everything at the start positions), then our custom start pose if given, then START
  await page.evaluate((name) => { const s = [...document.querySelectorAll("#panel select")].find((x) => [...x.options].some((o) => o.value === name)); s.value = name; s.dispatchEvent(new Event("change")); }, scenario.opMode);
  await page.click('#panel button:has-text("INIT")');
  await page.waitForFunction(() => ["INIT", "ERROR"].includes(window.__twin.link.status), null, { timeout: 20_000 }).catch(() => {});
  const status = await page.evaluate(() => ({ status: window.__twin.link.status, error: window.__twin.link.statusError }));
  if (status.status !== "INIT") return finish(`INIT did not complete: ${status.status} ${status.error}`);
  if (scenario.start) await page.evaluate((p) => { const t = window.__twin; t.state.pose = { x: p.xIn * 0.0254, z: p.zIn * 0.0254, heading: (p.headingDeg * Math.PI) / 180 }; t.robot.setPose(t.state.pose); }, scenario.start);
  startSnapshot = await snapshot();
  await page.click('#panel button:has-text("START")');
  await page.waitForFunction(() => window.__twin.link.status === "RUNNING", null, { timeout: 10_000 }).catch(() => {});
  simStart = await page.evaluate(() => window.__twin.match.now());
  const wallStart = Date.now();

  // ---- 3. drive the scenario in simulated time
  const inputs = [...(scenario.inputs ?? [])].sort((a, b) => a.t - b.t);
  let nextSample = 0, idx = 0, now = 0;
  const wallLimit = Date.now() + (60 + duration * 12) * 1000; // simulated time can run slowly headless, but never hang
  let stall;
  for (;;) {
    if (pageErrors.length) { stall = `the twin threw in the browser: ${pageErrors[0]}`; break; }
    if (Date.now() > wallLimit) { stall = "simulated time stopped advancing (frame loop stalled?)"; break; }
    now = (await page.evaluate(() => window.__twin.match.now())) - simStart;
    while (idx < inputs.length && inputs[idx].t <= now) { const inp = inputs[idx++]; await page.evaluate(({ pad, set }) => window.__twin.input.inject(pad ?? 1, set), inp); }
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
    for (const s of t.recorder.samples) { if (s.t < from) continue; const key = s.telemetry.join("\n"); if (key !== prev) { out.push({ t: +((s.t - from) / 1000).toFixed(1), lines: s.telemetry }); prev = key; } }
    return out;
  }).catch(() => []);
  return finish(stall && !pageErrors.length ? stall : undefined);

  function report(failed) {
    const checks = [];
    const e = scenario.expect ?? {};
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
    const pass = checks.every((c) => c.pass) && !failed;
    const rep = { scenario: scenario.name ?? scenarioPath ?? scenario.opMode, opMode: scenario.opMode, team, twinSettings: settingsFile, pass, failed, checks, start: startSnapshot, final, samples, telemetryChanges, pageErrors, hostLogTail: simLog.split("\n").slice(-30), generatedAt: new Date().toISOString() };
    writeReport(out, rep);
    console.log(`\ntwin-test: ${rep.scenario}`);
    if (failed) console.log(`  ✗ ${failed}`);
    for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.check}${c.detail ? ` — ${c.detail}` : ""}`);
    if (final) {
      console.log(`  final: ${final.status}${final.error ? " " + final.error.split("\n")[0] : ""} · pose (${final.poseIn.x}, ${final.poseIn.z}) in @ ${final.poseIn.headingDeg}° · fired ${final.shotsFired}, hit ${final.shotsHit} · carrying ${final.carrying?.pollen} pollen + ${final.carrying?.nectar} nectar`);
      console.log(`  telemetry (final):\n    ${(final.telemetry ?? []).join("\n    ")}`);
    }
    console.log(`  report: ${out}`);
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
