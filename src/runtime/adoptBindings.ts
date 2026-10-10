/**
 * The reverse of a twin binding: given the value a TeamCode asset holds ON DISK for a bound key, set the twin knob the
 * binding reads from so the twin agrees with the file again (the running session then matches the repo instead of the
 * repo being rewritten from the session). Only bindings whose expression is a plain knob, possibly negated, scaled,
 * offset, rounded, upper/lower-cased or passed through a `map`, can be inverted; a value the twin DERIVES (the solver's
 * calibration, the hive geometry, a camera's field of view from its preset) cannot be set from the outside and is
 * reported as such. Pure planning; `applyAdoption` mutates the state it is given.
 */
import type { AppState } from "../state";
import type { Binding, Knob } from "./bindings";

const IN = 0.0254;

export type AdoptPlanItem =
  | { asset: string; key: string; fileValue: unknown; knob: string; value: Knob; expr: string }
  | { asset: string; key: string; fileValue: unknown; reason: string; expr: string };

/** Peel one binding expression into a knob name and the inverse transform of the file value. */
export function invertExpression(expr: string, fileValue: unknown, map?: Record<string, Knob>): { knob: string; value: Knob } | { reason: string } {
  let v: unknown = fileValue;
  if (map) {
    const hit = Object.entries(map).find(([, to]) => String(to) === String(v));
    if (!hit) return { reason: `file value ${JSON.stringify(v)} is not a target of the binding's map` };
    v = hit[0];
  }
  let e = expr.trim();
  // outer functions, innermost last: round(x, n) is lossy but invertible; upper/lower flip case
  const fn = /^(round|upper|lower)\((.*)\)$/s;
  let m: RegExpExecArray | null;
  const post: ((x: unknown) => unknown)[] = [];
  while ((m = fn.exec(e))) {
    const name = m[1]; let inner = m[2];
    if (name === "round") { const comma = inner.lastIndexOf(","); if (comma >= 0 && /^\s*\d+\s*$/.test(inner.slice(comma + 1))) inner = inner.slice(0, comma); }
    if (name === "upper") post.push((x) => (typeof x === "string" ? x.toLowerCase() : x));
    if (name === "lower") post.push((x) => (typeof x === "string" ? x.toUpperCase() : x));
    e = inner.trim();
  }
  const id = "[A-Za-z_][A-Za-z0-9_.]*", num = "-?\\d+(?:\\.\\d+)?";
  let knob: string | undefined; let value: unknown = v;
  let r: RegExpExecArray | null;
  const n = () => { if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) value = Number(value); if (typeof value !== "number") throw new Error("the file value is not a number"); return value; };
  try {
    if ((r = new RegExp(`^(${id})$`).exec(e))) knob = r[1];
    else if ((r = new RegExp(`^-\\s*(${id})$`).exec(e))) { knob = r[1]; value = -n(); }
    else if ((r = new RegExp(`^(${id})\\s*\\*\\s*(${num})$`).exec(e)) || (r = new RegExp(`^(${num})\\s*\\*\\s*(${id})$`).exec(e))) { const k = /^[A-Za-z_]/.test(r[1]) ? r[1] : r[2], c = Number(/^[A-Za-z_]/.test(r[1]) ? r[2] : r[1]); knob = k; value = n() / c; }
    else if ((r = new RegExp(`^(${id})\\s*/\\s*(${num})$`).exec(e))) { knob = r[1]; value = n() * Number(r[2]); }
    else if ((r = new RegExp(`^(${id})\\s*\\+\\s*(${num})$`).exec(e)) || (r = new RegExp(`^(${num})\\s*\\+\\s*(${id})$`).exec(e))) { const k = /^[A-Za-z_]/.test(r[1]) ? r[1] : r[2], c = Number(/^[A-Za-z_]/.test(r[1]) ? r[2] : r[1]); knob = k; value = n() - c; }
    else if ((r = new RegExp(`^(${id})\\s*-\\s*(${num})$`).exec(e))) { knob = r[1]; value = n() + Number(r[2]); }
    else if ((r = new RegExp(`^(${num})\\s*-\\s*(${id})$`).exec(e))) { knob = r[2]; value = Number(r[1]) - n(); }
    else return { reason: `expression "${expr}" is not a plain knob (not invertible)` };
  } catch (err) { return { reason: (err as Error).message }; }
  for (const f of post.reverse()) value = f(value);
  return { knob: knob!, value: value as Knob };
}

