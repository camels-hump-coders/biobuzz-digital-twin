#!/usr/bin/env node
/**
 * One command to run the twin + virtual runtime against your TeamCode.
 *
 *   pnpm sim --team ~/dev/FtcRobotController          # first time: remembers the path
 *   pnpm sim                                           # afterwards
 *   pnpm sim --team <path> --exclude "**\/roadrunner/**,**\/Old*.java"
 *   pnpm sim --no-watch --no-browser --no-panels --port 5173 --host-port 8765
 *   pnpm sim --built            # serve a production build of the COMMITTED tree (HEAD): no hot reload, no half-edited sources
 *   pnpm sim --built --wip      # …of the working tree instead (--rebuild forces a build in either mode)
 *
 * --team accepts either the FtcRobotController project root (TeamCode/src/main/java is appended),
 * the TeamCode module folder, or the java source folder itself.
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, watch as watchFs, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { lineReader, startupTracker, browserLaunch } from "./sim-startup.mjs";
import { selectHostPort } from "./sim-ports.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = join(root, ".biobuzz.local.json");
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes(name);

const saved = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
let team = flag("--team", saved.team);
const exclude = flag("--exclude", saved.exclude ?? "");
const port = flag("--port", "5173");
let hostPort;
try {
  hostPort = await selectHostPort(flag("--host-port", "8765"), has("--host-port"));
} catch (error) {
  console.error(`sim: ${error.message}`);
  process.exit(1);
}
if (!has("--host-port") && hostPort !== "8765") {
  console.log(`sim: default runtime/API ports are occupied; using ${hostPort}/${Number(hostPort) + 1}.`);
}
const watch = !has("--no-watch");
const openBrowser = !has("--no-browser") && process.env.BROWSER?.toLowerCase() !== "none";
const panels = !has("--no-panels"); // the real FTC Panels dashboard on 8001/8002; off for secondary hosts such as twin-test
// --built: serve a production build (vite preview) instead of the dev server. No hot reload: edits to the twin's
// sources while this runs cannot reload the page under a running OpMode or a headless test. The build is reused when
// dist/ is newer than every source file; --rebuild forces one.
const built = has("--built");
const forceRebuild = has("--rebuild");

function resolveTeam(p) {
  if (!p) return undefined;
  const abs = resolve(p.replace(/^~(?=$|\/)/, homedir()));
  // Prefer the TeamCode module. The FtcRobotController module next to it holds the Android app's own
  // sources (activities, Blocks, OnBot Java) which can never compile on the desktop.
  const candidates = [
    join(abs, "TeamCode/src/main/java"),
    join(abs, "../TeamCode/src/main/java"),
    join(abs, "src/main/java"),
    abs,
  ];
  for (const cand of candidates) {
    const r = resolve(cand);
    if (existsSync(r) && existsSync(join(r, "org"))) {
      if (/[\/\\]FtcRobotController[\/\\]src[\/\\]main[\/\\]java$/.test(r)) {
        console.error(`sim: ${r} is the FtcRobotController app module, not TeamCode, and no TeamCode module was found next to it.`);
        console.error("sim: point --team at your project root or at TeamCode/src/main/java.");
        process.exit(1);
      }
      return r;
    }
  }
  if (existsSync(abs)) return abs;
  console.error(`sim: TeamCode path not found: ${p}`);
  process.exit(1);
}

// Fresh clone? Install JS dependencies first.
if (!existsSync(join(root, "node_modules"))) {
  console.log("sim: installing JS dependencies (first run)…");
  const r = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) { console.error("sim: pnpm install failed"); process.exit(1); }
}
team = resolveTeam(team);
writeFileSync(cfgPath, JSON.stringify({ team, exclude }, null, 2) + "\n");

// ---- find a JDK: PATH java (17+) else Android Studio's bundled JBR
function javaOk(home) {
  const bin = home ? join(home, "bin/java") : "java";
  const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
  if (r.status !== 0) return false;
  const m = /version "(\d+)/.exec(r.stderr + r.stdout);
  return m && parseInt(m[1], 10) >= 17;
}
let javaHome = process.env.JAVA_HOME;
if (!javaOk(javaHome)) {
  javaHome = undefined;
  const candidates = [
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    join(homedir(), "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
    ...(existsSync(join(homedir(), "Library/Java/JavaVirtualMachines")) ? spawnSync("ls", [join(homedir(), "Library/Java/JavaVirtualMachines")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map((d) => join(homedir(), "Library/Java/JavaVirtualMachines", d, "Contents/Home")) : []),
    "/usr/lib/jvm/default-java",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs/Android Studio/jbr") : "",
    "C:/Program Files/Android/Android Studio/jbr",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c) && javaOk(c)) { javaHome = c; break; }
  if (!javaHome && !javaOk(undefined)) { console.error("sim: no JDK 17+ found. Install Android Studio or set JAVA_HOME."); process.exit(1); }
}

const isWin = process.platform === "win32";
const gradlew = join(root, "runtime", isWin ? "gradlew.bat" : "gradlew");
// --low-priority (twin-test uses it): the Gradle daemon and everything it launches, including the host JVM, run at
// low scheduling priority so a headless test never starves the human's session or the desktop
const lowPriority = has("--low-priority");
const gradleArgs = [":host:run", "--console=plain", "--max-workers=4", ...(lowPriority ? ["--priority=low"] : []), `--args=${hostPort}`];
// Files that import Android-only or robot-only packages can never compile on the desktop. Skip them
// automatically unless a sim override with the same relative path exists in <TeamCode>/src/sim/java.
const ANDROID_ONLY = /^import (android\.|androidx\.|org\.opencv\.|fi\.iki\.elonen|com\.qualcomm\.ftccommon|org\.firstinspires\.ftc\.ftccommon|org\.firstinspires\.ftc\.robotcore\.internal|com\.acmerobotics\.dashboard)/m;
// Android classes the shim does provide (Context/assets/prefs, Bitmap for camera frames, Base64, the Activity Panels pokes)
const ANDROID_ALLOWED = /^import android\.(content\.Context|content\.SharedPreferences|content\.res\.AssetManager|util\.Size|util\.Base64|graphics\.Bitmap|graphics\.BitmapFactory|app\.Activity);\s*$/gm;
function walk(dir, out = []) { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".java")) out.push(p); } return out; }
let autoExcluded = [];
let simDir;
let assetsDir;
if (team) {
  const moduleRoot = resolve(team, "../../.."); // <TeamCode>
  simDir = join(moduleRoot, "src/sim/java");
  assetsDir = join(moduleRoot, "src/main/assets");
  const overrides = new Set(existsSync(simDir) ? walk(simDir).map((f) => f.slice(simDir.length + 1)) : []);
  for (const f of walk(team)) {
    const rel = f.slice(team.length + 1);
    if (overrides.has(rel)) continue;
    const src = readFileSync(f, "utf8").replace(ANDROID_ALLOWED, "");
    if (ANDROID_ONLY.test(src)) autoExcluded.push(rel);
  }
}
const allExcludes = [...(exclude ? exclude.split(",") : []), ...autoExcluded].filter(Boolean);
if (team) gradleArgs.push(`-PteamCode=${team}`);
// the team repo's identity for run manifests (which TeamCode a result belongs to): path, commit, dirty flag
if (team) {
  const info = { path: team, revision: "unknown", dirty: false };
  try { info.revision = execSync("git rev-parse --short HEAD", { cwd: team, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); info.dirty = execSync("git status --porcelain", { cwd: team, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0; } catch { /* not a git checkout */ }
  gradleArgs.push(`-PsimTeamInfo=${JSON.stringify(info)}`);
}
if (allExcludes.length) gradleArgs.push(`-PteamExclude=${allExcludes.join(",")}`);
if (simDir && existsSync(simDir)) gradleArgs.push(`-PteamSim=${simDir}`);
if (assetsDir && existsSync(assetsDir)) gradleArgs.push(`-PsimAssets=${assetsDir}`);
if (!panels) gradleArgs.push("-PsimPanels=false");
const bindingsFile = team ? join(resolve(team, "../../.."), "twin-bindings.json") : undefined;
if (bindingsFile && existsSync(bindingsFile)) gradleArgs.push(`-PsimBindings=${bindingsFile}`);
// the twin's own settings (robot config, launcher, hardware map, overrides, calibration…) live next to the team's
// bindings so they are versioned with the code; without a team they stay under runtime/
const settingsFile = team ? join(resolve(team, "../../.."), "twin-settings.json") : join(root, "runtime", "twin-settings.json");
gradleArgs.push(`-PsimSettings=${settingsFile}`);

