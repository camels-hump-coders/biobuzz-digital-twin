import { describe, expect, it } from "vitest";
import { createActuatorModel, stepActuators, motorSensors, feederFires } from "../src/runtime/actuators";
import { defaultHardwareConfig } from "../src/runtime/hardwareConfig";

const cfg = defaultHardwareConfig();
// left motors are mirrored on the StarterBot, so code sets them REVERSE; mimic that here
const cmd = (power: number, reverse = false) => ({ kind: "motor", power, mode: "RUN_WITHOUT_ENCODER", reverse, targetVel: 0, targetPos: 0, brake: true });

describe("actuator model", () => {
  it("all four wheels forward drives forward and spins up with a lag", () => {
    const m = createActuatorModel();
    let r = stepActuators(m, cfg, { frontLeft: cmd(1, true), frontRight: cmd(1), backLeft: cmd(1, true), backRight: cmd(1) }, 0.02, "mecanum", 0, 0.104, 0.33, 0.3);
    expect(Math.hypot(r.vel.vx, r.vel.vz)).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) r = stepActuators(m, cfg, { frontLeft: cmd(1, true), frontRight: cmd(1), backLeft: cmd(1, true), backRight: cmd(1) }, 0.02, "mecanum", 0, 0.104, 0.33, 0.3);
    // 312 rpm * pi * 0.104 m = 1.70 m/s toward -Z at heading 0
    expect(r.vel.vz).toBeCloseTo(-1.70, 1);
    expect(Math.abs(r.vel.vx)).toBeLessThan(1e-6);
    expect(Math.abs(r.vel.yawRate)).toBeLessThan(1e-6);
  });
  it("mecanum strafe pattern produces lateral motion", () => {
    const m = createActuatorModel();
    let r = { vel: { vx: 0, vz: 0, yawRate: 0 } } as any;
    for (let i = 0; i < 100; i++) r = stepActuators(m, cfg, { frontLeft: cmd(-1, true), frontRight: cmd(1), backLeft: cmd(1, true), backRight: cmd(-1) }, 0.02, "mecanum", 0, 0.104, 0.33, 0.3);
    expect(r.vel.vx).toBeLessThan(-1.5); // left = -X at heading 0
    expect(Math.abs(r.vel.vz)).toBeLessThan(1e-6);
  });
  it("encoders count and flywheel velocity command reaches rpm", () => {
    const m = createActuatorModel();
    let r;
    for (let i = 0; i < 200; i++) r = stepActuators(m, cfg, { frontLeft: cmd(0.5, true), shooter: { kind: "motor", power: 0.5, mode: "RUN_USING_ENCODER", reverse: false, targetVel: 3000 / 60 * 28, targetPos: 0, brake: true } }, 0.02, "mecanum", 0, 0.104, 0.33, 0.3);
    const s = motorSensors(m, cfg);
    expect(s.frontLeft.pos).toBeGreaterThan(1000);
    expect(s.frontLeft.vel).toBeCloseTo(0.5 * 312 / 60 * 537.7, 0);
    expect(r!.flywheelRpm).toBeCloseTo(3000, 0);
  });
  it("feeder fires once per rising edge through the threshold, even for brief pulses", () => {
    expect(feederFires(cfg, [{ name: "feeder", from: 0, to: 1 }, { name: "feeder", from: 1, to: 0 }, { name: "feeder", from: 0, to: 1 }])).toBe(2);
    expect(feederFires(cfg, [{ name: "feeder", from: 0.6, to: 1 }])).toBe(0);
    expect(feederFires(cfg, [{ name: "hood", from: 0, to: 1 }])).toBe(0);
  });
});

import { camelsHumpHardwareConfig } from "../src/runtime/hardwareConfig";
import { PHYSICS_PROFILES } from "../src/sim/drivePhysics";
describe("actuator model with drive physics (tank, tiles profile)", () => {
  const hw = camelsHumpHardwareConfig(); // right side mirrored: code REVERSEs the left motor, so forward = negative power on both
  const tiles = { profile: PHYSICS_PROFILES.tiles, massKg: 11 };
  const turnCmd = (p: number) => ({ "Left Drive": cmd(-p, true), "Right Drive": cmd(p) }); // the team's turnTo: left=-turn, right=+turn
  const steps = (cmds: any, n: number, m = createActuatorModel()) => { let r; for (let i = 0; i < n; i++) r = stepActuators(m, hw, cmds, 0.02, "tank", 0, 0.096, 15.3 * 0.0254, 13.5 * 0.0254, tiles); return { r: r!, m }; };
  it("a 14 % turn stalls: no yaw, encoders stuck, current reported", () => {
    const { r, m } = steps(turnCmd(0.14), 75);
    expect(Math.abs(r.vel.yawRate)).toBeLessThan(1e-9);
    const s = motorSensors(m, hw);
    expect(s["Left Drive"].vel).toBe(0);
    expect(s["Left Drive"].amps).toBeGreaterThan(1.2);
    expect([...m.stalled].sort()).toEqual(["Left Drive", "Right Drive"]);
    expect(m.breakaway.turn).toBeGreaterThan(0.14);
  });
  it("a 30 % turn turns and the ideal profile ignores friction", () => {
    const { r } = steps(turnCmd(0.3), 75);
    expect(Math.abs(r.vel.yawRate)).toBeGreaterThan(0.3);
    let r2; const m = createActuatorModel();
    for (let i = 0; i < 75; i++) r2 = stepActuators(m, hw, turnCmd(0.14), 0.02, "tank", 0, 0.096, 15.3 * 0.0254, 13.5 * 0.0254, { profile: PHYSICS_PROFILES.ideal, massKg: 11 });
    expect(Math.abs(r2!.vel.yawRate)).toBeGreaterThan(0.1);
    expect(m.stalled.size).toBe(0);
  });
});
