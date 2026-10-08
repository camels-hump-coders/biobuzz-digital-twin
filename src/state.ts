import { type StartPositions, defaultStarts, startPose } from "./sim/starts";
import type { RobotSpec } from "./robot/robotSpec";
import type { Pose } from "./sim/drive";
import type { Alliance, CellSide } from "./field/hive";
import { clonePreset } from "./robot/presets";
import { DEFAULT_NOISE, type NoiseConfig } from "./ballistics/dispersion";
import { defaultHardwareConfig, type HardwareConfig } from "./runtime/hardwareConfig";
import { defaultCalibration, type CalibrationSession } from "./ballistics/calibration";
import { DEFAULT_AUDIO, type AudioSettings } from "./sim/audio";
import { type AiTier, coerceTier } from "./sim/aiTiers";

export type ViewMode = "orbit" | "top" | "chase" | "robot";

export interface AppState {
  robotPresetId: string;
  robot: RobotSpec;
  pose: Pose;
  alliance: Alliance;
  hive: Record<Alliance, CellSide>;
  selectedCameraId: string;
  ballKind: "pollen" | "nectar";
  autoRpm: boolean;
  autoHood: boolean;
  drag: boolean;
  fieldCentric: boolean;
  opponents: boolean;
  pauseOpponents: boolean;
  view: ViewMode;
  pip: boolean;
  /** stadium backdrop: audience stands, lighting truss and sweeping colour spots around the field */
  stadium: boolean;
  /** other robots use the CAD chassis (tinted in their alliance colour) instead of boxes */
  opponentsCad: boolean;
  /** carve the CAD's wheels out and spin them with the drive (on by default: a one-off geometry pass, then free) */
  wheelSpin: boolean;
  /** transient: rotate to face the target on the next frame */
  aimRequest?: boolean;
  shootRequest?: boolean;
  /** transient: put every game piece back to match start */
  resetMatchRequest?: boolean;
  /** put our robot (and, outside a running match, the scripted robots) back on the starting marks */
  placeAtStartRequest?: boolean;
  overlays: { trajectory: boolean; actualArc: boolean; dispersion: boolean; fan: boolean; footprint: boolean; frustum: boolean; target: boolean; aim: boolean; reach: boolean; hitmap: boolean };
  /** show per-frame timing of the main loop sections */
  showPerf: boolean;
  /** match start positions (red frame, inches) */
  starts: StartPositions;
  /** transient: setup (robots parked at start, scripted robots idle) / running / stopped */
  matchPhase?: "setup" | "running" | "stopped";
  /** transient: seconds left on the 2:30 match clock */
  matchClock?: number;
  /** transient: seconds left in the 8 s AUTO→TELEOP transition (the 2:30 clock holds at 2:00 meanwhile) */
  matchTransition?: number;
  /** hold the clock for the official 8 s AUTO→TELEOP transition (Competition Manual §10.4); off = continuous 2:30 */
  autoTransition: boolean;
  /** competition sounds and effects, 0-1 per bus */
  audio: AudioSettings;
  /** transient: start or stop the match on the next frame */
  matchRequest?: "start" | "stop";
  /** panel shows every setting (true) or only the everyday ones with per-section "more" expanders (false) */
  panelAdvanced: boolean;
  /** the getting-started note at the top of the panel has been dismissed */
  introSeen: boolean;
  noise: NoiseConfig;
  monteCarloN: number;
  /** virtual runtime (TeamCode) */
  /** hive tipping */
  autoTip: boolean;
  tipMassG: number;
  /** our robot's game-piece handling */
  capacity: number;
  canPollen: boolean;
  canNectar: boolean;
  /** scripted robots collect and score (otherwise they just patrol) */
  opponentsScore: boolean;
  /** how well the scripted robots play (src/sim/aiTiers.ts) */
  aiTier: AiTier;
  runtimeEnabled: boolean;
  runtimeUrl: string;
  hardware: HardwareConfig;
  tagNoiseIn: number;
  /** TeamCode asset overrides edited in the browser: asset path -> dotted key -> value (sent to the host) */
  assetOverrides: Record<string, Record<string, unknown>>;
  /** shooter calibration wizard: setup, measured shots and the OpMode's pending shot announcements */
  calibration: CalibrationSession;
  /** server mode: apply the repo's twin-settings.json when the host connects (unless the browser has unsaved changes) */
  settingsAutoLoad: boolean;
  /** practice mode: our robot always has a ball of the selected kind to launch; intake and capacity still work */
  infiniteAmmo: boolean;
  /** manual driving: keep the intake running whenever there is room (off: press I to toggle it, hold K to run it) */
  autoIntake: boolean;
}

