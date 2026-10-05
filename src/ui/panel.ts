/** Side panel built from plain DOM. Edits the AppState and calls onChange. */
import type { AppState } from "../state";
import { ROBOT_PRESETS, clonePreset, defaultCamera } from "../robot/presets";
import { CAMERA_PRESETS, presetById } from "../camera/cameraPresets";
import { LAUNCHER_PRESETS } from "../ballistics/launcher";
import { diagonalDeg } from "../camera/cameraMath";
import { intrinsicsFor } from "../robot/robot";

const IN = 0.0254;

type Change = (what: "robot" | "cameras" | "launcher" | "view" | "sim" | "overlays" | "reset") => void;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) (e as any)[k] = v;
    else if (v !== undefined) e.setAttribute(k, String(v));
  }
  for (const c of children) e.append(c);
  return e;
}

function num(label: string, get: () => number, set: (v: number) => void, opts: { min?: number; max?: number; step?: number; unit?: string } = {}): HTMLElement[] {
  const input = el("input", { type: "number", value: round(get()), min: opts.min, max: opts.max, step: opts.step ?? 0.1 }) as HTMLInputElement;
  input.onchange = () => { const v = parseFloat(input.value); if (!Number.isNaN(v)) set(v); };
  return [el("label", {}, opts.unit ? `${label} (${opts.unit})` : label), input];
}
function round(v: number): number { return Math.round(v * 100) / 100; }

function sel(label: string, options: { value: string; label: string }[], get: () => string, set: (v: string) => void): HTMLElement[] {
  const s = el("select") as HTMLSelectElement;
  for (const o of options) s.append(el("option", { value: o.value, selected: o.value === get() ? "" : undefined }, o.label));
  s.value = get();
  s.onchange = () => set(s.value);
  return [el("label", {}, label), s];
}

