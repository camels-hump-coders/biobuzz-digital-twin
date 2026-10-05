/** Side panel built from plain DOM. Edits the AppState and calls onChange. */
import type { AppState } from "../state";
import { ROBOT_PRESETS, clonePreset, defaultCamera } from "../robot/presets";
import { CAMERA_PRESETS, presetById } from "../camera/cameraPresets";
import { LAUNCHER_PRESETS } from "../ballistics/launcher";
import { diagonalDeg } from "../camera/cameraMath";
import { intrinsicsFor } from "../robot/robot";
import type { RuntimeLink } from "../runtime/link";
import { MOTOR_ROLES, SERVO_ROLES, defaultHardwareConfig, camelsHumpHardwareConfig, type DeviceKind } from "../runtime/hardwareConfig";

const IN = 0.0254;

type Change = (what: "robot" | "cameras" | "launcher" | "view" | "sim" | "overlays" | "reset" | "runtime" | "hardware") => void;

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
  link?: RuntimeLink;
  private telemetryEl?: HTMLElement;
  constructor(state: AppState, onChange: Change) {
    this.state = state;
    this.onChange = onChange;
    this.root = document.getElementById("panel")!;
    this.render();
  }

  toggle() { this.root.classList.toggle("hidden"); }
  selectedOpMode = "";
  /** cheap per-frame refresh of the telemetry box without re-rendering the panel */
  updateTelemetry(lines: string[], status: string) {
    if (this.telemetryEl) { const t = lines.join("\n") || "(telemetry)"; if (this.telemetryEl.textContent !== t) this.telemetryEl.textContent = t; }
    const s = this.root.querySelector("#rt-status"); if (s && !s.textContent!.endsWith(status)) s.textContent = `Status: ${status}`;
  }

  render() {
    // remember open/closed
    this.root.querySelectorAll("details").forEach((d) => this.openState.set(d.querySelector("summary")!.textContent!, d.open));
    this.root.replaceChildren();
    const st = this.state;
    const open = (t: string, def: boolean) => this.openState.get(t) ?? def;
    const change = (w: Parameters<Change>[0]) => { this.onChange(w); this.render(); };
    this.root.append(el("h1", {}, "BIOBUZZ Digital Twin"));

    // --- Runtime (TeamCode)
    const link = this.link;
    const rtRows: (HTMLElement | HTMLElement[])[] = [];
    rtRows.push(chk("Connect to runtime host", () => st.runtimeEnabled, (v) => { st.runtimeEnabled = v; change("runtime"); }));
    const urlInput = el("input", { type: "text", value: st.runtimeUrl }) as HTMLInputElement;
    urlInput.onchange = () => { st.runtimeUrl = urlInput.value; change("runtime"); };
    rtRows.push([el("label", {}, "Host URL"), urlInput]);
    const statusTxt = link ? (link.connected ? `${link.status}${link.currentOpMode ? " · " + link.currentOpMode : ""}` : "not connected — run ./gradlew :host:run in runtime/") : "off";
    rtRows.push(el("div", { class: "note", id: "rt-status" }, `Status: ${statusTxt}`));
    if (link?.connected) {
      const names = link.opModes.map((o) => ({ value: o.name, label: `[${o.flavor}] ${o.name}` }));
      if (!names.length) rtRows.push(el("div", { class: "note" }, "No OpModes found on the host classpath."));
      else {
        if (!names.some((n) => n.value === this.selectedOpMode)) this.selectedOpMode = names[0].value;
        rtRows.push(sel("OpMode", names, () => this.selectedOpMode, (v) => { this.selectedOpMode = v; }));
        rtRows.push(el("div", { class: "row full" },
          el("button", { class: "primary", onclick: () => link.init(this.selectedOpMode) }, "INIT"),
          el("button", { class: "primary", onclick: () => link.start() }, "▶ START"),
          el("button", { onclick: () => link.stop() }, "■ STOP"),
        ));
      }
      if (link.statusError) rtRows.push(el("pre", { class: "note full", style: "white-space:pre-wrap;color:#ff8888" }, link.statusError));
      for (const n of link.notes) rtRows.push(el("div", { class: "note full", style: "color:#f2c200" }, n));
      rtRows.push(el("div", { class: "note full" }, `Hardware map: ${st.hardware.devices.length} devices (${st.hardware.devices.map((d) => d.name).join(", ")}). Names must match your hardwareMap.get() calls; see the Hardware map panel for presets.`));
      this.telemetryEl = el("pre", { class: "full", style: "margin:0;white-space:pre-wrap;font-size:11px;background:#0b0e13;border:1px solid #2a313a;border-radius:4px;padding:6px;min-height:60px;max-height:220px;overflow:auto" }, link.telemetry.join("\n") || "(telemetry)");
      rtRows.push(this.telemetryEl);
    }
    rtRows.push(el("div", { class: "note" }, "While an OpMode is running, its motor and servo commands drive the robot; the keyboard acts as gamepad1 (WASD left stick, Q/E right stick, Space = A, B/X/Y buttons, Shift = right trigger, Ctrl = left trigger, Z/C = bumpers, G = Home/guide (goBILDA logo button), Enter = Start, Backspace = Back, V/N = stick clicks, arrows = dpad). Plug in a gamepad to use it instead."));
    this.root.append(section("Runtime — run your TeamCode", open("Runtime — run your TeamCode", true), ...rtRows));

    // --- Hardware map
    const hw = st.hardware;
    const hwRows: (HTMLElement | HTMLElement[])[] = [];
    hwRows.push(el("div", { class: "note" }, "Names must match what your OpMode passes to hardwareMap.get(). Roles tell the sim what each device moves."));
    hwRows.push(sel("Mirrored drive side", [{ value: "left", label: "Left motors mirrored (code reverses left)" }, { value: "right", label: "Right motors mirrored (code reverses right)" }, { value: "none", label: "None (positive power = forward on all)" }], () => hw.mirroredSide ?? "left", (v) => { hw.mirroredSide = v as any; change("hardware"); }));
    hw.devices.forEach((d, i) => {
      const nameIn = el("input", { type: "text", value: d.name }) as HTMLInputElement;
      nameIn.onchange = () => { d.name = nameIn.value; change("hardware"); };
      hwRows.push([el("label", {}, d.kind), nameIn]);
      if (d.kind === "motor" || d.kind === "servo" || d.kind === "crservo") hwRows.push(num("port", () => d.port ?? 0, (v) => { d.port = Math.round(v); change("hardware"); }, { min: 0, max: 5, step: 1 }));
      if (d.kind === "motor") {
        hwRows.push(sel("role", MOTOR_ROLES.map((r) => ({ value: r, label: r })), () => d.role ?? "other", (v) => { d.role = v as any; change("hardware"); }));
        hwRows.push(num("ticks/rev", () => d.ticksPerRev ?? 537.7, (v) => { d.ticksPerRev = v; change("hardware"); }, { min: 1, max: 10000, step: 0.1 }));
        hwRows.push(num("free RPM", () => d.freeRpm ?? 312, (v) => { d.freeRpm = v; change("hardware"); }, { min: 10, max: 12000, step: 1 }));
      } else if (d.kind === "servo" || d.kind === "crservo") {
        hwRows.push(sel("role", SERVO_ROLES.map((r) => ({ value: r, label: r })), () => d.role ?? "other", (v) => { d.role = v as any; change("hardware"); }));
        if (d.role === "feeder") hwRows.push(num(d.kind === "crservo" ? "fire when |power| ≥" : "fire at position ≥", () => d.fireThreshold ?? 0.5, (v) => { d.fireThreshold = v; change("hardware"); }, { min: 0, max: 1, step: 0.05 }));
      } else if (d.kind === "webcam") {
        hwRows.push(sel("camera mount", st.robot.cameras.map((c) => ({ value: c.id, label: c.name })), () => d.cameraId ?? st.robot.cameras[0]?.id ?? "", (v) => { d.cameraId = v; change("hardware"); }));
      }
      hwRows.push(el("div", { class: "row full" }, el("button", { onclick: () => { hw.devices.splice(i, 1); change("hardware"); } }, "Remove")));
    });
    const addDev = (kind: DeviceKind) => { hw.devices.push({ name: `${kind}${hw.devices.length + 1}`, kind, ...(kind === "motor" ? { role: "other" as const, ticksPerRev: 537.7, freeRpm: 312 } : {}), ...(kind === "servo" ? { role: "other" as const } : {}) }); change("hardware"); };
    hwRows.push(el("div", { class: "row full" },
      el("button", { onclick: () => addDev("motor") }, "+ motor"), el("button", { onclick: () => addDev("servo") }, "+ servo"), el("button", { onclick: () => addDev("crservo") }, "+ CR servo"),
      el("button", { onclick: () => addDev("distance") }, "+ distance"), el("button", { onclick: () => addDev("webcam") }, "+ webcam"),
    ));
    hwRows.push(el("div", { class: "row full" }, el("button", { onclick: () => { st.hardware = defaultHardwareConfig(); change("hardware"); } }, "StarterBot names"), el("button", { onclick: () => { st.hardware = camelsHumpHardwareConfig(); st.robot.drivetrain = "tank"; change("hardware"); change("robot"); } }, "Camels Hump tank bot names")));
    hwRows.push(num("AprilTag noise (1σ)", () => st.tagNoiseIn, (v) => { st.tagNoiseIn = v; change("hardware"); }, { unit: "in", min: 0, max: 5, step: 0.1 }));
    this.root.append(section("Hardware map", open("Hardware map", false), ...hwRows));

    // --- Robot
    const r = st.robot;
    this.root.append(section("Robot", open("Robot", true),
      sel("Preset", Object.entries(ROBOT_PRESETS).map(([k, v]) => ({ value: k, label: v.name })), () => st.robotPresetId, (v) => { st.robotPresetId = v; st.robot = clonePreset(v); change("robot"); }),
      sel("Drivetrain", [{ value: "mecanum", label: "Mecanum (holonomic)" }, { value: "tank", label: "Tank / 6WD (no strafe)" }], () => r.drivetrain, (v) => { r.drivetrain = v as any; change("robot"); }),
      sel("Chassis model", [{ value: "starterbot-mecanum", label: "goBILDA StarterBot mecanum CAD" }, { value: "starterbot-6wd", label: "goBILDA StarterBot 6WD CAD" }, { value: "box", label: "Simple box" }], () => r.model, (v) => { r.model = v as any; change("robot"); }),
      num("CAD yaw", () => r.modelYawDeg ?? 0, (v) => { r.modelYawDeg = v; change("robot"); }, { unit: "°", min: -180, max: 180, step: 90 }),
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
      el("div", { class: "row full" },
        el("button", { title: "Rotate everything attached to the chassis by 180° so the other end is forward: CAD, cameras, launcher. The robot does not move.", onclick: () => {
          r.modelYawDeg = (((r.modelYawDeg ?? 0) + 180 + 180) % 360) - 180;
          for (const c of r.cameras) { c.forwardM = -c.forwardM; c.leftM = -c.leftM; c.yawDeg = ((c.yawDeg + 180 + 180) % 360) - 180; }
          const l = r.launcher; l.exitForwardM = -l.exitForwardM; l.exitLeftM = -l.exitLeftM; l.yawOffsetDeg = ((l.yawOffsetDeg + 180 + 180) % 360) - 180;
          st.pose = { ...st.pose, heading: st.pose.heading + Math.PI };
          change("robot");
        } }, "Flip forward direction (180°)"),
        el("span", { class: "note" }, "Makes the other end of the robot the forward arrow (drive code's +forward). Cameras and launcher come along, so a shooter-forward robot is one click."),
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
    const addCam = (name: string, yaw: number, fwdIn: number) => { const id = `cam${Date.now() % 100000}`; const c = defaultCamera(id); c.name = name; c.yawDeg = yaw; c.forwardM = fwdIn * IN; r.cameras.push(c); st.selectedCameraId = id; change("cameras"); };
    const MAX_CAMERAS = 2; // FTC allows at most two cameras on the robot
    const full = r.cameras.length >= MAX_CAMERAS;
    const dis = full ? { disabled: "" } : {};
    camRows.push(el("div", { class: "row full" },
      el("button", { class: "primary", ...dis, onclick: () => addCam(`Camera ${r.cameras.length + 1}`, 0, 7) }, "+ Front camera"),
      el("button", { class: "primary", ...dis, onclick: () => addCam("Rear camera", 180, -7) }, "+ Rear camera"),
      el("button", { ...dis, onclick: () => addCam("Left camera", 90, 0) }, "+ Left"),
      el("button", { ...dis, onclick: () => addCam("Right camera", -90, 0) }, "+ Right"),
    ));
    if (full) camRows.push(el("div", { class: "note" }, "FTC rules allow a maximum of two cameras; remove one to add another."));
    camRows.push(el("div", { class: "note" }, "Drag a camera's green body on the robot to move it (orbit view). Hold Alt while dragging to change height. Then fine-tune the numbers above."));
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
      num("Launcher yaw", () => l.yawOffsetDeg, (v) => { l.yawOffsetDeg = v; change("launcher"); }, { unit: "°", min: -180, max: 180, step: 5 }),
      el("div", { class: "note" }, "Launcher yaw is the fixed direction the shooter points relative to the robot's forward arrow (180 = fires out the back, like the StarterBot ramp). Drag the orange exit marker on the robot to move it; Alt-drag for height. It is hidden from the camera views."),
      num("Turret min", () => l.turretMinDeg, (v) => { l.turretMinDeg = v; change("launcher"); }, { unit: "°", min: -180, max: 0, step: 1 }),
      num("Turret max", () => l.turretMaxDeg, (v) => { l.turretMaxDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 180, step: 1 }),
      num("Backspin fraction", () => l.spinFraction, (v) => { l.spinFraction = v; change("launcher"); }, { min: 0, max: 1, step: 0.05 }),
      chk("Auto-RPM to target", () => st.autoRpm, (v) => { st.autoRpm = v; change("launcher"); }),
      chk("Auto-hood to best angle", () => st.autoHood, (v) => { st.autoHood = v; change("launcher"); }),
      chk("Air drag (Cd 0.45)", () => st.drag, (v) => { st.drag = v; change("launcher"); }),
      el("div", { class: "sub" }, "Shot variability (1-sigma)"),
      num("Speed error", () => st.noise.speedFrac * 100, (v) => { st.noise.speedFrac = v / 100; change("launcher"); }, { unit: "%", min: 0, max: 30, step: 0.5 }),
      num("Elevation error", () => st.noise.elevationDeg, (v) => { st.noise.elevationDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 15, step: 0.1 }),
      num("Yaw error", () => st.noise.yawDeg, (v) => { st.noise.yawDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 15, step: 0.1 }),
      num("Spin variation", () => st.noise.spinFrac * 100, (v) => { st.noise.spinFrac = v / 100; change("launcher"); }, { unit: "%", min: 0, max: 100, step: 5 }),
      num("Monte Carlo shots", () => st.monteCarloN, (v) => { st.monteCarloN = Math.round(v); change("launcher"); }, { min: 20, max: 1000, step: 10 }),
      el("div", { class: "note" }, "Each fired ball gets a random draw from these. The HUD hit probability and the dot cloud on the opening plane come from re-simulating this many perturbed shots along the direction the launcher points right now."),
      el("div", { class: "note" }, "Exit speed = efficiency x flywheel surface speed. Measure a few shots on your robot and tune efficiency until the sim matches."),
    ));

    // --- Match / target
    this.root.append(section("Field & target", open("Field & target", true),
      sel("Our alliance", [{ value: "red", label: "Red (left of audience)" }, { value: "blue", label: "Blue" }], () => st.alliance, (v) => { st.alliance = v as any; change("sim"); }),
      sel("Red hive up cell", [{ value: "audience", label: "Audience side (match start)" }, { value: "scoring", label: "Scoring side" }], () => st.hive.red, (v) => { st.hive.red = v as any; change("sim"); }),
      sel("Blue hive up cell", [{ value: "scoring", label: "Scoring side (match start)" }, { value: "audience", label: "Audience side" }], () => st.hive.blue, (v) => { st.hive.blue = v as any; change("sim"); }),
      chk("Hives tip when loaded", () => st.autoTip, (v) => { st.autoTip = v; change("sim"); }),
      num("Tip load", () => st.tipMassG, (v) => { st.tipMassG = v; change("sim"); }, { unit: "g", min: 50, max: 600, step: 1 }),
      el("div", { class: "note" }, "Field staff calibrate each cell to tip at 8 POLLEN or 3 NECTAR + 3 POLLEN (198.6 g, so the default threshold is 195 g). The up cell starts with 3 NECTAR, so three POLLEN in tips it. A heavier load tips faster. When it tips the contents fall out and the other cell comes up, facing the other way, so you must move to keep scoring. T or the selectors above reset the hive to match start."),
      chk("Simulated other robots", () => st.opponents, (v) => { st.opponents = v; change("sim"); }),
      chk("They collect and score", () => st.opponentsScore, (v) => { st.opponentsScore = v; change("sim"); }),
      chk("Pause other robots", () => st.pauseOpponents, (v) => { st.pauseOpponents = v; change("sim"); }),
      el("div", { class: "sub" }, "Game pieces"),
      num("Robot capacity", () => st.capacity, (v) => { st.capacity = Math.round(v); change("sim"); }, { min: 1, max: 8, step: 1 }),
      chk("Can intake POLLEN", () => st.canPollen, (v) => { st.canPollen = v; change("sim"); }),
      chk("Can intake NECTAR", () => st.canNectar, (v) => { st.canNectar = v; change("sim"); }),
      el("div", { class: "note" }, "Match start: 4 POLLEN preloaded, 4 in each FLOWER, 4 in each GARDEN, 3 NECTAR in each raised cell, 5 NECTAR per alliance in reserve (one enters the LOADING ZONE after each tip). Drive the intake end onto a ball or up to a FLOWER's retrieval opening to pick up; you can only launch what you carry. Keyboard driving always runs the intake; under TeamCode the intake motor must be powered."),
      el("div", { class: "row full" }, el("button", { class: "primary", onclick: () => { st.resetMatchRequest = true; change("sim"); } }, "Reset match to start")),
    ));

    // --- View / overlays
    const o = st.overlays;
    this.root.append(section("View & overlays", open("View & overlays", false),
      sel("Main view", [{ value: "orbit", label: "Orbit (1)" }, { value: "top", label: "Top-down (2)" }, { value: "chase", label: "Chase (3)" }, { value: "robot", label: "Robot camera (4)" }], () => st.view, (v) => { st.view = v as any; change("view"); }),
      chk("Camera insets (all cameras)", () => st.pip, (v) => { st.pip = v; change("view"); }),
      chk("Arc if aimed at target (green/red)", () => o.trajectory, (v) => { o.trajectory = v; change("overlays"); }),
      chk("Arc as launcher points now (orange)", () => o.actualArc, (v) => { o.actualArc = v; change("overlays"); }),
      chk("Dispersion cloud", () => o.dispersion, (v) => { o.dispersion = v; change("overlays"); }),
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
