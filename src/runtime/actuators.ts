/** Actuator model: motor commands from the OpMode -> wheel speeds, encoders, flywheel RPM, servo events. Pure. */
import type { DeviceConfig, HardwareConfig } from "./hardwareConfig";
import type { Drivetrain, Velocity } from "../sim/drive";
import { forwardVector, leftVector } from "../sim/drive";
import { GOBILDA_5203_312, PHYSICS_PROFILES, motorSpecFor, stepDrive, type DriveBody, type PhysicsProfile } from "../sim/drivePhysics";

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
  /** chassis body speeds carried between steps by the drive physics (tank) */
  body: DriveBody;
  /** per motor current, A, from the motor model */
  currents: Map<string, number>;
  /** battery terminal volts after sag */
  volts: number;
  /** drive motors commanded above 5 % whose shaft is not turning (the physics says breakaway was not reached) */
  stalled: Set<string>;
  /** breakaway command fractions for the current robot and profile (straight, turning in place) */
  breakaway: { straight: number; turn: number };
}

export function createActuatorModel(): ActuatorModel {
  return { motors: new Map(), servos: new Map(), fired: [], body: { vFwd: 0, omega: 0 }, currents: new Map(), volts: 12, stalled: new Set(), breakaway: { straight: 0, turn: 0 } };
}