/** Knobs the twin derives from other things: no setter exists, say why. */
const DERIVED: [RegExp, string][] = [
  [/^launcher\.calibration(Behind)?\./, "the twin's solver computes this from the hood angle, exit height and ball; set those instead (adopt launchAngleDeg / exitHeightIn) or measure on the robot"],
  [/^hive\./, "field geometry"],
  [/^start\./, "the start pose is chosen on the field, not a robot fact"],
  [/^robot\.(maxSpeedInPerSec|trackWidthIn|wheelbaseIn|massLb)$/, "derived from the robot's size, wheel and motor; adopt those"],
  [/^launcher\.exitSpeedMps$/, "derived from the flywheel RPM"],
  [/\.(hfovDeg|vfovDeg|width|height|preset|name|kind|role)$/, "comes from the camera or device preset"],
];

/** Set one twin knob (team-friendly units) on the state; throws with a reason when the knob has no setter. */
export function setKnob(state: AppState, knob: string, value: Knob): void {
  for (const [re, why] of DERIVED) if (re.test(knob)) throw new Error(why);
  const r = state.robot, l = r.launcher;
  const num = () => { const x = typeof value === "string" ? Number(value) : typeof value === "boolean" ? (value ? 1 : 0) : value; if (!Number.isFinite(x)) throw new Error(`"${value}" is not a number`); return x; };
  const str = () => String(value);
  const simple: Record<string, () => void> = {
    "alliance": () => { const a = str().toLowerCase(); if (a !== "red" && a !== "blue") throw new Error("alliance must be red or blue"); state.alliance = a; },
    "robot.lengthIn": () => { r.lengthM = num() * IN; }, "robot.widthIn": () => { r.widthM = num() * IN; }, "robot.heightIn": () => { r.heightM = num() * IN; },
    "robot.massKg": () => { r.massKg = num(); }, "robot.wheelRpm": () => { r.wheelRpm = num(); },
    "robot.wheelDiameterIn": () => { r.wheelDiameterM = num() * IN; }, "robot.wheelDiameterMm": () => { r.wheelDiameterM = num() / 1000; },
    "robot.intakeSide": () => { const s = str(); if (!["front", "rear", "left", "right"].includes(s)) throw new Error("intake side must be front, rear, left or right"); r.intake.side = s as typeof r.intake.side; },
    "robot.intakeHeadingDeg": () => { const h = ((num() % 360) + 540) % 360 - 180; const side = Math.abs(h) < 45 ? "front" : Math.abs(h) > 135 ? "rear" : h > 0 ? "left" : "right"; r.intake.side = side; },
    "robot.intakeWidthIn": () => { r.intake.widthM = num() * IN; },
    "launcher.exitHeightIn": () => { l.exitHeightM = num() * IN; }, "launcher.exitForwardIn": () => { l.exitForwardM = num() * IN; }, "launcher.exitLeftIn": () => { l.exitLeftM = num() * IN; },
    "launcher.yawOffsetDeg": () => { l.yawOffsetDeg = num(); }, "launcher.elevationDeg": () => { l.elevationDeg = num(); },
    "launcher.elevationMinDeg": () => { l.elevationMinDeg = num(); }, "launcher.elevationMaxDeg": () => { l.elevationMaxDeg = num(); },
    "launcher.maxRpm": () => { l.maxRpm = num(); }, "launcher.wheelDiameterMm": () => { l.wheelDiameterM = num() / 1000; },
    "launcher.efficiency": () => { l.efficiency = num(); }, "launcher.spinFraction": () => { l.spinFraction = num(); },
    "launcher.turretMinDeg": () => { l.turretMinDeg = num(); }, "launcher.turretMaxDeg": () => { l.turretMaxDeg = num(); },
    "launcher.rpm": () => { l.rpm = num(); },
    "noise.speedPct": () => { state.noise.speedFrac = num() / 100; }, "noise.elevationDeg": () => { state.noise.elevationDeg = num(); }, "noise.yawDeg": () => { state.noise.yawDeg = num(); },
    "field.tipMassG": () => { state.tipMassG = num(); }, "match.capacity": () => { state.capacity = num(); },
    "match.canPollen": () => { state.canPollen = value === true || str() === "true"; }, "match.canNectar": () => { state.canNectar = value === true || str() === "true"; },
    "hardware.mirroredSide": () => { const s = str(); if (s !== "left" && s !== "right") throw new Error("mirroredSide must be left or right"); state.hardware.mirroredSide = s; },
  };
  if (simple[knob]) { simple[knob](); return; }
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  // camera mounts: camera.<slug|index|selected>.<field> and hardware.<webcam slug>.<field>
  const cm = /^(camera\.([A-Za-z0-9_]+)|hardware\.([A-Za-z0-9_]+))\.(forwardIn|leftIn|rightIn|heightIn|pitchDeg|pitchUpDeg|yawDeg|rollDeg|enabled)$/.exec(knob);
  if (cm) {
    let cam: AppState["robot"]["cameras"][number] | undefined;
    if (cm[2] !== undefined) cam = cm[2] === "selected" ? r.cameras.find((c) => c.id === state.selectedCameraId) : /^\d+$/.test(cm[2]) ? r.cameras[Number(cm[2])] : r.cameras.find((c) => slug(c.name) === cm[2] || c.id === cm[2]);
    else { const d = state.hardware.devices.find((x) => slug(x.name) === cm[3]); if (!d) throw new Error(`no device named like "${cm[3]}" in the hardware map`); cam = r.cameras.find((c) => c.id === d.cameraId) ?? r.cameras[0]; }
    if (!cam) throw new Error(`no camera for "${knob}"`);
    const f = cm[4];
    if (f === "forwardIn") cam.forwardM = num() * IN; else if (f === "leftIn") cam.leftM = num() * IN; else if (f === "rightIn") cam.leftM = -num() * IN; else if (f === "heightIn") cam.heightM = num() * IN;
    else if (f === "pitchDeg") cam.pitchDeg = num(); else if (f === "pitchUpDeg") cam.pitchDeg = -num(); else if (f === "yawDeg") cam.yawDeg = num(); else if (f === "rollDeg") cam.rollDeg = num(); else if (f === "enabled") cam.enabled = value === true || str() === "true";
    return;
  }
  const hm = /^hardware\.([A-Za-z0-9_]+)\.(ticksPerRev|freeRpm|port|directionSign|mirrored)$/.exec(knob);
  if (hm) {
    const d = state.hardware.devices.find((x) => slug(x.name) === hm[1]); if (!d) throw new Error(`no device named like "${hm[1]}" in the hardware map`);
    const f = hm[2];
    if (f === "ticksPerRev") d.ticksPerRev = num(); else if (f === "freeRpm") d.freeRpm = num(); else if (f === "port") d.port = num();
    else {
      const isLeft = d.role === "left" || d.role === "frontLeft" || d.role === "backLeft", isRight = d.role === "right" || d.role === "frontRight" || d.role === "backRight";
      if (!isLeft && !isRight) throw new Error(`"${d.name}" is not a drive-side motor`);
      const mirrored = f === "mirrored" ? value === true || str() === "true" : num() < 0;
      // a mirrored left motor means the left side is the mirrored one; an unmirrored left motor means the right side is
      state.hardware.mirroredSide = mirrored === isLeft ? "left" : "right";
    }
    return;
  }
  throw new Error(`no setter for twin knob "${knob}"`);
}