export function defaultState(): AppState {
  const robot = clonePreset("starterbotMecanum");
  return {
    robotPresetId: "starterbotMecanum",
    robot,
    pose: startPose(defaultStarts(), "you", "blue", { red: "audience", blue: "scoring" }), // on blue's far-side start square, as a match begins
    alliance: "blue",
    hive: { red: "audience", blue: "scoring" },
    selectedCameraId: robot.cameras[0].id,
    ballKind: "pollen",
    autoRpm: true,
    autoHood: false,
    drag: true,
    fieldCentric: true,
    opponents: true,
    pauseOpponents: false,
    view: "orbit",
    pip: true,
    stadium: true,
    opponentsCad: false,
    wheelSpin: true,
    overlays: { trajectory: true, actualArc: true, dispersion: true, fan: false, footprint: true, frustum: true, target: true, aim: true, reach: false, hitmap: true },
    showPerf: false,
    panelAdvanced: false,
    introSeen: false,
    starts: defaultStarts(),
    noise: { ...DEFAULT_NOISE },
    monteCarloN: 150,
    autoTip: true,
    tipMassG: 195,
    capacity: 4,
    canPollen: true,
    canNectar: true,
    opponentsScore: true,
    aiTier: "medium",
    runtimeEnabled: false,
    runtimeUrl: "ws://127.0.0.1:8765",
    hardware: defaultHardwareConfig(),
    tagNoiseIn: 0.3,
    assetOverrides: {},
    calibration: defaultCalibration(robot.launcher.exitHeightM),
    settingsAutoLoad: true,
    infiniteAmmo: false,
    autoIntake: false,
    autoTransition: true,
    audio: { ...DEFAULT_AUDIO },
  };
}

