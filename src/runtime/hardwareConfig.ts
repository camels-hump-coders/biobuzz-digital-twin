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

/** A tank-drive bot with Driver-Station names matching the Camels Hump Coders (FTC Team #36682) TeamCode (RobotConfig.java + controller-profile.json).
 * Their drive code sends negative power to both motors for forward with the left motor REVERSEd, which means the
 * right-hand motor is the physically mirrored one on that robot. */
export function camelsHumpHardwareConfig(): HardwareConfig {
  return {
    mirroredSide: "right",
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

/** Every preset's devices by name: lets the host give auto-created devices the port/role a known robot uses. */
export function deviceHints(): Record<string, DeviceConfig> {
  const out: Record<string, DeviceConfig> = {};
  for (const cfg of [camelsHumpHardwareConfig(), defaultHardwareConfig()]) for (const d of cfg.devices) if (!out[d.name]) out[d.name] = d;
  return out;
}

/** Guess kind and role for a device TeamCode asked for by name and SDK type, so it can be added automatically. */
export function inferDevice(name: string, requestedType: string, existing: DeviceConfig[]): DeviceConfig {
  const hint = deviceHints()[name];
  if (hint) return { ...hint };
  const n = name.toLowerCase();
  const t = requestedType;
  let kind: DeviceKind = "motor";
  if (/Servo$|ServoImplEx/.test(t) && !/CRServo/.test(t)) kind = "servo";
  else if (/CRServo/.test(t)) kind = "crservo";
  else if (/IMU|BNO055|Gyro/.test(t)) kind = "imu";
  else if (/Webcam|Camera/.test(t)) kind = "webcam";
  else if (/Distance|Rev2mDistance/.test(t)) kind = "distance";
  else if (/Touch/.test(t)) kind = "touch";
  const dev: DeviceConfig = { name, kind, port: existing.filter((d) => d.kind === kind).length };
  if (kind === "motor") {
    dev.ticksPerRev = 537.7; dev.freeRpm = 312;
    const hasFB = /front|back|rear/.test(n);
    if (/left/.test(n)) dev.role = hasFB ? (/front/.test(n) ? "frontLeft" : "backLeft") : "left";
    else if (/right/.test(n)) dev.role = hasFB ? (/front/.test(n) ? "frontRight" : "backRight") : "right";
    else if (/intake|gecko|roller/.test(n)) dev.role = "intake";
    else if (/shoot|fly|fir|launch|wheel/.test(n)) { dev.role = "flywheel"; dev.ticksPerRev = 28; dev.freeRpm = 6000; }
    else dev.role = "other";
  } else if (kind === "servo" || kind === "crservo") {
    if (/feed|windmill|trigger|index|kick/.test(n)) { dev.role = "feeder"; dev.fireThreshold = kind === "crservo" ? 0.1 : 0.5; }
    else if (/hood|angle|tilt/.test(n)) dev.role = "hood";
    else dev.role = "other";
  }
  return dev;
}

export const MOTOR_ROLES: MotorRole[] = ["frontLeft", "frontRight", "backLeft", "backRight", "left", "right", "flywheel", "intake", "other"];
export const SERVO_ROLES: ServoRole[] = ["feeder", "hood", "other"];