console.log(`sim: TeamCode  ${team ?? "(none — sample OpModes only; pass --team <path>)"}`);
if (exclude) console.log(`sim: excluding ${exclude}`);
if (autoExcluded.length) { console.log(`sim: skipping ${autoExcluded.length} file(s) that use Android/robot-only APIs (add a copy under TeamCode/src/sim/java to provide a sim version):`); for (const f of autoExcluded) console.log(`sim:   ${f}`); }
if (simDir && existsSync(simDir)) console.log(`sim: overrides ${simDir}`);
if (assetsDir && existsSync(assetsDir)) console.log(`sim: assets    ${assetsDir}`);
if (bindingsFile && existsSync(bindingsFile)) console.log(`sim: bindings  ${bindingsFile}`);
console.log(`sim: settings  ${settingsFile}${existsSync(settingsFile) ? "" : "  (not created yet: Session → Save to repo file)"}`);
console.log(`sim: JDK       ${javaHome ?? "from PATH"}`);
console.log(`sim: host      ws://127.0.0.1:${hostPort}${watch ? "  (auto-rebuilds and restarts when your code changes)" : ""}`);
const twinUrl = `http://localhost:${port}/?runtime=1&sim=1&hostPort=${hostPort}`;
console.log(`sim: twin      ${twinUrl}${built ? "  (built bundle, no hot reload)" : ""}`);

