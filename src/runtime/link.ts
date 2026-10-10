/** WebSocket client to the JVM runtime host. */
export interface OpModeInfo { name: string; group: string; flavor: "TeleOp" | "Autonomous"; className: string }
export type RunStatus = "IDLE" | "INIT" | "RUNNING" | "STOPPED" | "ERROR" | "DISCONNECTED";

export interface GamepadPacket {
  lx: number; ly: number; rx: number; ry: number; lt: number; rt: number;
  a: boolean; b: boolean; x: boolean; y: boolean; lb: boolean; rb: boolean; back: boolean; start: boolean; guide: boolean;
  du: boolean; dd: boolean; dl: boolean; dr: boolean; ls: boolean; rs: boolean;
}
export const emptyGamepad = (): GamepadPacket => ({ lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, a: false, b: false, x: false, y: false, lb: false, rb: false, back: false, start: false, guide: false, du: false, dd: false, dl: false, dr: false, ls: false, rs: false });

export interface TagPacket {
  id: number; cx: number; cy: number;
  x: number; y: number; z: number; yaw: number; pitch: number; roll: number; range: number; bearing: number; elevation: number;
  robotX: number; robotY: number; robotYaw: number;
  /** tag->camera rotation, row-major 3x3, OpenCV camera axes (x right, y down, z forward); tag z points into the tag */
  R: number[];
  /** how old the frame already is when sent (a camera-latency fault); the host backdates frameAcquisitionNanoTime */
  ageMs?: number;
}

export interface SensorPacket {
  type: "sensors";
  motors: Record<string, { pos: number; vel: number; amps?: number }>;
  imu: { yaw: number; pitch: number; roll: number; yawRate: number };
  distances: Record<string, number>;
  tags: Record<string, TagPacket[]>;
  gamepad1: GamepadPacket;
  gamepad2: GamepadPacket;
  battery: number;
  /** perception level flags for the shim (singles: individual-tag detections instead of SDK clusters) */
  perception?: { singles: boolean };
}

export class RuntimeLink {
  private ws?: WebSocket;
  private url: string;
  connected = false;
  status: RunStatus = "DISCONNECTED";
  statusError = "";
  currentOpMode = "";
  /** when the current status began (performance.now ms) */
  statusSince = performance.now();
  opModes: OpModeInfo[] = [];
  telemetry: string[] = [];
  /** latest actuator commands by device name */
  actuators: Record<string, any> = {};
  /** every servo position change seen on the wire, so brief pulses are not lost between render frames */
  servoTransitions: { name: string; from: number; to: number }[] = [];
  private lastServo: Record<string, number> = {};
  onChange: () => void = () => {};
  /** TeamCode asked for a device the hardware map does not have */
  onMissingDevice: (name: string, requested: string) => void = () => {};
  /** human-readable notes for the panel */
  notes: string[] = [];
  /** JSON assets found in the TeamCode assets folder (hardwareMap.appContext.getAssets()) */
  assets: { path: string; text: string }[] = [];
  /** host console lines (OpMode prints, RobotLog, exceptions) */
  onLog: (level: string, text: string, millis: number) => void = () => {};
  /** the host wrote (or refused to write) an asset file back to the team repo */
  onAssetWritten: (r: { path: string; ok: boolean; file?: string; error?: string }) => void = () => {};
  /** server mode: the repo's twin-settings.json as last reported by the host */
  settings?: { path: string; exists: boolean; text?: string; modified?: number };
  onSettings: (s: { path: string; exists: boolean; text?: string; modified?: number }) => void = () => {};
  onSettingsSaved: (r: { ok: boolean; path?: string; error?: string }) => void = () => {};
  /** TeamCode/twin-bindings.json from the team repo, when present */
  bindings?: { path: string; text: string };
  /** latest evaluation of the bindings (filled by the app) */
  bound: { overrides: Record<string, Record<string, unknown>>; sources: Record<string, Record<string, string>>; errors: string[] } = { overrides: {}, sources: {}, errors: [] };
  /** the real FTC Panels dashboard the host serves (undefined when the host runs without it) */
  panelsUrl?: string;
  /** local HTTP API on the host for agents (AgentApi.java); requests arrive here as {type:"agent"} and are answered by main */
  agentUrl?: string;
  /** the TeamCode checkout the host compiled (path, revision, dirty) and the host process, for run manifests */
  hostInfo?: { path?: string; revision?: string; dirty?: boolean; hostPid?: number };
  onAgent: (action: string, params: Record<string, unknown>) => Promise<{ result?: unknown; contentType?: string }> = async () => { throw new Error("no agent handler"); };
  private retryTimer?: number;
  private reconnect = false;
  private lastSend = 0;

  constructor(url = "ws://127.0.0.1:8765") { this.url = url; }

