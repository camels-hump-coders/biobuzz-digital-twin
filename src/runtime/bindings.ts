/**
 * Twin bindings: the team's JSON settings that describe the physical robot (wheel size, ticks per rev, camera mount,
 * start pose, alliance, ...) can be derived from the twin's own knobs instead of being typed twice. A bindings file in
 * the team repo (TeamCode/twin-bindings.json) says which asset key comes from which twin expression; the twin evaluates
 * it whenever a knob changes and feeds the results to the OpModes as asset overrides at INIT.
 *
 *   { "version": 1, "bindings": [
 *       { "asset": "biobuzz/robot-profile.json", "key": "wheelDiameterIn", "twin": "robot.wheelDiameterIn" },
 *       { "asset": "biobuzz/robot-profile.json", "key": "camera.pitchDeg", "twin": "-camera.webcam_1.pitchDeg", "round": 1 },
 *       { "asset": "biobuzz/robot-profile.json", "key": "tagTracking.alliance", "twin": "upper(alliance)" } ] }
 *
 * Expressions: numbers, "strings", knob names, + - * / and parentheses, functions round(x, digits) abs min max floor
 * ceil sign upper lower. `map` translates the result ({"red": "RED"}), `round` rounds numbers.
 */
import type { AppState } from "../state";
import { intrinsicsFor } from "../robot/robot";
import { startPose } from "../sim/starts";

const IN = 0.0254;
export type Knob = number | string | boolean;
export type Knobs = Record<string, Knob>;

