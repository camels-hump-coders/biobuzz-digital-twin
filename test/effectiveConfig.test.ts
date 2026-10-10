import { describe, expect, it } from "vitest";
import { derivePersisted, effectiveConfig, schemaLeafKeys } from "../src/runtime/effectiveConfig";

const profile = { tagTracking: { shotRangeIn: 54, adaptivePower: true, launchAngleDeg: 60, launchAngleMeasured: true, minShotRangeIn: null }, matchAuto: { enabled: true, pauseAimTimers: true } };
const schema = { type: "object", properties: { tagTracking: { type: "object", properties: { shotRangeIn: {}, adaptivePower: {}, launchAngleDeg: {}, launchAngleMeasured: {}, minShotRangeIn: {}, powerTable: { type: "array" } } }, matchAuto: { type: "object", properties: { enabled: {}, pauseAimTimers: {} } } } };
const files = [
  { path: "biobuzz/robot-profile.json", text: JSON.stringify(profile) },
  { path: "biobuzz/robot-profile.schema.json", text: JSON.stringify(schema) },
];

describe("effective configuration with provenance (SG-001)", () => {
  it("clean install: packaged values, schema keys the file lacks are missing, not false", () => {
    const { effective, profile: p } = effectiveConfig(files);
    const f = effective["biobuzz/robot-profile.json"];
    expect(f["tagTracking.shotRangeIn"]).toEqual({ value: 54, source: "packaged" });
    expect(f["tagTracking.minShotRangeIn"]).toEqual({ value: null, source: "packaged" }); // null is a value, not missing
    expect(f["tagTracking.powerTable"].source).toBe("missing");
    expect(f["tagTracking.powerTable"].value).toBeUndefined();
    expect(p.mode).toBe("clean-install");
    expect(p.missing["biobuzz/robot-profile.json"]).toEqual(["tagTracking.powerTable"]);
  });
  it("a saved hub profile that predates the solver keys leaves them missing although the packaged file has them", () => {
    const saved = derivePersisted(profile, ["tagTracking.launchAngleDeg", "tagTracking.launchAngleMeasured", "tagTracking.adaptivePower"]);
    const { effective, profile: p } = effectiveConfig(files, { "biobuzz/robot-profile.json": saved });
    const f = effective["biobuzz/robot-profile.json"];
    expect(f["tagTracking.launchAngleMeasured"].source).toBe("missing");
    expect(f["tagTracking.launchAngleMeasured"].note).toMatch(/saved hub profile/);
    expect(f["tagTracking.shotRangeIn"]).toEqual({ value: 54, source: "persisted" });
    expect(p.mode).toBe("persisted");
    expect(p.missing["biobuzz/robot-profile.json"].sort()).toEqual(["tagTracking.adaptivePower", "tagTracking.launchAngleDeg", "tagTracking.launchAngleMeasured", "tagTracking.powerTable"]);
  });
  it("overrides win over the saved copy, bound over manual, and bound calibration keys mark the run synthetic", () => {
    const saved = derivePersisted(profile, ["tagTracking.launchAngleMeasured"], { "matchAuto.pauseAimTimers": false });
    const { effective, profile: p } = effectiveConfig(files, { "biobuzz/robot-profile.json": saved }, { "biobuzz/robot-profile.json": { "matchAuto.enabled": false, "tagTracking.shotRangeIn": 60 } }, { "biobuzz/robot-profile.json": { "tagTracking.shotRangeIn": 72 } });
    const f = effective["biobuzz/robot-profile.json"];
    expect(f["matchAuto.pauseAimTimers"]).toEqual({ value: false, source: "persisted" });
    expect(f["matchAuto.enabled"]).toEqual({ value: false, source: "manual" });
    expect(f["tagTracking.shotRangeIn"]).toEqual({ value: 72, source: "bound" });
    expect(f["tagTracking.launchAngleMeasured"].source).toBe("missing");
    expect(p.calibration).toMatch(/synthetic/);
    expect(p.boundCalibration).toEqual(["robot-profile.json tagTracking.shotRangeIn"]);
  });
  it("schema leaf keys descend objects and stop at arrays", () => {
    expect(schemaLeafKeys(schema as any)).toContain("tagTracking.powerTable");
    expect(schemaLeafKeys(schema as any)).not.toContain("tagTracking");
  });
});
