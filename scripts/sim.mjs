#!/usr/bin/env node
/**
 * One command to run the twin + virtual runtime against your TeamCode.
 *
 *   pnpm sim --team ~/dev/FtcRobotController          # first time: remembers the path
 *   pnpm sim                                           # afterwards
 *   pnpm sim --team <path> --exclude "**\/roadrunner/**,**\/Old*.java"
 *   pnpm sim --no-watch --no-browser --no-panels --port 5173 --host-port 8765
 *
 * --team accepts either the FtcRobotController project root (TeamCode/src/main/java is appended),
 * the TeamCode module folder, or the java source folder itself.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = join(root, ".biobuzz.local.json");
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const has = (name) => args.includes(name);

const saved = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
let team = flag("--team", saved.team);
const exclude = flag("--exclude", saved.exclude ?? "");
const port = flag("--port", "5173");
const hostPort = flag("--host-port", "8765");
const watch = !has("--no-watch");
const openBrowser = !has("--no-browser");
const panels = !has("--no-panels"); // the real FTC Panels dashboard on 8001/8002; off for secondary hosts such as twin-test

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
const gradleArgs = [":host:run", "--console=plain", "-q", `--args=${hostPort}`];
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
if (allExcludes.length) gradleArgs.push(`-PteamExclude=${allExcludes.join(",")}`);
if (simDir && existsSync(simDir)) gradleArgs.push(`-PteamSim=${simDir}`);
if (assetsDir && existsSync(assetsDir)) gradleArgs.push(`-PsimAssets=${assetsDir}`);
if (!panels) gradleArgs.push("-PsimPanels=false");
const bindingsFile = team ? join(resolve(team, "../../.."), "twin-bindings.json") : undefined;
if (bindingsFile && existsSync(bindingsFile)) gradleArgs.push(`-PsimBindings=${bindingsFile}`);
if (watch) gradleArgs.push("--continuous");

console.log(`sim: TeamCode  ${team ?? "(none — sample OpModes only; pass --team <path>)"}`);
if (exclude) console.log(`sim: excluding ${exclude}`);
if (autoExcluded.length) { console.log(`sim: skipping ${autoExcluded.length} file(s) that use Android/robot-only APIs (add a copy under TeamCode/src/sim/java to provide a sim version):`); for (const f of autoExcluded) console.log(`sim:   ${f}`); }
if (simDir && existsSync(simDir)) console.log(`sim: overrides ${simDir}`);
if (assetsDir && existsSync(assetsDir)) console.log(`sim: assets    ${assetsDir}`);
if (bindingsFile && existsSync(bindingsFile)) console.log(`sim: bindings  ${bindingsFile}`);
console.log(`sim: JDK       ${javaHome ?? "from PATH"}`);
console.log(`sim: host      ws://127.0.0.1:${hostPort}${watch ? "  (auto-rebuilds and restarts when your code changes)" : ""}`);
console.log(`sim: twin      http://localhost:${port}/?runtime=1`);

const children = [];
const prefix = (name, color) => { let buf = ""; return (chunk) => { buf += chunk.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ""; for (const line of lines) if (line.trim()) process.stdout.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`); }; };

const host = spawn(gradlew, gradleArgs, { cwd: join(root, "runtime"), env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) }, shell: isWin });
const errFiles = new Set();
let hostPid; // the host JVM itself (announced on its first stdout line), distinct from the gradlew client we spawned
// one line buffer for the whole stream: a buffer per chunk (the old code) dropped every line split across two pipe
// reads, which garbled the OpMode list and sometimes swallowed the "listening on ws:" line twin-test waits for
const hostPrefix = prefix("host", "33");
const hostOut = (chunk) => {
  hostPrefix(chunk);
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
host.stdout.on("data", hostOut);
host.stderr.on("data", hostOut);
children.push(host);

// run Vite's own entry point rather than `pnpm exec vite`, so the pid we hold is Vite itself and a signal reaches it
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const viteArgs = [viteBin, "--port", port, "--strictPort"];
if (openBrowser) viteArgs.push("--open", "/?runtime=1");
const vite = spawn(process.execPath, viteArgs, { cwd: root, env: process.env });
vite.stdout.on("data", prefix("twin", "36"));
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
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; shuttingDown = true;
  for (const c of children) try { c.kill("SIGINT"); } catch {}
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
host.on("exit", (code) => { if (code && code !== 130) console.log(`\x1b[33m[host]\x1b[0m exited with code ${code}`); });
vite.on("exit", () => shutdown());
