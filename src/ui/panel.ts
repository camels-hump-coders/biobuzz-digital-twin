/** Side panel built from plain DOM. Edits the AppState and calls onChange. */
import type { AppState } from "../state";
import { ROBOT_PRESETS, clonePreset, defaultCamera } from "../robot/presets";
import { CAMERA_PRESETS, presetById } from "../camera/cameraPresets";
import { LAUNCHER_PRESETS } from "../ballistics/launcher";
import { diagonalDeg } from "../camera/cameraMath";
import { intrinsicsFor } from "../robot/robot";
import type { RuntimeLink } from "../runtime/link";
import { START_LABELS, defaultStarts, startPose, type StartKey } from "../sim/starts";
import { twinKnobs } from "../runtime/bindings";
import type { Recorder } from "../runtime/recorder";
import { applyOverrides, downloadText, exportChangedAssets, guessAssetFor, parsePastedSettings } from "../runtime/assetExport";
import { calibrationRows, type CalForm, type SimImpactLike } from "./calibration";
import type { FitResult } from "../ballistics/calibration";
import { MOTOR_ROLES, SERVO_ROLES, defaultHardwareConfig, camelsHumpHardwareConfig, type DeviceKind } from "../runtime/hardwareConfig";

const IN = 0.0254;

export type Change = (what: "robot" | "cameras" | "launcher" | "view" | "sim" | "overlays" | "reset" | "runtime" | "hardware" | "assets" | "calibration") => void;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) (e as any)[k] = v;
    else if (v !== undefined) e.setAttribute(k, String(v));
  }
  for (const c of children) e.append(c);
  return e;
}

export function num(label: string, get: () => number, set: (v: number) => void, opts: { min?: number; max?: number; step?: number; unit?: string } = {}): HTMLElement[] {
  const input = el("input", { type: "number", value: round(get()), min: opts.min, max: opts.max, step: opts.step ?? 0.1 }) as HTMLInputElement;
  input.onchange = () => { const v = parseFloat(input.value); if (!Number.isNaN(v)) set(v); };
  return [el("label", {}, opts.unit ? `${label} (${opts.unit})` : label), input];
}
function round(v: number): number { return Math.round(v * 100) / 100; }

export function sel(label: string, options: { value: string; label: string }[], get: () => string, set: (v: string) => void): HTMLElement[] {
  const s = el("select") as HTMLSelectElement;
  for (const o of options) s.append(el("option", { value: o.value, selected: o.value === get() ? "" : undefined }, o.label));
  s.value = get();
  s.onchange = () => set(s.value);
  return [el("label", {}, label), s];
}

