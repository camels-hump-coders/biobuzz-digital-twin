import { LAUNCHER_PRESETS } from "../ballistics/launcher";
import type { CameraMount, RobotSpec } from "./robotSpec";
import { defaultLook } from "./look";

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
    intake: { side: "rear", widthM: 13 * IN, kind: "brushes", deckDepthM: 2.75 * IN }, // kit intake between the wheels at the back pulls POLLEN out of a FLOWER; the launcher fires forward over the ramp
    massKg: 11,
    color: 0xe8e8e8,
    look: defaultLook(0xe8e8e8),
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
    intake: { side: "rear", widthM: 13 * IN, kind: "brushes", deckDepthM: 2.75 * IN }, // kit intake between the wheels at the back pulls POLLEN out of a FLOWER; the launcher fires forward over the ramp
    massKg: 11,
    color: 0xe8e8e8,
    look: defaultLook(0xe8e8e8),
  },
  pollinator: {
    name: "Pollinator (fast mecanum turret bot)",
    // an archetype, not a kit: 435 rpm mecanum, brushes at the front, dual flywheels with an adjustable hood, a camera up high
    drivetrain: "mecanum",
    lengthM: 16 * IN,
    widthM: 17 * IN,
    heightM: 15 * IN,
    wheelRpm: 435,
    wheelDiameterM: 0.104,
    model: "box",
    cameras: [{ ...defaultCamera(), heightM: 14 * IN, pitchDeg: -20 }],
    launcher: { ...LAUNCHER_PRESETS.dualFlywheel },
    intake: { side: "front", widthM: 15 * IN, kind: "brushes", deckDepthM: 4 * IN },
    massKg: 13,
    color: 0xf2c200,
    look: defaultLook(0xf2c200),
  },
  forager: {
    name: "Forager (heavy 6WD pusher)",
    // an archetype: slow, heavy tank bot that collects at the back and wins pushing matches
    drivetrain: "tank",
    lengthM: 18 * IN,
    widthM: 17 * IN,
    heightM: 13 * IN,
    wheelRpm: 312,
    wheelDiameterM: 0.096,
    model: "box",
    cameras: [defaultCamera()],
    launcher: { ...LAUNCHER_PRESETS.starterbot },
    intake: { side: "rear", widthM: 14 * IN, kind: "brushes", deckDepthM: 4 * IN },
    massKg: 15.5,
    color: 0x3e8e2f,
    look: defaultLook(0x3e8e2f),
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
    intake: { side: "front", widthM: 14 * IN, kind: "brushes", deckDepthM: 4 * IN },
    massKg: 13,
    color: 0x3aa0c8,
    look: defaultLook(0x3aa0c8),
  },
};

/** Card copy for the customizer's starter profiles, in display order. */
export const PROFILES: { id: string; title: string; tagline: string; kit?: boolean }[] = [
  { id: "starterbotMecanum", title: "StarterBot Strafer", tagline: "goBILDA kit · mecanum · lines up without turning", kit: true },
  { id: "starterbot6wd", title: "StarterBot 6WD", tagline: "goBILDA kit · 6 wheels · holds its ground when pushed", kit: true },
  { id: "pollinator", title: "Pollinator", tagline: "Fast mecanum · front brushes · dual flywheel hood" },
  { id: "forager", title: "Forager", tagline: "Heavy 6WD · rear brushes · wins pushing matches" },
  { id: "custom18", title: "Custom 18 in", tagline: "Blank mecanum box to build on" },
];

/** The fields a profile is defined by: everything that changes how the robot drives, collects or shoots.
 *  Identity (name) and look are left out so recolouring a StarterBot keeps it a StarterBot. */
function buildSignature(s: RobotSpec): string {
  const l = s.launcher;
  return JSON.stringify([s.drivetrain, +s.lengthM.toFixed(4), +s.widthM.toFixed(4), +s.heightM.toFixed(4), s.wheelRpm, +s.wheelDiameterM.toFixed(4), s.model, s.modelYawDeg ?? 0, s.massKg,
    s.intake.side, +s.intake.widthM.toFixed(4), s.intake.kind ?? "brushes", l.wheelDiameterM, l.maxRpm, l.efficiency, l.yawOffsetDeg ?? 0, l.elevationMinDeg, l.elevationMaxDeg, l.spinFraction, l.exitHeightM, l.exitForwardM]);
}
/** Id of the profile this spec is a copy of (build fields only), or undefined when it has been customised. */
export function matchingProfile(spec: RobotSpec): string | undefined {
  const sig = buildSignature(spec);
  return Object.keys(ROBOT_PRESETS).find((id) => buildSignature(ROBOT_PRESETS[id]) === sig);
}
/** Free top speed from wheel RPM and diameter, m/s. */
export function topSpeedMps(spec: Pick<RobotSpec, "wheelRpm" | "wheelDiameterM">): number {
  return (spec.wheelRpm / 60) * Math.PI * spec.wheelDiameterM;
}
/** Starting-configuration check (R102: 18 x 18 x 18 in). Returns the problems, empty when legal. */
export function sizingIssues(spec: Pick<RobotSpec, "lengthM" | "widthM" | "heightM">): string[] {
  const out: string[] = [];
  const lim = 18 * IN + 1e-6;
  if (spec.lengthM > lim) out.push(`length ${(spec.lengthM / IN).toFixed(1)} in > 18 in`);
  if (spec.widthM > lim) out.push(`width ${(spec.widthM / IN).toFixed(1)} in > 18 in`);
  if (spec.heightM > lim) out.push(`height ${(spec.heightM / IN).toFixed(1)} in > 18 in`);
  return out;
}

export function clonePreset(id: string): RobotSpec {
  const p = ROBOT_PRESETS[id] ?? ROBOT_PRESETS.starterbotMecanum;
  return JSON.parse(JSON.stringify(p));
}
