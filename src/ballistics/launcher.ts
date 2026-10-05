/** Launcher mechanism model: flywheel surface speed -> ball exit speed. */
export type LauncherKind = "flywheel-single" | "flywheel-dual" | "custom";

export interface LauncherConfig {
  kind: LauncherKind;
  name: string;
  /** flywheel diameter, metres */
  wheelDiameterM: number;
  /** motor free speed at the wheel, RPM (after gearing) */
  maxRpm: number;
  /** exit speed / wheel surface speed. Hooded single wheel ~0.45, dual ~0.9 */
  efficiency: number;
  /** current commanded RPM */
  rpm: number;
  /** exit elevation, degrees */
  elevationDeg: number;
  /** adjustable hood range (deg); equal values = fixed */
  elevationMinDeg: number;
  elevationMaxDeg: number;
  /** exit point relative to robot centre at floor level: forward (+x robot), left (+y robot), height; metres */
  exitForwardM: number;
  exitLeftM: number;
  exitHeightM: number;
  /** turret yaw range relative to robot heading, degrees; 0/0 = fixed forward */
  turretMinDeg: number;
  turretMaxDeg: number;
  /** backspin imparted as fraction of wheel angular speed (0..1) */
  spinFraction: number;
}

export function surfaceSpeed(cfg: LauncherConfig, rpm = cfg.rpm): number {
  return (Math.PI * cfg.wheelDiameterM * rpm) / 60;
}

export function exitSpeed(cfg: LauncherConfig, rpm = cfg.rpm): number {
  return surfaceSpeed(cfg, rpm) * cfg.efficiency;
}

export function rpmForExitSpeed(cfg: LauncherConfig, speed: number): number {
  return (speed * 60) / (Math.PI * cfg.wheelDiameterM * cfg.efficiency);
}

export function maxExitSpeed(cfg: LauncherConfig): number {
  return exitSpeed(cfg, cfg.maxRpm);
}

/** Ball backspin in rad/s for a given wheel RPM. */
export function spinRate(cfg: LauncherConfig, rpm = cfg.rpm): number {
  return ((rpm * 2 * Math.PI) / 60) * cfg.spinFraction;
}

export const LAUNCHER_PRESETS: Record<string, LauncherConfig> = {
  starterbot: {
    kind: "flywheel-single",
    name: "goBILDA StarterBot (96 mm Hogback, 6000 RPM 5203)",
    wheelDiameterM: 0.096,
    maxRpm: 6000,
    efficiency: 0.45,
    rpm: 3600,
    elevationDeg: 55,
    elevationMinDeg: 55,
    elevationMaxDeg: 55,
    exitForwardM: -0.05, // ball leaves the top of the hood, just behind centre
    exitLeftM: 0,
    exitHeightM: 0.31,
    turretMinDeg: 0,
    turretMaxDeg: 0,
    spinFraction: 0.5,
  },
  dualFlywheel: {
    kind: "flywheel-dual",
    name: "Dual 96 mm flywheels, adjustable hood",
    wheelDiameterM: 0.096,
    maxRpm: 6000,
    efficiency: 0.85,
    rpm: 2500,
    elevationDeg: 50,
    elevationMinDeg: 35,
    elevationMaxDeg: 70,
    exitForwardM: 0.1,
    exitLeftM: 0,
    exitHeightM: 0.45,
    turretMinDeg: -180,
    turretMaxDeg: 180,
    spinFraction: 0,
  },
  custom: {
    kind: "custom",
    name: "Custom",
    wheelDiameterM: 0.1,
    maxRpm: 6000,
    efficiency: 0.5,
    rpm: 3000,
    elevationDeg: 50,
    elevationMinDeg: 30,
    elevationMaxDeg: 75,
    exitForwardM: 0.1,
    exitLeftM: 0,
    exitHeightM: 0.4,
    turretMinDeg: -45,
    turretMaxDeg: 45,
    spinFraction: 0.3,
  },
};
