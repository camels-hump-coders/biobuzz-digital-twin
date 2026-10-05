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
/** Where game pieces enter the robot. Balls meeting any other side get pushed, not collected. */
export interface IntakeConfig { side: IntakeSide; widthM: number }

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
  color: number;
}