/** For each bound key that differs from the file: the knob to set and the value, or why it cannot be adopted. */
export function planAdoption(bindings: Binding[], diffs: { asset: string; key: string; fileValue: unknown }[]): AdoptPlanItem[] {
  return diffs.map((d) => {
    const b = bindings.find((x) => x.key === d.key && (x.asset === d.asset || d.asset.endsWith("/" + x.asset) || x.asset.endsWith("/" + d.asset)));
    if (!b) return { ...d, expr: "", reason: "no binding found for this key" };
    const inv = invertExpression(b.twin, d.fileValue, b.map);
    if ("reason" in inv) return { ...d, expr: b.twin, reason: inv.reason };
    for (const [re, why] of DERIVED) if (re.test(inv.knob)) return { ...d, expr: b.twin, reason: why };
    return { ...d, expr: b.twin, knob: inv.knob, value: inv.value };
  });
}

/** Apply a plan: set every invertible knob; returns what was set and what was skipped (with reasons). */
export function applyAdoption(state: AppState, plan: AdoptPlanItem[]): { adopted: { key: string; knob: string; value: Knob }[]; skipped: { key: string; reason: string }[] } {
  const adopted: { key: string; knob: string; value: Knob }[] = [], skipped: { key: string; reason: string }[] = [];
  for (const p of plan) {
    if ("reason" in p) { skipped.push({ key: p.key, reason: p.reason }); continue; }
    try { setKnob(state, p.knob, p.value); adopted.push({ key: p.key, knob: p.knob, value: p.value }); } catch (e) { skipped.push({ key: p.key, reason: (e as Error).message }); }
  }
  return { adopted, skipped };
}
