/** "Shooter calibration" panel section: a guided wizard that turns shots measured on the real robot into the twin's
 * launcher knobs (see ballistics/calibration.ts for the fitter). */
import type { AppState } from "../state";
import type { RuntimeLink } from "../runtime/link";
import { BALL, m } from "../field/fieldSpec";
import { aimPoint, upCellFrame } from "../field/hive";
import { IN } from "../util/units";
import { type CalShot, type FitResult, type FlightModel, type Params, exitToWallDistance, fitCalibration, nextSlot, parseCalLines, powerTable, predict, trajectory, defaultCalibration, shotRpm } from "../ballistics/calibration";
import { el, num, sel, chk, type Change } from "./panel";

export interface SimImpactLike { kind: "wall" | "floor"; distanceM: number; heightM: number; lateralM: number; power: number; rpm: number; t: number }

/** The shot being entered; lives on the panel so it survives re-renders. */
export interface CalForm { power: number; rpm?: number; kind: "wall" | "floor"; measuredIn: number; lateralIn: number; srcId?: number; bumperIn: number }

export interface CalCtx {
  state: AppState;
  link?: RuntimeLink;
  change: Change;
  rerender: () => void;
  form: CalForm | undefined;
  setForm: (f: CalForm | undefined) => void;
  simImpact?: SimImpactLike;
  clearImpact: () => void;
  /** fit cache across renders */
  cache: { key: string; fit: FitResult } | undefined;
  setCache: (c: { key: string; fit: FitResult }) => void;
}

function flightModel(st: AppState, exitHeightM: number): FlightModel {
  const b = st.ballKind === "pollen" ? BALL.pollen : BALL.nectarRed;
  const fly = st.hardware.devices.find((d) => d.kind === "motor" && d.role === "flywheel");
  return { ball: { massKg: b.massKg, diameterM: m(b.diaIn), cd: st.drag ? 0.45 : 0, cl: st.drag ? 0.2 : 0 }, wheelDiameterM: st.robot.launcher.wheelDiameterM, freeRpm: fly?.freeRpm ?? st.robot.launcher.maxRpm, exitHeightM };
}
const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const inch = (mm: number) => fmt(mm / IN, 1);

