#!/usr/bin/env node
/**
 * Regenerate the README gallery (docs/screenshots/*.png) from a running twin, headless.
 *
 *   pnpm sim --built --no-panels --port 5180 --host-port 8780 --team <team repo>   # in one terminal
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
const only = flag("--only"); // comma list of shot names to redo
const want = (name) => !only || only.split(",").includes(name);
const { chromium } = await import("playwright");
const launch = () => chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const base = `http://localhost:${port}/`;
const shot = async (page, name) => { await page.screenshot({ path: OUT + name + ".png" }); console.log("gallery:", name); };

// ---------------------------------------------------------------- field-only shots (no host needed)
{
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const seed = { alliance: "red", pose: { x: -0.95, z: 1.55, heading: 0 }, opponents: true, opponentsScore: false, pauseOpponents: true, runtimeEnabled: false, pip: true, panelAdvanced: false, settingsAutoLoad: false,
    overlays: { trajectory: true, actualArc: true, dispersion: true, fan: false, footprint: true, frustum: true, target: true, aim: true, reach: false, hitmap: false } };
  await page.addInitScript((s) => { localStorage.setItem("biobuzz-twin", JSON.stringify(s)); }, seed);
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__twin && window.__twin.robot.modelStatus === "loaded", null, { timeout: 90_000 });
  const t = (fn, arg) => page.evaluate(fn, arg);
  await t(() => { const t = window.__twin; t.state.aimRequest = true; document.getElementById("panel").classList.add("hidden"); });
  const dismissToasts = () => t(() => { document.getElementById("update-toast")?.remove(); }); // the PWA "ready to work offline" / "reload" toast
  await dismissToasts();
  await page.waitForTimeout(1500);
  if (want("overview")) {
    await t(() => { const t = window.__twin; t.orbitCam.position.set(2.9, 2.3, 3.6); t.controls.target.set(-0.2, 0.4, 0.2); t.controls.update(); });
    await page.waitForTimeout(800); await dismissToasts(); await shot(page, "overview");
  }
  if (want("camera-view")) { await t(() => { window.__twin.state.view = "robot"; }); await page.waitForTimeout(1200); await shot(page, "camera-view"); }
  if (want("top-view")) { await t(() => { window.__twin.state.view = "top"; }); await page.waitForTimeout(1200); await shot(page, "top-view"); }
  if (want("hit-probability-map")) {
    await t(() => { const t = window.__twin; t.state.view = "top"; t.state.overlays.hitmap = true; t.state.overlays.dispersion = false; Object.assign(t.overlays.show, t.state.overlays); });
    await page.waitForFunction(() => window.__twin.hitmapDone(), null, { timeout: 120_000 }).catch(() => console.log("gallery: hit map did not finish"));
    await page.waitForTimeout(500); await shot(page, "hit-probability-map");
    await t(() => { const t = window.__twin; t.state.overlays.hitmap = false; t.state.overlays.dispersion = true; Object.assign(t.overlays.show, t.state.overlays); });
  }
  if (want("hive-tipping")) {
    await t(() => { const t = window.__twin; t.state.view = "orbit"; t.state.capacity = 12; t.playerAgent.caps.capacity = 12; t.playerAgent.inventory = { pollen: 12, nectar: 0 }; t.state.overlays.dispersion = false; Object.assign(t.overlays.show, t.state.overlays); t.orbitCam.position.set(2.4, 1.9, 2.6); t.controls.target.set(-0.3, 0.9, 0.3); t.controls.update(); });
    await page.mouse.click(800, 500);
    for (let i = 0; i < 9; i++) { await page.keyboard.press("Space"); await page.waitForTimeout(700); }
    await page.waitForFunction(() => !!window.__twin.match.hives.red.tipping, null, { timeout: 15_000 }).catch(() => console.log("gallery: no tip"));
    await page.waitForTimeout(900); await shot(page, "hive-tipping");
  }
  await browser.close();
}

// ---------------------------------------------------------------- server-mode shots (host + team code)
const hostUp = await fetch(`http://127.0.0.1:${+hostPort + 1}/api/status`).then((r) => r.ok).catch(() => false);
if (!hostUp) { console.log(`gallery: no host on ${hostPort}; skipping runtime, settings-editor, replay and calibration shots`); process.exit(0); }
{
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const seed = { alliance: "blue", opponents: true, opponentsScore: true, pauseOpponents: false, runtimeEnabled: true, runtimeUrl: `ws://127.0.0.1:${hostPort}`, pip: true, panelAdvanced: false, settingsAutoLoad: false,
    overlays: { trajectory: true, actualArc: true, dispersion: false, fan: false, footprint: true, frustum: true, target: true, aim: true, reach: false, hitmap: false },
    assetOverrides: { "biobuzz/robot-profile.json": { "tagTracking.autoShootEnabled": true, "tagTracking.shotRangeIn": 72, "tagTracking.shotPower": 0.45, "matchAuto.enabled": true, "matchAuto.startPosition": "FAR_SIDE" }, "biobuzz/controller-profile.json": { "servos.windmill.continuousRotationVerified": true } } };
  await page.addInitScript((s) => { localStorage.setItem("biobuzz-twin", JSON.stringify(s)); }, seed);
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__twin && window.__twin.robot.modelStatus === "loaded" && window.__twin.link.connected && window.__twin.link.opModes.length > 0 && (window.__twinRenderCount ?? 0) >= 3, null, { timeout: 120_000 });
  const t = (fn, arg) => page.evaluate(fn, arg);
  const openOnly = (titleStart) => t((s) => { document.querySelectorAll("#panel details[data-title]").forEach((d) => { const t = d.dataset.title; if (t === "More sections") d.open = true; else d.open = t.startsWith(s); }); const p = document.getElementById("panel"); p.scrollTop = 0; }, titleStart);
  await t(() => { [...document.querySelectorAll("#panel button")].find((b) => b.textContent.includes("Camels Hump"))?.click(); });
  await page.waitForTimeout(600);
  const opModes = await t(() => window.__twin.link.opModes.map((o) => o.name));
  const op = opModes.find((n) => /Auto 30s \+ Drive/.test(n)) ?? opModes.find((n) => /Auto Aim/i.test(n)) ?? opModes[0];
  // INIT / START a run and let it play for a while
  await t((name) => { const s = [...document.querySelectorAll("#panel select")].find((x) => [...x.options].some((o) => o.value === name)); s.value = name; s.dispatchEvent(new Event("change")); }, op);
  await page.click('#panel button.init');
  await page.waitForFunction(() => window.__twin.link.status === "INIT", null, { timeout: 20_000 });
  await page.click('#panel button.start');
  await page.waitForFunction(() => window.__twin.link.status === "RUNNING", null, { timeout: 10_000 });
  await page.waitForTimeout(9000);
  if (want("runtime-teamcode")) {
    await openOnly("Runtime");
    await t(() => { const t = window.__twin; t.orbitCam.position.set(2.2, 1.8, -3.6); t.controls.target.set(0.3, 0.6, -0.8); t.controls.update(); });
    await page.waitForTimeout(800); await shot(page, "runtime-teamcode");
  }
  await page.waitForTimeout(6000);
  await page.click('#panel button.stop').catch(() => {});
  await page.waitForFunction(() => window.__twin.link.status !== "RUNNING", null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (want("replay-timeline")) {
    await openOnly("Timeline");
    await t(() => { const t = window.__twin; const run = t.recorder.latestRun(); t.recorder.cursor = run ? run.start + 4000 : undefined; t.panel?.refreshTimeline?.(); });
    await t(() => { [...document.querySelectorAll("#panel button")].find((b) => b.textContent.includes("0.1 ▶"))?.click(); });
    await page.waitForTimeout(900); await shot(page, "replay-timeline");
    await t(() => { [...document.querySelectorAll("#panel button")].find((b) => b.textContent.includes("Go live"))?.click(); });
  }
  if (want("settings-editor")) {
    await openOnly("TeamCode settings");
    await t(() => { [...document.querySelectorAll("#panel button")].find((b) => b.textContent === "Open settings editor")?.click(); });
    await page.waitForTimeout(600);
    await t(() => { const d = document.querySelector("dialog.settings-dialog"); const rp = [...d.querySelectorAll("details.afile")].find((f) => (f.querySelector("summary .name")?.textContent || "").includes("robot-profile")); if (rp) { rp.open = true; const g = [...rp.querySelectorAll(".agroup")].find((x) => x.textContent.startsWith("matchAuto")); if (g) d.querySelector(".sd-body").scrollTop = g.offsetTop - 70; } });
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
    await t(() => { const c = document.querySelector("#panel .cal-canvas"); const p = document.getElementById("panel"); if (c) p.scrollTop = c.offsetTop - 160; });
    await page.waitForTimeout(300);
    const box = await t(() => { const r = document.getElementById("panel").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 980) }; });
    await page.screenshot({ path: OUT + "shooter-calibration.png", clip: box }); console.log("gallery: shooter-calibration");
  }
  await browser.close();
}
console.log(`gallery: done → ${OUT}`);
if (!existsSync(OUT + "overview.png")) process.exit(1);