  connect() {
    this.reconnect = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    try { this.ws = new WebSocket(this.url); } catch { this.scheduleRetry(); return; }
    this.ws.onopen = () => { this.connected = true; this.status = "IDLE"; this.statusSince = performance.now(); this.onChange(); };
    this.ws.onclose = () => { this.connected = false; this.status = "DISCONNECTED"; this.statusSince = performance.now(); this.opModes = []; this.actuators = {}; this.onChange(); this.scheduleRetry(); };
    this.ws.onerror = () => { /* onclose follows */ };
    this.ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
  }
  /** Drain queued servo transitions. */
  takeServoTransitions() { const t = this.servoTransitions; this.servoTransitions = []; return t; }
  disconnect() { this.reconnect = false; if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = undefined; this.ws?.close(); this.ws = undefined; }
  private scheduleRetry() { if (!this.reconnect || this.retryTimer) return; this.retryTimer = window.setTimeout(() => { this.retryTimer = undefined; this.connect(); }, 1500); }

  private handle(msg: any) {
    switch (msg.type) {
      case "actuators": {
        this.actuators = msg.devices ?? {};
        for (const [name, d] of Object.entries<any>(this.actuators)) {
          if (d.kind !== "servo" && d.kind !== "crservo") continue;
          const val = d.kind === "servo" ? d.position : Math.abs(d.power ?? 0);
          const prev = this.lastServo[name];
          if (prev !== undefined && prev !== val) this.servoTransitions.push({ name, from: prev, to: val });
          this.lastServo[name] = val;
        }
        if (this.servoTransitions.length > 200) this.servoTransitions.splice(0, this.servoTransitions.length - 200);
        break;
      }
      case "opmodes": this.opModes = msg.opModes ?? []; this.panelsUrl = msg.panelsUrl || undefined; this.agentUrl = msg.agentUrl || undefined; this.hostInfo = { ...(msg.team ?? {}), hostPid: msg.hostPid }; this.onChange(); break;
      case "agent": { // an agent asked the host something only the browser session knows or can do
        const id = msg.id as string;
        this.onAgent(String(msg.action ?? ""), (msg.params ?? {}) as Record<string, unknown>)
          .then((r) => this.send({ type: "agentReply", id, ok: true, result: r.result ?? null, contentType: r.contentType ?? "application/json" }))
          .catch((e) => this.send({ type: "agentReply", id, ok: false, error: String(e?.message ?? e) }));
        break;
      }
      case "status": { const prev = this.status; this.status = msg.status; this.currentOpMode = msg.opMode ?? ""; this.statusError = msg.error ?? ""; if (prev !== this.status) this.statusSince = performance.now(); this.onChange(); break; }
      case "telemetry": this.telemetry = msg.lines ?? []; break;
      case "missingDevice": this.onMissingDevice(msg.name, msg.requested); break;
      case "assetWritten": this.onAssetWritten({ path: msg.path, ok: !!msg.ok, file: msg.file, error: msg.error }); break;
      case "settings": this.settings = { path: msg.path, exists: !!msg.exists, text: msg.text, modified: msg.modified }; this.onSettings(this.settings); break;
      case "settingsSaved": this.onSettingsSaved({ ok: !!msg.ok, path: msg.path, error: msg.error }); break;
      case "log": this.onLog(msg.level ?? "out", msg.text ?? "", msg.millis ?? Date.now()); break;
      case "assets": {
        // Panels' web UI files are not robot settings (older hosts still send them)
        this.assets = (msg.files ?? []).filter((f: { path: string }) => !/^web\/(app|plugins|biobuzz-)/.test(f.path));
        this.bindings = msg.bindings && msg.bindings.text ? msg.bindings : undefined;
        this.onChange();
        break;
      }
    }
  }
  private send(o: unknown) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  sendHardware(devices: unknown[], hints?: unknown) { this.send({ type: "hardware", devices, hints }); }
  /** asset path -> dotted key -> value; the host merges these into the JSON the OpMode reads at INIT */
  /** ask the host to re-read the TeamCode assets (and twin-bindings.json) from disk and send them again */
  reloadAssets() { this.send({ type: "list" }); }
  sendAssetOverrides(overrides: Record<string, Record<string, unknown>>, persisted: Record<string, Record<string, unknown>> = {}) { this.send({ type: "assetOverrides", overrides, persisted }); }
  /** a finished run (samples + events + context) for the host to keep under runtime/runs/ */
  sendRun(run: unknown) { this.send({ type: "run", run }); }
  /** server mode: ask the host to write the merged settings file into the team's assets folder */
  writeAsset(path: string, text: string) { this.send({ type: "writeAsset", path, text }); }
  saveSettings(text: string) { this.send({ type: "settingsSave", text }); }
  requestSettings() { this.send({ type: "settingsLoad" }); }
  sendSensors(p: SensorPacket) { const now = performance.now(); if (now - this.lastSend < 15) return; this.lastSend = now; this.send(p); }
  init(opMode: string) { this.send({ type: "init", opMode }); }
  start() { this.send({ type: "start" }); }
  stop() { this.send({ type: "stop" }); }
  get running() { return this.connected && (this.status === "INIT" || this.status === "RUNNING"); }
}
