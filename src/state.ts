import type { RobotSpec } from "./robot/robotSpec";
import type { Pose } from "./sim/drive";
import type { Alliance, CellSide } from "./field/hive";
import { clonePreset } from "./robot/presets";

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
  overlays: { trajectory: boolean; fan: boolean; footprint: boolean; frustum: boolean; target: boolean; aim: boolean };
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
    overlays: { trajectory: true, fan: true, footprint: true, frustum: true, target: true, aim: true },
  };
}

const KEY = "biobuzz-twin";
export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return { ...defaultState(), ...s, overlays: { ...defaultState().overlays, ...(s.overlays ?? {}) } };
    }
  } catch { /* ignore */ }
  return defaultState();
}
export function saveState(s: AppState) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