export function calibrationRows(ctx: CalCtx): HTMLElement[] {
  const st = ctx.state, cal = st.calibration, l = st.robot.launcher, setup = cal.setup;
  const save = () => { ctx.change("calibration"); ctx.rerender(); };
  const rows: HTMLElement[] = [];
  const geom = { exitForwardM: l.exitForwardM, yawOffsetDeg: l.yawOffsetDeg };
  const wallD = exitToWallDistance(setup.bumperDistanceM, geom, st.robot.lengthM);
  const model = flightModel(st, setup.exitHeightM);
  const start: Params = { efficiency: l.efficiency, elevationDeg: l.elevationDeg, spinFraction: l.spinFraction };

  // ---- fit (cached: the optimiser simulates every shot a few hundred times)
  const key = JSON.stringify([cal.shots, cal.fitSpin, model, start]);
  let fit: FitResult;
  if (ctx.cache && ctx.cache.key === key) fit = ctx.cache.fit; else { fit = fitCalibration(model, start, cal.shots, cal.fitSpin); ctx.setCache({ key, fit }); }

  rows.push(el("div", { class: "note" },
    "Make the twin shoot like your robot. Run the \"Twin: Shooter Calibration\" OpMode (runtime/samples/…/TwinCalibration.java, copy it into your TeamCode): park the robot square to a wall with the shooter facing it, fire one ball per power level, and note where each ball hit — the height on the wall, or how far out it landed if it fell short. Enter each shot below (click the diagram); the fitter tunes exit-speed efficiency and hood angle until the twin's flight model reproduces every impact, then Apply writes them to the Launcher."));

  // ---- 1. setup
  rows.push(el("div", { class: "sub" }, "1 · Setup"));
  rows.push(...num("Bumper to wall", () => setup.bumperDistanceM / IN, (v) => { setup.bumperDistanceM = v * IN; save(); }, { unit: "in", min: 6, max: 200, step: 1 }));
  rows.push(...num("Exit height (measured)", () => setup.exitHeightM / IN, (v) => { setup.exitHeightM = v * IN; save(); }, { unit: "in", min: 1, max: 40, step: 0.1 }));
  const listInput = (label: string, get: () => number[], set: (v: number[]) => void) => {
    const i = el("input", { type: "text", value: get().join(", ") }) as HTMLInputElement;
    i.onchange = () => { const v = i.value.split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0); if (v.length) { set(v); save(); } };
    return [el("label", {}, label), i];
  };
  rows.push(...listInput("Powers to test", () => setup.powers, (v) => (setup.powers = v)));
  rows.push(...listInput("Bumper distances (in)", () => setup.bumperDistancesIn, (v) => (setup.bumperDistancesIn = v)));
  rows.push(...num("Shots per power & distance", () => setup.perSlot, (v) => { setup.perSlot = Math.max(1, Math.round(v)); save(); }, { min: 1, max: 10, step: 1 }));
  rows.push(el("div", { class: "note" }, `Exit → wall: ${inch(wallD)} in (bumper ${inch(setup.bumperDistanceM)} in + half length ${inch(st.robot.lengthM / 2)} in, exit ${inch(Math.abs(l.exitForwardM))} in ${l.exitForwardM * Math.cos((l.yawOffsetDeg * Math.PI) / 180) >= 0 ? "toward" : "away from"} the wall). Ball: ${st.ballKind.toUpperCase()}. The fitted hood angle only separates from exit speed when the geometry varies: use two bumper distances, or let weak shots land on the floor. Keep POWERS in the OpMode equal to the list here.`));

  // ---- 2. fire & measure
  rows.push(el("div", { class: "sub" }, "2 · Fire and measure"));
  const slot = nextSlot(setup, cal.shots, geom, st.robot.lengthM);
  rows.push(el("div", { class: "note full" }, slot
    ? `Next: power ${slot.power.toFixed(2)} with the bumper ${slot.bumperIn} in from the wall (shot ${slot.have + 1} of ${slot.want} there · ${slot.done} of ${slot.total} planned shots done).`
    : `Plan complete (${cal.shots.length} shots). Add more anywhere the fit looks off, or Apply.`));
  let form = ctx.form;
  if (!form) { form = { power: slot?.power ?? setup.powers[0] ?? 0.5, kind: "wall", measuredIn: 0, lateralIn: 0, bumperIn: slot?.bumperIn ?? setup.bumperDistanceM / IN }; ctx.setForm(form); }
  if (slot && Math.abs(form.bumperIn - slot.bumperIn) > 1e-6 && Math.abs(setup.bumperDistanceM / IN - slot.bumperIn) > 1e-6) {
    rows.push(el("div", { class: "note full" }, `⚠ Setup says the bumper is ${inch(setup.bumperDistanceM)} in from the wall; the plan wants ${slot.bumperIn} in next. Move the robot and update "Bumper to wall", or change the plan.`));
  }
  // inbox from the OpMode
  for (const r of cal.inbox) {
    rows.push(el("div", { class: "row full cal-inbox" },
      el("span", {}, `OpMode shot ${r.id} · power ${r.power.toFixed(2)}${r.rpm ? ` · ${Math.round(r.rpm)} rpm` : ""}${r.volts ? ` · ${r.volts.toFixed(1)} V` : ""}`),
      el("button", { onclick: () => { ctx.setForm({ ...form, power: r.power, rpm: r.rpm, srcId: r.id }); ctx.rerender(); } }, "Measure"),
      el("button", { title: "ignore this shot (mis-feed)", onclick: () => { cal.inbox.splice(cal.inbox.indexOf(r), 1); save(); } }, "×")));
  }
  if (ctx.simImpact) {
    const s = ctx.simImpact;
    rows.push(el("div", { class: "row full cal-inbox" },
      el("span", {}, `Sim ball at power ${s.power.toFixed(2)} (${Math.round(s.rpm)} rpm): ${s.kind === "wall" ? `crossed the wall plane ${inch(s.distanceM)} in out at ${inch(s.heightM)} in high` : `landed on the floor ${inch(s.distanceM)} in out`}`),
      el("button", { title: "use the simulated impact as if it were measured — handy for checking the wizard against the twin", onclick: () => {
        const shot: CalShot = { id: cal.nextId++, power: Math.round(s.power * 100) / 100, rpm: Math.round(s.rpm), distanceM: s.distanceM, kind: s.kind, measuredM: s.kind === "wall" ? s.heightM : s.distanceM, lateralM: s.lateralM, note: "sim" };
        // the OpMode announced this very shot a moment ago: take its record off the inbox
        const rec = [...cal.inbox].reverse().find((r) => Math.abs(r.power - shot.power) < 0.011);
        if (rec) { shot.note = `sim · OpMode shot ${rec.id}`; cal.inbox.splice(cal.inbox.indexOf(rec), 1); }
        cal.shots.push(shot); ctx.clearImpact(); save();
      } }, "Add as shot")));
  }
  // paste log lines
  const paste = el("textarea", { rows: 2, placeholder: "Paste Driver Station / logcat lines like: CAL shot=3 power=0.60 rpm=3412 volts=12.6", class: "full" }) as HTMLTextAreaElement;
  paste.onchange = () => { const recs = parseCalLines(paste.value); for (const r of recs) { const i = cal.inbox.findIndex((x) => x.id === r.id); if (i >= 0) cal.inbox[i] = r; else cal.inbox.push(r); } if (recs.length) { paste.value = ""; save(); } };
  rows.push(paste);

  // side-view diagram
  const canvas = el("canvas", { width: 300, height: 190, class: "cal-canvas full", title: "click on the wall to set the impact height, or near the floor to set a landing distance" }) as HTMLCanvasElement;
  const formD = exitToWallDistance(form.bumperIn * IN, geom, st.robot.lengthM);
  const view = drawSideView(canvas, { model, fit: fit.params, shots: cal.shots, wallD: formD, form, powers: Array.from(new Set([...setup.powers, ...cal.shots.map((s) => s.power)])) });
  canvas.onclick = (ev) => {
    const r = canvas.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * canvas.width, py = ((ev.clientY - r.top) / r.height) * canvas.height;
    const x = view.toWorldX(px), y = Math.max(0, view.toWorldY(py));
    if (y <= 0.2) ctx.setForm({ ...form, kind: "floor", measuredIn: Math.round((x / IN) * 10) / 10 });
    else ctx.setForm({ ...form, kind: "wall", measuredIn: Math.round((y / IN) * 10) / 10 });
    ctx.rerender();
  };
  rows.push(canvas);

  // the shot form
  rows.push(...num("Power", () => form.power, (v) => { ctx.setForm({ ...form, power: v }); ctx.rerender(); }, { min: 0.05, max: 1, step: 0.05 }));
  rows.push(...num("Measured RPM (optional)", () => form.rpm ?? 0, (v) => { ctx.setForm({ ...form, rpm: v > 0 ? v : undefined }); ctx.rerender(); }, { min: 0, max: 12000, step: 10 }));
  rows.push(...num("Bumper to wall for this shot", () => form.bumperIn, (v) => { ctx.setForm({ ...form, bumperIn: v }); ctx.rerender(); }, { unit: "in", min: 6, max: 200, step: 1 }));
  rows.push(...sel("Ball hit", [{ value: "wall", label: "the wall (enter height)" }, { value: "floor", label: "the floor first (enter distance)" }], () => form.kind, (v) => { ctx.setForm({ ...form, kind: v as any }); ctx.rerender(); }));
  rows.push(...num(form.kind === "wall" ? "Impact height" : "Landing distance from exit", () => form.measuredIn, (v) => { ctx.setForm({ ...form, measuredIn: v }); ctx.rerender(); }, { unit: "in", min: 0, max: 400, step: 0.5 }));
  rows.push(...num("Sideways offset (+ = left)", () => form.lateralIn, (v) => { ctx.setForm({ ...form, lateralIn: v }); ctx.rerender(); }, { unit: "in", min: -60, max: 60, step: 0.5 }));
  rows.push(el("div", { class: "row full" },
    el("button", { class: "primary", disabled: form.measuredIn > 0 ? undefined : "", onclick: () => {
      const shot: CalShot = { id: cal.nextId++, power: form.power, rpm: form.rpm, distanceM: exitToWallDistance(form.bumperIn * IN, geom, st.robot.lengthM), kind: form.kind, measuredM: form.measuredIn * IN, lateralM: form.lateralIn ? form.lateralIn * IN : undefined };
      if (form.srcId !== undefined) { shot.note = `OpMode shot ${form.srcId}`; const i = cal.inbox.findIndex((x) => x.id === form.srcId); if (i >= 0) cal.inbox.splice(i, 1); }
      cal.shots.push(shot);
      ctx.setForm(undefined); // next render prefills from the plan
      save();
    } }, "Add shot"),
    el("span", { class: "note" }, form.measuredIn > 0 ? `${form.kind === "wall" ? "wall" : "floor"} · ${fmt(form.measuredIn)} in · power ${form.power.toFixed(2)}` : "click the diagram or type the measurement")));

  // ---- 3. shots table
  rows.push(el("div", { class: "sub" }, `3 · Shots (${cal.shots.length})`));
  if (cal.shots.length) {
    const tbl = el("table", { class: "cal-table full" });
    tbl.append(el("tr", {}, ...["#", "power", "rpm", "dist in", "hit", "meas in", "fit in", "Δ in", ""].map((h) => el("th", {}, h))));
    cal.shots.forEach((s, i) => {
      const pred = predict(model, fit.params, s);
      const d = fit.residualsM[i] ?? pred - s.measuredM;
      tbl.append(el("tr", { title: s.note ?? "" },
        el("td", {}, String(s.id)), el("td", {}, s.power.toFixed(2)), el("td", {}, s.rpm ? String(Math.round(s.rpm)) : `~${Math.round(shotRpm(s, model.freeRpm))}`), el("td", {}, inch(s.distanceM)), el("td", {}, s.kind), el("td", {}, inch(s.measuredM)), el("td", {}, inch(pred)),
        el("td", { class: Math.abs(d) > 0.1 ? "bad" : "" }, (d >= 0 ? "+" : "") + inch(d)),
        el("td", {}, el("button", { onclick: () => { cal.shots.splice(i, 1); save(); } }, "×"))));
    });
    rows.push(tbl);
  }

  // ---- 4. fit
  rows.push(el("div", { class: "sub" }, "4 · Fit and apply"));
  rows.push(...chk("Also fit backspin (Magnus)", () => cal.fitSpin, (v) => { cal.fitSpin = v; save(); }));
  const p = fit.params, se = fit.stdErr;
  const pm = (v: number, s: number | undefined, d: number, unit = "") => `${v.toFixed(d)}${s !== undefined ? ` ± ${s.toFixed(d)}` : ""}${unit}`;
  const lines: string[] = [];
  if (fit.n) {
    lines.push(`Efficiency ${pm(p.efficiency, se.efficiency, 3)} (now ${l.efficiency.toFixed(3)})`);
    lines.push(`Hood angle ${fit.sufficiency.fitElevation ? pm(p.elevationDeg, se.elevationDeg, 1, "°") : `held at ${l.elevationDeg.toFixed(1)}°`}`);
    if (cal.fitSpin) lines.push(`Backspin ${fit.sufficiency.fitSpin ? pm(p.spinFraction, se.spinFraction, 2) : `held at ${l.spinFraction.toFixed(2)}`}`);
    lines.push(`RMS error ${inch(fit.rmsM)} in over ${fit.n} shot${fit.n > 1 ? "s" : ""} · ${fit.sufficiency.distinctDistances} distance${fit.sufficiency.distinctDistances !== 1 ? "s" : ""} · ${fit.sufficiency.distinctPowers} power level${fit.sufficiency.distinctPowers !== 1 ? "s" : ""}`);
    if (fit.rpmPerPower) lines.push(`Flywheel: ${Math.round(fit.rpmPerPower)} rpm per unit power → free speed ${Math.round(fit.rpmPerPower)} rpm (hardware map: ${model.freeRpm})`);
    if (fit.yawBiasDeg !== undefined) lines.push(`Shots land ${Math.abs(fit.yawBiasDeg).toFixed(1)}° to the ${fit.yawBiasDeg >= 0 ? "left" : "right"} of straight (launcher yaw bias)`);
  }
  for (const r of fit.sufficiency.reasons) lines.push(`• ${r}`);
  rows.push(el("pre", { class: "cal-fit full" }, lines.join("\n") || "Add shots to see the fit."));
  const applied = Math.abs(l.efficiency - p.efficiency) <= 0.0006 && (!fit.sufficiency.fitElevation || Math.abs(l.elevationDeg - p.elevationDeg) <= 0.06) && Math.abs(l.exitHeightM - setup.exitHeightM) < 1e-6;
  rows.push(el("div", { class: "row full" },
    el("button", { class: "primary", disabled: fit.n && !applied ? undefined : "", onclick: () => {
      l.efficiency = Math.round(p.efficiency * 1000) / 1000;
      if (fit.sufficiency.fitElevation) { l.elevationDeg = Math.round(p.elevationDeg * 10) / 10; if (l.elevationMinDeg === l.elevationMaxDeg) l.elevationMinDeg = l.elevationMaxDeg = l.elevationDeg; }
      if (fit.sufficiency.fitSpin) l.spinFraction = Math.round(p.spinFraction * 100) / 100;
      l.exitHeightM = setup.exitHeightM;
      if (fit.rpmPerPower) {
        const fly = st.hardware.devices.find((d) => d.kind === "motor" && d.role === "flywheel");
        if (fly) { fly.freeRpm = Math.round(fit.rpmPerPower); if (l.maxRpm < fly.freeRpm) l.maxRpm = fly.freeRpm; ctx.change("hardware"); }
      }
      ctx.change("launcher"); ctx.rerender();
    } }, applied ? "Applied ✓" : "Apply to twin"),
    el("button", { onclick: () => { const blob = new Blob([JSON.stringify(cal, null, 2)], { type: "application/json" }); const a = el("a", { href: URL.createObjectURL(blob), download: "shooter-calibration.json" }); a.click(); } }, "Export"),
    el("button", { onclick: () => { const i = el("input", { type: "file", accept: ".json" }) as HTMLInputElement; i.onchange = async () => { const f = i.files?.[0]; if (!f) return; try { const j = JSON.parse(await f.text()); if (Array.isArray(j.shots)) { st.calibration = { ...defaultCalibration(), ...j, setup: { ...defaultCalibration().setup, ...(j.setup ?? {}) } }; save(); } } catch (e) { alert(`Not a calibration file: ${e}`); } }; i.click(); } }, "Import"),
    el("button", { onclick: () => { if (cal.shots.length && !confirm(`Delete ${cal.shots.length} shots?`)) return; st.calibration = defaultCalibration(setup.exitHeightM); st.calibration.setup = { ...setup }; ctx.setForm(undefined); save(); } }, "Clear")));

  // TeamCode values from the fitted model
  if (fit.n) {
    const frame = upCellFrame({ alliance: st.alliance, upCell: st.hive[st.alliance] });
    const targetIn = aimPoint(frame).y / IN;
    const table = powerTable(model, p, [36, 48, 60, 72, 84, 96, 108, 120, 132], targetIn);
    const mid = table[Math.floor(table.length / 2)];
    const tc = {
      launchAngleDeg: Math.round(p.elevationDeg * 10) / 10,
      exitHeightIn: Math.round((setup.exitHeightM / IN) * 10) / 10,
      targetHeightIn: Math.round(targetIn * 10) / 10,
      shotRangeIn: mid?.rangeIn, shotPower: mid?.power,
      powerTable: table.map((t) => ({ rangeIn: t.rangeIn, power: t.power })),
    };
    const text = JSON.stringify(tc, null, 1).replace(/\n\s*(?=[\d"}]|\{)/g, (s0) => s0).replace(/\{\s+"rangeIn": (\d+),\s+"power": ([\d.]+)\s+\}/g, '{ "rangeIn": $1, "power": $2 }');
    const profile = ctx.link?.assets.find((a) => a.path.endsWith("robot-profile.json"));
    rows.push(el("div", { class: "note full" }, `For TeamCode's range → power model (horizontal range from the exit to the cell opening at ${fmt(targetIn)} in, descending arc, flywheel power = rpm / ${model.freeRpm}):`));
    rows.push(el("pre", { class: "cal-fit full" }, text));
    rows.push(el("div", { class: "row full" },
      el("button", { onclick: () => navigator.clipboard?.writeText(text) }, "Copy"),
      ...(profile ? [el("button", { title: `write launchAngleDeg, exitHeightIn, targetHeightIn, shotRangeIn and shotPower into the TeamCode settings overrides for ${profile.path} (sent at INIT). powerTable is an array: paste it into the asset file yourself.`, onclick: () => {
        const o = (st.assetOverrides[profile.path] ??= {});
        o["tagTracking.launchAngleDeg"] = tc.launchAngleDeg; o["tagTracking.exitHeightIn"] = tc.exitHeightIn; o["tagTracking.targetHeightIn"] = tc.targetHeightIn;
        if (tc.shotRangeIn !== undefined) { o["tagTracking.shotRangeIn"] = tc.shotRangeIn; o["tagTracking.shotPower"] = tc.shotPower; }
        ctx.change("assets"); ctx.rerender();
      } }, "Send to TeamCode settings")] : [])));
  }
  return rows;
}

/** Draw the side view: floor, wall, predicted arcs per power, measured and fitted impacts. Returns pixel↔world maps. */
function drawSideView(canvas: HTMLCanvasElement, o: { model: FlightModel; fit: Params; shots: CalShot[]; wallD: number; form: CalForm; powers: number[] }) {
  const g = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height, padL = 28, padB = 18, padT = 8, padR = 8;
  const arcs = o.powers.sort((a, b) => a - b).map((pw) => ({ pw, traj: trajectory(o.model, o.fit, pw * o.model.freeRpm, 0.004, 8) }));
  let xmax = Math.max(2.5, o.wallD + 0.4, ...o.shots.map((s) => (s.kind === "floor" ? s.measuredM : s.distanceM) + 0.4));
  let ymax = Math.max(1.6, ...o.shots.filter((s) => s.kind === "wall").map((s) => s.measuredM + 0.3));
  for (const a of arcs) for (const pt of a.traj) if (pt.x <= xmax) ymax = Math.max(ymax, pt.y + 0.2);
  xmax = Math.min(xmax, 8); ymax = Math.min(ymax, 6);
  const sx = (x: number) => padL + ((x + 0.15) / (xmax + 0.15)) * (W - padL - padR);
  const sy = (y: number) => H - padB - (y / ymax) * (H - padB - padT);
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#0d1117"; g.fillRect(0, 0, W, H);
  // grid every foot
  g.strokeStyle = "#1f262e"; g.lineWidth = 1; g.font = "9px system-ui"; g.fillStyle = "#6b7684";
  for (let ft = 0; ft * 0.3048 <= xmax; ft++) { const x = sx(ft * 0.3048); g.beginPath(); g.moveTo(x, padT); g.lineTo(x, H - padB); g.stroke(); if (ft % 2 === 0) g.fillText(`${ft * 12}`, x - 6, H - 5); }
  for (let ft = 0; ft * 0.3048 <= ymax; ft++) { const y = sy(ft * 0.3048); g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke(); g.fillText(`${ft * 12}`, 2, y + 3); }
  // floor and wall
  g.strokeStyle = "#8b949e"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(padL, sy(0)); g.lineTo(W - padR, sy(0)); g.stroke();
  g.strokeStyle = "#e0a030"; g.beginPath(); g.moveTo(sx(o.wallD), sy(0)); g.lineTo(sx(o.wallD), padT); g.stroke();
  g.fillStyle = "#e0a030"; g.fillText("wall", sx(o.wallD) + 3, padT + 9);
  // arcs
  arcs.forEach((a, i) => {
    const hue = 200 - (i / Math.max(1, arcs.length - 1)) * 160;
    g.strokeStyle = `hsl(${hue} 70% 55%)`; g.lineWidth = 1.2; g.beginPath();
    let first = true;
    for (const pt of a.traj) { if (pt.x > xmax || pt.y < 0) break; const px = sx(pt.x), py = sy(pt.y); first ? g.moveTo(px, py) : g.lineTo(px, py); first = false; }
    g.stroke();
    // label where the arc leaves the view (right edge, top or floor), where the arcs have spread apart
    const end = a.traj.find((pt) => pt.x >= xmax - 0.05 || pt.y >= ymax - 0.05 || pt.y < 0) ?? a.traj[a.traj.length - 1];
    g.fillStyle = g.strokeStyle; g.fillText(a.pw.toFixed(2), Math.min(W - 24, sx(Math.min(end.x, xmax)) - 22), Math.min(H - padB - 3, Math.max(padT + 9, sy(Math.max(0, Math.min(end.y, ymax))) + (end.y >= ymax - 0.05 ? 10 : -3))));
  });
  // exit point
  g.fillStyle = "#ff8c3a"; g.beginPath(); g.arc(sx(0), sy(o.model.exitHeightM), 3.5, 0, Math.PI * 2); g.fill();
  // measured (filled) and fitted (hollow) impacts
  for (const s of o.shots) {
    const mx = s.kind === "wall" ? s.distanceM : s.measuredM, my = s.kind === "wall" ? s.measuredM : 0;
    const pred = predict(o.model, o.fit, s);
    const px = s.kind === "wall" ? s.distanceM : pred, py = s.kind === "wall" ? Math.max(0, pred) : 0;
    g.strokeStyle = "#9ad1ff"; g.lineWidth = 1; g.beginPath(); g.moveTo(sx(mx), sy(my)); g.lineTo(sx(px), sy(py)); g.stroke();
    g.fillStyle = "#ffffff"; g.beginPath(); g.arc(sx(mx), sy(my), 3, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#9ad1ff"; g.beginPath(); g.arc(sx(px), sy(py), 3.5, 0, Math.PI * 2); g.stroke();
  }
  // the shot being entered
  if (o.form.measuredIn > 0) {
    const fx = o.form.kind === "wall" ? o.wallD : o.form.measuredIn * IN, fy = o.form.kind === "wall" ? o.form.measuredIn * IN : 0;
    g.strokeStyle = "#ffd54a"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(sx(fx) - 6, sy(fy) - 6); g.lineTo(sx(fx) + 6, sy(fy) + 6); g.moveTo(sx(fx) + 6, sy(fy) - 6); g.lineTo(sx(fx) - 6, sy(fy) + 6); g.stroke();
  }
  return { toWorldX: (px: number) => ((px - padL) / (W - padL - padR)) * (xmax + 0.15) - 0.15, toWorldY: (py: number) => ((H - padB - py) / (H - padB - padT)) * ymax };
}
