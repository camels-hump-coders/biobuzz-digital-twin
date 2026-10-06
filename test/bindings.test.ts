import { describe, expect, it } from "vitest";
import { computeBindings, evaluate, mergeOverrides, twinKnobs } from "../src/runtime/bindings";
import { defaultState } from "../src/state";
import { camelsHumpHardwareConfig } from "../src/runtime/hardwareConfig";

const knobs = { "robot.wheelDiameterIn": 3.78, "camera.webcam_1.pitchDeg": -8, alliance: "blue", "hardware.left_drive.ticksPerRev": 537.7 };

describe("binding expressions", () => {
  it("reads knobs, does arithmetic and functions", () => {
    expect(evaluate("robot.wheelDiameterIn", knobs)).toBeCloseTo(3.78);
    expect(evaluate("-camera.webcam_1.pitchDeg", knobs)).toBe(8);
    expect(evaluate("round(robot.wheelDiameterIn * 25.4, 1)", knobs)).toBe(96);
    expect(evaluate("upper(alliance)", knobs)).toBe("BLUE");
    expect(evaluate("(1 + 2) * 3 - 4 / 2", knobs)).toBe(7);
  });
  it("rejects unknown knobs and bad syntax with a message", () => {
    expect(() => evaluate("robot.nope", knobs)).toThrow(/unknown twin knob/);
    expect(() => evaluate("1 +", knobs)).toThrow();
  });
});

describe("computeBindings", () => {
  it("groups results by asset and keeps the source expression", () => {
    const r = computeBindings({ bindings: [
      { asset: "a.json", key: "wheelDiameterIn", twin: "robot.wheelDiameterIn", round: 2 },
      { asset: "a.json", key: "tagTracking.alliance", twin: "alliance", map: { red: "RED", blue: "BLUE" } },
      { asset: "a.json", key: "broken", twin: "robot.missing" },
    ] }, knobs);
    expect(r.overrides["a.json"].wheelDiameterIn).toBe(3.78);
    expect(r.overrides["a.json"]["tagTracking.alliance"]).toBe("BLUE");
    expect(r.sources["a.json"].wheelDiameterIn).toBe("robot.wheelDiameterIn");
    expect(r.errors).toHaveLength(1);
  });
  it("bound keys win over manual ones", () => {
    const m = mergeOverrides({ "a.json": { x: 1, y: 2 } }, { "a.json": { x: 9 } });
    expect(m["a.json"]).toEqual({ x: 9, y: 2 });
  });
});

describe("twin knob catalogue", () => {
  it("exposes robot, camera, launcher, hardware and start knobs in team units", () => {
    const st = defaultState();
    st.hardware = camelsHumpHardwareConfig();
    const k = twinKnobs(st);
    expect(k["robot.wheelDiameterIn"]).toBeCloseTo(st.robot.wheelDiameterM / 0.0254, 6);
    expect(k["hardware.left_drive.ticksPerRev"]).toBe(537.7);
    expect(k["hardware.left_drive.port"]).toBe(1);
    expect(k["hardware.webcam_1.yawDeg"]).toBe(st.robot.cameras[0].yawDeg);
    expect(typeof k["start.xIn"]).toBe("number");
    expect(k["launcher.yawOffsetDeg"]).toBe(st.robot.launcher.yawOffsetDeg);
  });
});

describe("intake heading knob", () => {
  it("maps the intake side to a heading left of forward", () => {
    const st = defaultState();
    st.robot.intake = { side: "rear", widthM: 0.3 };
    expect(twinKnobs(st)["robot.intakeHeadingDeg"]).toBe(180);
    st.robot.intake.side = "right";
    expect(twinKnobs(st)["robot.intakeHeadingDeg"]).toBe(-90);
    st.robot.intake.side = "front";
    expect(twinKnobs(st)["robot.intakeHeadingDeg"]).toBe(0);
  });
});