export interface Binding { asset: string; key: string; twin: string; map?: Record<string, Knob>; round?: number; note?: string }
export interface BindingsFile { version?: number; bindings: Binding[] }
export interface BoundResult { overrides: Record<string, Record<string, unknown>>; sources: Record<string, Record<string, string>>; errors: string[] }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Every twin value a binding may refer to, in team-friendly units (inches, degrees, mm for flywheels). */
export function twinKnobs(state: AppState): Knobs {
  const r = state.robot, l = r.launcher, k: Knobs = {};
  k["alliance"] = state.alliance;
  k["robot.name"] = r.name; k["robot.drivetrain"] = r.drivetrain;
  k["robot.lengthIn"] = r.lengthM / IN; k["robot.widthIn"] = r.widthM / IN; k["robot.heightIn"] = r.heightM / IN;
  k["robot.massKg"] = r.massKg ?? 12; k["robot.massLb"] = (r.massKg ?? 12) * 2.20462;
  k["robot.wheelDiameterIn"] = r.wheelDiameterM / IN; k["robot.wheelDiameterMm"] = r.wheelDiameterM * 1000; k["robot.wheelRpm"] = r.wheelRpm;
  k["robot.trackWidthIn"] = (r.widthM * 0.9) / IN; k["robot.wheelbaseIn"] = (r.lengthM * 0.75) / IN; // what the twin's kinematics use
  k["robot.intakeSide"] = r.intake?.side ?? "front"; k["robot.intakeWidthIn"] = (r.intake?.widthM ?? 0.3) / IN;
  k["robot.maxSpeedInPerSec"] = (Math.PI * r.wheelDiameterM * r.wheelRpm) / 60 / IN;
  const sp = startPose(state.starts, "you", state.alliance, state.hive);
  k["start.xIn"] = sp.x / IN; k["start.zIn"] = sp.z / IN; k["start.headingDeg"] = (sp.heading * 180) / Math.PI;
  k["hive.red"] = state.hive.red; k["hive.blue"] = state.hive.blue; k["hive.ours"] = state.hive[state.alliance];
  k["launcher.name"] = l.name; k["launcher.exitHeightIn"] = l.exitHeightM / IN; k["launcher.exitForwardIn"] = l.exitForwardM / IN; k["launcher.exitLeftIn"] = l.exitLeftM / IN;
  k["launcher.yawOffsetDeg"] = l.yawOffsetDeg; k["launcher.elevationDeg"] = l.elevationDeg; k["launcher.elevationMinDeg"] = l.elevationMinDeg; k["launcher.elevationMaxDeg"] = l.elevationMaxDeg;
  k["launcher.rpm"] = l.rpm; k["launcher.maxRpm"] = l.maxRpm; k["launcher.wheelDiameterMm"] = l.wheelDiameterM * 1000; k["launcher.efficiency"] = l.efficiency; k["launcher.spinFraction"] = l.spinFraction;
  k["launcher.turretMinDeg"] = l.turretMinDeg; k["launcher.turretMaxDeg"] = l.turretMaxDeg;
  k["launcher.exitSpeedMps"] = (l.efficiency * Math.PI * l.wheelDiameterM * l.rpm) / 60;
  k["noise.speedPct"] = state.noise.speedFrac * 100; k["noise.elevationDeg"] = state.noise.elevationDeg; k["noise.yawDeg"] = state.noise.yawDeg;
  k["field.tipMassG"] = state.tipMassG; k["match.capacity"] = state.capacity;
  const cam = (prefix: string, c: typeof r.cameras[number]) => {
    const i = intrinsicsFor(c);
    k[`${prefix}.name`] = c.name; k[`${prefix}.preset`] = c.presetId;
    k[`${prefix}.forwardIn`] = c.forwardM / IN; k[`${prefix}.leftIn`] = c.leftM / IN; k[`${prefix}.rightIn`] = -c.leftM / IN; k[`${prefix}.heightIn`] = c.heightM / IN;
    k[`${prefix}.pitchDeg`] = c.pitchDeg; k[`${prefix}.pitchUpDeg`] = -c.pitchDeg; k[`${prefix}.yawDeg`] = c.yawDeg; k[`${prefix}.rollDeg`] = c.rollDeg;
    k[`${prefix}.hfovDeg`] = (i.hfov * 180) / Math.PI; k[`${prefix}.vfovDeg`] = (i.vfov * 180) / Math.PI; k[`${prefix}.width`] = i.width; k[`${prefix}.height`] = i.height; k[`${prefix}.enabled`] = c.enabled;
  };
  r.cameras.forEach((c, idx) => { cam(`camera.${slug(c.name) || c.id}`, c); cam(`camera.${idx}`, c); if (c.id === state.selectedCameraId) cam("camera.selected", c); });
  k["hardware.mirroredSide"] = state.hardware.mirroredSide ?? "left";
  for (const d of state.hardware.devices) {
    const p = `hardware.${slug(d.name)}`;
    k[`${p}.kind`] = d.kind; if (d.role) k[`${p}.role`] = d.role; if (d.port !== undefined) k[`${p}.port`] = d.port;
    if (d.ticksPerRev !== undefined) k[`${p}.ticksPerRev`] = d.ticksPerRev; if (d.freeRpm !== undefined) k[`${p}.freeRpm`] = d.freeRpm;
    if (d.kind === "webcam") { const c = r.cameras.find((x) => x.id === d.cameraId) ?? r.cameras[0]; if (c) cam(p, c); }
    const isLeft = d.role === "left" || d.role === "frontLeft" || d.role === "backLeft", isRight = d.role === "right" || d.role === "frontRight" || d.role === "backRight";
    if (d.kind === "motor" && (isLeft || isRight)) { const m = state.hardware.mirroredSide ?? "left"; k[`${p}.mirrored`] = (m === "left" && isLeft) || (m === "right" && isRight); k[`${p}.directionSign`] = k[`${p}.mirrored`] ? -1 : 1; }
  }
  return k;
}

