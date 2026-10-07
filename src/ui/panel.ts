/** Side panel built from plain DOM. Edits the AppState and calls onChange. */
import type { AppState } from "../state";
import { ROBOT_PRESETS, clonePreset, defaultCamera } from "../robot/presets";
import { CAMERA_PRESETS, presetById } from "../camera/cameraPresets";
import { LAUNCHER_PRESETS } from "../ballistics/launcher";
import { diagonalDeg } from "../camera/cameraMath";
import { intrinsicsFor } from "../robot/robot";
import type { RuntimeLink } from "../runtime/link";
import { START_LABELS, defaultStarts, startPose, type StartKey, startSideOf, setStartSide } from "../sim/starts";
import { twinKnobs } from "../runtime/bindings";
import type { Recorder } from "../runtime/recorder";
import { applyOverrides, downloadText, exportChangedAssets, guessAssetFor, parsePastedSettings } from "../runtime/assetExport";
import { constraintText, hasRange, isInteger, isNumeric, isSchemaFile, nodeAt, nullable, schemaFor, searchText, validate, validateAll } from "../runtime/assetSchema";
import { classifyTelemetryLine, splitTelemetryLine } from "./telemetryFormat";
import { calibrationRows, type CalForm, type SimImpactLike } from "./calibration";
import type { FitResult } from "../ballistics/calibration";
import { MOTOR_ROLES, SERVO_ROLES, defaultHardwareConfig, camelsHumpHardwareConfig, type DeviceKind } from "../runtime/hardwareConfig";

const IN = 0.0254;
let controlSequence = 0;
export function labelControl(label: string, control: HTMLElement) {
  const id = `control-${++controlSequence}`;
  control.id = id;
  control.setAttribute("aria-label", label);
  return el("label", { for: id }, label);
}
const friendly = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase());

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
  return [labelControl(opts.unit ? `${label} (${opts.unit})` : label, input), input];
}
function round(v: number): number { return Math.round(v * 100) / 100; }

export function sel(label: string, options: { value: string; label: string }[], get: () => string, set: (v: string) => void): HTMLElement[] {
  const s = el("select") as HTMLSelectElement;
  for (const o of options) s.append(el("option", { value: o.value, selected: o.value === get() ? "" : undefined }, o.label));
  s.value = get();
  s.onchange = () => set(s.value);
  return [labelControl(label, s), s];
}

