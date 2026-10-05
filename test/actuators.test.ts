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
