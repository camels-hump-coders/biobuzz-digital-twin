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
  overlays: { trajectory: boolean; actualArc: boolean; dispersion: boolean; fan: boolean; footprint: boolean; frustum: boolean; target: boolean; aim: boolean; reach: boolean };
  noise: NoiseConfig;
  monteCarloN: number;
  /** virtual runtime (TeamCode) */
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
      return { ...defaultState(), ...s, overlays: { ...defaultState().overlays, ...(s.overlays ?? {}) }, noise: { ...DEFAULT_NOISE, ...(s.noise ?? {}) }, hardware: s.hardware?.devices ? { mirroredSide: "left", ...s.hardware } : defaultHardwareConfig() };
    }
  } catch { /* ignore */ }
  return defaultState();
}
export function saveState(s: AppState) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
