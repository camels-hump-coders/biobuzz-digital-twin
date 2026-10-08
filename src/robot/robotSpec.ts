import type { LauncherConfig } from "../ballistics/launcher";
import type { Drivetrain } from "../sim/drive";

export interface CameraMount {
  id: string;
  name: string;
  presetId: string;
  /** overrides, degrees; undefined = use preset */
  diagFovDeg?: number;
  hfovDeg?: number;
  width?: number;
  height?: number;
  /** mount position relative to robot centre at floor level, metres: forward, left, height */
  forwardM: number;
  leftM: number;
  heightM: number;
  /** pitch degrees, positive = looking down */
  pitchDeg: number;
  /** yaw degrees, positive = looking left */
  yawDeg: number;
  rollDeg: number;
  enabled: boolean;
}

export type IntakeSide = "front" | "rear" | "left" | "right";
/** `roller`: a plain compliant roller / sweeper that only takes balls off the floor. `brushes`: side brushes or star
 *  wheels at the mouth ends that also reach into a FLOWER's retrieval opening and pull POLLEN out (the kit intake). */
export type IntakeKind = "roller" | "brushes";
/** Where game pieces enter the robot. Balls meeting any other side get pushed, not collected. */
export interface IntakeConfig { side: IntakeSide; widthM: number; kind: IntakeKind }

export type Decal = "none" | "stripe" | "chevron" | "checker";
/** Appearance: chassis colour (box fully, CAD tinted), accent for decal and plate, team number plate text. */
export interface RobotLook { color: number; accent: number; decal: Decal; plateText: string }

export type ChassisModel = "box" | "starterbot-6wd" | "starterbot-mecanum";

export interface RobotSpec {
  name: string;
  drivetrain: Drivetrain;
  /** footprint metres */
  lengthM: number;
  widthM: number;
  heightM: number;
  wheelRpm: number;
  wheelDiameterM: number;
  model: ChassisModel;
  /** extra yaw applied to the CAD model so its front matches robot +X forward, degrees */
  modelYawDeg?: number;
  cameras: CameraMount[];
  launcher: LauncherConfig;
  intake: IntakeConfig;
  /** mass with battery, kg; sets how hard the robot pushes and resists pushing (traction = 0.8 x weight) */
  massKg: number;
  /** chassis colour; mirrors look.color (kept for older saves and the settings file) */
  color: number;
  look?: RobotLook;
}
