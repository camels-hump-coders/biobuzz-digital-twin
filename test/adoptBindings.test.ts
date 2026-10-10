import { describe, expect, it } from "vitest";
import { applyAdoption, invertExpression, planAdoption } from "../src/runtime/adoptBindings";
import { defaultState } from "../src/state";
import { computeBindings, twinKnobs } from "../src/runtime/bindings";

describe("adopting file values into the twin (reverse bindings)", () => {
  it("inverts plain, negated, rounded, scaled and case-changed knob expressions", () => {
    expect(invertExpression("launcher.elevationDeg", 60)).toEqual({ knob: "launcher.elevationDeg", value: 60 });
    expect(invertExpression("-camera.webcam_1.pitchDeg", 35)).toEqual({ knob: "camera.webcam_1.pitchDeg", value: -35 });
    expect(invertExpression("round(hardware.webcam_1.pitchUpDeg, 1)", 35)).toEqual({ knob: "hardware.webcam_1.pitchUpDeg", value: 35 });
    expect(invertExpression("robot.wheelDiameterMm / 25.4", 3.78)).toEqual({ knob: "robot.wheelDiameterMm", value: 3.78 * 25.4 });
    expect(invertExpression("upper(alliance)", "BLUE")).toEqual({ knob: "alliance", value: "blue" });
    expect(invertExpression("hive.ours", "SCORING", { scoring: "SCORING", audience: "AUDIENCE" })).toEqual({ knob: "hive.ours", value: "scoring" });
    expect(invertExpression("robot.lengthIn + robot.widthIn", 30)).toHaveProperty("reason");
  });
  it("plans adoption from the team's bindings: geometry adopts, the solver calibration is explained, nothing else moves", () => {
    const state = defaultState();
    const bindings = [
      { asset: "biobuzz/robot-profile.json", key: "tagTracking.launchAngleDeg", twin: "launcher.elevationDeg", round: 1 },
      { asset: "biobuzz/robot-profile.json", key: "camera.pitchDeg", twin: "hardware.webcam_1.pitchUpDeg", round: 1 },
      { asset: "biobuzz/robot-profile.json", key: "tagTracking.shotRangeIn", twin: "launcher.calibration.rangeIn" },
      { asset: "biobuzz/robot-profile.json", key: "robotWidthIn", twin: "robot.widthIn", round: 2 },
    ];
    state.hardware.devices.push({ name: "Webcam 1", kind: "webcam", cameraId: state.robot.cameras[0]?.id } as any);
    const plan = planAdoption(bindings, [
      { asset: "biobuzz/robot-profile.json", key: "tagTracking.launchAngleDeg", fileValue: 60 },
      { asset: "biobuzz/robot-profile.json", key: "camera.pitchDeg", fileValue: 35 },
      { asset: "biobuzz/robot-profile.json", key: "tagTracking.shotRangeIn", fileValue: 54 },
      { asset: "biobuzz/robot-profile.json", key: "robotWidthIn", fileValue: 16.8 },
    ]);
    const r = applyAdoption(state, plan);
    expect(r.adopted.map((a) => a.key).sort()).toEqual(["camera.pitchDeg", "robotWidthIn", "tagTracking.launchAngleDeg"]);
    expect(r.skipped).toEqual([{ key: "tagTracking.shotRangeIn", reason: expect.stringMatching(/solver/) }]);
    expect(state.robot.launcher.elevationDeg).toBe(60);
    expect(state.robot.cameras[0].pitchDeg).toBe(-35); // pitchUpDeg 35 = pitch 35 down-negative
    expect(state.robot.widthM).toBeCloseTo(16.8 * 0.0254, 6);
    // and the bindings now reproduce the file values
    const bound = computeBindings({ bindings }, twinKnobs(state)).overrides["biobuzz/robot-profile.json"];
    expect(bound["tagTracking.launchAngleDeg"]).toBe(60);
    expect(bound["camera.pitchDeg"]).toBe(35);
    expect(bound["robotWidthIn"]).toBe(16.8);
  });
});
