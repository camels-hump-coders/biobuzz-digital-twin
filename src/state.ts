import type { RobotSpec } from "./robot/robotSpec";
import type { Pose } from "./sim/drive";
import type { Alliance, CellSide } from "./field/hive";
import { clonePreset } from "./robot/presets";
import { DEFAULT_NOISE, type NoiseConfig } from "./ballistics/dispersion";
import { defaultHardwareConfig, type HardwareConfig } from "./runtime/hardwareConfig";

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
  /** transient: rotate to face the target on the next frame */
  aimRequest?: boolean;
  /** transient: put every game piece back to match start */
  resetMatchRequest?: boolean;
  overlays: { trajectory: boolean; actualArc: boolean; dispersion: boolean; fan: boolean; footprint: boolean; frustum: boolean; target: boolean; aim: boolean; reach: boolean };
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
  runtimeEnabled: boolean;
  runtimeUrl: string;
  hardware: HardwareConfig;
  tagNoiseIn: number;
}

export function defaultState(): AppState {
  const robot = clonePreset("starterbotMecanum");
  return {
    robotPresetId: "starterbotMecanum",
    robot,
    pose: { x: -1.2, z: 1.5, heading: 0 },
    alliance: "red",
    hive: { red: "audience", blue: "scoring" },
    selectedCameraId: robot.cameras[0].id,
    ballKind: "pollen",
    autoRpm: true,
    autoHood: false,
    drag: true,
    fieldCentric: false,
    opponents: true,
    pauseOpponents: false,
    view: "orbit",
    pip: true,
    overlays: { trajectory: true, actualArc: true, dispersion: true, fan: false, footprint: true, frustum: true, target: true, aim: true, reach: false },
    noise: { ...DEFAULT_NOISE },
    monteCarloN: 150,
    autoTip: true,
    tipMassG: 195,
    capacity: 4,
    canPollen: true,
    canNectar: true,
    opponentsScore: true,
    runtimeEnabled: false,
    runtimeUrl: "ws://127.0.0.1:8765",
    hardware: defaultHardwareConfig(),
    tagNoiseIn: 0.3,
  };
}

const KEY = "biobuzz-twin";
export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
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
      if (s.tipMassG === 199) s.tipMassG = 195; // 3 NECTAR + 3 POLLEN weigh 198.6 g; tip just under that
      return { ...defaultState(), ...s, overlays: { ...defaultState().overlays, ...(s.overlays ?? {}) }, noise: { ...DEFAULT_NOISE, ...(s.noise ?? {}) }, hardware: s.hardware?.devices ? { mirroredSide: "left", ...s.hardware } : defaultHardwareConfig() };
    }
  } catch { /* ignore */ }
  return defaultState();
}
export function saveState(s: AppState) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
