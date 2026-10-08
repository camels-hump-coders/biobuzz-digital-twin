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

/** Camera on top of the StarterBot ramp, looking forward over the hood where the ball leaves, i.e. at the target.
 *  The twin treats the hood side as the StarterBot's front: the camera sees the cell, the intake is at the back. */
export function starterBotCamera(id = "cam1"): CameraMount {
  const c = defaultCamera(id);
  c.name = "Shooter camera";
  c.forwardM = 6 * IN;
  c.heightM = 13 * IN;
  c.yawDeg = 0;
  c.pitchDeg = -35; // tilted up 35 deg: from 12.5 in the raised cell's tags sit ~37 in higher at ~55 in range
  return c;
}

export const ROBOT_PRESETS: Record<string, RobotSpec> = {
  starterbot6wd: {
    name: "goBILDA StarterBot (6WD, Gecko wheels)",
    // Chassis box from goBILDA's STEP (3200-2627-0003) via scripts/step2glb.py: 17.8 x 16.8 in, 12.0 in to the top edge of
    // the launcher ramp (no camera). Wheel diameter, motor speeds, intake width and mass are kit specs or estimates.
    drivetrain: "tank",
    lengthM: 17.8 * IN,
    widthM: 16.8 * IN,
    heightM: 12 * IN,
    wheelRpm: 312,
    wheelDiameterM: 0.096,
    model: "starterbot-6wd",
    modelYawDeg: -90, // CAD faces +Z; hood side forward
    cameras: [starterBotCamera()],
    launcher: { ...LAUNCHER_PRESETS.starterbot },
    intake: { side: "rear", widthM: 13 * IN, kind: "brushes" }, // kit intake between the wheels at the back pulls POLLEN out of a FLOWER; the launcher fires forward over the ramp
    massKg: 11,
    color: 0xe8e8e8,
  },
  starterbotMecanum: {
    name: "goBILDA StarterBot (Strafer mecanum)",
    // Chassis box from goBILDA's STEP (3200-2627-0004): 17.8 x 17.8 in, 12.2 in to the ramp's top edge (no camera).
    drivetrain: "mecanum",
    lengthM: 17.8 * IN,
    widthM: 17.8 * IN,
    heightM: 12.2 * IN,
    wheelRpm: 312,
    wheelDiameterM: 0.104,
    model: "starterbot-mecanum",
    modelYawDeg: -90, // CAD faces +Z; hood side forward
    cameras: [starterBotCamera()],
    launcher: { ...LAUNCHER_PRESETS.starterbot },
    intake: { side: "rear", widthM: 13 * IN, kind: "brushes" }, // kit intake between the wheels at the back pulls POLLEN out of a FLOWER; the launcher fires forward over the ramp
    massKg: 11,
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
    intake: { side: "front", widthM: 14 * IN, kind: "brushes" },
    massKg: 13,
    color: 0x3aa0c8,
  },
};

export function clonePreset(id: string): RobotSpec {
  const p = ROBOT_PRESETS[id] ?? ROBOT_PRESETS.starterbotMecanum;
  return JSON.parse(JSON.stringify(p));
}
