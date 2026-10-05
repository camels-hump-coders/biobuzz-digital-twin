#!/usr/bin/env node
/**
 * One command to run the twin + virtual runtime against your TeamCode.
 *
 *   pnpm sim --team ~/dev/FtcRobotController          # first time: remembers the path
 *   pnpm sim                                           # afterwards
 *   pnpm sim --team <path> --exclude "**\/roadrunner/**,**\/Old*.java"
 *   pnpm sim --no-watch --no-browser --port 5173 --host-port 8765
 *
 * --team accepts either the FtcRobotController project root (TeamCode/src/main/java is appended),
 * the TeamCode module folder, or the java source folder itself.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
if (team) gradleArgs.push(`-PteamCode=${team}`);
if (exclude) gradleArgs.push(`-PteamExclude=${exclude}`);
if (watch) gradleArgs.push("--continuous");

console.log(`sim: TeamCode  ${team ?? "(none — sample OpModes only; pass --team <path>)"}`);
if (exclude) console.log(`sim: excluding ${exclude}`);
console.log(`sim: JDK       ${javaHome ?? "from PATH"}`);
console.log(`sim: host      ws://127.0.0.1:${hostPort}${watch ? "  (auto-rebuilds and restarts when your code changes)" : ""}`);
console.log(`sim: twin      http://localhost:${port}/?runtime=1`);

const children = [];
const prefix = (name, color) => (chunk) => { for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) process.stdout.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`); };

const host = spawn(gradlew, gradleArgs, { cwd: join(root, "runtime"), env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) }, shell: isWin });
const errFiles = new Set();
const hostOut = (chunk) => {
  prefix("host", "33")(chunk);
  for (const m of chunk.toString().matchAll(/^(\S+\.java):\d+: error:/gm)) errFiles.add(m[1]);
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

const viteArgs = ["exec", "vite", "--port", port, "--strictPort"];
if (openBrowser) viteArgs.push("--open", "/?runtime=1");
const vite = spawn(isWin ? "pnpm.cmd" : "pnpm", viteArgs, { cwd: root, env: process.env, shell: isWin });
vite.stdout.on("data", prefix("twin", "36"));
vite.stderr.on("data", prefix("twin", "36"));
children.push(vite);

const shutdown = () => { for (const c of children) try { c.kill("SIGINT"); } catch {} setTimeout(() => process.exit(0), 300); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
host.on("exit", (code) => { if (code && code !== 130) console.log(`\x1b[33m[host]\x1b[0m exited with code ${code}`); });
vite.on("exit", () => shutdown());
