#!/usr/bin/env node
/**
 * Headless test bed: run one of the team's OpModes against the digital twin from a scenario file and report what happened.
 *
 *   pnpm twin-test --team <TeamCode project> --scenario scenarios/example-teleop.json [--out report.json] [--headed]
 *   pnpm twin-test --team <path> --opmode "My TeleOp" --duration 10          # minimal, no scenario file
 *
 * Starts the host + twin (ports 5190/8790 by default so a human's `pnpm sim` is untouched), drives the browser with
 * Playwright, injects gamepad inputs at simulated times, samples telemetry, checks the scenario's `expect` block and
 * writes a JSON report. Exit code 0 = all expectations met. See scenarios/scenario.schema.json for the format.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes(name);

const scenarioPath = flag("--scenario");
const scenario = scenarioPath ? JSON.parse(readFileSync(resolve(scenarioPath), "utf8")) : {};
if (flag("--opmode")) scenario.opMode = flag("--opmode");
if (flag("--duration")) scenario.durationS = parseFloat(flag("--duration"));
if (!scenario.opMode) { console.error("twin-test: give --scenario <file> (with opMode) or --opmode <name>"); process.exit(2); }
const team = flag("--team");
const port = flag("--port", "5190"), hostPort = flag("--host-port", "8790");
const out = resolve(flag("--out", "twin-report.json"));
const headed = has("--headed");
const duration = scenario.durationS ?? 20;
const sampleEvery = scenario.sampleEveryS ?? 1;

let playwright;
try { playwright = await import("playwright"); } catch {
  console.error("twin-test: playwright is not installed. Run: pnpm install && pnpm exec playwright install chromium"); process.exit(2);
}

// ---- 1. host + twin
const simArgs = [resolve(root, "scripts/sim.mjs"), "--no-browser", "--no-watch", "--port", port, "--host-port", hostPort];
if (team) simArgs.push("--team", team);
console.log(`twin-test: starting host and twin (${simArgs.slice(1).join(" ")})`);
const sim = spawn(process.execPath, simArgs, { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let simLog = "";
const ready = { host: false, twin: false };
let progressNoted = false;
const onData = (d) => { const s = d.toString(); simLog += s; if (/listening on ws:/.test(s)) ready.host = true; if (/Local:\s+http/.test(s)) ready.twin = true; if (/error:|FAILED|Exception/.test(s)) process.stdout.write(s); };
sim.stdout.on("data", onData); sim.stderr.on("data", onData);
const killSim = () => { try { process.kill(-sim.pid, "SIGTERM"); } catch {} try { execSync(`lsof -nP -iTCP:${port} -iTCP:${hostPort} -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null`, { stdio: "ignore" }); } catch {} };
process.on("exit", killSim); process.on("SIGINT", () => { killSim(); process.exit(130); });
const t0 = Date.now();
while (!(ready.host && ready.twin)) {
  if (sim.exitCode !== null) { console.error("twin-test: the host exited before it was ready. Log tail:\n" + simLog.split("\n").slice(-40).join("\n")); process.exit(1); }
  if (Date.now() - t0 > (parseFloat(flag("--host-timeout", "600")) * 1000)) { console.error("twin-test: timed out waiting for the host (first Gradle build can take minutes). Launcher output:\n" + simLog.split("\n").slice(-60).join("\n")); process.exit(1); }
  if (Date.now() - t0 > 20_000 && !ready.host && !progressNoted) { progressNoted = true; console.log("twin-test: still waiting for the host (Gradle compiling TeamCode)…"); }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`twin-test: host ready after ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// ---- 2. browser
const browser = await playwright.chromium.launch({ headless: !headed, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const seed = {
  alliance: scenario.alliance ?? "red",
  opponents: scenario.opponents ?? true,
  opponentsScore: scenario.opponentsScore ?? true,
  pauseOpponents: false,
  runtimeEnabled: true,
  runtimeUrl: `ws://127.0.0.1:${hostPort}`,
  assetOverrides: scenario.assetOverrides ?? {},
  overlays: { fan: false, dispersion: false, hitmap: false, reach: false },
  showPerf: false,
};
if (scenario.starts) seed.starts = scenario.starts;
await page.addInitScript((s) => { localStorage.setItem("biobuzz-twin", JSON.stringify(s)); }, seed);
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__twin && window.__twin.robot.modelStatus !== "loading", null, { timeout: 60_000 });
await page.waitForFunction(() => window.__twin.link.connected && window.__twin.link.opModes.length > 0, null, { timeout: 30_000 }).catch(() => {});
const opModes = await page.evaluate(() => window.__twin.link.opModes.map((o) => o.name));
if (!opModes.includes(scenario.opMode)) { console.error(`twin-test: OpMode "${scenario.opMode}" not found. Available:\n  ${opModes.join("\n  ")}`); await browser.close(); process.exit(1); }
// robot / hardware presets through the panel so the same code paths run as for a human
if (scenario.robotPreset) await page.evaluate((id) => { const s = [...document.querySelectorAll("#panel select")].find((x) => [...x.options].some((o) => o.value === id)); if (s) { s.value = id; s.dispatchEvent(new Event("change")); } }, scenario.robotPreset);
if (scenario.hardwarePreset) await page.evaluate((hp) => { const label = hp === "camelsHump" ? "Camels Hump" : "StarterBot names"; [...document.querySelectorAll("#panel button")].find((b) => b.textContent.includes(label))?.click(); }, scenario.hardwarePreset);
await page.waitForTimeout(400);
// INIT (parks everything at the start positions), then our custom start pose if given, then START
await page.evaluate((name) => { const s = [...document.querySelectorAll("#panel select")].find((x) => [...x.options].some((o) => o.value === name)); s.value = name; s.dispatchEvent(new Event("change")); }, scenario.opMode);
await page.click('#panel button:has-text("INIT")');
await page.waitForFunction(() => ["INIT", "ERROR"].includes(window.__twin.link.status), null, { timeout: 20_000 }).catch(() => {});
let status = await page.evaluate(() => ({ status: window.__twin.link.status, error: window.__twin.link.statusError }));
if (status.status !== "INIT") { report({ failed: `INIT did not complete: ${status.status} ${status.error}` }); }
if (scenario.start) await page.evaluate((p) => { const t = window.__twin; t.state.pose = { x: p.xIn * 0.0254, z: p.zIn * 0.0254, heading: (p.headingDeg * Math.PI) / 180 }; t.robot.setPose(t.state.pose); }, scenario.start);
const startSnapshot = await snapshot();
await page.click('#panel button:has-text("START")');
await page.waitForFunction(() => window.__twin.link.status === "RUNNING", null, { timeout: 10_000 }).catch(() => {});
const simStart = await page.evaluate(() => window.__twin.match.now());

// ---- 3. drive the scenario in simulated time
const inputs = [...(scenario.inputs ?? [])].sort((a, b) => a.t - b.t);
const samples = [];
let nextSample = 0, idx = 0;
const wallLimit = Date.now() + (60 + duration * 12) * 1000; // simulated time can run slowly headless, but never hang
for (;;) {
  if (pageErrors.length) { console.error(`twin-test: the twin threw in the browser: ${pageErrors[0]}`); break; }
  if (Date.now() > wallLimit) { console.error("twin-test: simulated time stopped advancing (frame loop stalled?)"); break; }
  const now = (await page.evaluate(() => window.__twin.match.now())) - simStart;
  while (idx < inputs.length && inputs[idx].t <= now) { const inp = inputs[idx++]; await page.evaluate(({ pad, set }) => window.__twin.input.inject(pad ?? 1, set), inp); }
  if (now >= nextSample) { samples.push({ t: +now.toFixed(2), ...(await snapshot(true)) }); nextSample += sampleEvery; }
  const st = await page.evaluate(() => window.__twin.link.status);
  if (st === "ERROR" || st === "STOPPED") break;
  if (now >= duration) break;
  await page.waitForTimeout(100);
}
await page.evaluate(() => window.__twin.input.clearInjected());
const final = await snapshot();
await page.click('#panel button:has-text("STOP")').catch(() => {});
if (flag("--screenshot")) await page.screenshot({ path: resolve(flag("--screenshot")) });
await browser.close();
report({});

async function snapshot(light = false) {
  return page.evaluate((light) => {
    const t = window.__twin, s = t.stats();
    const base = { status: t.link.status, error: t.link.statusError || undefined, telemetry: t.link.telemetry, poseIn: { x: +(t.state.pose.x / 0.0254).toFixed(1), z: +(t.state.pose.z / 0.0254).toFixed(1), headingDeg: +((t.state.pose.heading * 180) / Math.PI).toFixed(1) }, shotsFired: s.shotsFired, shotsHit: s.shotsHit };
    if (light) return base;
    const inv = t.playerAgent.inventory;
    return { ...base, carrying: { pollen: inv.pollen, nectar: inv.nectar }, hives: Object.fromEntries(Object.entries(t.match.hives).map(([a, h]) => [a, { upCell: h.upCell, tips: h.tips, load: t.match.cellLoad(a) }])), fouls: Object.fromEntries(t.__pins.fouls), matchClock: t.state.matchClock, matchPhase: t.state.matchPhase, hardware: t.state.hardware.devices.map((d) => `${d.kind}:${d.name}`) };
  }, light);
}

function cmp(expr, value) {
  const m = /^(>=|<=|==|!=|>|<)?\s*(-?\d+(?:\.\d+)?)$/.exec(String(expr).trim());
  if (!m) return false;
  const [, op = "==", n] = m; const x = parseFloat(n);
  return op === ">=" ? value >= x : op === "<=" ? value <= x : op === ">" ? value > x : op === "<" ? value < x : op === "!=" ? value !== x : value === x;
}

function report(extra) {
  const checks = [];
  const e = scenario.expect ?? {};
  const allLines = samples.flatMap((s) => s.telemetry ?? []).concat(final?.telemetry ?? []);
  if (e.noErrors) checks.push({ check: "noErrors", pass: !final?.error && pageErrors.length === 0 && !extra.failed, detail: final?.error || pageErrors[0] || extra.failed || "" });
  if (e.shotsFired) checks.push({ check: `shotsFired ${e.shotsFired}`, pass: cmp(e.shotsFired, final?.shotsFired ?? 0), detail: `fired ${final?.shotsFired ?? 0}` });
  if (e.shotsHit) checks.push({ check: `shotsHit ${e.shotsHit}`, pass: cmp(e.shotsHit, final?.shotsHit ?? 0), detail: `hit ${final?.shotsHit ?? 0}` });
  if (e.fouls) { const n = Object.values(final?.fouls ?? {}).reduce((a, b) => a + b, 0); checks.push({ check: `fouls ${e.fouls}`, pass: cmp(e.fouls, n), detail: `${n} fouls` }); }
  for (const re of e.telemetryIncludes ?? []) checks.push({ check: `telemetry matches /${re}/ at some point`, pass: allLines.some((l) => new RegExp(re).test(l)), detail: "" });
  for (const re of e.telemetryFinalIncludes ?? []) checks.push({ check: `final telemetry matches /${re}/`, pass: (final?.telemetry ?? []).some((l) => new RegExp(re).test(l)), detail: "" });
  if (e.movedAtLeastIn !== undefined && final && startSnapshot) { const d = Math.hypot(final.poseIn.x - startSnapshot.poseIn.x, final.poseIn.z - startSnapshot.poseIn.z); checks.push({ check: `moved ≥ ${e.movedAtLeastIn} in`, pass: d >= e.movedAtLeastIn, detail: `${d.toFixed(1)} in` }); }
  if (e.poseNear && final) { const d = Math.hypot(final.poseIn.x - e.poseNear.xIn, final.poseIn.z - e.poseNear.zIn); checks.push({ check: `ends within ${e.poseNear.tolIn ?? 12} in of (${e.poseNear.xIn}, ${e.poseNear.zIn})`, pass: d <= (e.poseNear.tolIn ?? 12), detail: `${d.toFixed(1)} in away` }); }
  const pass = checks.every((c) => c.pass) && !extra.failed;
  const rep = { scenario: scenario.name ?? scenarioPath ?? scenario.opMode, opMode: scenario.opMode, team, pass, failed: extra.failed, checks, start: startSnapshot, final, samples, pageErrors, hostLogTail: simLog.split("\n").slice(-30), generatedAt: new Date().toISOString() };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(rep, null, 2));
  console.log(`\ntwin-test: ${rep.scenario}`);
  if (extra.failed) console.log(`  ✗ ${extra.failed}`);
  for (const c of checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.check}${c.detail ? ` — ${c.detail}` : ""}`);
  if (final) {
    console.log(`  final: ${final.status}${final.error ? " " + final.error.split("\n")[0] : ""} · pose (${final.poseIn.x}, ${final.poseIn.z}) in @ ${final.poseIn.headingDeg}° · fired ${final.shotsFired}, hit ${final.shotsHit} · carrying ${final.carrying?.pollen} pollen + ${final.carrying?.nectar} nectar`);
    console.log(`  telemetry (final):\n    ${(final.telemetry ?? []).join("\n    ")}`);
  }
  console.log(`  report: ${out}`);
  console.log(pass ? "PASS" : "FAIL");
  killSim();
  process.exit(pass ? 0 : 1);
}