/** What the drive physics needs from the robot: the surface/battery profile and the chassis mass. */
export interface PhysicsInput { profile: PhysicsProfile; massKg: number }
const IDEAL_PHYSICS: PhysicsInput = { profile: PHYSICS_PROFILES.ideal, massKg: 11 };

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
  physics: PhysicsInput = IDEAL_PHYSICS,
): { vel: Velocity; flywheelRpm: number; hoodPos?: number; intakePower: number } {
  model.fired = [];
  const wheel: Record<string, number> = {}; // role -> wheel rim speed m/s (forward positive)
  let flywheelRpm = 0;
  let hoodPos: number | undefined;
  let intakePower = 0;
  const prof = physics.profile;
  const realistic = prof.kind !== "ideal";
  // drive motors of a tank chassis go through the torque / friction model as two sides
  const sideOf = (role?: string): "left" | "right" | undefined => role === "frontLeft" || role === "backLeft" || role === "left" ? "left" : role === "frontRight" || role === "backRight" || role === "right" ? "right" : undefined;
  const sideCmd: Record<"left" | "right", { u: number; brake: boolean; devices: DeviceConfig[] }> = { left: { u: 0, brake: true, devices: [] }, right: { u: 0, brake: true, devices: [] } };
  const useSides = drivetrain === "tank" && realistic;
  model.stalled.clear();
  for (const dev of cfg.devices) {
    const c = cmds[dev.name];
    if (dev.kind === "motor") {
      let st = model.motors.get(dev.name);
      if (!st) { st = { revPerSec: 0, ticks: 0 }; model.motors.set(dev.name, st); }
      const free = (dev.freeRpm ?? 312) / 60; // rev/s
      const tpr = dev.ticksPerRev ?? 537.7;
      let target = 0;
      let u = 0; // effective command fraction, + = forward for the drive roles
      if (c) {
        const isLeft = dev.role === "frontLeft" || dev.role === "backLeft" || dev.role === "left";
        const isRight = dev.role === "frontRight" || dev.role === "backRight" || dev.role === "right";
        const mirror = (cfg.mirroredSide === "left" && isLeft) || (cfg.mirroredSide === "right" && isRight) ? -1 : 1;
        const sgn = (c.reverse ? -1 : 1) * mirror;
        if (c.mode === "RUN_USING_ENCODER" && c.targetVel) { target = mirror * Math.max(-free, Math.min(free, c.targetVel / tpr)); u = target / free + 2 * ((target - st.revPerSec) / free); }
        else { target = (c.power ?? 0) * free * sgn; u = (c.power ?? 0) * sgn; }
        u = Math.max(-1, Math.min(1, u));
        // the browser receives the raw (direction-adjusted) command; targetVel already has direction applied by the shim
      }
      const side = sideOf(dev.role);
      if (useSides && side) {
        // side command: the mean of its motors (they share one chain); the shaft speed is assigned after the step
        const s = sideCmd[side]; s.devices.push(dev); s.u = (s.u * (s.devices.length - 1) + u) / s.devices.length; s.brake = c?.brake ?? true;
        continue;
      }
      st.revPerSec += (target - st.revPerSec) * Math.min(1, dt / TAU);
      st.ticks += st.revPerSec * tpr * dt;
      // current from the same motor model: torque demanded in proportion to the speed error
      const spec = motorSpecFor(dev.freeRpm ?? 312, GOBILDA_5203_312);
      const demand = Math.min(1, Math.abs(target - st.revPerSec) / free + (c && Math.abs(u) > 0.01 ? 0.02 : 0));
      model.currents.set(dev.name, c && (Math.abs(u) > 0.01 || Math.abs(st.revPerSec) > 0.01) ? spec.freeCurrentA + (spec.stallCurrentA - spec.freeCurrentA) * demand : 0);
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
  if (useSides && (sideCmd.left.devices.length || sideCmd.right.devices.length)) {
    const ref = sideCmd.left.devices[0] ?? sideCmd.right.devices[0];
    const spec = motorSpecFor(ref.freeRpm ?? 312, GOBILDA_5203_312);
    const r = stepDrive(model.body, { left: { u: sideCmd.left.u, brake: sideCmd.left.brake }, right: { u: sideCmd.right.u, brake: sideCmd.right.brake } },
      { massKg: physics.massKg, trackWidthM, wheelbaseM, wheelRadiusM: wheelDiameterM / 2, motorsPerSide: Math.max(1, Math.max(sideCmd.left.devices.length, sideCmd.right.devices.length)), motor: spec }, prof, dt);
    model.body = r.body; model.volts = r.volts; model.breakaway = r.breakaway;
    for (const side of ["left", "right"] as const) for (const dev of sideCmd[side].devices) {
      const st = model.motors.get(dev.name)!; const tpr = dev.ticksPerRev ?? 537.7;
      st.revPerSec = r.shaftRevPerSec[side]; st.ticks += st.revPerSec * tpr * dt;
      model.currents.set(dev.name, r.currentA[side]);
      if (r.stalled[side]) model.stalled.add(dev.name);
    }
    const f = forwardVector(heading);
    return { vel: { vx: f.x * r.body.vFwd, vz: f.z * r.body.vFwd, yawRate: r.body.omega }, flywheelRpm, hoodPos, intakePower };
  }
  if (!realistic) { model.volts = prof.batteryVolts; model.breakaway = { straight: 0, turn: 0 }; }
  // forward kinematics
  let vFwd = 0, vLeft = 0, omega = 0;
  // the hardware map may describe a tank bot (roles left/right) while the chassis preset is mecanum, or the other way
  // round; use whichever wheel roles actually carry commands rather than silently standing still
  const moving = (k: string) => Math.abs(wheel[k] ?? 0) > 1e-6;
  const corner = ["frontLeft", "frontRight", "backLeft", "backRight"].some(moving);
  const sides = moving("left") || moving("right");
  if (drivetrain === "mecanum" && (corner || !sides)) {
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
  if (realistic) {
    // mecanum (or a tank map under a mecanum chassis): kinematic speeds, but no motion below the straight breakaway
    model.volts = prof.batteryVolts;
    const driveU = Object.entries(cmds).filter(([n]) => sideOf(cfg.devices.find((d) => d.name === n)?.role)).map(([, c]) => Math.abs(c.power ?? 0));
    const maxU = driveU.length ? Math.max(...driveU) : 0;
    const spec = motorSpecFor(cfg.devices.find((d) => sideOf(d.role))?.freeRpm ?? 312, GOBILDA_5203_312);
    const perWheel = (spec.stallTorqueNm * (prof.batteryVolts / spec.nominalVolts)) / (wheelDiameterM / 2);
    const straight = perWheel > 0 ? (prof.staticMu * physics.massKg * 9.81) / (Math.max(1, driveU.length) * perWheel) : 0;
    model.breakaway = { straight, turn: straight };
    const atRest = Math.abs(model.body.vFwd) < 1e-3 && Math.abs(model.body.omega) < 1e-3;
    if (atRest && maxU > 0 && maxU < straight) { vFwd = vLeft = omega = 0; for (const d of cfg.devices) if (sideOf(d.role) && Math.abs(cmds[d.name]?.power ?? 0) > 0.05) model.stalled.add(d.name); }
    model.body = { vFwd, omega };
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

/** Sensor packet for the motors: position (ticks) and velocity (ticks/s), raw, plus the modelled current (A). */
export function motorSensors(model: ActuatorModel, cfg: HardwareConfig): Record<string, { pos: number; vel: number; amps: number }> {
  const out: Record<string, { pos: number; vel: number; amps: number }> = {};
  for (const dev of cfg.devices) if (dev.kind === "motor") {
    const st = model.motors.get(dev.name);
    const tpr = dev.ticksPerRev ?? 537.7;
    out[dev.name] = { pos: st ? st.ticks : 0, vel: st ? st.revPerSec * tpr : 0, amps: +(model.currents.get(dev.name) ?? 0).toFixed(2) };
  }
  return out;
}

export function deviceByRole(cfg: HardwareConfig, role: string): DeviceConfig | undefined {
  return cfg.devices.find((d) => d.role === role);
}
