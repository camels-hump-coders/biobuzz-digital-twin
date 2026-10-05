#!/usr/bin/env node
/**
 * Install the "biobuzz-twin" agent skill into a team's repository:
 *   pnpm skill:install ~/dev/FtcRobotController
 * Copies skills/biobuzz-twin into <team>/.claude/skills/biobuzz-twin and writes <team>/.biobuzz-twin.json pointing back
 * at this checkout so the agent knows where the twin lives.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) { console.error("usage: pnpm skill:install <team repo path>"); process.exit(2); }
const team = resolve(target.replace(/^~(?=$|\/)/, homedir()));
if (!existsSync(team)) { console.error(`not a directory: ${team}`); process.exit(2); }
const dest = join(team, ".claude", "skills", "biobuzz-twin");
mkdirSync(dest, { recursive: true });
cpSync(join(root, "skills", "biobuzz-twin"), dest, { recursive: true });
writeFileSync(join(team, ".biobuzz-twin.json"), JSON.stringify({ twinPath: root, note: "Location of the BIOBUZZ digital twin checkout used by .claude/skills/biobuzz-twin. Safe to commit; teammates can point it at their own clone." }, null, 2) + "\n");
console.log(`installed skill to ${dest}\nwrote ${join(team, ".biobuzz-twin.json")} (twinPath: ${root})\nCommit both so every teammate's agent gets it.`);
