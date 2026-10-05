import { LAUNCHER_PRESETS } from "../ballistics/launcher";
import type { CameraMount, RobotSpec } from "./robotSpec";

const IN = 0.0254;

export function defaultCamera(id = "cam1"): CameraMount {
  return {
    id,
    name: "Front camera",
    presetId: "c920",
    forwardM: 7 * IN,
    leftM: 0,
    heightM: 10 * IN,
    pitchDeg: -10, // slightly up to see the tags under the cells
    yawDeg: 0,
    rollDeg: 0,
    enabled: true,
  };
}

/** Camera on the front edge of the StarterBot hood plate, looking forward over the intake. */
export function starterBotCamera(id = "cam1"): CameraMount {
  const c = defaultCamera(id);
  c.forwardM = 1.5 * IN;
  c.heightM = 12.5 * IN;
  c.pitchDeg = -8;
  return c;
}

export const ROBOT_PRESETS: Record<string, RobotSpec> = {
  starterbot6wd: {
    name: "goBILDA StarterBot (6WD, Gecko wheels)",
    drivetrain: "tank",
    lengthM: 17.5 * IN,
    widthM: 17.5 * IN,
    heightM: 16 * IN,
    wheelRpm: 312,
    wheelDiameterM: 0.096,
    model: "starterbot-6wd",
    modelYawDeg: 90,
    cameras: [starterBotCamera()],
    launcher: { ...LAUNCHER_PRESETS.starterbot },
    color: 0xe8e8e8,
  },
  starterbotMecanum: {
    name: "goBILDA StarterBot (Strafer mecanum)",
    drivetrain: "mecanum",
    lengthM: 17.5 * IN,
    widthM: 17.5 * IN,
    heightM: 16 * IN,
    wheelRpm: 312,
    wheelDiameterM: 0.104,
    model: "starterbot-mecanum",
    modelYawDeg: 90,
    cameras: [starterBotCamera()],
    launcher: { ...LAUNCHER_PRESETS.starterbot },
    color: 0xe8e8e8,
  },
  custom18: {
    name: "Custom 18 in mecanum",
    drivetrain: "mecanum",
    lengthM: 18 * IN,
    widthM: 18 * IN,
    heightM: 14 * IN,
    wheelRpm: 435,
    wheelDiameterM: 0.104,
    model: "box",
    cameras: [defaultCamera()],
    launcher: { ...LAUNCHER_PRESETS.dualFlywheel },
    color: 0x3aa0c8,
  },
};

export function clonePreset(id: string): RobotSpec {
  const p = ROBOT_PRESETS[id] ?? ROBOT_PRESETS.starterbotMecanum;
  return JSON.parse(JSON.stringify(p));
}
