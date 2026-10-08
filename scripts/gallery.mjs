#!/usr/bin/env node
/**
 * Regenerate the README gallery (docs/screenshots/*.png) from a running twin, headless.
 *
 *   pnpm sim --built --wip --no-browser --no-panels --port 5180 --host-port 8780 --team <team repo>   # in one terminal
 *   pnpm gallery -- --port 5180 --host-port 8780                                   # in another
 *
 * Needs the host (server mode) with the Camels Hump TeamCode for the runtime, settings-editor and replay shots; the
 * field-only shots work without it. Playwright chromium must be installed (pnpm exec playwright install chromium).
 * Run this only after a major UI change or a new visual feature (see .claude/skills/readme-upkeep); screenshots are
 * committed, so churn shows up in git history.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(root, "docs/screenshots") + "/";
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const port = flag("--port", "5180"), hostPort = flag("--host-port", "8780");
const demoRuntime = args.includes("--demo-runtime"); // isolated, labelled example; never writes a team repo
const only = flag("--only"); // comma list of shot names to redo
const names = ["overview", "robot-setup", "camera-view", "top-view", "hit-probability-map", "hive-tipping", "match-score", "runtime-teamcode", "replay-timeline", "settings-editor", "shooter-calibration"];
if (only && only.split(",").some(n => !names.includes(n))) throw new Error(`Unknown screenshot in --only ${only}`);
const want = (name) => !only || only.split(",").includes(name);
const { chromium } = await import("playwright");
const launch = () => chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const base = `http://localhost:${port}/`;
const shot = async (page, name) => {
  await page.evaluate(() => document.getElementById("update-toast")?.remove());
  await page.screenshot({ path: OUT + name + ".png" }); console.log("gallery:", name); };

// ---------------------------------------------------------------- field-only shots (no host needed)
{
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  // far audience-side corner: with the StarterBot's fixed 55° hood that is where the twin scores reliably (close shots arrive rising)
  const seed = { alliance: "red", pose: { x: -1.55, z: 1.6, heading: 0 }, opponents: true, opponentsScore: false, pauseOpponents: true, runtimeEnabled: false, pip: true, panelAdvanced: false, settingsAutoLoad: false, introSeen: true,
    overlays: { trajectory: true, actualArc: true, dispersion: true, fan: false, footprint: true, frustum: true, target: true, aim: true, reach: false, hitmap: false } };
  await page.addInitScript((s) => { localStorage.setItem("biobuzz-twin", JSON.stringify(s)); localStorage.setItem("biobuzz-workspace-v1", JSON.stringify({task:"practice",analysis:"shots",pins:[],welcome:false})); }, seed);
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__twin && window.__twin.robot.modelStatus === "loaded", null, { timeout: 90_000 });
  const t = (fn, arg) => page.evaluate(fn, arg);
  const setSidebar = async visible => {
    const hidden = await page.locator('body').evaluate(b => b.classList.contains('panel-hidden'));
    if (hidden === visible) await page.getByRole('button', { name: visible ? 'Show sidebar' : 'Hide sidebar', exact: true }).click();
  };
  await t(() => { window.__twin.state.aimRequest = true; });
  await setSidebar(true);
  await page.waitForFunction(() => document.querySelector('#hud .shot-at-glance')?.textContent.includes('%'));
  const dismissToasts = () => t(() => { document.getElementById("update-toast")?.remove(); }); // the PWA "ready to work offline" / "reload" toast
  await dismissToasts();
  await page.waitForTimeout(1500);
  if (want("overview")) {
    await t(() => window.__twin.workspace.navigate("practice"));
    await t(() => { const t = window.__twin; t.orbitCam.position.set(2.9, 2.3, 3.6); t.controls.target.set(-0.8, 0.4, 0.7); t.controls.update(); });
    await page.waitForTimeout(800); await dismissToasts(); await shot(page, "overview");

  }
  if (want("robot-setup")) {
    // the customizer: profile cards, build readout and the Look swatches, with the Pollinator (box chassis, livery on top) on the field
    await t(() => { const t = window.__twin; t.workspace.navigate("setup"); });
    await page.waitForTimeout(300);
    await page.locator('.profile-card', { hasText: 'Pollinator' }).click();
    await t(() => { const t = window.__twin; t.state.robot.look.decal = "chevron"; t.robot.applySpec(t.state.robot); t.state.view = "orbit"; t.orbitCam.position.set(-0.6, 1.3, 3.0); t.controls.target.set(-1.4, 0.2, 1.5); t.controls.update(); const d = document.querySelector('details[data-title="Robot"]'); if (d) { d.open = true; d.scrollIntoView({ block: "start" }); } });
    await page.waitForTimeout(1200); await dismissToasts(); await shot(page, "robot-setup");
    await page.locator('.profile-card', { hasText: 'StarterBot Strafer' }).click();
    await t(() => { window.__twin.workspace.navigate("practice"); window.__twin.state.aimRequest = true; });
    await page.waitForTimeout(800);
  }
  await setSidebar(false);
  if (want("camera-view")) {
    const overlays = await t(() => ({ ...window.__twin.state.overlays }));
    await t(() => { const t = window.__twin; t.state.view = "robot"; for (const key of Object.keys(t.state.overlays)) t.state.overlays[key] = false; Object.assign(t.overlays.show, t.state.overlays); });
    await page.waitForTimeout(1200); await shot(page, "camera-view");
    await t(overlays => { const t = window.__twin; Object.assign(t.state.overlays, overlays); Object.assign(t.overlays.show, overlays); }, overlays);
  }
  if (want("top-view")) { await t(() => { window.__twin.state.view = "top"; }); await page.waitForTimeout(1200); await shot(page, "top-view"); }
  if (want("hit-probability-map")) {
    await t(() => { const t = window.__twin; t.state.view = "top"; t.state.overlays.hitmap = true; t.state.overlays.dispersion = false; Object.assign(t.overlays.show, t.state.overlays); });
    await page.waitForFunction(() => window.__twin.hitmapDone(), null, { timeout: 120_000 });
    await page.waitForTimeout(500); await shot(page, "hit-probability-map");
    await t(() => { const t = window.__twin; t.state.overlays.hitmap = false; t.state.overlays.dispersion = true; Object.assign(t.overlays.show, t.state.overlays); });
  }
  if (want("hive-tipping") || want("match-score")) {
    await page.getByRole('button', { name: 'Start timed match', exact: true }).click();
    // a tip needs three POLLEN in the cell: shoot many, with the shot variability turned down so the scene is deterministic
    await t(() => { const t = window.__twin; t.state.view = "orbit"; t.state.infiniteAmmo = true; for (const k of Object.keys(t.state.noise)) if (typeof t.state.noise[k] === "number") t.state.noise[k] *= 0.2; t.state.overlays.dispersion = false; Object.assign(t.overlays.show, t.state.overlays); t.orbitCam.position.set(2.4, 1.9, 2.6); t.controls.target.set(-0.3, 0.9, 0.3); t.controls.update(); });
    // find a spot on the audience side from which the fixed-hood shot is a predicted HIT (the HUD's "if aimed" solve)
    for (const [x, z] of [[-1.6, 1.6], [-1.6, 1.5], [0.8, 1.7], [-1.2, 1.7]]) {
      await t(([x, z]) => { const t = window.__twin; t.state.pose = { x, z, heading: 0 }; t.state.aimRequest = true; }, [x, z]);
      await page.waitForTimeout(450);
      if (await t(() => !!window.__twin.ifAimed()?.hit)) break;
    }
    await page.mouse.click(800, 500);
    for (let i = 0; i < 14; i++) { await page.keyboard.press("Space"); await page.waitForTimeout(500); if (await t(() => !!window.__twin.match.hives.red.tipping)) break; }
    await page.waitForFunction(() => !!window.__twin.match.hives.red.tipping, null, { timeout: 25_000 });
    if (want("hive-tipping")) await shot(page, "hive-tipping");
  }
  if (want("match-score")) {
    await t(() => { const t = window.__twin; t.state.view = "orbit"; t.state.pip = true; t.state.overlays.hitmap = false; Object.assign(t.overlays.show, t.state.overlays); });
    await page.waitForFunction(() => window.__twin.state.matchPhase === 'running');
    const move = page.getByRole('button', { name: 'Move camera previews to upper right', exact: true });
    if (await move.count()) await move.first().click();
    await page.locator('#match-score .score-trigger').focus();
    await page.locator('#score-breakdown').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    await page.locator('#match-score .score-trigger').hover();
    await page.locator('#score-breakdown').waitFor({ state: 'visible' });
    await shot(page, "match-score");
  }
  await browser.close();
}

// ---------------------------------------------------------------- server-mode shots (host + team code)
const hostUp = await fetch(`http://127.0.0.1:${+hostPort + 1}/api/status`).then((r) => r.ok).catch(() => false);
const serverShots = ["runtime-teamcode", "settings-editor", "replay-timeline", "shooter-calibration"];
if (!serverShots.some(want)) process.exit(0);
if (!hostUp && !demoRuntime) throw new Error(`No host on ${hostPort}. Start a dedicated host or use --demo-runtime to capture the complete gallery.`);
{
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  if (demoRuntime) { const { mockRuntime } = await import("./ux-fixtures.mjs"); await mockRuntime(page); }
  const seed = { alliance: "blue", opponents: true, opponentsScore: true, pauseOpponents: false, runtimeEnabled: true, runtimeUrl: `ws://127.0.0.1:${hostPort}`, pip: true, panelAdvanced: false, settingsAutoLoad: false,
    overlays: { trajectory: true, actualArc: true, dispersion: false, fan: false, footprint: true, frustum: true, target: true, aim: true, reach: false, hitmap: false },
    assetOverrides: { "biobuzz/robot-profile.json": { "tagTracking.autoShootEnabled": true, "tagTracking.shotRangeIn": 72, "tagTracking.shotPower": 0.45, "matchAuto.enabled": true, "matchAuto.startPosition": "FAR_SIDE" }, "biobuzz/controller-profile.json": { "servos.windmill.continuousRotationVerified": true } } };
  if (demoRuntime) seed.assetOverrides = { "biobuzz/robot-profile.json": { "drive.maxPower": 0.5 } };
  await page.addInitScript((s) => { localStorage.setItem("biobuzz-twin", JSON.stringify(s)); localStorage.setItem("biobuzz-workspace-v1", JSON.stringify({task:"practice",analysis:"shots",pins:[],welcome:false})); }, seed);
  await page.goto(base + "?runtime=1", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__twin && window.__twin.robot.modelStatus === "loaded" && window.__twin.link.connected && window.__twin.link.opModes.length > 0 && (window.__twinRenderCount ?? 0) >= 3, null, { timeout: 120_000 });
  const t = (fn, arg) => page.evaluate(fn, arg);
  const openOnly = (titleStart) => t((s) => {
    const w = window.__twin.workspace;
    if (s.startsWith('Runtime') || s.startsWith('TeamCode')) w.navigate('teamcode');
    else if (s.startsWith('Timeline')) w.navigate('analyze', 'replay');
    else if (s.startsWith('Shooter')) w.navigate('analyze', 'calibration');
    document.querySelectorAll("#panel details[data-title]").forEach((d) => { d.open = d.dataset.title.startsWith(s); }); const p = document.getElementById("panel"); p.scrollTop = 0; }, titleStart);
  await t(() => { [...document.querySelectorAll("#panel button")].find((b) => b.textContent.includes("Camels Hump"))?.click(); });
  await page.waitForTimeout(600);
  const opModes = await t(() => window.__twin.link.opModes.map((o) => o.name));
  const op = opModes.find((n) => /Auto 30s \+ Drive/.test(n)) ?? opModes.find((n) => /Auto Aim/i.test(n)) ?? opModes[0];
  // INIT / START a run and let it play for a while
  await t((name) => { const s = [...document.querySelectorAll("#panel select")].find((x) => [...x.options].some((o) => o.value === name)); s.value = name; s.dispatchEvent(new Event("change")); }, op);
  await page.getByRole('button', { name: 'Run TeamCode', exact: true }).click();
  await page.click('#control-dock button.init');
  await page.waitForFunction(() => window.__twin.link.status === "INIT", null, { timeout: 20_000 });
  await page.click('#control-dock button.start');
  await page.waitForFunction(() => window.__twin.link.status === "RUNNING", null, { timeout: 10_000 });
  await page.waitForTimeout(9000);
  if (want("runtime-teamcode")) {
    await openOnly("Runtime");
    await t(() => { window.__twin.state.pip = false; });
    await t(() => { const t = window.__twin; t.orbitCam.position.set(2.2, 1.8, -3.6); t.controls.target.set(0.3, 0.6, -0.8); t.controls.update(); });
    await page.locator('.runtime-logs .telemetry-box').waitFor({state:'visible'});
    await page.waitForFunction(() => document.querySelector('.runtime-guidance')?.nextElementSibling?.classList.contains('runtime-logs'));
    await page.waitForTimeout(800); await shot(page, "runtime-teamcode");
  }
  await page.waitForTimeout(6000);
  await page.click('#control-dock button.stop');
  await page.waitForFunction(() => window.__twin.link.status !== "RUNNING", null, { timeout: 10_000 });
  await page.waitForTimeout(800);
  if (want("replay-timeline")) {
    await openOnly("Timeline");
    await t(() => { const t = window.__twin; const run = t.recorder.latestRun(); t.recorder.cursor = run ? run.start + 4000 : undefined; t.panel?.refreshTimeline?.(); });
    await t(() => { [...document.querySelectorAll("#replay-dock button")].find((b) => b.textContent.includes("0.1 ▶"))?.click(); });
    await page.waitForFunction(() => document.body.classList.contains('is-replaying'));
    await t(() => { const log = document.querySelector('#panel .replay-log'); const panel = document.getElementById('panel'); if (!log) throw new Error('Missing replay log'); panel.scrollTop += log.getBoundingClientRect().top - panel.getBoundingClientRect().top - 16; });
    await page.locator('#panel .replay-log .telemetry-box').waitFor({state:'visible'});
    await page.waitForTimeout(900); await shot(page, "replay-timeline");
    await page.getByRole('button', { name: 'Return to live', exact: true }).first().click();
  }
  if (want("settings-editor")) {
    await openOnly("TeamCode settings");
    await t(() => { [...document.querySelectorAll("#panel button")].find((b) => b.textContent === "Open settings editor")?.click(); });
    await page.locator("dialog.settings-dialog").waitFor({state:"visible"});
    await t(() => { const d = document.querySelector("dialog.settings-dialog"); const rp = [...d.querySelectorAll("details.afile")].find((f) => (f.querySelector("summary .name")?.textContent || "").toLowerCase().includes("robot profile")); if (rp) { rp.open = true; const g = [...rp.querySelectorAll(".agroup")].find((x) => x.textContent.startsWith("matchAuto")); if (g) d.querySelector(".sd-body").scrollTop = g.offsetTop - 70; } });
    await t(() => { const d = document.querySelector('dialog.settings-dialog'); const f = d.querySelector('details.afile[open]'); const body = d.querySelector('.sd-body'); if (!f) throw new Error('Missing open profile'); body.scrollTop += f.getBoundingClientRect().top - body.getBoundingClientRect().top - 16; });
    await page.waitForTimeout(400); await shot(page, "settings-editor");
    await t(() => document.querySelector("dialog.settings-dialog")?.close());
    await page.waitForFunction(() => !document.querySelector("dialog.settings-dialog")?.open, null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  if (want("shooter-calibration")) {
    await openOnly("Shooter calibration");
    await t(() => { const t = window.__twin; const cal = t.state.calibration; if (!cal.shots.length) { // a believable demo data set
      const d = (b) => (b + 8.75 - 3.94) * 0.0254; const rows = [[0.5, 48, 63.5], [0.65, 48, 73.2], [0.8, 48, 78.0], [1.0, 48, 81.4], [0.5, 96, 65.5], [0.65, 96, 104.2], [0.8, 96, 124.3], [1.0, 96, 138.8]];
      for (const [p, b, h] of rows) cal.shots.push({ id: cal.nextId++, power: p, rpm: p * 6000, distanceM: d(b), kind: "wall", measuredM: h * 0.0254 }); t.panel?.render?.(); } });
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '3. Review & apply', exact: true }).click();
    await t(() => { const c = document.querySelector("#panel .cal-fit"); const p = document.getElementById("panel"); if (c) p.scrollTop = 0; });
    await page.waitForTimeout(300);
    await t(() => { const badge = document.createElement('p'); badge.className = 'note'; badge.textContent = 'Example measurements · illustration of the calibration workflow'; document.querySelector('#panel [data-title="Shooter calibration"] > .body')?.prepend(badge); const section = document.querySelector('#panel [data-title="Shooter calibration"]'); const panel = document.getElementById('panel'); panel.scrollTop += section.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12; });
    await shot(page, "shooter-calibration");
  }
  await browser.close();
}
console.log(`gallery: done → ${OUT}`);
if (!existsSync(OUT + "overview.png")) process.exit(1);
