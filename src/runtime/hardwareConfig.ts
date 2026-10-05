/** Robot configuration (name -> role) mirroring the Control Hub's hardware map. */
export type DeviceKind = "motor" | "servo" | "crservo" | "imu" | "webcam" | "distance" | "touch";
export type MotorRole = "frontLeft" | "frontRight" | "backLeft" | "backRight" | "left" | "right" | "flywheel" | "intake" | "other";
export type ServoRole = "feeder" | "hood" | "other";

export interface DeviceConfig {
  name: string;
  kind: DeviceKind;
  /** motors */
  role?: MotorRole | ServoRole;
  ticksPerRev?: number;
  freeRpm?: number;
  /** servo feeder: fire when position crosses this (rising edge) */
  fireThreshold?: number;
  /** webcam: which camera mount id it maps to */
  cameraId?: string;
  /** hub port number, reported by getPortNumber() */
  port?: number;
}

export interface HardwareConfig {
  devices: DeviceConfig[];
  /** Which side's drive motors are physically mounted mirrored, so positive power spins the wheel backwards.
   * Real robots need setDirection(REVERSE) on that side; the FTC samples and goBILDA code reverse the left. */
  mirroredSide: "left" | "right" | "none";
}

export function defaultHardwareConfig(): HardwareConfig {
  return {
    mirroredSide: "left",
    devices: [
      { name: "frontLeft", kind: "motor", role: "frontLeft", ticksPerRev: 537.7, freeRpm: 312 },
      { name: "frontRight", kind: "motor", role: "frontRight", ticksPerRev: 537.7, freeRpm: 312 },
      { name: "backLeft", kind: "motor", role: "backLeft", ticksPerRev: 537.7, freeRpm: 312 },
      { name: "backRight", kind: "motor", role: "backRight", ticksPerRev: 537.7, freeRpm: 312 },
      { name: "shooter", kind: "motor", role: "flywheel", ticksPerRev: 28, freeRpm: 6000 },
      { name: "intake", kind: "motor", role: "intake", ticksPerRev: 537.7, freeRpm: 312 },
      { name: "feeder", kind: "servo", role: "feeder", fireThreshold: 0.5 },
      { name: "hood", kind: "servo", role: "hood" },
      { name: "imu", kind: "imu" },
      { name: "Webcam 1", kind: "webcam", cameraId: "cam1" },
    ],
  };
}

/** A tank-drive bot with Driver-Station names matching the Camels Hump Coders TeamCode (RobotConfig.java + controller-profile.json). */
export function camelsHumpHardwareConfig(): HardwareConfig {
  return {
    mirroredSide: "left",
    devices: [
      { name: "Left Drive", kind: "motor", role: "left", ticksPerRev: 537.7, freeRpm: 312, port: 1 },
      { name: "Right Drive", kind: "motor", role: "right", ticksPerRev: 537.7, freeRpm: 312, port: 0 },
      { name: "Intake", kind: "motor", role: "intake", ticksPerRev: 537.7, freeRpm: 312, port: 2 },
      { name: "Firing Mechanism", kind: "motor", role: "flywheel", ticksPerRev: 28, freeRpm: 6000, port: 3 },
      { name: "Windmill Feeder", kind: "crservo", role: "feeder", fireThreshold: 0.1, port: 0 },
      { name: "Front Right Feeder", kind: "crservo", role: "other", port: 1 },
      { name: "Front Left Feeder", kind: "crservo", role: "other", port: 2 },
      { name: "imu", kind: "imu" },
      { name: "Webcam 1", kind: "webcam", cameraId: "cam1" },
    ],
  };
}

export const MOTOR_ROLES: MotorRole[] = ["frontLeft", "frontRight", "backLeft", "backRight", "left", "right", "flywheel", "intake", "other"];
export const SERVO_ROLES: ServoRole[] = ["feeder", "hood", "other"];