// ---- tiny expression language -------------------------------------------------------------------------------------
type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "id"; v: string } | { t: "op"; v: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { const m = /^[0-9]*\.?[0-9]+(e-?[0-9]+)?/i.exec(src.slice(i))!; out.push({ t: "num", v: parseFloat(m[0]) }); i += m[0].length; continue; }
    if (c === '"' || c === "'") { const j = src.indexOf(c, i + 1); if (j < 0) throw new Error("unterminated string"); out.push({ t: "str", v: src.slice(i + 1, j) }); i = j + 1; continue; }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!; out.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
    if ("+-*/(),".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`unexpected '${c}'`);
  }
  return out;
}
const FUNCS: Record<string, (...a: Knob[]) => Knob> = {
  round: (x, d = 0) => { const f = Math.pow(10, Number(d)); return Math.round(Number(x) * f) / f; },
  abs: (x) => Math.abs(Number(x)), floor: (x) => Math.floor(Number(x)), ceil: (x) => Math.ceil(Number(x)), sign: (x) => Math.sign(Number(x)),
  min: (...a) => Math.min(...a.map(Number)), max: (...a) => Math.max(...a.map(Number)),
  upper: (s) => String(s).toUpperCase(), lower: (s) => String(s).toLowerCase(), str: (s) => String(s), num: (s) => Number(s),
};
export function evaluate(expr: string, knobs: Knobs): Knob {
  const toks = tokenize(expr); let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as any).v === v;
  const num = (v: Knob, what: string) => { if (typeof v === "boolean") return v ? 1 : 0; if (typeof v === "string") { const n = Number(v); if (Number.isNaN(n)) throw new Error(`${what}: '${v}' is not a number`); return n; } return v; };
  function primary(): Knob {
    const t = next(); if (!t) throw new Error("unexpected end");
    if (t.t === "num" || t.t === "str") return t.v;
    if (t.t === "op" && t.v === "(") { const v = expression(); if (!isOp(")")) throw new Error("missing )"); next(); return v; }
    if (t.t === "op" && t.v === "-") return -num(primary(), "negation");
    if (t.t === "id") {
      if (isOp("(")) { next(); const args: Knob[] = []; if (!isOp(")")) { args.push(expression()); while (isOp(",")) { next(); args.push(expression()); } } if (!isOp(")")) throw new Error("missing )"); next(); const f = FUNCS[t.v]; if (!f) throw new Error(`unknown function ${t.v}`); return f(...args); }
      if (!(t.v in knobs)) throw new Error(`unknown twin knob '${t.v}'`);
      return knobs[t.v];
    }
    throw new Error(`unexpected '${(t as any).v}'`);
  }
  function term(): Knob { let v = primary(); while (isOp("*") || isOp("/")) { const op = (next() as any).v; const r = primary(); v = op === "*" ? num(v, "*") * num(r, "*") : num(v, "/") / num(r, "/"); } return v; }
  function expression(): Knob { let v = term(); while (isOp("+") || isOp("-")) { const op = (next() as any).v; const r = term(); v = op === "+" ? (typeof v === "string" || typeof r === "string" ? String(v) + String(r) : num(v, "+") + num(r, "+")) : num(v, "-") - num(r, "-"); } return v; }
  const v = expression();
  if (p < toks.length) throw new Error(`unexpected '${(toks[p] as any).v}'`);
  return v;
}

export function parseBindings(text: string): BindingsFile {
  const j = JSON.parse(text);
  if (!j || !Array.isArray(j.bindings)) throw new Error("twin-bindings.json needs a \"bindings\" array");
  return j as BindingsFile;
}

/** Evaluate every binding; results grouped by asset path, plus the knob expression each key came from. */
export function computeBindings(file: BindingsFile, knobs: Knobs): BoundResult {
  const out: BoundResult = { overrides: {}, sources: {}, errors: [] };
  for (const b of file.bindings) {
    if (!b || !b.asset || !b.key || !b.twin) { out.errors.push(`binding needs asset, key and twin: ${JSON.stringify(b)}`); continue; }
    try {
      let v = evaluate(b.twin, knobs);
      if (b.map && String(v) in b.map) v = b.map[String(v)];
      if (b.round !== undefined && typeof v === "number") v = FUNCS.round(v, b.round);
      (out.overrides[b.asset] ??= {})[b.key] = v;
      (out.sources[b.asset] ??= {})[b.key] = b.twin;
    } catch (e) { out.errors.push(`${b.asset} → ${b.key}: ${(e as Error).message}`); }
  }
  return out;
}

/** Manual overrides plus bound ones; a bound key always wins (it mirrors the twin). */
export function mergeOverrides(manual: Record<string, Record<string, unknown>>, bound: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [a, m] of Object.entries(manual)) out[a] = { ...m };
  for (const [a, m] of Object.entries(bound)) out[a] = { ...(out[a] ?? {}), ...m };
  return out;
}