const startupDir = mkdtempSync(join(tmpdir(), 'biobuzz-startup-'));
const statusFile = join(startupDir, 'status.json');
const startup = startupTracker(state => {
  writeFileSync(statusFile, JSON.stringify(state));
  console.log(`sim: ${state.message}`);
});
const heartbeat = setInterval(() => {
  const s = startup.state;
  if (s && !['ready', 'error'].includes(s.phase)) console.log(`sim: ${s.phase} · ${Math.floor((Date.now() - s.startedAt) / 1000)}s elapsed — ${s.message}`);
}, 5000);
heartbeat.unref();
if (!openBrowser) console.log(`sim: browser auto-open disabled (${has('--no-browser') ? '--no-browser' : 'BROWSER=none'}). Open ${twinUrl}`);
const children = [];
const prefix = (name, color) => { let buf = ""; return (chunk) => { buf += chunk.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ""; for (const line of lines) if (line.trim()) process.stdout.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`); }; };

// The host is a Gradle `run` task that never ends, and Gradle's --continuous build never interrupts a running task, so
// the launcher does the watching itself: on a source change it ends the host JVM and runs the task again (the Gradle
// daemon makes the recompile a few seconds). The browser reconnects by itself; INIT the OpMode again to run new code.
let host;
let restarting = false;
let shuttingDown = false;
const startHost = () => {
  startup.set('compiling', 'Starting Gradle: resolving dependencies and compiling TeamCode + runtime. First builds can take longer; the browser will connect when ready.', true);
  host = spawn(gradlew, gradleArgs, { cwd: join(root, "runtime"), env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) }, shell: isWin });
  host.stdout.on("data", lineReader(hostOut));
  host.stderr.on("data", lineReader(hostOut));
  host.on("error", error => startup.set('error', `Could not start Gradle: ${error.message}`));
  host.on("exit", (code, signal) => {
    if (!restarting && !shuttingDown) startup.set('error', `Runtime stopped (${signal ?? `exit ${code}`}). Check the terminal above.${watch ? ' Fix a source file to rebuild automatically.' : ' Run pnpm sim again after fixing the error.'}`);
  });
  return host;
};
const errFiles = new Set();
let hostPid; // the host JVM itself (announced on its first stdout line), distinct from the gradlew client we spawned
// one line buffer for the whole stream: a buffer per chunk (the old code) dropped every line split across two pipe
// reads, which garbled the OpMode list and sometimes swallowed the "listening on ws:" line twin-test waits for
const hostPrefix = prefix("host", "33");
const hostOut = (chunk) => {
  hostPrefix(chunk + "\n");
  startup.line(chunk);
  const pm = /sim-host pid (\d+) port/.exec(chunk.toString());
  if (pm) hostPid = +pm[1];
  for (const m of chunk.toString().matchAll(/^\s*(\S+\.java):\d+: error:/gm)) errFiles.add(m[1]);
  if (/BUILD FAILED|Compilation failed/.test(chunk.toString()) && errFiles.size) {
    const rels = [...errFiles].map((f) => (team ? f.replace(team + "/", "") : f));
    console.log(`\x1b[33m[host]\x1b[0m ${rels.length} file(s) use SDK classes the shim does not have:`);
    for (const f of rels) console.log(`\x1b[33m[host]\x1b[0m   ${f}`);
    console.log(`\x1b[33m[host]\x1b[0m Either add those classes to runtime/sdk-shim or skip the files:`);
    console.log(`\x1b[33m[host]\x1b[0m   pnpm sim --exclude "${rels.map((f) => "**/" + f.split("/").pop()).join(",")}"`);
    errFiles.clear();
  }
};
startHost();

// run Vite's own entry point rather than `pnpm exec vite`, so the pid we hold is Vite itself and a signal reaches it
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
let previewDir = join(root, "dist");
if (built) {
  // Build from the COMMITTED tree, not the working tree: another agent may be mid-edit in this checkout, and a build
  // of half-finished sources would silently become what every headless run executes. `git archive HEAD` is exported
  // to a cache dir keyed by the commit, built once there, and served with `vite preview --outDir`. --wip builds the
  // working tree into dist/ instead (for checking uncommitted twin changes).
  const wip = has("--wip");
  const head = (() => { try { return execSync("git rev-parse --short HEAD", { cwd: root, encoding: "utf8" }).trim(); } catch { return ""; } })();
  if (wip || !head) {
    const newest = (dir) => { let t = 0; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else t = Math.max(t, statSync(f).mtimeMs); } }; if (existsSync(dir)) walk(dir); return t; };
    const distIndex = join(root, "dist", "index.html");
    const stale = forceRebuild || !existsSync(distIndex) || statSync(distIndex).mtimeMs < Math.max(newest(join(root, "src")), newest(join(root, "public")), statSync(join(root, "index.html")).mtimeMs, statSync(join(root, "vite.config.ts")).mtimeMs);
    if (stale) {
      console.log("sim: building the twin from the WORKING TREE (vite build) …");
      const b = spawnSync(process.execPath, [viteBin, "build"], { cwd: root, stdio: "inherit", env: { ...process.env, BASE_PATH: "/" } });
      if (b.status !== 0) { console.error("sim: vite build failed"); process.exit(1); }
    } else console.log("sim: serving the existing working-tree build in dist/ (--rebuild forces a build)");
  } else {
    const cache = join(root, "node_modules", ".cache", "twin-dist", head);
    previewDir = join(cache, "dist");
    const dirty = (() => { try { return execSync("git status --porcelain -- src public index.html vite.config.ts", { cwd: root, encoding: "utf8" }).trim().length > 0; } catch { return false; } })();
    if (forceRebuild || !existsSync(join(previewDir, "index.html"))) {
      console.log(`sim: building the twin from commit ${head} (vite build of \`git archive HEAD\`) …`);
      rmSync(cache, { recursive: true, force: true }); mkdirSync(cache, { recursive: true });
      const src = join(cache, "src-tree"); mkdirSync(src);
      const ar = spawnSync("sh", ["-c", `git archive HEAD | tar -x -C "${src}"`], { cwd: root, stdio: "inherit" });
      if (ar.status !== 0) { console.error("sim: git archive failed"); process.exit(1); }
      try { symlinkSync(join(root, "node_modules"), join(src, "node_modules"), "dir"); } catch {}
      const b = spawnSync(process.execPath, [viteBin, "build", "--outDir", previewDir, "--emptyOutDir"], { cwd: src, stdio: "inherit", env: { ...process.env, BASE_PATH: "/" } });
      if (b.status !== 0) { console.error("sim: vite build failed"); process.exit(1); }
      rmSync(src, { recursive: true, force: true });
    } else console.log(`sim: serving the cached build of commit ${head}`);
    if (dirty) console.log("sim: note — this checkout has uncommitted twin changes; they are NOT in the served build (pass --wip to build the working tree)");
  }
}
const viteArgs = built ? [viteBin, "preview", "--port", port, "--strictPort", "--outDir", previewDir] : [viteBin, "--port", port, "--strictPort"];

const vite = spawn(process.execPath, viteArgs, { cwd: root, env: { ...process.env, BIOBUZZ_STARTUP_FILE: statusFile } });
let opened = false;
const twinOut = prefix("twin", "36");
vite.stdout.on("data", lineReader(line => {
  twinOut(line + "\n");
  if (!opened && /Local:.*https?:/.test(line)) {
    opened = true;
    console.log(`sim: UI ready at ${twinUrl} — runtime build/startup progress is shown there.`);
    if (openBrowser) {
      console.log(`sim: opening browser → ${twinUrl}`);
      const [command, openerArgs] = browserLaunch(process.platform, process.env.BROWSER, twinUrl);
      const opener = spawn(command, openerArgs, { stdio: 'ignore' });
      opener.on('error', e => console.error(`sim: browser could not open (${e.message}). Open ${twinUrl}`));
      opener.on('exit', code => { if (code) console.error(`sim: browser opener exited ${code}. Open ${twinUrl}`); });
    }
  }
}));
vite.stderr.on("data", prefix("twin", "36"));
children.push(vite);

/** Host JVMs for this port that are still alive: the announced pid, plus anything else whose command line ends in
 * "org.biobuzz.sim.host.Main <port>" (e.g. an orphan of an earlier run). Unix only; Windows returns []. */
const hostPids = () => {
  if (isWin) return hostPid ? [hostPid] : [];
  const out = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  const re = new RegExp(`org\\.biobuzz\\.sim\\.host\\.Main\\s+${hostPort}\\s*$`);
  const found = out.split("\n").filter((l) => re.test(l)).map((l) => +l.trim().split(/\s+/)[0]).filter((n) => n > 0);
  if (hostPid && !found.includes(hostPid)) found.push(hostPid);
  return found;
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const shutdown = async () => {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(heartbeat);
  rmSync(startupDir, { recursive: true, force: true });
  for (const c of children) try { c.kill("SIGINT"); } catch {}
  try { host?.kill("SIGINT"); } catch {}
  // the host JVM runs under the Gradle daemon, so it must be stopped explicitly: TERM, wait, then KILL
  const pids = hostPids().filter(alive);
  if (vite.pid && alive(vite.pid)) pids.push(vite.pid);
  for (const pid of pids) try { process.kill(pid, "SIGTERM"); } catch {}
  const until = Date.now() + 4000;
  while (Date.now() < until && pids.some(alive)) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// ---- watch the sources the host is built from and restart it on change
if (watch) {
  const watchDirs = [team, simDir, assetsDir, join(root, "runtime", "sdk-shim", "src"), join(root, "runtime", "host", "src"), join(root, "runtime", "samples", "src")].filter((d) => d && existsSync(d));
  const watchFiles = [bindingsFile].filter((f) => f && existsSync(f));
  let timer;
  const relevant = (f) => !f || /\.(java|kt|json|properties)$/.test(f);
  const onChange = (what) => {
    if (!relevant(what)) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (shuttingDown) return;
      restarting = true;
      startup.set('restarting', 'Source changed. Stopping the old runtime before recompiling…', true);
      console.log(`\x1b[33m[host]\x1b[0m change in ${what ?? "sources"} — recompiling and restarting the host (re-INIT your OpMode when it is back)`);
      const pids = hostPids().filter(alive);
      try { host.kill("SIGINT"); } catch {}
      for (const pid of pids) try { process.kill(pid, "SIGTERM"); } catch {}
      const until = Date.now() + 4000;
      while (Date.now() < until && pids.some(alive)) await new Promise((r) => setTimeout(r, 100));
      for (const pid of pids.filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      hostPid = undefined;
      restarting = false;
      startHost();
    }, 500);
  };
  for (const d of watchDirs) { try { watchFs(d, { recursive: true }, (_ev, f) => onChange(f ? `${d.split("/").pop()}/${f}` : d)); } catch (e) { console.log(`sim: cannot watch ${d}: ${e.message}`); } }
  for (const f of watchFiles) { try { watchFs(f, () => onChange(f.split("/").pop())); } catch {} }
}
vite.on("exit", () => shutdown());