export function chk(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement[] {
  const c = el("input", { type: "checkbox" }) as HTMLInputElement;
  c.checked = get();
  c.onchange = () => set(c.checked);
  return [labelControl(label, c), c];
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
let sectionCtx: { advanced: boolean; more: Set<string>; toggle: (title: string) => void; hints: Map<string, string> } = { advanced: true, more: new Set(), toggle: () => {}, hints: new Map() };
/** A pill-shaped on/off button for the quick bar at the top of the panel. */
function chip(label: string, title: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
  return el("button", { class: get() ? "chip on" : "chip", title, "aria-pressed": get() ? "true" : "false", onclick: () => set(!get()) }, label);
}
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
  const hint = sectionCtx.hints.get(title);
  const d = el("details", { "data-title": title, ...(open ? { open: "" } : {}) }, el("summary", {}, el("span", { class: "stitle" }, title), hint ? el("span", { class: "hint" }, hint) : ""), body);
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
  private timelineEvents?: HTMLElement;
  private telemetryEl?: HTMLElement;
  private pillEl?: HTMLElement;
  constructor(state: AppState, onChange: Change) {
    this.state = state;
    this.onChange = onChange;
    this.root = document.getElementById("panel")!;
    this.render();
  }

  decorate?: () => void;
  toggle() { this.root.classList.toggle("hidden"); document.dispatchEvent(new Event("panel-visibility")); }
  openSection(title: string) { this.openState.set(title, true); this.render(); }

  private reviewChanges(title: string, detail: string): Promise<boolean> {
    return new Promise(resolve => {
      const d = el("dialog", { class: "workspace-dialog review-dialog", "aria-label": title });
      let accepted = false;
      d.append(el("h2", {}, title), el("p", {}, "Review the files and values below. Save writes these changes to your project; simulator changes remain local until then."), el("pre", { class: "change-preview" }, detail), el("div", { class: "row" }, el("button", { onclick: () => d.close() }, "Keep in simulator"), el("button", { class: "primary", onclick: () => { accepted = true; d.close(); } }, "Save to project")));
      d.addEventListener("close", () => { d.remove(); resolve(accepted); });
      document.body.append(d); d.showModal();
    });
  }
  private aboutDialog?: HTMLDialogElement;
  /** About: who built the twin, where the code lives, licence. */
  openAbout() {
    if (!this.aboutDialog) {
      const base = (import.meta as any).env?.BASE_URL ?? "/";
      const d = el("dialog", { class: "about-dialog", "aria-label": "About Camels Hump Coders" },
        el("button", { class: "close", title: "Close", "aria-label": "Close", onclick: () => d.close() }, "×"),
        el("img", { class: "logo", src: base + "chc-logo.png", alt: "Camels Hump Coders logo", width: "128", height: "128" }),
        el("h2", {}, "Camels Hump Coders #36682"),
        el("p", {}, "A browser 3D twin of the FIRST Tech Challenge 2026-27 BIOBUZZ field and robot, with a virtual runtime that runs a team's unmodified Java TeamCode against it."),
        el("p", {}, "Built by the ", el("a", { href: "https://camelshumpcoders.org", target: "_blank", rel: "noopener" }, "Camels Hump Coders"), ", FIRST Tech Challenge Team #36682, a rookie team of middle- and high-school students from Huntington, Vermont, who moved up from FIRST LEGO League. We share it so other teams can test code before the robot is built."),
        el("div", { class: "links" },
          el("a", { class: "button-link", href: "https://camelshumpcoders.org", target: "_blank", rel: "noopener" }, "camelshumpcoders.org"),
          el("a", { class: "button-link", href: "https://github.com/camels-hump-coders/biobuzz-digital-twin", target: "_blank", rel: "noopener" }, "Source on GitHub"),
          el("a", { class: "button-link", href: "https://digital-twin.camelshumpcoders.org/", target: "_blank", rel: "noopener" }, "Hosted twin")),
        el("p", { class: "fine" }, "MIT licence. AprilTag 36h11 codes from AprilRobotics (BSD-2); goBILDA StarterBot CAD from goBILDA's published STEP files; the FTC Panels dashboard (com.bylazar) runs unmodified in the host. Not affiliated with FIRST or goBILDA; BIOBUZZ and FIRST Tech Challenge are trademarks of FIRST."),
      );
      d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
      document.body.append(d);
      this.aboutDialog = d;
    }
    if (!this.aboutDialog.open) this.aboutDialog.showModal();
  }
  selectedOpMode = "";
  /** TeamCode settings panel: search text and which files are expanded */
  private assetFilter = "";
  private assetOpen = new Map<string, boolean>();
  /** sections whose advanced rows were revealed with their "more" button (Essential mode) */
  private moreOpen = new Set<string>();
  /** cheap per-frame refresh of the telemetry box without re-rendering the panel */
  /** TeamCode settings editor dialog (full width): built from the latest render's closure */
  private assetEditorBuilder?: () => HTMLElement | undefined;
  private assetDialog?: HTMLDialogElement;
  assetDialogOpen = false;
  openAssetDialog() {
    if (!this.assetDialog) {
      const d = document.createElement("dialog"); d.className = "settings-dialog";
      d.addEventListener("close", () => { this.assetDialogOpen = false; });
      d.addEventListener("click", (e) => { if (e.target === d) d.close(); }); // backdrop click closes
      document.body.append(d); this.assetDialog = d;
    }
    this.assetDialogOpen = true;
    this.renderAssetDialog();
    if (!this.assetDialog.open) this.assetDialog.showModal();
  }
  private renderAssetDialog() {
    const d = this.assetDialog; if (!d) return;
    const body = this.assetEditorBuilder?.();
    const scroll = (d.querySelector(".sd-body") as HTMLElement | null)?.scrollTop ?? 0;
    const focused = document.activeElement as HTMLInputElement | null;
    const keepFilter = focused && d.contains(focused) && focused.type === "text" && focused.closest(".tools");
    d.replaceChildren(
      el("div", { class: "sd-head" }, el("h2", {}, "TeamCode settings"), el("span", { class: "note" }, "Preview changes in the simulator, then review and save to your project."), el("button", { class: "sd-close", title: "Close (Esc)", onclick: () => d.close() }, "×")),
      el("div", { class: "sd-body" }, body ?? el("div", { class: "note" }, "Connect to the runtime host to edit TeamCode settings.")),
    );
    const sb = d.querySelector(".sd-body") as HTMLElement | null; if (sb) sb.scrollTop = scroll;
    if (keepFilter) { const f = d.querySelector(".tools input[type=text]") as HTMLInputElement | null; if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
  }
  /** short confirmation at the top of the panel (saves, loads, failures) */
  toast(text: string, bad = false) {
    document.getElementById("panel-toast")?.remove();
    const t = el("div", { id: "panel-toast", class: bad ? "bad" : "" }, text);
    document.body.append(t); // outside the panel: a re-render must not wipe it
    setTimeout(() => t.remove(), bad ? 8000 : 4000);
  }
  /** server mode: the twin's settings file on disk (set by main) */
  settingsFile?: { save: () => Promise<{ ok: boolean; path?: string; error?: string }>; load: () => { ok: boolean; error?: string }; differs: () => boolean; unsaved: () => boolean; unsavedPaths: () => string[]; filePaths: () => string[] };
  private sessionFlashEl?: HTMLElement;
  /** survives the re-renders that follow a save (the host re-broadcasts the settings) */
  private sessionFlash?: { text: string; bad: boolean; until: number };
  flashSession(text: string, bad = false) { this.sessionFlash = { text, bad, until: Date.now() + 6000 }; const e = this.sessionFlashEl; if (e) { e.textContent = text; e.classList.toggle("bad", bad); } }
  /** server mode: write a merged asset file back into the team repo (set by main) */
  saveAssetToRepo?: (path: string) => Promise<{ ok: boolean; file?: string; error?: string }>;
  private assetFlashEl?: HTMLElement;
  flashAssets(text: string, bad = false) { const e = this.assetFlashEl; if (!e) return; e.textContent = text; e.classList.toggle("bad", bad); setTimeout(() => { if (e.textContent === text) e.textContent = ""; }, 6000); }
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
      const shown = hist ? hist.telemetry : lines;
      const head = hist ? `⏪ ${((Date.now() - hist.t) / 1000).toFixed(1)} s ago · ${hist.status}${hist.opMode ? " " + hist.opMode : ""}` : "";
      const key = head + "\u0000" + shown.join("\n");
      if ((this.telemetryEl as any).__key !== key) {
        (this.telemetryEl as any).__key = key;
        const rows: HTMLElement[] = [];
        if (head) rows.push(el("div", { class: "tel-line tel-head" }, head));
        if (!shown.length) rows.push(el("div", { class: "tel-line tel-empty" }, hist ? "(no telemetry)" : "(telemetry)"));
        for (const line of shown) {
          // free-form text: colour by well-known words, bold the caption of "caption : value" lines
          const level = classifyTelemetryLine(line);
          const { key: cap, value } = splitTelemetryLine(line);
          const icon = level === "err" ? "✖ " : level === "warn" ? "⚠ " : level === "ok" ? "✓ " : "";
          rows.push(cap !== undefined ? el("div", { class: `tel-line tel-${level}` }, el("span", { class: "tel-key" }, icon + cap), el("span", { class: "tel-sep" }, " : "), el("span", { class: "tel-val" }, value ?? "")) : el("div", { class: `tel-line tel-${level}` }, icon + line));
        }
        this.telemetryEl.replaceChildren(...rows);
      }
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
    const list = this.timelineEvents;
    const run = rec.latestRun();
    const start = this.tlScope === "run" && run ? run.start : rec.start, end = this.tlScope === "run" && run && run.end !== undefined ? run.end : rec.end;
    if (slider && start !== undefined && end !== undefined) {
      slider.min = String(start); slider.max = String(end);
      if (rec.cursor === undefined) slider.value = String(end); else slider.value = String(Math.max(start, Math.min(end, rec.cursor)));
      const shown = rec.cursor ?? end;
      const inRun = rec.runAt(shown);
      if (label) label.textContent = rec.cursor === undefined
        ? `LIVE · ${run ? `last run ${run.opMode || "keyboard match"} · ${(((run.end ?? rec.end ?? shown) - run.start) / 1000).toFixed(0)} s${run.end === undefined ? " (running)" : ""}` : `${((end - start) / 1000).toFixed(0)} s recorded, no run yet`}`
        : `⏪ REPLAY ${inRun ? `run +${((shown - inRun.start) / 1000).toFixed(1)} s · ` : ""}${(((rec.end ?? shown) - shown) / 1000).toFixed(1)} s ago (${new Date(shown).toLocaleTimeString()}) — the field shows this moment; the live sim is paused`;
    }
    this.root.querySelectorAll(".tl-replay-note").forEach((n) => n.classList.toggle("hidden", rec.cursor === undefined));
    const mode = box.querySelector(".tl-mode") as HTMLElement | null;
    if (mode) { mode.classList.toggle("live", rec.cursor === undefined); mode.classList.toggle("replay", rec.cursor !== undefined); }
    const goLive = box.querySelector<HTMLButtonElement>(".tl-golive");
    if (goLive) goLive.disabled = rec.cursor === undefined;
    const scopeBtns = box.querySelectorAll(".tl-scope button");
    scopeBtns.forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.scope === this.tlScope));
    if (list) {
      const recent = rec.events.filter(e => rec.cursor === undefined || e.t <= rec.cursor).slice(-40).reverse();
      const key = recent.map((e) => e.t + e.text).join("|");
      if ((list as any).__key !== key) {
        (list as any).__key = key;
        list.replaceChildren(...recent.map((e) => el("button", { type: "button", class: `tl-ev ${e.kind}`, title: new Date(e.t).toLocaleTimeString() + (e.text.includes("\n") ? "\n" + e.text : ""), onclick: () => { rec.cursor = e.t; this.refreshTimeline(); this.updateTelemetry(this.link?.telemetry ?? [], this.link?.status ?? ""); } },
          el("span", { class: "tl-t" }, end !== undefined ? `-${((end - e.t) / 1000).toFixed(1)}s` : ""), el("span", { class: "tl-k" }, e.kind), e.text.split("\n")[0] + (e.text.includes("\n") ? ` (+${e.text.split("\n").length - 1} lines)` : ""))));
        if (!recent.length) list.append(el("div", { class: "note" }, "Events (status changes, button presses, shots, host log lines, errors, fouls) appear here as they happen. Click one to jump to it."));
      }
    }
  }

  beforeRender?: () => void;
  render() {
    this.beforeRender?.();
    const t0 = performance.now();
    const active = document.activeElement as HTMLInputElement | null;
    const focusKey = active?.closest<HTMLElement>('[data-control-key]')?.dataset.controlKey;
    const focusName = active?.getAttribute('aria-label');
    const scroll = this.root.scrollTop;
    this.renderInner();
    this.root.scrollTop = scroll;
    if (active && !active.isConnected && document.activeElement === document.body) {
      const controls = focusKey ? this.root.querySelectorAll<HTMLElement>('[data-control-key]') : [];
      const row = [...controls].find(e => e.dataset.controlKey === focusKey);
      const target = row?.querySelector<HTMLElement>('input,select,textarea') ?? [...document.querySelectorAll<HTMLElement>('dialog[open] [aria-label]')].find(e => e.getAttribute('aria-label') === focusName);
      target?.focus({ preventScroll: true });
    }
    const ms = performance.now() - t0;
    if (ms > 120) this.recorder?.event(Date.now(), "note", `slow panel render ${ms.toFixed(0)} ms`);
  }
  /** panel sections in display order: everyday controls first, housekeeping last */
  private static readonly ORDER = ["Runtime — run your TeamCode", "Field & target", "Timeline & logs", "Robot", "Launcher", "Cameras", "Shooter calibration", "Hardware map", "TeamCode settings (assets)", "View & overlays", "Settings & session"];
  private renderInner() {
    // remember open/closed
    this.root.querySelectorAll("details").forEach((d) => this.openState.set((d as HTMLElement).dataset.title ?? d.querySelector("summary")!.textContent!, d.open));
    this.root.replaceChildren();
    const sections: HTMLElement[] = [];
    const addSection = (d: HTMLElement) => { sections.push(d); };
    const st = this.state;
    const open = (t: string, def: boolean) => this.openState.get(t) ?? def;
    const change = (w: Parameters<Change>[0]) => { this.onChange(w); this.render(); };
    const hints = new Map<string, string>();
    sectionCtx = { advanced: st.panelAdvanced, more: this.moreOpen, toggle: (t) => { if (this.moreOpen.has(t)) this.moreOpen.delete(t); else this.moreOpen.add(t); this.render(); }, hints };
    this.root.append(el("div", { class: "head" }, el("h1", {}, "BIOBUZZ Digital Twin"), el("button", { class: "about", title: "Who made this, licence and links", onclick: () => this.openAbout() }, "About")));
    // Quick bar: the handful of switches most people reach for first, visible before any section is opened
    const ov = st.overlays;
    this.root.append(el("div", { class: "quick" },
      chip("Infinite ammo", "Keep a ball loaded so you can practise shots without collecting. Off = the match model counts real pieces.", () => st.infiniteAmmo, (v) => { st.infiniteAmmo = v; change("sim"); }),
      chip("Hit map", "Colour every 6 in square of the mat by the chance of scoring from there (40 simulated shots each, aimed at the target cell). Fills in over a few seconds.", () => ov.hitmap, (v) => { ov.hitmap = v; change("overlays"); }),
      chip("Reachability", "Colour the mat by the flywheel RPM the launcher needs from each square (green = low, red = near max, dark = cannot reach).", () => ov.reach, (v) => { ov.reach = v; change("overlays"); }),
      chip("Other robots", "Three simulated robots on their starting marks: partner and two opponents.", () => st.opponents, (v) => { st.opponents = v; change("sim"); }),
      chip("Camera insets", "Show what each robot camera sees in the corner of the view.", () => st.pip, (v) => { st.pip = v; change("view"); }),
      chip("Top view", "Look straight down at the field (key 2); off = orbit camera (key 1).", () => st.view === "top", (v) => { st.view = v ? "top" : "orbit"; change("view"); }),
      chip("Stadium", "Audience stands, a lighting truss and sweeping colour spots around the field. Decoration only; turn off for a plain backdrop or on a slow machine.", () => st.stadium, (v) => { st.stadium = v; change("view"); }),
    ));
    // Alliance and start square: colour-matched segments; pressing the start you are already on puts the robot back on it
    const startSide = startSideOf(st.starts, st.alliance, st.hive);
    const pickStart = (side: "loading" | "far") => { setStartSide(st.starts, side); st.placeAtStartRequest = true; change("sim"); };
    this.root.append(el("div", { class: "quick seg-row" },
      el("div", { class: "seg", role: "group", "aria-label": "Alliance" },
        el("button", { class: st.alliance === "red" ? "chip red on" : "chip red", title: "Play as the red alliance (left of the audience)", onclick: () => { if (st.alliance !== "red") { st.alliance = "red"; change("sim"); } } }, "Red"),
        el("button", { class: st.alliance === "blue" ? "chip blue on" : "chip blue", title: "Play as the blue alliance", onclick: () => { if (st.alliance !== "blue") { st.alliance = "blue"; change("sim"); } } }, "Blue")),
      el("span", { class: "seg-label" }, "Start"),
      el("div", { class: "seg", role: "group", "aria-label": "Start square" },
        el("button", { class: startSide === "loading" ? "chip on" : "chip", title: "Start on the square next to our LOADING ZONE (scoring-side half). Press again to put the robot back on it.", onclick: () => pickStart("loading") }, "Loading zone"),
        el("button", { class: startSide === "far" ? "chip on" : "chip", title: "Start on the far square beyond the FLOWER (audience-side half). Press again to put the robot back on it.", onclick: () => pickStart("far") }, "Far side")),
    ));
    if (!st.introSeen) {
      this.root.append(el("div", { class: "intro" },
        el("b", {}, "New here? "), "Drive with ", el("kbd", {}, "W A S D"), ", turn with ", el("kbd", {}, "Q E"), ", press ", el("kbd", {}, "Space"), " to shoot a ball at the hive (", el("kbd", {}, "R"), " aims first). ",
        "The buttons above switch the most-used options; open a section below for its everyday settings, or pick ", el("b", {}, "All settings"), " to see everything. ", el("kbd", {}, "H"), " hides this panel.",
        el("button", { class: "dismiss", title: "Hide this note", onclick: () => { st.introSeen = true; change("view"); } }, "Got it"),
      ));
    }
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
    const settingsRows: (Row | AdvGroup)[] = [];
    if (this.link?.connected && this.link.settings && this.settingsFile) {
      const f = this.link.settings, sf = this.settingsFile;
      const differs = sf.differs(), unsaved = sf.unsaved();
      // one state at a time: not created / in sync / unsaved here / file changed elsewhere
      const state = !f.exists ? "none" : !differs ? "sync" : unsaved ? "unsaved" : "fileNewer";
      const badge = { none: ["Not saved to the repo yet", "warn"], sync: ["In sync with the repo file", "ok"], unsaved: ["Unsaved changes in this browser", "warn"], fileNewer: ["The repo file changed; this browser is behind", "warn"] }[state];
      const fl = this.sessionFlash && this.sessionFlash.until > Date.now() ? this.sessionFlash : undefined;
      this.sessionFlashEl = el("span", { class: `note aflash${fl?.bad ? " bad" : ""}` }, fl?.text ?? "");
      settingsRows.push(el("div", { class: "sub" }, "Robot configuration"));
      const diffPaths = state === "unsaved" ? sf.unsavedPaths() : state === "fileNewer" ? sf.filePaths() : [];
      settingsRows.push(el("div", { class: `status-badge ${badge[1]} full`, title: diffPaths.length ? `Differs in: ${diffPaths.join(", ")}` : "" }, el("span", { class: "dot" }), badge[0]));
      if (diffPaths.length) settingsRows.push(el("div", { class: "note full" }, "Differs in: ", el("code", {}, diffPaths.slice(0, 8).join(", ") + (diffPaths.length > 8 ? ` +${diffPaths.length - 8} more` : ""))));
      settingsRows.push(el("div", { class: "row full", style: "align-items:center;gap:6px" },
        el("button", { class: state === "sync" ? "" : "primary", ...(state === "sync" ? { disabled: "" } : {}), title: "Write every setting in this panel (robot, cameras, launcher, hardware map, overrides, calibration, starts…) to the file so it can be committed and shared", onclick: async () => { if (await this.reviewChanges("Save robot configuration", `${f.path}\n\n${diffPaths.length ? diffPaths.join("\n") : "Robot, cameras, launcher, hardware, and session settings"}`)) await sf.save(); } }, "Save robot configuration"),
        el("button", { class: state === "fileNewer" ? "primary" : "", ...(f.exists && differs ? {} : { disabled: "" }), title: f.exists ? "Replace this browser's settings with the file's" : "No file yet", onclick: () => { if (!sf.unsaved() || confirm("Replace this browser's settings with the repo file? Unsaved changes here are lost.")) { const r = sf.load(); if (!r.ok) alert(r.error); } } }, "Load from repo file"),
        this.sessionFlashEl));
      const syncRows = settingsRows.splice(0) as HTMLElement[];
      settingsRows.push(el("section", { class: "robot-config-sync full" }, ...syncRows));
      settingsRows.push(adv(el("div", { class: "note full" }, el("code", {}, f.path), f.exists && f.modified ? ` · saved ${new Date(f.modified).toLocaleString()}` : ""),
        chk("Load the repo file on connect", () => st.settingsAutoLoad, (v) => { st.settingsAutoLoad = v; change("view"); }),
        el("div", { class: "note" }, "With the host running, the file is the shared, versioned copy of these settings; the browser's storage is only a cache. On connect the file is applied unless this browser has unsaved changes.")));
    }
    addSection(section("Settings & session", open("Settings & session", false),
      ...settingsRows,
      adv(el("div", { class: "note" }, "Everything in this panel is saved in this browser's localStorage and restored on reload. Robot config = robot preset, dimensions, cameras, launcher, shot variability, hardware map and game-piece settings.")),
      el("div", { class: "sub" }, "Robot config file"),
      el("div", { class: "row full" },
        el("button", { class: "primary", onclick: () => download(`biobuzz-robot-${(st.robot.name || "robot").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`, { biobuzzRobotConfig: 1, robotPresetId: st.robotPresetId, robot: st.robot, hardware: st.hardware, noise: st.noise, capacity: st.capacity, canPollen: st.canPollen, canNectar: st.canNectar, alliance: st.alliance }) }, "Export robot config"),
        el("button", { onclick: () => upload((j) => { const src = j.biobuzzRobotConfig ? j : j.robot ? j : null; if (!src) { alert("No robot config in that file"); return; } if (src.robot) st.robot = src.robot; if (src.robotPresetId) st.robotPresetId = src.robotPresetId; if (src.hardware?.devices) st.hardware = src.hardware; if (src.noise) st.noise = { ...st.noise, ...src.noise }; if (src.capacity) st.capacity = src.capacity; if (typeof src.canPollen === "boolean") st.canPollen = src.canPollen; if (typeof src.canNectar === "boolean") st.canNectar = src.canNectar; st.selectedCameraId = st.robot.cameras[0]?.id ?? ""; change("reset"); }) }, "Import robot config"),
      ),
      adv(el("div", { class: "row full" },
        el("button", { onclick: () => download("biobuzz-session.json", st) }, "Export whole session"),
        el("button", { onclick: () => upload((j) => { Object.assign(st, j); change("reset"); }) }, "Import whole session"),
      )),
      adv(el("div", { class: "sub" }, "Danger zone"),
      el("div", { class: "row full" },
        el("button", { style: "border-color:#a33;color:#faa", onclick: () => {
          const keepAssets = !resetAssetsToo.checked && Object.keys(st.assetOverrides ?? {}).length > 0;
          if (!confirm(`Clear everything saved in this browser (robot config, cameras, hardware map, overlays)${keepAssets ? ", keeping your TeamCode asset overrides," : " including TeamCode asset overrides,"} and reload with defaults?`)) return;
          if (keepAssets) localStorage.setItem("biobuzz-twin", JSON.stringify({ assetOverrides: st.assetOverrides })); else localStorage.removeItem("biobuzz-twin");
          location.reload();
        } }, "Reset session to defaults"),
        el("button", { onclick: () => { st.robot = clonePreset(st.robotPresetId); st.selectedCameraId = st.robot.cameras[0]?.id ?? ""; change("robot"); } }, "Reset robot to preset"),
      ),
      el("div", { class: "row full", style: "align-items:center;gap:6px" }, resetAssetsToo, el("label", { style: "color:var(--muted)" }, "Reset also clears TeamCode asset overrides (otherwise they are kept)"))),
    ));

    hints.set("Robot", ROBOT_PRESETS[st.robotPresetId]?.name ?? "custom");
    hints.set("Launcher", `${Math.round(st.robot.launcher.rpm)} rpm · hood ${st.robot.launcher.elevationDeg.toFixed(0)}°`);
    hints.set("Cameras", `${st.robot.cameras.length} camera${st.robot.cameras.length === 1 ? "" : "s"}`);
    hints.set("Field & target", `${st.alliance} · ${st.hive[st.alliance]} cell`);
    hints.set("View & overlays", st.view);
    // --- Runtime (TeamCode)
    const link = this.link;
    const rtRows: (Row | AdvGroup)[] = [];
    rtRows.push(chk("Connect to runtime host", () => st.runtimeEnabled, (v) => { st.runtimeEnabled = v; change("runtime"); }));
    const urlInput = el("input", { "aria-label": "Host URL", type: "text", value: st.runtimeUrl }) as HTMLInputElement;
    urlInput.onchange = () => { st.runtimeUrl = urlInput.value; change("runtime"); };
    rtRows.push(adv([el("label", {}, "Host URL"), urlInput]));
    const statusTxt = link ? (link.connected ? `${link.status}${link.currentOpMode ? " · " + link.currentOpMode : ""}` : "not connected — run ./gradlew :host:run in runtime/") : "off";
    hints.set("Runtime — run your TeamCode", !st.runtimeEnabled ? "off" : link?.connected ? link.status : "not connected");
    // Driver-Station style status pill, refreshed live by updateTelemetry()
    const pillState = !st.runtimeEnabled ? "off" : !link?.connected ? "disconnected" : link.status.toLowerCase();
    const pillLabel: Record<string, string> = { off: "RUNTIME OFF", disconnected: "WAITING FOR HOST", idle: "READY — pick an OpMode", init: "INITIALISED", running: "RUNNING", stopped: "STOPPED", error: "ERROR" };
    this.pillEl = el("div", { class: `rt-pill ${pillState}`, id: "rt-pill" }, el("span", { class: "dot" }), el("span", { class: "label" }, pillLabel[pillState] ?? pillState.toUpperCase()), el("span", { class: "sub" }, link?.currentOpMode ?? ""), el("span", { class: "time" }, ""));
    rtRows.push(this.pillEl);
    rtRows.push(el("div", { class: "note", id: "rt-status", style: "display:none" }, `Status: ${statusTxt}`));
    if (st.runtimeEnabled && !link?.connected && new URLSearchParams(location.search).get("sim") !== "1") rtRows.push(el("div", { class: "note" }, "Start the host: pnpm sim (or ./gradlew :host:run in runtime/). This panel connects automatically."));
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
      this.telemetryEl = el("div", { class: "full telemetry-box" }, el("div", { class: "tel-line tel-empty" }, "(telemetry)"));
      rtRows.push(this.telemetryEl);
    }
    if (this.recorder) rtRows.push(el("div", { class: `note full warn-note tl-replay-note${this.recorder.cursor === undefined ? " hidden" : ""}` }, "⏪ Replaying a past moment (Timeline below). INIT, START, Start match or Reset return to live. Driving is paused until you choose Return to live."));
    rtRows.push(adv(el("div", { class: "note" }, "While an OpMode is running, its motor and servo commands drive the robot; the keyboard acts as gamepad1 (WASD left stick, Q/E right stick, Space = A, B/X/Y buttons, Shift = right trigger, Ctrl = left trigger, Z/C = bumpers, G = Home/guide (goBILDA logo button), Enter = Start, Backspace = Back, V/N = stick clicks, arrows = dpad). Use the control bar’s Gamepad selector to switch the keyboard between gamepad1 and gamepad2. Tab navigates the interface. Plug in a gamepad to use it instead.")));
    addSection(section("Runtime — run your TeamCode", open("Runtime — run your TeamCode", st.runtimeEnabled), ...rtRows));

    // --- Timeline & logs: scrub back through what happened, copy a snapshot for a teammate or an agent
    if (this.recorder) {
      const rec = this.recorder;
      const slider = el("input", { "aria-label": "Replay position", type: "range", min: "0", max: "1", step: "100", style: "width:100%" }) as HTMLInputElement;
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
        el("div", { class: "note" }, "Drag or step to replay a moment on the field (the live sim pauses; Go live resumes). Copy a snapshot to paste into a chat."),
        el("div", { class: "row tl-scope", style: "gap:4px;align-items:center" },
          el("span", { class: "note" }, "Span:"),
          el("button", { "data-scope": "run", onclick: () => { this.tlScope = "run"; this.refreshTimeline(); } }, "Latest run"),
          el("button", { "data-scope": "all", onclick: () => { this.tlScope = "all"; this.refreshTimeline(); } }, "Everything")),
        el("div", { class: "tl-mode live" }, el("span", { class: "tl-pos" }, "LIVE"), el("button", { class: "primary tl-golive", title: "Stop replaying and show the live field again", onclick: () => { stopPlay(); scrub(undefined); } }, "● Go live")),
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
          el("button", { onclick: () => { rec.clear(); this.refreshTimeline(); } }, "Clear")),
        flashEl,
        el("div", { class: "tl-events" }),
      );
      this.timelineEvents = this.timelineEl.querySelector<HTMLElement>(".tl-events") ?? undefined;
      addSection(section("Timeline & logs", open("Timeline & logs", false), this.timelineEl));
      this.refreshTimeline();
    }

    // --- TeamCode settings: JSON assets the OpModes read (robot-profile.json, ...), editable as sim-only overrides in a
    // full-width dialog; the panel section only summarises and opens it
    const buildAssetEditor = (): HTMLElement | undefined => {
      if (!(link?.connected && link.assets.length)) return undefined;
      const total = Object.values(st.assetOverrides).reduce((n, o) => n + Object.keys(o).length, 0);
      const box = el("div", { class: "assets full" });
      const filter = el("input", { "aria-label": "Search TeamCode settings", type: "text", placeholder: "Filter settings by name, description or value… e.g. autoShoot, start square, LEFT", value: this.assetFilter }) as HTMLInputElement;
      filter.oninput = () => { this.assetFilter = filter.value; renderFiles(); };
      const list = el("div", {});
      const boundCount = Object.values(link.bound.overrides).reduce((n, o) => n + Object.keys(o).length, 0);
      box.append(
        el("div", { class: "note" }, "Edits affect the simulator. Save to project writes them to your TeamCode files. Re-initialize the program to use updated settings."),
        link.bindings
          ? el("div", { class: "note" }, `Twin bindings: ${link.bindings.path} binds ${boundCount} key${boundCount === 1 ? "" : "s"} to twin knobs (marked ⇐ below, read-only here: change the twin instead).`)
          : el("div", { class: "note" }, "No TeamCode/twin-bindings.json in the team repo: settings that mirror the robot (wheel size, ticks, camera mount, alliance) can be derived from the twin's knobs instead of being typed twice. See README → Twin bindings."),
        ...link.bound.errors.map((e) => el("div", { class: "note", style: "color:#ff8888" }, `binding error: ${e}`)),
        el("details", { class: "advanced-import full" }, el("summary", {}, "Advanced: twin setting catalogue"), el("button", { title: "Every twin knob a binding can reference, with its current value", onclick: () => { const blob = new Blob([JSON.stringify(twinKnobs(st), null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "twin-knobs.json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } }, "Download twin knob catalogue")),
        el("div", { class: "arow tools" }, filter, el("button", { ...(total ? {} : { disabled: "" }), title: "Forget every override in every file", onclick: () => { st.assetOverrides = {}; change("assets"); } }, `Clear all${total ? ` (${total})` : ""}`)),
        (() => {
          // paste settings an agent conveyed in chat ("key": value lines or a JSON fragment) and apply them as overrides
          const ta = el("textarea", { "aria-label": "Paste JSON settings", rows: 3, class: "full", placeholder: 'Paste settings from an agent, e.g.\n"matchAuto.startPosition": "FAR_SIDE",\n"matchAuto.loadingZoneDistanceIn": 72' }) as HTMLTextAreaElement;
          const target = el("select", { "aria-label": "Destination settings file" }) as HTMLSelectElement;
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
          return el("details", { class: "advanced-import full" }, el("summary", {}, "Advanced: paste or import settings"), ta, el("div", { class: "row", style: "align-items:center;gap:6px" }, target, apply, status));
        })(),
        (() => {
          // export: the committed files with every override and twin-bound value applied, in the file's own format
          const changed = exportChangedAssets(link.assets, st.assetOverrides, link.bound.overrides);
          const nKeys = changed.reduce((n, c) => n + c.changed.length, 0);
          this.assetFlashEl = el("span", { class: "note aflash" }, "");
          const saveAll = async () => {
            const list = changed.map((c) => `${c.path}:\n${c.changed.map((k) => `  ${k.key}: ${JSON.stringify(k.from)} → ${JSON.stringify(k.to)}${k.source === "twin" ? " (twin)" : ""}`).join("\n")}`).join("\n");
            if (!await this.reviewChanges("Save TeamCode settings", list)) return;
            for (const c of changed) await this.saveAssetToRepo?.(c.path);
          };
          return el("div", { class: "arow tools" },
            el("button", { class: "primary", ...(changed.length && this.saveAssetToRepo ? {} : { disabled: "" }), title: changed.length ? "Write every changed file into TeamCode/src/main/assets on disk (server mode)" : "No file differs from what is on disk", onclick: saveAll }, changed.length ? `Review ${changed.length} changed file${changed.length > 1 ? "s" : ""}` : "Review changes"),
            this.assetFlashEl,
            el("button", { ...(changed.length ? {} : { disabled: "" }), title: changed.map((c) => `${c.path}: ${c.changed.map((k) => k.key).join(", ")}`).join("\n") || "No file differs from what is committed", onclick: () => { for (const c of changed) downloadText(c.path.split("/").pop()!, c.text); } },
              changed.length ? `Export ${changed.length} changed file${changed.length > 1 ? "s" : ""} (${nKeys} value${nKeys > 1 ? "s" : ""})` : "Export changed files"),
            el("span", { class: "note" }, changed.length ? "Save writes the files with your overrides and the twin-bound values into the team repo (original key order and indentation), ready to commit; Export downloads them instead." : "When settings here differ from the files on disk, Save writes them back into the repo (Export downloads them)."));
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
          if (isSchemaFile(file.path)) continue; // sidecars describe their asset; they are not settings
          let json: unknown;
          try { json = JSON.parse(file.text); } catch { list.append(el("div", { class: "note" }, `${file.path}: not valid JSON`)); continue; }
          const schema = schemaFor(link.assets, file.path);
          const ov = st.assetOverrides[file.path] ?? {};
          const n = Object.keys(ov).length;
          const body = el("div", { class: "abody" });
          let shown = 0;
          // walk the tree: objects become indented group headings, everything else a row
          const walk = (v: unknown, key: string, name: string, depth: number) => {
            const node = nodeAt(schema, key);
            if (v && typeof v === "object" && !Array.isArray(v)) {
              const entries = Object.entries(v as Record<string, unknown>);
              const head = key ? el("div", { class: "agroup", style: `padding-left:${depth * 10}px`, title: node?.description ?? "" }, name, node?.description ? el("span", { class: "adesc" }, ` — ${node.description}`) : "") : null;
              const before = shown;
              if (head) body.append(head);
              for (const [k, x] of entries) walk(x, key ? `${key}.${k}` : k, k, key ? depth + 1 : depth);
              if (head && shown === before) head.remove(); // nothing matched the filter in this group
              return;
            }
            if (q && !(searchText(key, node) + " " + JSON.stringify(ov[key] ?? v)).toLowerCase().includes(q)) return;
            shown++;
            const boundSrc = link.bound.sources[file.path]?.[key];
            if (boundSrc !== undefined) {
              const bv = link.bound.overrides[file.path][key];
              body.append(el("div", { class: "arow over bound", style: `padding-left:${depth * 10}px` }, el("label", { title: `${key} ⇐ ${boundSrc}` }, friendly(name)), el("span", { class: "bval" }, typeof bv === "string" ? bv : JSON.stringify(bv))),
                el("div", { class: "ahint", style: `padding-left:${depth * 10}px` }, `Linked to Robot setup: ${boundSrc} · project: ${fmt(v)}`, el("button", { class: "text-button", onclick: () => { this.assetDialog?.close(); document.dispatchEvent(new CustomEvent("open-twin-setting", { detail: boundSrc })); } }, "Open linked setting")));
              return;
            }
            const has = key in ov;
            const value = has ? ov[key] : v;
            const problem = validate(node, value);
            const label = el("label", { title: `${key}${node?.description ? "\n" + node.description : ""}` }, friendly(name));
            const row = el("div", { class: `arow${has ? " over" : ""}${problem ? " invalid" : ""}`, style: `padding-left:${depth * 10}px`, "data-setting": key }, label);
            let control: HTMLElement;
            const commit = (x: unknown) => setOv(file.path, key, x, v);
            if (node?.enum && !(typeof value === "boolean")) {
              // enumerated setting: a select listing the allowed values (plus the current one if it is not allowed)
              const sel = el("select") as HTMLSelectElement;
              const opts = [...node.enum];
              if (!opts.some((o) => JSON.stringify(o) === JSON.stringify(value))) opts.unshift(value);
              for (const o of opts) sel.append(el("option", { value: JSON.stringify(o), selected: JSON.stringify(o) === JSON.stringify(value) ? "" : undefined }, o === null ? "null" : typeof o === "string" ? o : JSON.stringify(o)));
              sel.onchange = () => commit(JSON.parse(sel.value)); control = sel;
            } else if (typeof value === "boolean") {
              const c = el("input", { type: "checkbox" }) as HTMLInputElement; c.checked = value; c.onchange = () => commit(c.checked); control = c;
            } else if (node && hasRange(node) && (typeof value === "number" || value === null) && isNumeric(node)) {
              // ranged number: slider + exact box
              const lo = node.minimum ?? node.exclusiveMinimum!, hi = node.maximum ?? node.exclusiveMaximum!;
              const step = isInteger(node) ? 1 : node.multipleOf ?? Math.max(0.001, +((hi - lo) / 200).toPrecision(1));
              const range = el("input", { type: "range", min: String(lo), max: String(hi), step: String(step), value: value === null ? String(lo) : String(value), class: "arange" }) as HTMLInputElement;
              const box = el("input", { type: "number", step: isInteger(node) ? "1" : "any", value: value === null ? "" : String(value), placeholder: nullable(node) ? "null" : "", class: "anum" }) as HTMLInputElement;
              range.oninput = () => { box.value = range.value; };
              range.onchange = () => commit(isInteger(node) ? Math.round(+range.value) : +range.value);
              box.onchange = () => { const x = parseFloat(box.value); commit(Number.isNaN(x) ? null : isInteger(node) ? Math.round(x) : x); };
              control = el("div", { class: "aranged" }, range, box);
            } else if (typeof value === "number" || (value === null && (typeof v === "number" || (node && isNumeric(node))))) {
              const i = el("input", { type: "number", step: node && isInteger(node) ? "1" : "any", value: value === null ? "" : String(value), placeholder: "null" }) as HTMLInputElement;
              i.onchange = () => { const x = parseFloat(i.value); commit(Number.isNaN(x) ? null : x); }; control = i;
            } else if (typeof value === "string" || value === null) {
              const i = el("input", { type: "text", value: value ?? "", placeholder: value === null ? "null — type a number, true/false or text" : "", class: "atext" }) as HTMLInputElement;
              i.onchange = () => { const t = i.value; let x: unknown = t; if (t === "") x = null; else if (t === "true" || t === "false") x = t === "true"; else if (/^-?\d+(\.\d+)?$/.test(t)) x = parseFloat(t); setOv(file.path, key, x, v); }; control = i;
            } else {
              // arrays and other structures: raw JSON
              const ta = el("textarea", { rows: "2", class: "ajson", spellcheck: "false" }) as HTMLTextAreaElement; ta.value = JSON.stringify(value);
              ta.onchange = () => { try { setOv(file.path, key, JSON.parse(ta.value), v); } catch { ta.classList.add("bad"); } }; control = ta;
            }
            const inputs = control.matches("input,select,textarea") ? [control] : [...control.querySelectorAll("input,select,textarea")];
            inputs.forEach((input, i) => { const l = labelControl(`${friendly(key)}${i ? " exact value" : ""}`, input as HTMLElement); input.setAttribute("aria-invalid", String(!!problem)); if (!i) label.htmlFor = l.htmlFor; });
            row.append(control, el("span", { class: "source-badge" }, has ? "Modified in simulator" : "From project"));
            if (has) row.append(el("button", { class: "reset", title: `Back to the file's value: ${fmt(v)}`, onclick: () => setOv(file.path, key, v, v) }, "↺"));
            body.append(row);
            // help: description and constraints from the schema, the file's value when overridden, the problem if any
            const hints: string[] = [];
            if (node?.description) hints.push(node.description);
            const c = constraintText(node); if (c && !node?.enum) hints.push(c);
            if (has) hints.push(`file: ${fmt(v)}`);
            if (problem) hints.push(`⚠ ${problem}`);
            if (hints.length) body.append(el("div", { class: `ahint${problem ? " bad" : ""}`, style: `padding-left:${depth * 10}px` }, hints.join(" · ")));
          };
          walk(json, "", "", 0);
          if (q && !shown) continue;
          const openIt = q ? true : (this.assetOpen.get(file.path) ?? true);
          let exported: ReturnType<typeof applyOverrides> | undefined;
          try { exported = applyOverrides(file, ov, link.bound.overrides[file.path]); } catch { /* shown as invalid above */ }
          const diff = exported?.changed.length ?? 0;
          const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
          const merged = (() => { try { return JSON.parse(exported?.text ?? file.text); } catch { return json; } })();
          const problems = validateAll(merged, schema);
          const det = el("details", { class: "afile", ...(openIt ? { open: "" } : {}) },
            el("summary", {}, el("span", { class: "name", title: file.path }, friendly(file.path.split("/").pop()!.replace(/\.json$/, ""))), n ? el("span", { class: "badge" }, `${n} override${n > 1 ? "s" : ""}`) : "",
              schema ? el("span", { class: `badge ${problems.length ? "bad" : "ok"}`, title: problems.length ? problems.map((x) => `${x.key}: ${x.error}`).join("\n") : `${file.path.replace(/\.json$/, ".schema.json")} describes these settings` }, problems.length ? `${problems.length} invalid` : "schema ✓") : file.path.startsWith("web/") ? "" : el("span", { class: "badge quiet", title: `Add ${file.path.replace(/\.json$/, ".schema.json")} next to the asset (JSON Schema: description, enum, minimum/maximum, type) to get help text, dropdowns, sliders and validation here` }, "no schema"),
              el("button", { class: "primary", ...(diff && this.saveAssetToRepo ? {} : { disabled: "" }), title: diff ? `Write ${file.path} on disk with these values (${exported!.changed.map((c) => c.key).join(", ")}) — the file the robot build uses` : "Matches the file on disk", onclick: async (e: Event) => { stop(e); if (!exported) return; const list = exported.changed.map((k) => `  ${k.key}: ${JSON.stringify(k.from)} → ${JSON.stringify(k.to)}${k.source === "twin" ? " (twin)" : ""}`).join("\n"); if (await this.reviewChanges(`Save ${file.path}`, list)) await this.saveAssetToRepo?.(file.path); } }, "Save"),
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
      return box;
    };
    this.assetEditorBuilder = buildAssetEditor;
    if (link?.connected && link.assets.length) {
      const files = link.assets.filter((a) => a.path.endsWith(".json") && !isSchemaFile(a.path));
      const total = Object.values(st.assetOverrides).reduce((n, o) => n + Object.keys(o).length, 0);
      const bound = Object.values(link.bound.overrides).reduce((n, o) => n + Object.keys(o).length, 0);
      const changed = exportChangedAssets(link.assets, st.assetOverrides, link.bound.overrides);
      let invalid = 0;
      for (const f of files) { try { invalid += validateAll(JSON.parse(applyOverrides(f, st.assetOverrides[f.path], link.bound.overrides[f.path]).text), schemaFor(link.assets, f.path)).length; } catch { /* shown in the editor */ } }
      const summaryRows: (Row | AdvGroup)[] = [
        el("div", { class: `status-badge ${changed.length ? "warn" : "ok"} full` }, changed.length ? `${changed.length} changed file${changed.length === 1 ? "" : "s"} to save` : "In sync with project files"),
        el("div", { class: "note full" }, `${files.length} file${files.length === 1 ? "" : "s"} · ${total} override${total === 1 ? "" : "s"} · ${bound} bound from the twin${invalid ? ` · ${invalid} invalid` : ""}${changed.length ? ` · ${changed.length} file${changed.length > 1 ? "s" : ""} differ${changed.length > 1 ? "" : "s"} from disk` : " · matches disk"}`),
        el("div", { class: "row full", style: "gap:6px;align-items:center" },
          el("button", { class: "primary", onclick: () => this.openAssetDialog() }, "Open settings editor"),
          el("button", { ...(changed.length && this.saveAssetToRepo ? {} : { disabled: "" }), title: changed.length ? "Write every changed file into TeamCode/src/main/assets" : "Nothing differs from disk", onclick: async () => { const list = changed.map((c) => `${c.path}:\n${c.changed.map(k => `${k.key}: ${JSON.stringify(k.from)} → ${JSON.stringify(k.to)}`).join("\n")}`).join("\n\n"); if (await this.reviewChanges("Save TeamCode settings", list)) for (const c of changed) await this.saveAssetToRepo?.(c.path); } }, changed.length ? `Review & save TeamCode (${changed.length})` : "Save TeamCode settings")),
        adv(el("div", { class: "note" }, "The OpModes read these JSON files from assets. Edits are simulator-only overrides until you Save them to the repo; bound values (⇐) come from the twin's measurements; a schema sidecar gives help, dropdowns, sliders and validation.")),
      ];
      if (invalid) summaryRows.push(el("div", { class: "status-badge bad full" }, el("span", { class: "dot" }), `${invalid} value${invalid > 1 ? "s" : ""} the code will reject at INIT — open the editor`));
      addSection(section("TeamCode settings (assets)", open("TeamCode settings (assets)", false), ...summaryRows));
    }

    // --- Hardware map
    const hw = st.hardware;
    const hwRows: (Row | AdvGroup)[] = [];
    hwRows.push(adv(el("div", { class: "note" }, "Names must match what your OpMode passes to hardwareMap.get(). Roles tell the sim what each device moves.")));
    hwRows.push(sel("Mirrored drive side", [{ value: "left", label: "Left motors mirrored (code reverses left)" }, { value: "right", label: "Right motors mirrored (code reverses right)" }, { value: "none", label: "None (positive power = forward on all)" }], () => hw.mirroredSide ?? "left", (v) => { hw.mirroredSide = v as any; change("hardware"); }));
    const devRows: Row[] = [];
    hw.devices.forEach((d, i) => {
      devRows.push(el("div", { class: "sub" }, `${d.kind}: ${d.name}`));
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
    addSection(section("Hardware map", open("Hardware map", false), ...hwRows));

    // --- Robot
    const r = st.robot;
    addSection(section("Robot", open("Robot", false),
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
      const nameInput = el("input", { type: "text", value: c.name, "aria-label": "Camera name" }) as HTMLInputElement;
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
    addSection(section("Cameras", open("Cameras", false), ...outerCamRows));

    // --- Launcher
    const l = r.launcher;
    addSection(section("Launcher", open("Launcher", true),
      sel("Preset", Object.entries(LAUNCHER_PRESETS).map(([k, v]) => ({ value: k, label: v.name })), () => Object.entries(LAUNCHER_PRESETS).find(([, v]) => v.name === l.name)?.[0] ?? "custom", (v) => { r.launcher = { ...LAUNCHER_PRESETS[v] }; change("launcher"); }),
      sel("Ball", [{ value: "pollen", label: "POLLEN (2.8 in, 25 g)" }, { value: "nectar", label: "NECTAR (3.6 in, 41 g)" }], () => st.ballKind, (v) => { st.ballKind = v as any; change("launcher"); }),
      adv(num("Flywheel dia", () => l.wheelDiameterM * 1000, (v) => { l.wheelDiameterM = v / 1000; change("launcher"); }, { unit: "mm", min: 40, max: 200, step: 1 }),
      num("Max RPM", () => l.maxRpm, (v) => { l.maxRpm = v; change("launcher"); }, { min: 100, max: 12000, step: 10 }),
      num("Efficiency", () => l.efficiency, (v) => { l.efficiency = v; change("launcher"); }, { min: 0.1, max: 1, step: 0.01 })),
      num("Commanded RPM", () => l.rpm, (v) => { l.rpm = v; change("launcher"); }, { min: 0, max: 12000, step: 10 }),
      num("Hood angle", () => l.elevationDeg, (v) => { l.elevationDeg = Math.min(89, Math.max(0, v)); if (l.elevationMinDeg === l.elevationMaxDeg) l.elevationMinDeg = l.elevationMaxDeg = l.elevationDeg; change("launcher"); }, { unit: "°", min: 0, max: 89, step: 0.5 }),
      adv(num("Hood min", () => l.elevationMinDeg, (v) => { l.elevationMinDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 89, step: 0.5 }),
      num("Hood max", () => l.elevationMaxDeg, (v) => { l.elevationMaxDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 89, step: 0.5 }),
      num("Exit height", () => l.exitHeightM / IN, (v) => { l.exitHeightM = v * IN; change("launcher"); }, { unit: "in", min: 1, max: 29, step: 0.25 }),
      num("Exit forward", () => l.exitForwardM / IN, (v) => { l.exitForwardM = v * IN; change("launcher"); }, { unit: "in", min: -12, max: 12, step: 0.25 }),
      num("Exit left", () => l.exitLeftM / IN, (v) => { l.exitLeftM = v * IN; change("launcher"); }, { unit: "in", min: -12, max: 12, step: 0.25 })),
      num("Launcher yaw", () => l.yawOffsetDeg, (v) => { l.yawOffsetDeg = v; change("launcher"); }, { unit: "°", min: -180, max: 180, step: 5 }),
      adv(el("div", { class: "note" }, "Launcher yaw is the fixed direction the shooter points relative to the robot's forward arrow (0 = forward, as the StarterBot presets are set up with the hood side forward; 180 = out the back). Drag the orange exit marker on the robot to move it; Alt-drag for height. It is hidden from the camera views."),
      num("Turret min", () => l.turretMinDeg, (v) => { l.turretMinDeg = v; change("launcher"); }, { unit: "°", min: -180, max: 0, step: 1 }),
      num("Turret max", () => l.turretMaxDeg, (v) => { l.turretMaxDeg = v; change("launcher"); }, { unit: "°", min: 0, max: 180, step: 1 }),
      num("Backspin fraction", () => l.spinFraction, (v) => { l.spinFraction = v; change("launcher"); }, { min: 0, max: 1, step: 0.05 })),
      chk("Infinite ammo (practice)", () => st.infiniteAmmo, (v) => { st.infiniteAmmo = v; change("sim"); }),
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
      el("div", { class: "note" }, "Infinite ammo keeps a ball of the selected kind loaded so you can play with hood angle and power without collecting; the field's pieces, the intake and the other robots behave as usual. Off by default: the match model counts real pieces."),
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
    addSection(calSec);

    addSection(section("Field & target", open("Field & target", true),
      sel("Our alliance", [{ value: "red", label: "Red (left of audience)" }, { value: "blue", label: "Blue" }], () => st.alliance, (v) => { st.alliance = v as any; change("sim"); }),
      sel("Red hive up cell", [{ value: "audience", label: "Audience side (match start)" }, { value: "scoring", label: "Scoring side" }], () => st.hive.red, (v) => { st.hive.red = v as any; change("sim"); }),
      sel("Blue hive up cell", [{ value: "scoring", label: "Scoring side (match start)" }, { value: "audience", label: "Audience side" }], () => st.hive.blue, (v) => { st.hive.blue = v as any; change("sim"); }),
      adv(chk("Hives tip when loaded", () => st.autoTip, (v) => { st.autoTip = v; change("sim"); }),
      num("Tip load", () => st.tipMassG, (v) => { st.tipMassG = v; change("sim"); }, { unit: "g", min: 50, max: 600, step: 1 }),
      el("div", { class: "note" }, "Field staff calibrate each cell to tip at 8 POLLEN or 3 NECTAR + 3 POLLEN (198.6 g, so the default threshold is 195 g). The up cell starts with 3 NECTAR, so three POLLEN in tips it. A heavier load tips faster. When it tips the contents fall out and the other cell comes up, facing the other way, so you must move to keep scoring. T or the selectors above reset the hive to match start.")),
      chk("Simulated other robots", () => st.opponents, (v) => { st.opponents = v; change("sim"); }),
      adv(chk("Other robots use the CAD chassis", () => st.opponentsCad, (v) => { st.opponentsCad = v; change("sim"); }),
        el("div", { class: "note" }, "Off by default to save frames: three more copies of the goBILDA CAD, tinted red or blue.")),
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
      adv(el("div", { class: "note" }, "Reset parks every robot on its starting mark with the field at match start; Start releases the 2:30 clock and the other robots. With TeamCode connected, INIT resets and START/STOP do the same for the whole field.")),
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
    addSection(section("View & overlays", open("View & overlays", false),
      sel("Main view", [{ value: "orbit", label: "Orbit (1)" }, { value: "top", label: "Top-down (2)" }, { value: "chase", label: "Chase (3)" }, { value: "robot", label: "Robot camera (4)" }], () => st.view, (v) => { st.view = v as any; change("view"); }),
      chk("Camera insets (all cameras)", () => st.pip, (v) => { st.pip = v; change("view"); }),
      chk("Stadium backdrop", () => st.stadium, (v) => { st.stadium = v; change("view"); }),
      chk("Spinning wheels on the CAD", () => st.wheelSpin, (v) => { st.wheelSpin = v; change("view"); }),
      adv(el("div", { class: "note" }, "Carves the wheels out of the CAD mesh once and turns them with the drive (mecanum rollers spin for strafes too). On by default; the carve is a one-off pass.")),
      adv(chk("Arc if aimed at target (green/red)", () => o.trajectory, (v) => { o.trajectory = v; change("overlays"); }),
      chk("Arc as launcher points now (orange)", () => o.actualArc, (v) => { o.actualArc = v; change("overlays"); }),
      chk("Dispersion cloud", () => o.dispersion, (v) => { o.dispersion = v; change("overlays"); }),
      chk("Feasible-angle fan", () => o.fan, (v) => { o.fan = v; change("overlays"); }),
      chk("FOV footprint on mat", () => o.footprint, (v) => { o.footprint = v; change("overlays"); }),
      chk("Camera frustum", () => o.frustum, (v) => { o.frustum = v; change("overlays"); }),
      chk("Target opening", () => o.target, (v) => { o.target = v; change("overlays"); }),
      chk("Aim line", () => o.aim, (v) => { o.aim = v; change("overlays"); })),
      sel("Field overlay", [{ value: "none", label: "No overlay" }, { value: "hitmap", label: "Hit map" }, { value: "reach", label: "Reachability" }], () => o.hitmap ? "hitmap" : o.reach ? "reach" : "none", (v) => { o.hitmap = v === "hitmap"; o.reach = v === "reach"; change("overlays"); }),
      adv(el("div", { class: "note" }, "Reachability colours the mat by the flywheel RPM needed to hit the target cell from each 6 in square with the current launcher (green = low, red = near max, dark = cannot reach). Recomputed when launcher or target change.")),
      adv(el("div", { class: "note" }, "For every 6 in square: aim at the target cell, use the hood/RPM the launcher would need from there, and fire 40 simulated shots with the configured shot variability. Green = always in, red = never. Squares are dimmed where the selected camera would not see any of the target cell's AprilTags, so auto-aim could not lock on. Fills in over a few seconds; the map for the other cell is then computed in the background so it swaps instantly when the hive tips or you press T. Recomputes when you change the launcher, variability, hood or cameras.")),
      adv(chk("Performance stats", () => st.showPerf, (v) => { st.showPerf = v; change("view"); }),
      el("div", { class: "note" }, "Export, import and reset live in Settings & session at the bottom.")),
    ));
    // lay the sections out in ORDER (anything new goes last), then refresh the bits that read the DOM
    const title = (d: HTMLElement) => d.dataset.title ?? "";
    sections.sort((a, b) => { const ia = Panel.ORDER.indexOf(title(a)), ib = Panel.ORDER.indexOf(title(b)); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    this.root.append(...sections);
    this.decorate?.();
    this.refreshTimeline();
    if (this.assetDialogOpen) this.renderAssetDialog();
  }
}
