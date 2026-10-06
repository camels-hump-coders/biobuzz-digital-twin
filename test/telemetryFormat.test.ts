import { describe, expect, it } from "vitest";
import { classifyTelemetryLine, splitTelemetryLine } from "../src/ui/telemetryFormat";

describe("telemetry classification", () => {
  it("flags errors by the words teams and the SDK use", () => {
    expect(classifyTelemetryLine("Driver Control error : Adaptive power: the calibrated shot at 60 in cannot descend into the cell")).toBe("err");
    expect(classifyTelemetryLine("Outputs stopped. Fix setup/settings, then STOP and re-INIT.")).toBe("err");
    expect(classifyTelemetryLine("Camera : CAMERA NOT READY")).toBe("warn"); // not ready is a warning, not a crash
    expect(classifyTelemetryLine("Aim / shot : WAITING FOR FRESH CAMERA FRAME / IDLE")).toBe("warn");
    expect(classifyTelemetryLine("Match auto : DRIVE_OUT")).toBe("");
    expect(classifyTelemetryLine("Autonomous result : PARKED")).toBe("ok");
    expect(classifyTelemetryLine("Camera : STREAMING")).toBe("ok");
  });
  it("does not call a clear error field an error", () => {
    expect(classifyTelemetryLine("Driver Control error : none")).toBe("");
    expect(classifyTelemetryLine("Last error : -")).toBe("");
  });
  it("splits caption and value", () => {
    expect(splitTelemetryLine("heading : 12.4 deg")).toEqual({ key: "heading", value: "12.4 deg" });
    expect(splitTelemetryLine("just a line")).toEqual({});
    expect(splitTelemetryLine("Target / range / power : cluster:blue tier 1 / 68 in / 50%")).toEqual({ key: "Target / range / power", value: "cluster:blue tier 1 / 68 in / 50%" });
  });
});
