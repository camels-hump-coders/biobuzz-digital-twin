/** Actuator model: motor commands from the OpMode -> wheel speeds, encoders, flywheel RPM, servo events. Pure. */
import type { DeviceConfig, HardwareConfig } from "./hardwareConfig";
import type { Drivetrain, Velocity } from "../sim/drive";
import { forwardVector, leftVector } from "../sim/drive";

export interface MotorCommand {
  power: number;
  mode: string;
  reverse: boolean;
  targetVel: number; // ticks/s
  targetPos: number;
  brake: boolean;
}
export interface ServoCommand { position: number }

export interface MotorState {
  /** shaft speed, rev/s (positive = forward for the configured direction) */
  revPerSec: number;
  /** encoder ticks, raw (before direction) */
  ticks: number;
}

export interface ActuatorModel {
  motors: Map<string, MotorState>;
  servos: Map<string, number>;
  /** servo rising-edge events this step, by device name */
  fired: string[];
}

export function createActuatorModel(): ActuatorModel {
  return { motors: new Map(), servos: new Map(), fired: [] };
}

const TAU = 0.12; // s, motor spin-up time constant

/** Advance motor states toward their commands. Returns body velocity for the drive roles and flywheel RPM. */
export function stepActuators(
  model: ActuatorModel,
  cfg: HardwareConfig,
  cmds: Record<string, Partial<MotorCommand & ServoCommand & { kind: string }>>,
  dt: number,
  drivetrain: Drivetrain,
  heading: number,
  wheelDiameterM: number,
  trackWidthM: number,
  wheelbaseM: number,
): { vel: Velocity; flywheelRpm: number; hoodPos?: number; intakePower: number } {
  model.fired = [];
  const wheel: Record<string, number> = {}; // role -> wheel rim speed m/s (forward positive)
  let flywheelRpm = 0;
  let hoodPos: number | undefined;
  let intakePower = 0;
  for (const dev of cfg.devices) {
    const c = cmds[dev.name];
    if (dev.kind === "motor") {
      let st = model.motors.get(dev.name);
      if (!st) { st = { revPerSec: 0, ticks: 0 }; model.motors.set(dev.name, st); }
      const free = (dev.freeRpm ?? 312) / 60; // rev/s
      const tpr = dev.ticksPerRev ?? 537.7;
      let target = 0;
      if (c) {
        const isLeft = dev.role === "frontLeft" || dev.role === "backLeft" || dev.role === "left";
        const isRight = dev.role === "frontRight" || dev.role === "backRight" || dev.role === "right";
        const mirror = (cfg.mirroredSide === "left" && isLeft) || (cfg.mirroredSide === "right" && isRight) ? -1 : 1;
        const sgn = (c.reverse ? -1 : 1) * mirror;
        if (c.mode === "RUN_USING_ENCODER" && c.targetVel) target = mirror * Math.max(-free, Math.min(free, c.targetVel / tpr));
        else target = (c.power ?? 0) * free * sgn;
        // the browser receives the raw (direction-adjusted) command; targetVel already has direction applied by the shim
      }
      st.revPerSec += (target - st.revPerSec) * Math.min(1, dt / TAU);
      st.ticks += st.revPerSec * tpr * dt;
      const rim = st.revPerSec * Math.PI * wheelDiameterM;
      switch (dev.role) {
        case "frontLeft": case "frontRight": case "backLeft": case "backRight": case "left": case "right": wheel[dev.role] = rim; break;
        case "flywheel": flywheelRpm = Math.abs(st.revPerSec) * 60; break;
        case "intake": intakePower = c?.power ?? 0; break;
        default: break;
      }
    } else if (dev.kind === "servo" || dev.kind === "crservo") {
      const prev = model.servos.get(dev.name);
      const pos = c?.position ?? prev ?? 0;
      if (dev.role === "hood") hoodPos = pos;
      model.servos.set(dev.name, pos);
    }
  }
  // forward kinematics
  let vFwd = 0, vLeft = 0, omega = 0;
  if (drivetrain === "mecanum") {
    const fl = wheel.frontLeft ?? 0, fr = wheel.frontRight ?? 0, bl = wheel.backLeft ?? 0, br = wheel.backRight ?? 0;
    vFwd = (fl + fr + bl + br) / 4;
    vLeft = (-fl + fr + bl - br) / 4; // standard mecanum: strafe left when FL/BR reverse and FR/BL forward
    omega = (-fl + fr - bl + br) / (4 * ((trackWidthM + wheelbaseM) / 2));
  } else {
    const l = wheel.left ?? ((wheel.frontLeft ?? 0) + (wheel.backLeft ?? 0)) / (wheel.frontLeft !== undefined && wheel.backLeft !== undefined ? 2 : 1);
    const r = wheel.right ?? ((wheel.frontRight ?? 0) + (wheel.backRight ?? 0)) / (wheel.frontRight !== undefined && wheel.backRight !== undefined ? 2 : 1);
    vFwd = (l + r) / 2;
    omega = (r - l) / trackWidthM;
  }
  const f = forwardVector(heading), lv = leftVector(heading);
  return { vel: { vx: f.x * vFwd + lv.x * vLeft, vz: f.z * vFwd + lv.z * vLeft, yawRate: omega }, flywheelRpm, hoodPos, intakePower };
}

/** Count feeder fire events from the wire-level servo transitions (rising edge through the threshold).
 * Positional servos use position; continuous-rotation feeders use |power|. */
export function feederFires(cfg: HardwareConfig, transitions: { name: string; from: number; to: number }[]): number {
  let n = 0;
  for (const t of transitions) {
    const dev = cfg.devices.find((d) => d.name === t.name && d.role === "feeder");
    if (!dev) continue;
    const th = dev.fireThreshold ?? 0.5;
    if (t.from < th && t.to >= th) n++;
  }
  return n;
}

/** Sensor packet for the motors: position (ticks) and velocity (ticks/s), raw. */
export function motorSensors(model: ActuatorModel, cfg: HardwareConfig): Record<string, { pos: number; vel: number }> {
  const out: Record<string, { pos: number; vel: number }> = {};
  for (const dev of cfg.devices) if (dev.kind === "motor") {
    const st = model.motors.get(dev.name);
    const tpr = dev.ticksPerRev ?? 537.7;
    out[dev.name] = { pos: st ? st.ticks : 0, vel: st ? st.revPerSec * tpr : 0 };
  }
  return out;
}

export function deviceByRole(cfg: HardwareConfig, role: string): DeviceConfig | undefined {
  return cfg.devices.find((d) => d.role === role);
}
