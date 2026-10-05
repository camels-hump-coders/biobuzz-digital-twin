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
}

export interface SensorPacket {
  type: "sensors";
  motors: Record<string, { pos: number; vel: number }>;
  imu: { yaw: number; pitch: number; roll: number; yawRate: number };
  distances: Record<string, number>;
  tags: Record<string, TagPacket[]>;
  gamepad1: GamepadPacket;
  gamepad2: GamepadPacket;
  battery: number;
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
  /** TeamCode/twin-bindings.json from the team repo, when present */
  bindings?: { path: string; text: string };
  /** latest evaluation of the bindings (filled by the app) */
  bound: { overrides: Record<string, Record<string, unknown>>; sources: Record<string, Record<string, string>>; errors: string[] } = { overrides: {}, sources: {}, errors: [] };
  /** the real FTC Panels dashboard the host serves (undefined when the host runs without it) */
  panelsUrl?: string;
  private retryTimer?: number;
  private lastSend = 0;

  constructor(url = "ws://127.0.0.1:8765") { this.url = url; }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    try { this.ws = new WebSocket(this.url); } catch { this.scheduleRetry(); return; }
    this.ws.onopen = () => { this.connected = true; this.status = "IDLE"; this.statusSince = performance.now(); this.onChange(); };
    this.ws.onclose = () => { this.connected = false; this.status = "DISCONNECTED"; this.statusSince = performance.now(); this.opModes = []; this.actuators = {}; this.onChange(); this.scheduleRetry(); };
    this.ws.onerror = () => { /* onclose follows */ };
    this.ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
  }
  /** Drain queued servo transitions. */
  takeServoTransitions() { const t = this.servoTransitions; this.servoTransitions = []; return t; }
  disconnect() { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = undefined; this.ws?.close(); this.ws = undefined; }
  private scheduleRetry() { if (this.retryTimer) return; this.retryTimer = window.setTimeout(() => { this.retryTimer = undefined; this.connect(); }, 1500); }

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
      case "opmodes": this.opModes = msg.opModes ?? []; this.panelsUrl = msg.panelsUrl || undefined; this.onChange(); break;
      case "status": { const prev = this.status; this.status = msg.status; this.currentOpMode = msg.opMode ?? ""; this.statusError = msg.error ?? ""; if (prev !== this.status) this.statusSince = performance.now(); this.onChange(); break; }
      case "telemetry": this.telemetry = msg.lines ?? []; break;
      case "missingDevice": this.onMissingDevice(msg.name, msg.requested); break;
      case "assets": this.assets = msg.files ?? []; this.bindings = msg.bindings && msg.bindings.text ? msg.bindings : undefined; this.onChange(); break;
    }
  }
  private send(o: unknown) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  sendHardware(devices: unknown[], hints?: unknown) { this.send({ type: "hardware", devices, hints }); }
  /** asset path -> dotted key -> value; the host merges these into the JSON the OpMode reads at INIT */
  sendAssetOverrides(overrides: Record<string, Record<string, unknown>>) { this.send({ type: "assetOverrides", overrides }); }
  /** JPEG (base64, no data: prefix) of what a simulated webcam sees; the host hands it to TeamCode as the camera frame */
  sendFrame(camera: string, jpegBase64: string, nanos: number) { this.send({ type: "frame", camera, jpeg: jpegBase64, nanos }); }
  sendSensors(p: SensorPacket) { const now = performance.now(); if (now - this.lastSend < 15) return; this.lastSend = now; this.send(p); }
  init(opMode: string) { this.send({ type: "init", opMode }); }
  start() { this.send({ type: "start" }); }
  stop() { this.send({ type: "stop" }); }
  get running() { return this.connected && (this.status === "INIT" || this.status === "RUNNING"); }
}