function chk(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement[] {
  const c = el("input", { type: "checkbox" }) as HTMLInputElement;
  c.checked = get();
  c.onchange = () => set(c.checked);
  return [el("label", {}, label), c];
}

function section(title: string, open: boolean, ...rows: (HTMLElement | HTMLElement[])[]): HTMLElement {
  const body = el("div", { class: "body" });
  for (const r of rows) Array.isArray(r) ? body.append(...r) : body.append(r);
  const d = el("details", open ? { open: "" } : {}, el("summary", {}, title), body);
  return d;
}

export class Panel {
  private root: HTMLElement;
  private openState = new Map<string, boolean>();
  private state: AppState;
  private onChange: Change;
  constructor(state: AppState, onChange: Change) {
    this.state = state;
    this.onChange = onChange;
    this.root = document.getElementById("panel")!;
    this.render();
  }

  toggle() { this.root.classList.toggle("hidden"); }

  render() {
    // remember open/closed
    this.root.querySelectorAll("details").forEach((d) => this.openState.set(d.querySelector("summary")!.textContent!, d.open));
    this.root.replaceChildren();
    const st = this.state;
    const open = (t: string, def: boolean) => this.openState.get(t) ?? def;
    const change = (w: Parameters<Change>[0]) => { this.onChange(w); this.render(); };
    this.root.append(el("h1", {}, "BIOBUZZ Digital Twin"));

    // --- Robot
    const r = st.robot;
    this.root.append(section("Robot", open("Robot", true),
      sel("Preset", Object.entries(ROBOT_PRESETS).map(([k, v]) => ({ value: k, label: v.name })), () => st.robotPresetId, (v) => { st.robotPresetId = v; st.robot = clonePreset(v); change("robot"); }),
      sel("Drivetrain", [{ value: "mecanum", label: "Mecanum (holonomic)" }, { value: "tank", label: "Tank / 6WD (no strafe)" }], () => r.drivetrain, (v) => { r.drivetrain = v as any; change("robot"); }),
      sel("Chassis model", [{ value: "starterbot-mecanum", label: "goBILDA StarterBot mecanum CAD" }, { value: "starterbot-6wd", label: "goBILDA StarterBot 6WD CAD" }, { value: "box", label: "Simple box" }], () => r.model, (v) => { r.model = v as any; change("robot"); }),
      num("Length", () => r.lengthM / IN, (v) => { r.lengthM = v * IN; change("robot"); }, { unit: "in", min: 6, max: 24, step: 0.5 }),
      num("Width", () => r.widthM / IN, (v) => { r.widthM = v * IN; change("robot"); }, { unit: "in", min: 6, max: 24, step: 0.5 }),
      num("Height", () => r.heightM / IN, (v) => { r.heightM = v * IN; change("robot"); }, { unit: "in", min: 4, max: 29, step: 0.5 }),
      num("Wheel RPM", () => r.wheelRpm, (v) => { r.wheelRpm = v; change("robot"); }, { min: 30, max: 1200, step: 1 }),
      num("Wheel dia", () => r.wheelDiameterM * 1000, (v) => { r.wheelDiameterM = v / 1000; change("robot"); }, { unit: "mm", min: 48, max: 160, step: 1 }),
      chk("Field-centric drive", () => st.fieldCentric, (v) => { st.fieldCentric = v; change("sim"); }),
      el("div", { class: "row full" },
        el("button", { onclick: () => { st.pose = { x: -1.2, z: 1.5, heading: 0 }; change("sim"); } }, "Reset pose"),
        el("button", { onclick: () => { st.pose = { x: 0.9 * (st.alliance === "red" ? -1 : 1), z: st.alliance === "red" ? 1.6 : -1.6, heading: st.alliance === "red" ? 0 : Math.PI }; change("sim"); } }, "To start wall"),
        el("button", { onclick: () => { st.aimRequest = true; change("sim"); } }, "Aim at target (R)"),
      ),
    ));

    // --- Cameras
    const camRows: (HTMLElement | HTMLElement[])[] = [];
    camRows.push(sel("Selected camera", r.cameras.map((c) => ({ value: c.id, label: c.name })), () => st.selectedCameraId, (v) => { st.selectedCameraId = v; change("view"); }));
    r.cameras.forEach((c, i) => {
      const intr = intrinsicsFor(c);
      camRows.push(el("div", { class: "sub" }, `${c.name}`));
      camRows.push(el("div", { class: "note" }, `${intr.width}x${intr.height} · HFOV ${(intr.hfov * 180 / Math.PI).toFixed(1)}° · VFOV ${(intr.vfov * 180 / Math.PI).toFixed(1)}° · diag ${diagonalDeg(intr).toFixed(1)}°${presetById(c.presetId).notes ? " · " + presetById(c.presetId).notes : ""}`));
      const nameInput = el("input", { type: "text", value: c.name }) as HTMLInputElement;
      nameInput.onchange = () => { c.name = nameInput.value; change("cameras"); };
      camRows.push([el("label", {}, "Name"), nameInput]);
      camRows.push(sel("Camera", CAMERA_PRESETS.map((p) => ({ value: p.id, label: p.name })), () => c.presetId, (v) => { c.presetId = v; c.diagFovDeg = undefined; c.hfovDeg = undefined; c.width = undefined; c.height = undefined; change("cameras"); }));
      camRows.push(chk("Enabled", () => c.enabled, (v) => { c.enabled = v; change("cameras"); }));
      camRows.push(num("Height", () => c.heightM / IN, (v) => { c.heightM = v * IN; change("cameras"); }, { unit: "in", min: 0, max: 29, step: 0.25 }));
      camRows.push(num("Forward offset", () => c.forwardM / IN, (v) => { c.forwardM = v * IN; change("cameras"); }, { unit: "in", min: -12, max: 12, step: 0.25 }));
      camRows.push(num("Left offset", () => c.leftM / IN, (v) => { c.leftM = v * IN; change("cameras"); }, { unit: "in", min: -12, max: 12, step: 0.25 }));
      camRows.push(num("Pitch (+down)", () => c.pitchDeg, (v) => { c.pitchDeg = v; change("cameras"); }, { unit: "°", min: -90, max: 90, step: 1 }));
      camRows.push(num("Yaw (+left)", () => c.yawDeg, (v) => { c.yawDeg = v; change("cameras"); }, { unit: "°", min: -180, max: 180, step: 1 }));
      camRows.push(num("Roll", () => c.rollDeg, (v) => { c.rollDeg = v; change("cameras"); }, { unit: "°", min: -180, max: 180, step: 1 }));
      camRows.push(num("Diag FOV override", () => c.diagFovDeg ?? diagonalDeg(intr), (v) => { c.diagFovDeg = v; c.hfovDeg = undefined; change("cameras"); }, { unit: "°", min: 20, max: 160, step: 0.5 }));
      camRows.push(num("Width", () => intr.width, (v) => { c.width = v; change("cameras"); }, { unit: "px", min: 160, max: 4096, step: 1 }));
      camRows.push(num("Height", () => intr.height, (v) => { c.height = v; change("cameras"); }, { unit: "px", min: 120, max: 3072, step: 1 }));
      camRows.push(el("div", { class: "row full" },
        el("button", { onclick: () => { r.cameras.splice(i, 1); if (st.selectedCameraId === c.id) st.selectedCameraId = r.cameras[0]?.id ?? ""; change("cameras"); } }, "Remove"),
      ));
    });
    camRows.push(el("div", { class: "row full" }, el("button", { class: "primary", onclick: () => { const id = `cam${Date.now() % 100000}`; const c = defaultCamera(id); c.name = `Camera ${r.cameras.length + 1}`; r.cameras.push(c); st.selectedCameraId = id; change("cameras"); } }, "+ Add camera")));
    this.root.append(section("Cameras", open("Cameras", true), ...camRows));

    // --- Launcher
    const l = r.launcher;
    this.root.append(section("Launcher", open("Launcher", true),
      sel("Preset", Object.entries(LAUNCHER_PRESETS).map(([k, v]) => ({ value: k, label: v.name })), () => Object.entries(LAUNCHER_PRESETS).find(([, v]) => v.name === l.name)?.[0] ?? "custom", (v) => { r.launcher = { ...LAUNCHER_PRESETS[v] }; change("launcher"); }),
      sel("Ball", [{ value: "pollen", label: "POLLEN (2.8 in, 25 g)" }, { value: "nectar", label: "NECTAR (3.6 in, 41 g)" }], () => st.ballKind, (v) => { st.ballKind = v as any; change("launcher"); }),
      num("Flywheel dia", () => l.wheelDiameterM * 1000, (v) => { l.wheelDiameterM = v / 1000; change("launcher"); }, { unit: "mm", min: 40, max: 200, step: 1 }),
      num("Max RPM", () => l.maxRpm, (v) => { l.maxRpm = v; change("launcher"); }, { min: 100, max: 12000, step: 10 }),
      num("Efficiency", () => l.efficiency, (v) => { l.efficiency = v; change("launcher"); }, { min: 0.1, max: 1, step: 0.01 }),
      num("Commanded RPM", () => l.rpm, (v) => { l.rpm = v; change("launcher"); }, { min: 0, max: 12000, step: 10 }),
      num("Hood angle", () => l.elevationDeg, (v) => { l.elevationDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 89, step: 0.5 }),
      num("Hood min", () => l.elevationMinDeg, (v) => { l.elevationMinDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 89, step: 0.5 }),
      num("Hood max", () => l.elevationMaxDeg, (v) => { l.elevationMaxDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 89, step: 0.5 }),
      num("Exit height", () => l.exitHeightM / IN, (v) => { l.exitHeightM = v * IN; change("launcher"); }, { unit: "in", min: 1, max: 29, step: 0.25 }),
      num("Exit forward", () => l.exitForwardM / IN, (v) => { l.exitForwardM = v * IN; change("launcher"); }, { unit: "in", min: -12, max: 12, step: 0.25 }),
      num("Exit left", () => l.exitLeftM / IN, (v) => { l.exitLeftM = v * IN; change("launcher"); }, { unit: "in", min: -12, max: 12, step: 0.25 }),
      num("Turret min", () => l.turretMinDeg, (v) => { l.turretMinDeg = v; change("launcher"); }, { unit: "°", min: -180, max: 0, step: 1 }),
      num("Turret max", () => l.turretMaxDeg, (v) => { l.turretMaxDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 180, step: 1 }),
      num("Backspin fraction", () => l.spinFraction, (v) => { l.spinFraction = v; change("launcher"); }, { min: 0, max: 1, step: 0.05 }),
      chk("Auto-RPM to target", () => st.autoRpm, (v) => { st.autoRpm = v; change("launcher"); }),
      chk("Auto-hood to best angle", () => st.autoHood, (v) => { st.autoHood = v; change("launcher"); }),
      chk("Air drag (Cd 0.45)", () => st.drag, (v) => { st.drag = v; change("launcher"); }),
      el("div", { class: "note" }, "Exit speed = efficiency x flywheel surface speed. Measure a few shots on your robot and tune efficiency until the sim matches."),
    ));

    // --- Match / target
    this.root.append(section("Field & target", open("Field & target", true),
      sel("Our alliance", [{ value: "red", label: "Red (left of audience)" }, { value: "blue", label: "Blue" }], () => st.alliance, (v) => { st.alliance = v as any; change("sim"); }),
      sel("Red hive up cell", [{ value: "audience", label: "Audience side (match start)" }, { value: "scoring", label: "Scoring side" }], () => st.hive.red, (v) => { st.hive.red = v as any; change("sim"); }),
      sel("Blue hive up cell", [{ value: "scoring", label: "Scoring side (match start)" }, { value: "audience", label: "Audience side" }], () => st.hive.blue, (v) => { st.hive.blue = v as any; change("sim"); }),
      chk("Simulated other robots", () => st.opponents, (v) => { st.opponents = v; change("sim"); }),
      chk("Pause other robots", () => st.pauseOpponents, (v) => { st.pauseOpponents = v; change("sim"); }),
    ));

    // --- View / overlays
    const o = st.overlays;
    this.root.append(section("View & overlays", open("View & overlays", false),
      sel("Main view", [{ value: "orbit", label: "Orbit (1)" }, { value: "top", label: "Top-down (2)" }, { value: "chase", label: "Chase (3)" }, { value: "robot", label: "Robot camera (4)" }], () => st.view, (v) => { st.view = v as any; change("view"); }),
      chk("Robot camera inset", () => st.pip, (v) => { st.pip = v; change("view"); }),
      chk("Trajectory", () => o.trajectory, (v) => { o.trajectory = v; change("overlays"); }),
      chk("Feasible-angle fan", () => o.fan, (v) => { o.fan = v; change("overlays"); }),
      chk("FOV footprint on mat", () => o.footprint, (v) => { o.footprint = v; change("overlays"); }),
      chk("Camera frustum", () => o.frustum, (v) => { o.frustum = v; change("overlays"); }),
      chk("Target opening", () => o.target, (v) => { o.target = v; change("overlays"); }),
      chk("Aim line", () => o.aim, (v) => { o.aim = v; change("overlays"); }),
      chk("Reachability map (RPM by position)", () => o.reach, (v) => { o.reach = v; change("overlays"); }),
      el("div", { class: "note" }, "Reachability colours the mat by the flywheel RPM needed to hit the target cell from each 6 in square with the current launcher (green = low, red = near max, dark = cannot reach). Recomputed when launcher or target change."),
      el("div", { class: "row full" },
        el("button", { onclick: () => { const blob = new Blob([JSON.stringify(st, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "biobuzz-twin-config.json"; a.click(); } }, "Export JSON"),
        el("button", { onclick: () => { const i = document.createElement("input"); i.type = "file"; i.accept = "application/json"; i.onchange = async () => { const f = i.files?.[0]; if (!f) return; Object.assign(st, JSON.parse(await f.text())); change("reset"); }; i.click(); } }, "Import JSON"),
        el("button", { onclick: () => { localStorage.removeItem("biobuzz-twin"); location.reload(); } }, "Factory reset"),
      ),
    ));
  }
}