export function chk(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement[] {
  const c = el("input", { type: "checkbox" }) as HTMLInputElement;
  c.checked = get();
  c.onchange = () => set(c.checked);
  return [el("label", {}, label), c];
}

type Row = HTMLElement | HTMLElement[];
/** A group of rows hidden in Essential mode until the section's "more" button or the global toggle reveals them. */
interface AdvGroup { adv: Row[] }
function adv(...rows: Row[]): AdvGroup {
  for (const r of rows) for (const e of Array.isArray(r) ? r : [r]) e.classList.add("adv");
  return { adv: rows };
}
const isAdv = (r: unknown): r is AdvGroup => !!r && typeof r === "object" && !Array.isArray(r) && !(r instanceof HTMLElement) && "adv" in (r as object);
/** Set by render() so section() knows which advanced rows to show. */
let sectionCtx: { advanced: boolean; more: Set<string>; toggle: (title: string) => void } = { advanced: true, more: new Set(), toggle: () => {} };
function section(title: string, open: boolean, ...rows: (Row | AdvGroup)[]): HTMLElement {
  const body = el("div", { class: "body" });
  for (const r of rows) {
    const list: Row[] = isAdv(r) ? r.adv : [r];
    for (const x of list) Array.isArray(x) ? body.append(...x) : body.append(x);
  }
  // count rows, not elements: a label+input pair is one setting
  const nAdv = [...body.querySelectorAll(":scope > .adv")].filter((e) => !["INPUT", "SELECT", "TEXTAREA"].includes(e.tagName)).length;
  const expanded = sectionCtx.advanced || sectionCtx.more.has(title);
  if (nAdv && !expanded) body.classList.add("adv-hidden");
  if (nAdv && !sectionCtx.advanced) {
    body.append(el("button", { class: "more full", onclick: () => sectionCtx.toggle(title) }, expanded ? "Fewer settings" : `Show ${nAdv} more setting${nAdv > 1 ? "s" : ""}…`));
  }
  const d = el("details", open ? { open: "" } : {}, el("summary", {}, title), body);
  return d;
}

export class Panel {
  private root: HTMLElement;
  private openState = new Map<string, boolean>();
  private state: AppState;
  private onChange: Change;
  link?: RuntimeLink;
  /** timeline recorder and the context block for snapshots (set by main) */
  recorder?: Recorder;
  snapshotContext: () => Record<string, unknown> = () => ({});
  private timelineEl?: HTMLElement;
  private telemetryEl?: HTMLElement;
  private pillEl?: HTMLElement;
  constructor(state: AppState, onChange: Change) {
    this.state = state;
    this.onChange = onChange;
    this.root = document.getElementById("panel")!;
    this.render();
  }

  toggle() { this.root.classList.toggle("hidden"); }
  selectedOpMode = "";
  /** TeamCode settings panel: search text and which files are expanded */
  private assetFilter = "";
  private assetOpen = new Map<string, boolean>();
  /** sections whose advanced rows were revealed with their "more" button (Essential mode) */
  private moreOpen = new Set<string>();
  /** cheap per-frame refresh of the telemetry box without re-rendering the panel */
  /** shooter calibration wizard: the shot being typed, the cached fit and the last simulated impact */
  private calForm: CalForm | undefined;
  private calCache: { key: string; fit: FitResult } | undefined;
  private calImpact: SimImpactLike | undefined;
  renderCalibrationImpact(impact: SimImpactLike) {
    this.calImpact = impact;
    if (this.openState.get("Shooter calibration")) this.render();
  }
  updateTelemetry(lines: string[], status: string) {
    const rec = this.recorder;
    if (this.telemetryEl) {
      // scrubbed back in time: show that moment's telemetry instead of the live stream
      const hist = rec?.cursor !== undefined ? rec.at(rec.cursor) : undefined;
      const t = hist ? `⏪ ${((Date.now() - hist.t) / 1000).toFixed(1)} s ago · ${hist.status}${hist.opMode ? " " + hist.opMode : ""}\n` + (hist.telemetry.join("\n") || "(no telemetry)") : (lines.join("\n") || "(telemetry)");
      if (this.telemetryEl.textContent !== t) this.telemetryEl.textContent = t;
      this.telemetryEl.classList.toggle("rewind", !!hist);
    }
    this.refreshTimeline();
    const s = this.root.querySelector("#rt-status"); if (s && !s.textContent!.endsWith(status)) s.textContent = `Status: ${status}`;
    if (this.pillEl && this.link) {
      const t = this.pillEl.querySelector(".time");
      const secs = Math.max(0, (performance.now() - this.link.statusSince) / 1000);
      const txt = this.link.status === "RUNNING" || this.link.status === "INIT" ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}` : "";
      if (t && t.textContent !== txt) t.textContent = txt;
    }
  }

  /** Live refresh of the timeline section (slider range, event list) without re-rendering the whole panel. */
  /** which span the run slider covers */
  tlScope: "run" | "all" = "run";
  private tlPlay?: number;
  refreshTimeline() {
    const rec = this.recorder, box = this.timelineEl;
    if (!rec || !box) return;
    const slider = box.querySelector("input[type=range]") as HTMLInputElement | null;
    const label = box.querySelector(".tl-pos") as HTMLElement | null;
    const list = box.querySelector(".tl-events") as HTMLElement | null;
    const run = rec.latestRun();
    const start = this.tlScope === "run" && run ? run.start : rec.start, end = this.tlScope === "run" && run && run.end !== undefined ? run.end : rec.end;
    if (slider && start !== undefined && end !== undefined) {
      slider.min = String(start); slider.max = String(end);
      if (rec.cursor === undefined) slider.value = String(end); else slider.value = String(Math.max(start, Math.min(end, rec.cursor)));
      const shown = rec.cursor ?? end;
      const inRun = rec.runAt(shown);
      if (label) label.textContent = rec.cursor === undefined
        ? `LIVE · ${run ? `last run ${run.opMode || "keyboard match"} · ${(((run.end ?? rec.end ?? shown) - run.start) / 1000).toFixed(0)} s${run.end === undefined ? " (running)" : ""}` : `${((end - start) / 1000).toFixed(0)} s recorded, no run yet`}`
        : `⏪ ${inRun ? `run +${((shown - inRun.start) / 1000).toFixed(1)} s · ` : ""}${(((rec.end ?? shown) - shown) / 1000).toFixed(1)} s ago (${new Date(shown).toLocaleTimeString()}) · live sim paused`;
    }
    const scopeBtns = box.querySelectorAll(".tl-scope button");
    scopeBtns.forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.scope === this.tlScope));
    if (list) {
      const recent = rec.events.slice(-40).reverse();
      const key = recent.map((e) => e.t + e.text).join("|");
      if ((list as any).__key !== key) {
        (list as any).__key = key;
        list.replaceChildren(...recent.map((e) => el("div", { class: `tl-ev ${e.kind}`, title: new Date(e.t).toLocaleTimeString() + (e.text.includes("\n") ? "\n" + e.text : ""), onclick: () => { rec.cursor = e.t; this.refreshTimeline(); this.updateTelemetry(this.link?.telemetry ?? [], this.link?.status ?? ""); } },
          el("span", { class: "tl-t" }, end !== undefined ? `-${((end - e.t) / 1000).toFixed(1)}s` : ""), el("span", { class: "tl-k" }, e.kind), e.text.split("\n")[0] + (e.text.includes("\n") ? ` (+${e.text.split("\n").length - 1} lines)` : ""))));
        if (!recent.length) list.append(el("div", { class: "note" }, "Events (status changes, button presses, shots, host log lines, errors, fouls) appear here as they happen. Click one to jump to it."));
      }
    }
  }

  render() {
    // remember open/closed
    this.root.querySelectorAll("details").forEach((d) => this.openState.set(d.querySelector("summary")!.textContent!, d.open));
    this.root.replaceChildren();
    const st = this.state;
    const open = (t: string, def: boolean) => this.openState.get(t) ?? def;
    const change = (w: Parameters<Change>[0]) => { this.onChange(w); this.render(); };
    sectionCtx = { advanced: st.panelAdvanced, more: this.moreOpen, toggle: (t) => { if (this.moreOpen.has(t)) this.moreOpen.delete(t); else this.moreOpen.add(t); this.render(); } };
    this.root.append(el("h1", {}, "BIOBUZZ Digital Twin"));
    // Essential / All settings switch: everyday controls up front, the rest behind per-section "more" buttons
    this.root.append(el("div", { class: "mode" },
      el("button", { class: st.panelAdvanced ? "" : "on", onclick: () => { st.panelAdvanced = false; this.moreOpen.clear(); change("view"); } }, "Essential"),
      el("button", { class: st.panelAdvanced ? "on" : "", onclick: () => { st.panelAdvanced = true; change("view"); } }, "All settings"),
      el("span", { class: "note" }, st.panelAdvanced ? "Every setting is shown." : "Common settings only; each section has a “more” button."),
    ));

    // --- Session: saved state lives in this browser's localStorage
    const download = (name: string, data: unknown) => { const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
    const upload = (onJson: (j: any) => void) => { const i = document.createElement("input"); i.type = "file"; i.accept = "application/json,.json"; i.onchange = async () => { const f = i.files?.[0]; if (!f) return; try { onJson(JSON.parse(await f.text())); } catch (e) { alert("Not a valid config file: " + e); } }; i.click(); };
    const resetAssetsToo = el("input", { type: "checkbox", title: "Also forget the TeamCode asset overrides (TeamCode settings panel). Off: they survive the reset." }) as HTMLInputElement;
    this.root.append(section("Session", open("Session", false),
      adv(el("div", { class: "note" }, "Everything in this panel is saved in this browser's localStorage) and restored on reload. Robot config = robot preset, dimensions, cameras, launcher, shot variability, hardware map and game-piece settings.")),
      el("div", { class: "row full" },
        el("button", { class: "primary", onclick: () => download(`biobuzz-robot-${(st.robot.name || "robot").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`, { biobuzzRobotConfig: 1, robotPresetId: st.robotPresetId, robot: st.robot, hardware: st.hardware, noise: st.noise, capacity: st.capacity, canPollen: st.canPollen, canNectar: st.canNectar, alliance: st.alliance }) }, "Export robot config"),
        el("button", { onclick: () => upload((j) => { const src = j.biobuzzRobotConfig ? j : j.robot ? j : null; if (!src) { alert("No robot config in that file"); return; } if (src.robot) st.robot = src.robot; if (src.robotPresetId) st.robotPresetId = src.robotPresetId; if (src.hardware?.devices) st.hardware = src.hardware; if (src.noise) st.noise = { ...st.noise, ...src.noise }; if (src.capacity) st.capacity = src.capacity; if (typeof src.canPollen === "boolean") st.canPollen = src.canPollen; if (typeof src.canNectar === "boolean") st.canNectar = src.canNectar; st.selectedCameraId = st.robot.cameras[0]?.id ?? ""; change("reset"); }) }, "Import robot config"),
      ),
      adv(el("div", { class: "row full" },
        el("button", { onclick: () => download("biobuzz-session.json", st) }, "Export whole session"),
        el("button", { onclick: () => upload((j) => { Object.assign(st, j); change("reset"); }) }, "Import whole session"),
      )),
      el("div", { class: "row full" },
        el("button", { style: "border-color:#a33;color:#faa", onclick: () => {
          const keepAssets = !resetAssetsToo.checked && Object.keys(st.assetOverrides ?? {}).length > 0;
          if (!confirm(`Clear everything saved in this browser (robot config, cameras, hardware map, overlays)${keepAssets ? ", keeping your TeamCode asset overrides," : " including TeamCode asset overrides,"} and reload with defaults?`)) return;
          if (keepAssets) localStorage.setItem("biobuzz-twin", JSON.stringify({ assetOverrides: st.assetOverrides })); else localStorage.removeItem("biobuzz-twin");
          location.reload();
        } }, "Reset session to defaults"),
        el("button", { onclick: () => { st.robot = clonePreset(st.robotPresetId); st.selectedCameraId = st.robot.cameras[0]?.id ?? ""; change("robot"); } }, "Reset robot to preset"),
      ),
      el("div", { class: "row full", style: "align-items:center;gap:6px" }, resetAssetsToo, el("label", { style: "color:var(--muted)" }, "Reset also clears TeamCode asset overrides (otherwise they are kept)")),
    ));

    // --- Runtime (TeamCode)
    const link = this.link;
    const rtRows: (Row | AdvGroup)[] = [];
    rtRows.push(chk("Connect to runtime host", () => st.runtimeEnabled, (v) => { st.runtimeEnabled = v; change("runtime"); }));
    const urlInput = el("input", { type: "text", value: st.runtimeUrl }) as HTMLInputElement;
    urlInput.onchange = () => { st.runtimeUrl = urlInput.value; change("runtime"); };
    rtRows.push(adv([el("label", {}, "Host URL"), urlInput]));
    const statusTxt = link ? (link.connected ? `${link.status}${link.currentOpMode ? " · " + link.currentOpMode : ""}` : "not connected — run ./gradlew :host:run in runtime/") : "off";
    // Driver-Station style status pill, refreshed live by updateTelemetry()
    const pillState = !st.runtimeEnabled ? "off" : !link?.connected ? "disconnected" : link.status.toLowerCase();
    const pillLabel: Record<string, string> = { off: "RUNTIME OFF", disconnected: "WAITING FOR HOST", idle: "READY — pick an OpMode", init: "INITIALISED", running: "RUNNING", stopped: "STOPPED", error: "ERROR" };
    this.pillEl = el("div", { class: `rt-pill ${pillState}`, id: "rt-pill" }, el("span", { class: "dot" }), el("span", { class: "label" }, pillLabel[pillState] ?? pillState.toUpperCase()), el("span", { class: "sub" }, link?.currentOpMode ?? ""), el("span", { class: "time" }, ""));
    rtRows.push(this.pillEl);
    rtRows.push(el("div", { class: "note", id: "rt-status", style: "display:none" }, `Status: ${statusTxt}`));
    if (st.runtimeEnabled && !link?.connected) rtRows.push(el("div", { class: "note" }, "Start the host: pnpm sim (or ./gradlew :host:run in runtime/). This panel connects automatically."));
    if (link?.connected) {
      const names = link.opModes.map((o) => ({ value: o.name, label: `[${o.flavor}] ${o.name}` }));
      if (!names.length) rtRows.push(el("div", { class: "note" }, "No OpModes found on the host classpath."));
      else {
        if (!names.some((n) => n.value === this.selectedOpMode)) this.selectedOpMode = names[0].value;
        const s = link.status;
        const canInit = s === "IDLE" || s === "STOPPED" || s === "ERROR";
        const canStart = s === "INIT";
        const canStop = s === "INIT" || s === "RUNNING";
        const selRow = sel("OpMode", names, () => this.selectedOpMode, (v) => { this.selectedOpMode = v; });
        if (!canInit) (selRow[1] as HTMLSelectElement).disabled = true;
        rtRows.push(selRow);
        rtRows.push(el("div", { class: "row full" },
          el("button", { class: "init", ...(canInit ? {} : { disabled: "" }), title: canInit ? "Load the OpMode and run its init()" : "Stop the current OpMode first", onclick: () => link.init(this.selectedOpMode) }, "INIT"),
          el("button", { class: "start", ...(canStart ? {} : { disabled: "" }), title: canStart ? "Start the match loop" : "INIT an OpMode first", onclick: () => link.start() }, "▶ START"),
          el("button", { class: "stop", ...(canStop ? {} : { disabled: "" }), title: canStop ? "Stop and cut all motor power" : "Nothing is running", onclick: () => link.stop() }, "■ STOP"),
        ));
        rtRows.push(el("div", { class: "note" }, s === "IDLE" || s === "STOPPED" ? "Pick an OpMode and press INIT." : s === "INIT" ? "init() ran. Press START to begin, or STOP to abort." : s === "RUNNING" ? "Running. Keyboard is gamepad1 while the 3D view has focus. STOP cuts all power." : s === "ERROR" ? "The OpMode threw; see the message below, fix and INIT again." : ""));
      }
      if (link.agentUrl) rtRows.push(adv(el("div", { class: "note full" }, "Agent API: ", el("code", {}, link.agentUrl), " — coding agents read this session's snapshot, timeline, telemetry and logs, and apply settings or Driver-Station actions, from the command line (GET / for the list). Localhost only.")));
      if (link.panelsUrl) rtRows.push(el("div", { class: "row full", style: "align-items:center;gap:8px" },
        el("a", { href: link.panelsUrl, target: "_blank", rel: "noopener", class: "button-link" }, "Open Panels dashboard ↗"),
        el("span", { class: "note" }, "The real FTC Panels (com.bylazar) running on the host: telemetry, graphs, field and the simulated camera stream, exactly as your code publishes them on the robot.")));
      if (link.statusError) rtRows.push(el("pre", { class: "note full", style: "white-space:pre-wrap;color:#ff8888" }, link.statusError));
      for (const n of link.notes) rtRows.push(el("div", { class: "note full", style: "color:#f2c200" }, n));
      rtRows.push(adv(el("div", { class: "note full" }, `Hardware map: ${st.hardware.devices.length} devices (${st.hardware.devices.map((d) => d.name).join(", ")}). Names must match your hardwareMap.get() calls; see the Hardware map panel for presets.`)));
      this.telemetryEl = el("pre", { class: "full", style: "margin:0;white-space:pre-wrap;font-size:11px;background:#0b0e13;border:1px solid #2a313a;border-radius:4px;padding:6px;min-height:60px;max-height:220px;overflow:auto" }, link.telemetry.join("\n") || "(telemetry)");
      rtRows.push(this.telemetryEl);
    }
    rtRows.push(adv(el("div", { class: "note" }, "While an OpMode is running, its motor and servo commands drive the robot; the keyboard acts as gamepad1 (WASD left stick, Q/E right stick, Space = A, B/X/Y buttons, Shift = right trigger, Ctrl = left trigger, Z/C = bumpers, G = Home/guide (goBILDA logo button), Enter = Start, Backspace = Back, V/N = stick clicks, arrows = dpad). Tab switches the keyboard between gamepad1 and gamepad2 so two-driver code can be exercised alone. Plug in a gamepad to use it instead.")));
    this.root.append(section("Runtime — run your TeamCode", open("Runtime — run your TeamCode", true), ...rtRows));

    // --- Timeline & logs: scrub back through what happened, copy a snapshot for a teammate or an agent
    if (this.recorder) {
      const rec = this.recorder;
      const slider = el("input", { type: "range", min: "0", max: "1", step: "100", style: "width:100%" }) as HTMLInputElement;
      const scrub = (t: number | undefined) => { rec.cursor = t; if (t !== undefined && rec.end !== undefined && rec.end - t < 300) rec.cursor = undefined; this.refreshTimeline(); this.updateTelemetry(this.link?.telemetry ?? [], this.link?.status ?? ""); };
      slider.oninput = () => scrub(Number(slider.value));
      const stepBy = (ms: number) => { const from = rec.cursor ?? rec.end ?? Date.now(); const run = rec.latestRun(); const lo = this.tlScope === "run" && run ? run.start : rec.start ?? from; const hi = this.tlScope === "run" && run && run.end !== undefined ? run.end : rec.end ?? from; scrub(Math.max(lo, Math.min(hi, from + ms))); };
      const stopPlay = () => { if (this.tlPlay) { clearInterval(this.tlPlay); this.tlPlay = undefined; } const b = this.timelineEl?.querySelector(".tl-play") as HTMLButtonElement | null; if (b) b.textContent = "▶ Play"; };
      const togglePlay = () => {
        if (this.tlPlay) { stopPlay(); return; }
        if (rec.cursor === undefined) { const run = rec.latestRun(); scrub(run ? run.start : rec.start); }
        const b = this.timelineEl?.querySelector(".tl-play") as HTMLButtonElement | null; if (b) b.textContent = "❚❚ Pause";
        this.tlPlay = window.setInterval(() => { if (rec.cursor === undefined) { stopPlay(); return; } stepBy(100); }, 100);
      };
      const dl = (name: string, data: unknown) => { const blob = new Blob([typeof data === "string" ? data : JSON.stringify(data, null, 2)], { type: typeof data === "string" ? "text/markdown" : "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
      const flashEl = el("span", { class: "note" }, "");
      const flash = (m: string) => { flashEl.textContent = m; setTimeout(() => { if (flashEl.textContent === m) flashEl.textContent = ""; }, 4000); };
      const copy = async (seconds: number) => {
        const to = rec.cursor ?? rec.end ?? Date.now(); const from = to - seconds * 1000;
        const text = rec.snapshot({ from, to, context: this.snapshotContext(), title: `BIOBUZZ twin snapshot · ${this.link?.currentOpMode || "no OpMode"} · last ${seconds} s` });
        try { await navigator.clipboard.writeText(text); flash(`Copied ${seconds} s snapshot (${(text.length / 1024).toFixed(0)} KB)`); } catch { dl(`twin-snapshot-${Date.now()}.md`, text); flash("Clipboard unavailable: downloaded instead"); }
      };
      this.timelineEl = el("div", { class: "timeline full" },
        el("div", { class: "note" }, "Everything is recorded at 10 Hz: robots, balls, hive tilts, telemetry, status, gamepad, shots, score, host log lines, errors, fouls. Drag the slider (or step / play) to replay a moment on the field: the live simulation pauses while you look and resumes when you go live. The slider covers the latest INIT→STOP run by default. Copy a snapshot to paste into a chat or a bug report."),
        el("div", { class: "row tl-scope", style: "gap:4px;align-items:center" },
          el("span", { class: "note" }, "Span:"),
          el("button", { "data-scope": "run", onclick: () => { this.tlScope = "run"; this.refreshTimeline(); } }, "Latest run"),
          el("button", { "data-scope": "all", onclick: () => { this.tlScope = "all"; this.refreshTimeline(); } }, "Everything")),
        el("div", { class: "tl-pos" }, "LIVE"),
        slider,
        el("div", { class: "row full tl-buttons" },
          el("button", { title: "back 1 s", onclick: () => { stopPlay(); stepBy(-1000); } }, "⏮ 1 s"),
          el("button", { title: "back one sample (0.1 s)", onclick: () => { stopPlay(); stepBy(-100); } }, "◀ 0.1"),
          el("button", { class: "tl-play", title: "replay from here at real speed", onclick: togglePlay }, this.tlPlay ? "❚❚ Pause" : "▶ Play"),
          el("button", { title: "forward one sample (0.1 s)", onclick: () => { stopPlay(); stepBy(100); } }, "0.1 ▶"),
          el("button", { title: "forward 1 s", onclick: () => { stopPlay(); stepBy(1000); } }, "1 s ⏭"),
          el("button", { title: "jump to the start of the latest run", onclick: () => { stopPlay(); const run = rec.latestRun(); scrub(run ? run.start : rec.start); } }, "⇤ Run start")),
        el("div", { class: "row full tl-buttons" },
          el("button", { class: "primary", title: "Copy a Markdown snapshot of the last 30 s (ending at the slider position) to the clipboard", onclick: () => copy(30) }, "Copy 30 s"),
          el("button", { title: "Copy the last 2 minutes", onclick: () => copy(120) }, "Copy 2 min"),
          el("button", { title: "Everything recorded, as JSON", onclick: () => dl(`twin-log-${Date.now()}.json`, { context: this.snapshotContext(), samples: rec.samples, events: rec.events }) }, "Download JSON"),
          el("button", { class: "primary", onclick: () => { stopPlay(); scrub(undefined); } }, "● Live"),
          el("button", { onclick: () => { rec.clear(); this.refreshTimeline(); } }, "Clear")),
        flashEl,
        el("div", { class: "tl-events" }),
      );
      this.root.append(section("Timeline & logs", open("Timeline & logs", true), this.timelineEl));
      this.refreshTimeline();
    }

    // --- TeamCode settings: JSON assets the OpModes read (robot-profile.json, ...), editable here as sim-only overrides
    if (link?.connected && link.assets.length) {
      const total = Object.values(st.assetOverrides).reduce((n, o) => n + Object.keys(o).length, 0);
      const box = el("div", { class: "assets full" });
      const filter = el("input", { type: "text", placeholder: "Filter settings… e.g. autoShoot", value: this.assetFilter }) as HTMLInputElement;
      filter.oninput = () => { this.assetFilter = filter.value; renderFiles(); };
      const list = el("div", {});
      const boundCount = Object.values(link.bound.overrides).reduce((n, o) => n + Object.keys(o).length, 0);
      box.append(
        el("div", { class: "note" }, "Your TeamCode reads these JSON files from assets. Changes here are simulator-only overrides: kept in this browser (and in exported sessions), merged into the file when an OpMode INITs. Your repo files are never modified. Re-INIT after changing."),
        link.bindings
          ? el("div", { class: "note" }, `Twin bindings: ${link.bindings.path} binds ${boundCount} key${boundCount === 1 ? "" : "s"} to twin knobs (marked ⇐ below, read-only here: change the twin instead).`)
          : el("div", { class: "note" }, "No TeamCode/twin-bindings.json in the team repo: settings that mirror the robot (wheel size, ticks, camera mount, alliance) can be derived from the twin's knobs instead of being typed twice. See README → Twin bindings."),
        ...link.bound.errors.map((e) => el("div", { class: "note", style: "color:#ff8888" }, `binding error: ${e}`)),
        el("div", { class: "row full" }, el("button", { title: "Every twin knob a binding can reference, with its current value", onclick: () => { const blob = new Blob([JSON.stringify(twinKnobs(st), null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "twin-knobs.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } }, "Download twin knob catalogue")),
        el("div", { class: "arow tools" }, filter, el("button", { ...(total ? {} : { disabled: "" }), title: "Forget every override in every file", onclick: () => { st.assetOverrides = {}; change("assets"); } }, `Clear all${total ? ` (${total})` : ""}`)),
        (() => {
          // paste settings an agent conveyed in chat ("key": value lines or a JSON fragment) and apply them as overrides
          const ta = el("textarea", { rows: 3, class: "full", placeholder: 'Paste settings from an agent, e.g.\n"matchAuto.startPosition": "FAR_SIDE",\n"matchAuto.loadingZoneDistanceIn": 72' }) as HTMLTextAreaElement;
          const target = el("select") as HTMLSelectElement;
          target.append(el("option", { value: "" }, "file: auto-detect"));
          for (const f of link.assets) if (f.path.endsWith(".json")) target.append(el("option", { value: f.path }, f.path));
          const status = el("span", { class: "note" }, "");
          const apply = el("button", { onclick: () => {
            const parsed = parsePastedSettings(ta.value);
            const keys = Object.keys(parsed.values);
            if (!keys.length) { status.textContent = "nothing recognisable: paste \"key\": value lines or a JSON object"; return; }
            const path = target.value || (parsed.asset && link.assets.some((a) => a.path === parsed.asset) ? parsed.asset : undefined) || (parsed.asset ? link.assets.find((a) => a.path.endsWith(parsed.asset!.split("/").pop()!))?.path : undefined) || guessAssetFor(keys, link.assets);
            if (!path) { status.textContent = "cannot tell which file these belong to: choose one"; return; }
            st.assetOverrides[path] = { ...(st.assetOverrides[path] ?? {}), ...parsed.values };
            this.recorder?.event(Date.now(), "note", `pasted overrides into ${path}: ${keys.join(", ")}`);
            change("assets");
          } }, "Apply pasted settings");
          return el("div", { class: "full", style: "display:grid;gap:4px" }, ta, el("div", { class: "row", style: "align-items:center;gap:6px" }, target, apply, status));
        })(),
        (() => {
          // export: the committed files with every override and twin-bound value applied, in the file's own format
          const changed = exportChangedAssets(link.assets, st.assetOverrides, link.bound.overrides);
          const nKeys = changed.reduce((n, c) => n + c.changed.length, 0);
          return el("div", { class: "arow tools" },
            el("button", { ...(changed.length ? {} : { disabled: "" }), title: changed.map((c) => `${c.path}: ${c.changed.map((k) => k.key).join(", ")}`).join("\n") || "No file differs from what is committed", onclick: () => { for (const c of changed) downloadText(c.path.split("/").pop()!, c.text); } },
              changed.length ? `Export ${changed.length} changed file${changed.length > 1 ? "s" : ""} (${nKeys} value${nKeys > 1 ? "s" : ""})` : "Export changed files"),
            el("span", { class: "note" }, changed.length ? "Downloads the files with your overrides and the twin-bound values written in (original key order and indentation). Drop each into TeamCode/src/main/assets/<path> and commit." : "When settings here differ from the committed files, export them to commit back into TeamCode."));
        })(),
        list,
      );
      const setOv = (path: string, key: string, value: unknown, original: unknown) => {
        const cur = st.assetOverrides[path] ?? (st.assetOverrides[path] = {});
        if (JSON.stringify(value) === JSON.stringify(original)) delete cur[key]; else cur[key] = value;
        if (!Object.keys(cur).length) delete st.assetOverrides[path];
        change("assets");
      };
      const fmt = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));
      const renderFiles = () => {
        list.replaceChildren();
        const q = this.assetFilter.trim().toLowerCase();
        for (const file of link.assets) {
          let json: unknown;
          try { json = JSON.parse(file.text); } catch { list.append(el("div", { class: "note" }, `${file.path}: not valid JSON`)); continue; }
          const ov = st.assetOverrides[file.path] ?? {};
          const n = Object.keys(ov).length;
          const body = el("div", { class: "abody" });
          let shown = 0;
          // walk the tree: objects become indented group headings, everything else a row
          const walk = (v: unknown, key: string, name: string, depth: number) => {
            if (v && typeof v === "object" && !Array.isArray(v)) {
              const entries = Object.entries(v as Record<string, unknown>);
              const head = key ? el("div", { class: "agroup", style: `padding-left:${depth * 10}px` }, name) : null;
              const before = shown;
              if (head) body.append(head);
              for (const [k, x] of entries) walk(x, key ? `${key}.${k}` : k, k, key ? depth + 1 : depth);
              if (head && shown === before) head.remove(); // nothing matched the filter in this group
              return;
            }
            if (q && !key.toLowerCase().includes(q)) return;
            shown++;
            const boundSrc = link.bound.sources[file.path]?.[key];
            if (boundSrc !== undefined) {
              const bv = link.bound.overrides[file.path][key];
              body.append(el("div", { class: "arow over bound", style: `padding-left:${depth * 10}px` }, el("label", { title: `${key} ⇐ ${boundSrc}` }, name), el("span", { class: "bval" }, typeof bv === "string" ? bv : JSON.stringify(bv))),
                el("div", { class: "ahint", style: `padding-left:${depth * 10}px` }, `⇐ twin: ${boundSrc} · file: ${fmt(v)}`));
              return;
            }
            const has = key in ov;
            const value = has ? ov[key] : v;
            const label = el("label", { title: key }, name);
            const row = el("div", { class: `arow${has ? " over" : ""}`, style: `padding-left:${depth * 10}px` }, label);
            let control: HTMLElement;
            if (typeof value === "boolean") {
              const c = el("input", { type: "checkbox" }) as HTMLInputElement; c.checked = value; c.onchange = () => setOv(file.path, key, c.checked, v); control = c;
            } else if (typeof value === "number" || (value === null && typeof v === "number")) {
              const i = el("input", { type: "number", step: "any", value: value === null ? "" : String(value), placeholder: "null" }) as HTMLInputElement;
              i.onchange = () => { const x = parseFloat(i.value); setOv(file.path, key, Number.isNaN(x) ? null : x, v); }; control = i;
            } else if (typeof value === "string" || value === null) {
              const i = el("input", { type: "text", value: value ?? "", placeholder: value === null ? "null — type a number, true/false or text" : "", class: "atext" }) as HTMLInputElement;
              i.onchange = () => { const t = i.value; let x: unknown = t; if (t === "") x = null; else if (t === "true" || t === "false") x = t === "true"; else if (/^-?\d+(\.\d+)?$/.test(t)) x = parseFloat(t); setOv(file.path, key, x, v); }; control = i;
            } else {
              // arrays and other structures: raw JSON
              const ta = el("textarea", { rows: "2", class: "ajson", spellcheck: "false" }) as HTMLTextAreaElement; ta.value = JSON.stringify(value);
              ta.onchange = () => { try { setOv(file.path, key, JSON.parse(ta.value), v); } catch { ta.classList.add("bad"); } }; control = ta;
            }
            row.append(control);
            if (has) row.append(el("button", { class: "reset", title: `Back to the file's value: ${fmt(v)}`, onclick: () => setOv(file.path, key, v, v) }, "↺"));
            body.append(row);
            if (has) body.append(el("div", { class: "ahint", style: `padding-left:${depth * 10}px` }, `file: ${fmt(v)}`));
          };
          walk(json, "", "", 0);
          if (q && !shown) continue;
          const openIt = q ? true : (this.assetOpen.get(file.path) ?? n > 0);
          let exported: ReturnType<typeof applyOverrides> | undefined;
          try { exported = applyOverrides(file, ov, link.bound.overrides[file.path]); } catch { /* shown as invalid above */ }
          const diff = exported?.changed.length ?? 0;
          const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
          const det = el("details", { class: "afile", ...(openIt ? { open: "" } : {}) },
            el("summary", {}, el("span", { class: "name" }, file.path), n ? el("span", { class: "badge" }, `${n} override${n > 1 ? "s" : ""}`) : "",
              el("button", { ...(diff ? {} : { disabled: "" }), title: diff ? `Download ${file.path} with these values written in (${exported!.changed.map((c) => c.key).join(", ")}); put it at TeamCode/src/main/assets/${file.path}` : "Matches the committed file", onclick: (e: Event) => { stop(e); if (exported) downloadText(file.path.split("/").pop()!, exported.text); } }, "Export"),
              el("button", { ...(diff ? {} : { disabled: "" }), title: "Copy the merged file to the clipboard", onclick: (e: Event) => { stop(e); if (exported) navigator.clipboard?.writeText(exported.text); } }, "Copy"),
              el("button", { ...(n ? {} : { disabled: "" }), onclick: (e: Event) => { stop(e); delete st.assetOverrides[file.path]; change("assets"); } }, "Clear")),
            body);
          det.addEventListener("toggle", () => { if (!q) this.assetOpen.set(file.path, det.open); });
          list.append(det);
        }
        if (q && !list.childElementCount) list.append(el("div", { class: "note" }, "No setting matches."));
      };
      renderFiles();
      this.root.append(section("TeamCode settings (assets)", open("TeamCode settings (assets)", false), box));
    }

    // --- Hardware map
    const hw = st.hardware;
    const hwRows: (Row | AdvGroup)[] = [];
    hwRows.push(adv(el("div", { class: "note" }, "Names must match what your OpMode passes to hardwareMap.get(). Roles tell the sim what each device moves.")));
    hwRows.push(sel("Mirrored drive side", [{ value: "left", label: "Left motors mirrored (code reverses left)" }, { value: "right", label: "Right motors mirrored (code reverses right)" }, { value: "none", label: "None (positive power = forward on all)" }], () => hw.mirroredSide ?? "left", (v) => { hw.mirroredSide = v as any; change("hardware"); }));
    const devRows: Row[] = [];
    hw.devices.forEach((d, i) => {
      const hwRows = devRows; // collected, then marked advanced below
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
    hwRows.push(adv(...devRows));
    const addDev = (kind: DeviceKind) => { hw.devices.push({ name: `${kind}${hw.devices.length + 1}`, kind, ...(kind === "motor" ? { role: "other" as const, ticksPerRev: 537.7, freeRpm: 312 } : {}), ...(kind === "servo" ? { role: "other" as const } : {}) }); change("hardware"); };
    hwRows.push(adv(el("div", { class: "row full" },
      el("button", { onclick: () => addDev("motor") }, "+ motor"), el("button", { onclick: () => addDev("servo") }, "+ servo"), el("button", { onclick: () => addDev("crservo") }, "+ CR servo"),
      el("button", { onclick: () => addDev("distance") }, "+ distance"), el("button", { onclick: () => addDev("webcam") }, "+ webcam"),
    )));
    hwRows.push(el("div", { class: "row full" }, el("button", { onclick: () => { st.hardware = defaultHardwareConfig(); change("hardware"); } }, "StarterBot names"), el("button", { title: "Hardware names/ports/polarity of the Camels Hump StarterBot, and the 6WD chassis preset (96 mm wheels, tank drive)", onclick: () => { st.hardware = camelsHumpHardwareConfig(); if (st.robotPresetId !== "starterbot6wd") { st.robotPresetId = "starterbot6wd"; st.robot = clonePreset("starterbot6wd"); st.selectedCameraId = st.robot.cameras[0]?.id ?? ""; } st.robot.drivetrain = "tank"; change("hardware"); change("robot"); } }, "Camels Hump tank bot names")));
    hwRows.push(adv(num("AprilTag noise (1σ)", () => st.tagNoiseIn, (v) => { st.tagNoiseIn = v; change("hardware"); }, { unit: "in", min: 0, max: 5, step: 0.1 })));
    this.root.append(section("Hardware map", open("Hardware map", false), ...hwRows));

    // --- Robot
    const r = st.robot;
    this.root.append(section("Robot", open("Robot", true),
      sel("Preset", Object.entries(ROBOT_PRESETS).map(([k, v]) => ({ value: k, label: v.name })), () => st.robotPresetId, (v) => { st.robotPresetId = v; st.robot = clonePreset(v); change("robot"); }),
      sel("Drivetrain", [{ value: "mecanum", label: "Mecanum (holonomic)" }, { value: "tank", label: "Tank / 6WD (no strafe)" }], () => r.drivetrain, (v) => { r.drivetrain = v as any; change("robot"); }),
      adv(sel("Chassis model", [{ value: "starterbot-mecanum", label: "goBILDA StarterBot mecanum CAD" }, { value: "starterbot-6wd", label: "goBILDA StarterBot 6WD CAD" }, { value: "box", label: "Simple box" }], () => r.model, (v) => { r.model = v as any; change("robot"); }),
      num("CAD yaw", () => r.modelYawDeg ?? 0, (v) => { r.modelYawDeg = v; change("robot"); }, { unit: "°", min: -180, max: 180, step: 90 }),
      num("Length", () => r.lengthM / IN, (v) => { r.lengthM = v * IN; change("robot"); }, { unit: "in", min: 6, max: 24, step: 0.5 }),
      num("Width", () => r.widthM / IN, (v) => { r.widthM = v * IN; change("robot"); }, { unit: "in", min: 6, max: 24, step: 0.5 }),
      num("Height", () => r.heightM / IN, (v) => { r.heightM = v * IN; change("robot"); }, { unit: "in", min: 4, max: 29, step: 0.5 }),
      num("Wheel RPM", () => r.wheelRpm, (v) => { r.wheelRpm = v; change("robot"); }, { min: 30, max: 1200, step: 1 }),
      num("Wheel dia", () => r.wheelDiameterM * 1000, (v) => { r.wheelDiameterM = v / 1000; change("robot"); }, { unit: "mm", min: 48, max: 160, step: 1 }),
      num("Mass", () => r.massKg ?? 12, (v) => { r.massKg = v; change("robot"); }, { unit: "kg", min: 3, max: 20, step: 0.5 }),
      el("div", { class: "note full" }, "Mass sets pushing: traction is 0.8 x weight. A robot driving against a push resists with all of it; an idle tank robot skids sideways but can be rolled lengthwise at about half; mecanum rollers give a little in every direction. The wall always holds, and holding an opponent for 3 s is a MAJOR FOUL (G421).")),
      sel("Intake side", [{ value: "front", label: "Front (forward arrow)" }, { value: "rear", label: "Rear" }, { value: "left", label: "Left" }, { value: "right", label: "Right" }], () => r.intake.side, (v) => { r.intake.side = v as any; change("robot"); }),
      adv(num("Intake width", () => r.intake.widthM / IN, (v) => { r.intake.widthM = v * IN; change("robot"); }, { unit: "in", min: 2, max: 24, step: 0.5 }),
      el("div", { class: "note full" }, "Balls are only collected through the intake side (green edge on the floor outline). Every other side pushes them, and so does the intake once the robot is full."),
      chk("Field-centric drive", () => st.fieldCentric, (v) => { st.fieldCentric = v; change("sim"); })),
      el("div", { class: "row full" },
        el("button", { onclick: () => { st.pose = { x: -1.2, z: 1.5, heading: 0 }; change("sim"); } }, "Reset pose"),
        el("button", { onclick: () => { st.pose = startPose(st.starts, "you", st.alliance, st.hive); change("sim"); } }, "To start position"),
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
        el("span", { class: "note" }, "Makes the other end of the robot the forward arrow. Cameras and launcher come along. This does NOT change which way the wheels spin."),
      ),
      el("div", { class: "row full" },
        el("button", { title: "If your code drives the robot backwards (and left/right come out swapped), your motors are mounted the other way round from the sim's assumption. This flips that assumption.", onclick: () => { st.hardware.mirroredSide = st.hardware.mirroredSide === "left" ? "right" : st.hardware.mirroredSide === "right" ? "none" : "left"; change("hardware"); } }, `Drive polarity: ${st.hardware.mirroredSide ?? "left"} side mirrored`),
        el("span", { class: "note" }, "Under TeamCode, if W drives backwards and A turns right, cycle this until it matches the real robot (left → right → none)."),
      ),
    ));

    // --- Cameras
    const outerCamRows: (Row | AdvGroup)[] = [];
    outerCamRows.push(sel("Selected camera", r.cameras.map((c) => ({ value: c.id, label: c.name })), () => st.selectedCameraId, (v) => { st.selectedCameraId = v; change("view"); }));
    r.cameras.forEach((c, i) => {
      const intr = intrinsicsFor(c);
      // only the selected camera's mount details are everyday settings; other cameras show their heading line
      const other = c.id !== st.selectedCameraId && r.cameras.length > 1;
      const camRows: Row[] = [];
      camRows.push(el("div", { class: "sub" }, `${c.name}${other ? " (select it above to edit)" : ""}`));
      camRows.push(el("div", { class: "note" }, `${intr.width}x${intr.height} · HFOV ${(intr.hfov * 180 / Math.PI).toFixed(1)}° · VFOV ${(intr.vfov * 180 / Math.PI).toFixed(1)}° · diag ${diagonalDeg(intr).toFixed(1)}°${presetById(c.presetId).notes ? " · " + presetById(c.presetId).notes : ""}`));
      const nameInput = el("input", { type: "text", value: c.name }) as HTMLInputElement;
      nameInput.onchange = () => { c.name = nameInput.value; change("cameras"); };
      camRows.push(adv([el("label", {}, "Name"), nameInput]).adv[0]);
      camRows.push(sel("Camera", CAMERA_PRESETS.map((p) => ({ value: p.id, label: p.name })), () => c.presetId, (v) => { c.presetId = v; c.diagFovDeg = undefined; c.hfovDeg = undefined; c.width = undefined; c.height = undefined; change("cameras"); }));
      camRows.push(chk("Enabled", () => c.enabled, (v) => { c.enabled = v; change("cameras"); }));
      camRows.push(num("Height", () => c.heightM / IN, (v) => { c.heightM = v * IN; change("cameras"); }, { unit: "in", min: 0, max: 29, step: 0.25 }));
      camRows.push(num("Forward offset", () => c.forwardM / IN, (v) => { c.forwardM = v * IN; change("cameras"); }, { unit: "in", min: -12, max: 12, step: 0.25 }));
      camRows.push(num("Left offset", () => c.leftM / IN, (v) => { c.leftM = v * IN; change("cameras"); }, { unit: "in", min: -12, max: 12, step: 0.25 }));
      camRows.push(num("Pitch (+down)", () => c.pitchDeg, (v) => { c.pitchDeg = v; change("cameras"); }, { unit: "°", min: -90, max: 90, step: 1 }));
      camRows.push(num("Yaw (+left)", () => c.yawDeg, (v) => { c.yawDeg = v; change("cameras"); }, { unit: "°", min: -180, max: 180, step: 1 }));
      camRows.push(...adv(
        num("Roll", () => c.rollDeg, (v) => { c.rollDeg = v; change("cameras"); }, { unit: "°", min: -180, max: 180, step: 1 }),
        num("Diag FOV override", () => c.diagFovDeg ?? diagonalDeg(intr), (v) => { c.diagFovDeg = v; c.hfovDeg = undefined; change("cameras"); }, { unit: "°", min: 20, max: 160, step: 0.5 }),
        num("Width", () => intr.width, (v) => { c.width = v; change("cameras"); }, { unit: "px", min: 160, max: 4096, step: 1 }),
        num("Height", () => intr.height, (v) => { c.height = v; change("cameras"); }, { unit: "px", min: 120, max: 3072, step: 1 }),
      ).adv);
      camRows.push(el("div", { class: "row full" },
        el("button", { onclick: () => { r.cameras.splice(i, 1); if (st.selectedCameraId === c.id) st.selectedCameraId = r.cameras[0]?.id ?? ""; change("cameras"); } }, "Remove"),
      ));
      outerCamRows.push(camRows[0], ...(other ? [adv(...camRows.slice(1))] : camRows.slice(1)));
    });
    const addCam = (name: string, yaw: number, fwdIn: number) => { const id = `cam${Date.now() % 100000}`; const c = defaultCamera(id); c.name = name; c.yawDeg = yaw; c.forwardM = fwdIn * IN; r.cameras.push(c); st.selectedCameraId = id; change("cameras"); };
    const MAX_CAMERAS = 2; // FTC allows at most two cameras on the robot
    const full = r.cameras.length >= MAX_CAMERAS;
    const dis = full ? { disabled: "" } : {};
    outerCamRows.push(el("div", { class: "row full" },
      el("button", { class: "primary", ...dis, onclick: () => addCam(`Camera ${r.cameras.length + 1}`, 0, 7) }, "+ Front camera"),
      el("button", { class: "primary", ...dis, onclick: () => addCam("Rear camera", 180, -7) }, "+ Rear camera"),
      el("button", { ...dis, onclick: () => addCam("Left camera", 90, 0) }, "+ Left"),
      el("button", { ...dis, onclick: () => addCam("Right camera", -90, 0) }, "+ Right"),
    ));
    if (full) outerCamRows.push(el("div", { class: "note" }, "FTC rules allow a maximum of two cameras; remove one to add another."));
    outerCamRows.push(el("div", { class: "note" }, "Drag a camera's green body on the robot to move it (orbit view). Hold Alt while dragging to change height. Then fine-tune the numbers above."));
    this.root.append(section("Cameras", open("Cameras", true), ...outerCamRows));

    // --- Launcher
    const l = r.launcher;
    this.root.append(section("Launcher", open("Launcher", true),
      sel("Preset", Object.entries(LAUNCHER_PRESETS).map(([k, v]) => ({ value: k, label: v.name })), () => Object.entries(LAUNCHER_PRESETS).find(([, v]) => v.name === l.name)?.[0] ?? "custom", (v) => { r.launcher = { ...LAUNCHER_PRESETS[v] }; change("launcher"); }),
      sel("Ball", [{ value: "pollen", label: "POLLEN (2.8 in, 25 g)" }, { value: "nectar", label: "NECTAR (3.6 in, 41 g)" }], () => st.ballKind, (v) => { st.ballKind = v as any; change("launcher"); }),
      adv(num("Flywheel dia", () => l.wheelDiameterM * 1000, (v) => { l.wheelDiameterM = v / 1000; change("launcher"); }, { unit: "mm", min: 40, max: 200, step: 1 }),
      num("Max RPM", () => l.maxRpm, (v) => { l.maxRpm = v; change("launcher"); }, { min: 100, max: 12000, step: 10 }),
      num("Efficiency", () => l.efficiency, (v) => { l.efficiency = v; change("launcher"); }, { min: 0.1, max: 1, step: 0.01 })),
      num("Commanded RPM", () => l.rpm, (v) => { l.rpm = v; change("launcher"); }, { min: 0, max: 12000, step: 10 }),
      num("Hood angle", () => l.elevationDeg, (v) => { l.elevationDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 89, step: 0.5 }),
      adv(num("Hood min", () => l.elevationMinDeg, (v) => { l.elevationMinDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 89, step: 0.5 }),
      num("Hood max", () => l.elevationMaxDeg, (v) => { l.elevationMaxDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 89, step: 0.5 }),
      num("Exit height", () => l.exitHeightM / IN, (v) => { l.exitHeightM = v * IN; change("launcher"); }, { unit: "in", min: 1, max: 29, step: 0.25 }),
      num("Exit forward", () => l.exitForwardM / IN, (v) => { l.exitForwardM = v * IN; change("launcher"); }, { unit: "in", min: -12, max: 12, step: 0.25 }),
      num("Exit left", () => l.exitLeftM / IN, (v) => { l.exitLeftM = v * IN; change("launcher"); }, { unit: "in", min: -12, max: 12, step: 0.25 })),
      num("Launcher yaw", () => l.yawOffsetDeg, (v) => { l.yawOffsetDeg = v; change("launcher"); }, { unit: "°", min: -180, max: 180, step: 5 }),
      adv(el("div", { class: "note" }, "Launcher yaw is the fixed direction the shooter points relative to the robot's forward arrow (180 = fires out the back, like the StarterBot ramp). Drag the orange exit marker on the robot to move it; Alt-drag for height. It is hidden from the camera views."),
      num("Turret min", () => l.turretMinDeg, (v) => { l.turretMinDeg = v; change("launcher"); }, { unit: "°", min: -180, max: 0, step: 1 }),
      num("Turret max", () => l.turretMaxDeg, (v) => { l.turretMaxDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 180, step: 1 }),
      num("Backspin fraction", () => l.spinFraction, (v) => { l.spinFraction = v; change("launcher"); }, { min: 0, max: 1, step: 0.05 })),
      chk("Auto-RPM to target (keyboard shots)", () => st.autoRpm, (v) => { st.autoRpm = v; (st as any).autoRpmUserSet = true; change("launcher"); }),
      chk("Auto-hood to best angle", () => st.autoHood, (v) => { st.autoHood = v; change("launcher"); }),
      adv(chk("Air drag (Cd 0.45)", () => st.drag, (v) => { st.drag = v; change("launcher"); }),
      el("div", { class: "sub" }, "Shot variability (1-sigma)"),
      num("Speed error", () => st.noise.speedFrac * 100, (v) => { st.noise.speedFrac = v / 100; change("launcher"); }, { unit: "%", min: 0, max: 30, step: 0.5 }),
      num("Elevation error", () => st.noise.elevationDeg, (v) => { st.noise.elevationDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 15, step: 0.1 }),
      num("Yaw error", () => st.noise.yawDeg, (v) => { st.noise.yawDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 15, step: 0.1 }),
      num("Spin variation", () => st.noise.spinFrac * 100, (v) => { st.noise.spinFrac = v / 100; change("launcher"); }, { unit: "%", min: 0, max: 100, step: 5 }),
      num("Monte Carlo shots", () => st.monteCarloN, (v) => { st.monteCarloN = Math.round(v); change("launcher"); }, { min: 20, max: 1000, step: 10 }),
      el("div", { class: "note" }, "Each fired ball gets a random draw from these. The HUD hit probability and the dot cloud on the opening plane come from re-simulating this many perturbed shots along the direction the launcher points right now."),
      el("div", { class: "note" }, "Exit speed = efficiency x flywheel surface speed. Measure a few shots on your robot and tune efficiency until the sim matches. While TeamCode is running, the flywheel RPM comes from your code's motor command and Auto-RPM is ignored; a ball fed with the flywheel stopped just drops out, as on the real robot.")),
    ));

    // --- Match / target
    const calOpen = open("Shooter calibration", false);
    const calSec = section("Shooter calibration", calOpen, ...(calOpen ? calibrationRows({
      state: st, link: this.link, change, rerender: () => this.render(),
      form: this.calForm, setForm: (f) => { this.calForm = f; }, simImpact: this.calImpact, clearImpact: () => { this.calImpact = undefined; },
      cache: this.calCache, setCache: (c) => { this.calCache = c; },
    }) : [el("div", { class: "note" }, "Open to start.")]));
    calSec.ontoggle = () => { if ((calSec as HTMLDetailsElement).open !== calOpen) this.render(); }; // the wizard renders only while open (it runs the fitter)
    this.root.append(calSec);

    this.root.append(section("Field & target", open("Field & target", true),
      sel("Our alliance", [{ value: "red", label: "Red (left of audience)" }, { value: "blue", label: "Blue" }], () => st.alliance, (v) => { st.alliance = v as any; change("sim"); }),
      sel("Red hive up cell", [{ value: "audience", label: "Audience side (match start)" }, { value: "scoring", label: "Scoring side" }], () => st.hive.red, (v) => { st.hive.red = v as any; change("sim"); }),
      sel("Blue hive up cell", [{ value: "scoring", label: "Scoring side (match start)" }, { value: "audience", label: "Audience side" }], () => st.hive.blue, (v) => { st.hive.blue = v as any; change("sim"); }),
      adv(chk("Hives tip when loaded", () => st.autoTip, (v) => { st.autoTip = v; change("sim"); }),
      num("Tip load", () => st.tipMassG, (v) => { st.tipMassG = v; change("sim"); }, { unit: "g", min: 50, max: 600, step: 1 }),
      el("div", { class: "note" }, "Field staff calibrate each cell to tip at 8 POLLEN or 3 NECTAR + 3 POLLEN (198.6 g, so the default threshold is 195 g). The up cell starts with 3 NECTAR, so three POLLEN in tips it. A heavier load tips faster. When it tips the contents fall out and the other cell comes up, facing the other way, so you must move to keep scoring. T or the selectors above reset the hive to match start.")),
      chk("Simulated other robots", () => st.opponents, (v) => { st.opponents = v; change("sim"); }),
      chk("They collect and score", () => st.opponentsScore, (v) => { st.opponentsScore = v; change("sim"); }),
      adv(chk("Pause other robots", () => st.pauseOpponents, (v) => { st.pauseOpponents = v; change("sim"); }),
      el("div", { class: "sub" }, "Game pieces"),
      num("Robot capacity", () => st.capacity, (v) => { st.capacity = Math.round(v); change("sim"); }, { min: 1, max: 8, step: 1 }),
      chk("Can intake POLLEN", () => st.canPollen, (v) => { st.canPollen = v; change("sim"); }),
      chk("Can intake NECTAR", () => st.canNectar, (v) => { st.canNectar = v; change("sim"); }),
      el("div", { class: "note" }, "Match start: 4 POLLEN preloaded, 4 in each FLOWER, 4 in each GARDEN, 3 NECTAR in each raised cell, 5 NECTAR per alliance in reserve (one enters the LOADING ZONE after each tip). Drive the intake end onto a ball or up to a FLOWER's retrieval opening to pick up; you can only launch what you carry. Keyboard driving always runs the intake; under TeamCode the intake motor must be powered.")),
      el("div", { class: "sub" }, `Match: ${st.matchPhase === "running" ? "running" : st.matchPhase === "stopped" ? "stopped" : "setup — robots on their marks"}`),
      el("div", { class: "row full" },
        el("button", { class: "primary", ...(st.matchPhase === "running" ? { disabled: "" } : {}), onclick: () => { st.matchRequest = "start"; change("sim"); } }, "▶ Start match"),
        el("button", { ...(st.matchPhase !== "running" ? { disabled: "" } : {}), onclick: () => { st.matchRequest = "stop"; change("sim"); } }, "■ Stop"),
        el("button", { onclick: () => { st.resetMatchRequest = true; change("sim"); } }, "Reset to start"),
      ),
      el("div", { class: "note" }, "Reset parks every robot on its starting mark with the field at match start; Start releases the 2:30 clock and the other robots. With TeamCode connected, INIT resets and START/STOP do the same for the whole field."),
      adv(el("div", { class: "sub" }, "Starting positions (red frame, inches; mirrored when you play blue)"),
        chk("Start on our raised cell's side", () => st.starts.followUpCell ?? true, (v) => { st.starts.followUpCell = v; change("sim"); }),
        el("div", { class: "note" }, "On: you start on the half of the field our hive's raised cell faces (the z values below are used as distances from the centre line), the partner takes the other half, and the opponents do the same for theirs. Off: the z values are used as given."),
        ...(["you", "partner", "opp1", "opp2"] as StartKey[]).flatMap((k) => [
          num(`${START_LABELS[k]} x`, () => st.starts[k].xIn, (v) => { st.starts[k].xIn = v; change("sim"); }, { unit: "in", min: -70, max: 70, step: 1 }),
          num(`${START_LABELS[k]} z`, () => st.starts[k].zIn, (v) => { st.starts[k].zIn = v; change("sim"); }, { unit: "in", min: -70, max: 70, step: 1 }),
          num(`${START_LABELS[k]} heading`, () => st.starts[k].headingDeg, (v) => { st.starts[k].headingDeg = v; change("sim"); }, { unit: "°", min: -180, max: 180, step: 5 }),
        ]),
        el("div", { class: "row full" }, el("button", { onclick: () => { st.starts = defaultStarts(); change("sim"); } }, "Default positions")),
        el("div", { class: "note" }, "x is toward the blue alliance, z toward the audience; heading 0 faces the scoring side, −90° faces +x. Defaults put each robot against its alliance wall facing the field.")),
    ));

    // --- View / overlays
    const o = st.overlays;
    this.root.append(section("View & overlays", open("View & overlays", false),
      sel("Main view", [{ value: "orbit", label: "Orbit (1)" }, { value: "top", label: "Top-down (2)" }, { value: "chase", label: "Chase (3)" }, { value: "robot", label: "Robot camera (4)" }], () => st.view, (v) => { st.view = v as any; change("view"); }),
      chk("Camera insets (all cameras)", () => st.pip, (v) => { st.pip = v; change("view"); }),
      adv(chk("Arc if aimed at target (green/red)", () => o.trajectory, (v) => { o.trajectory = v; change("overlays"); }),
      chk("Arc as launcher points now (orange)", () => o.actualArc, (v) => { o.actualArc = v; change("overlays"); }),
      chk("Dispersion cloud", () => o.dispersion, (v) => { o.dispersion = v; change("overlays"); }),
      chk("Feasible-angle fan", () => o.fan, (v) => { o.fan = v; change("overlays"); }),
      chk("FOV footprint on mat", () => o.footprint, (v) => { o.footprint = v; change("overlays"); }),
      chk("Camera frustum", () => o.frustum, (v) => { o.frustum = v; change("overlays"); }),
      chk("Target opening", () => o.target, (v) => { o.target = v; change("overlays"); }),
      chk("Aim line", () => o.aim, (v) => { o.aim = v; change("overlays"); })),
      chk("Reachability map (RPM by position)", () => o.reach, (v) => { o.reach = v; change("overlays"); }),
      el("div", { class: "note" }, "Reachability colours the mat by the flywheel RPM needed to hit the target cell from each 6 in square with the current launcher (green = low, red = near max, dark = cannot reach). Recomputed when launcher or target change."),
      chk("Hit-probability map (aimed from each square)", () => o.hitmap, (v) => { o.hitmap = v; change("overlays"); }),
      el("div", { class: "note" }, "For every 6 in square: aim at the target cell, use the hood/RPM the launcher would need from there, and fire 40 simulated shots with the configured shot variability. Green = always in, red = never. Squares are dimmed where the selected camera would not see any of the target cell's AprilTags, so auto-aim could not lock on. Fills in over a few seconds and recomputes as you change the launcher, variability, hood, cameras or target."),
      adv(chk("Performance stats", () => st.showPerf, (v) => { st.showPerf = v; change("view"); }),
      el("div", { class: "note" }, "Export, import and reset live in the Session section at the top.")),
    ));
  }
}