const KEY = "biobuzz-twin";
/** Fields that describe the moment, not the setup: never saved to the settings file, never restored from it. */
export const TRANSIENT_KEYS = ["pose", "aimRequest", "shootRequest", "resetMatchRequest", "placeAtStartRequest", "matchPhase", "matchClock", "matchTransition", "matchRequest"] as const;
/** Deterministic JSON of the settings (sorted keys, transient fields dropped) so a committed file diffs cleanly. */
/** The settings as they go into the file: transient fields and values the simulation itself writes every frame removed. */
export function settingsForFile(s: AppState): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...s };
  for (const k of TRANSIENT_KEYS) delete copy[k];
  // which cell is up is match state (tips flip it, every match start resets it), not setup
  delete copy.hive;
  // with auto-RPM / auto-hood on, the commanded RPM and hood angle follow the robot around: outputs, not settings
  const l = { ...s.robot.launcher } as Record<string, unknown>;
  if (s.autoRpm) delete l.rpm;
  if (s.autoHood) delete l.elevationDeg;
  copy.robot = { ...s.robot, launcher: l };
  return copy;
}
export function serializeSettings(s: AppState): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify({ biobuzzTwinSettings: 1, ...(sorted(settingsForFile(s)) as object) }, null, 2) + "\n";
}
/** Dotted paths where two settings JSON texts differ (for the sync badge): recurses into objects, compares arrays whole. */
export function settingsDiffPaths(a: string | null | undefined, b: string): string[] {
  let x: any, y: any;
  try { x = a ? JSON.parse(a) : {}; y = JSON.parse(b); } catch { return ["(unparseable)"]; }
  const out: string[] = [];
  const walk = (p: any, q: any, path: string) => {
    for (const k of new Set([...Object.keys(p ?? {}), ...Object.keys(q ?? {})])) {
      const pv = p?.[k], qv = q?.[k], here = path ? `${path}.${k}` : k;
      if (pv && qv && typeof pv === "object" && typeof qv === "object" && !Array.isArray(pv) && !Array.isArray(qv)) walk(pv, qv, here);
      else if (JSON.stringify(pv) !== JSON.stringify(qv)) out.push(here);
    }
  };
  walk(x, y, "");
  return out;
}
/** Turn saved JSON (localStorage or the repo's twin-settings.json) into a complete, migrated state. */
export function hydrateState(s: any): AppState {
  if (s && typeof s === "object") {
    delete s.biobuzzTwinSettings;
    return migrate(s);
  }
  return defaultState();
}
export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return hydrateState(JSON.parse(raw));
  } catch { /* ignore */ }
  return defaultState();
}
function migrate(s: any): AppState {
  {
    {
      // migration: StarterBot CAD exports face +Z; older saves predate the yaw fix
      if (s.robot && s.robot.model !== "box" && s.robot.modelYawDeg === undefined) s.robot.modelYawDeg = 90;
      // migration: launcher direction offset; the StarterBot fires out the back over its ramp
      if (s.robot?.launcher && s.robot.launcher.yawOffsetDeg === undefined) {
        const sb = String(s.robot.launcher.name ?? "").includes("StarterBot");
        s.robot.launcher.yawOffsetDeg = sb ? 180 : 0;
        if (sb) { s.robot.launcher.exitForwardM = -0.10; s.robot.launcher.exitHeightM = 0.31; }
        // move the stock front camera onto the ramp side if it is still at the old default
        const c = s.robot.cameras?.[0];
        if (sb && c && Math.abs(c.forwardM - 0.0381) < 1e-3 && c.yawDeg === 0 && s.robot.cameras.length === 1) { c.name = "Shooter camera"; c.forwardM = -6 * 0.0254; c.heightM = 13 * 0.0254; c.yawDeg = 180; }
      }
      if (s.tipMassG === 199) s.tipMassG = 195;
      // migration: intake side (older saves collected from every side)
      if (s.robot && !s.robot.intake) s.robot.intake = { side: "front", widthM: 13 * 0.0254, kind: "brushes" };
      // migration: intake kind (older saves pulled from FLOWERs with any intake; the kit intake has brushes)
      if (s.robot?.intake && !s.robot.intake.kind) s.robot.intake.kind = "brushes";
      if (s.robot && !s.robot.massKg) s.robot.massKg = 12;
      // migration: appearance (older saves only carried the chassis colour)
      if (s.robot) s.robot.look = { color: s.robot.look?.color ?? s.robot.color ?? 0xe8e8e8 }; // the decal / number plate of 2026-10-08 was dropped the same day
      // migration: the StarterBot shooter camera default pitch was a guess (8 deg up); the team measured 35 deg up
      for (const c of s.robot?.cameras ?? []) if (c.name === "Shooter camera" && c.pitchDeg === -8 && c.yawDeg === 180) c.pitchDeg = -35;
      // an earlier build switched Auto-RPM off permanently whenever TeamCode ran; restore the default
      if (s.autoRpm === false && !s.autoRpmUserSet) s.autoRpm = true; // 3 NECTAR + 3 POLLEN weigh 198.6 g; tip just under that
      return { ...defaultState(), ...s, overlays: { ...defaultState().overlays, ...(s.overlays ?? {}) }, noise: { ...DEFAULT_NOISE, ...(s.noise ?? {}) }, hardware: s.hardware?.devices ? { mirroredSide: "left", ...s.hardware } : defaultHardwareConfig(), starts: { ...defaultStarts(), ...(s.starts ?? {}) }, calibration: s.calibration?.setup ? { ...defaultCalibration(), ...s.calibration, setup: { ...defaultCalibration().setup, ...s.calibration.setup } } : defaultCalibration(s.robot?.launcher?.exitHeightM ?? 0.31), audio: { ...DEFAULT_AUDIO, ...(s.audio ?? {}) }, aiTier: coerceTier(s.aiTier), matchPhase: undefined, matchClock: undefined, matchTransition: undefined, matchRequest: undefined };
    }
  }
}
export function saveState(s: AppState) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
