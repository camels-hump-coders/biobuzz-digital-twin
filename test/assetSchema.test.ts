import { describe, expect, it } from "vitest";
import { constraintText, nodeAt, schemaFor, searchText, validate, validateAll } from "../src/runtime/assetSchema";

const schema = {
  properties: {
    matchAuto: { description: "Autonomous routine", properties: {
      startPosition: { type: "string", enum: ["LOADING_ZONE", "FAR_SIDE"], default: "LOADING_ZONE", description: "Which start square" },
      drivePower: { type: "number", minimum: 0.1, maximum: 0.5, default: 0.3 },
      ballCount: { type: "integer", minimum: 1, maximum: 8 },
      searchDirection: { enum: [0, 1, -1] },
    } },
    shotRangeIn: { type: ["number", "null"], minimum: 6, maximum: 144 },
    powerTable: { type: "array", items: { properties: { rangeIn: { type: "number", minimum: 6 } } } },
    bindings: { additionalProperties: { properties: { input: { enum: ["A", "B"] }, controller: { enum: [1, 2] } } } },
  },
};
const files = [{ path: "x/robot-profile.json", text: "{}" }, { path: "x/robot-profile.schema.json", text: JSON.stringify(schema) }];

describe("asset schema", () => {
  it("finds the sidecar and walks properties, items and additionalProperties", () => {
    expect(schemaFor(files, "x/robot-profile.json")).toBeTruthy();
    expect(schemaFor(files, "x/other.json")).toBeUndefined();
    expect(nodeAt(schema, "matchAuto.startPosition")?.enum).toEqual(["LOADING_ZONE", "FAR_SIDE"]);
    expect(nodeAt(schema, "powerTable.3.rangeIn")?.minimum).toBe(6);
    expect(nodeAt(schema, "bindings.driveForward.input")?.enum).toEqual(["A", "B"]);
    expect(nodeAt(schema, "nope.key")).toBeUndefined();
  });
  it("validates enums, ranges, integers and nulls", () => {
    const n = (k: string) => nodeAt(schema, k);
    expect(validate(n("matchAuto.startPosition"), "FAR_SIDE")).toBeUndefined();
    expect(validate(n("matchAuto.startPosition"), "LEFT")).toMatch(/one of/);
    expect(validate(n("matchAuto.drivePower"), 0.6)).toBe("maximum 0.5");
    expect(validate(n("matchAuto.drivePower"), "0.3")).toMatch(/expected number/);
    expect(validate(n("matchAuto.ballCount"), 2.5)).toMatch(/expected integer/);
    expect(validate(n("matchAuto.searchDirection"), -1)).toBeUndefined();
    expect(validate(n("shotRangeIn"), null)).toBeUndefined();
    expect(validate(n("matchAuto.drivePower"), null)).toMatch(/null/);
    expect(validate(undefined, "anything")).toBeUndefined();
  });
  it("summarises constraints and feeds the search", () => {
    expect(constraintText(nodeAt(schema, "matchAuto.drivePower"))).toBe("0.1 – 0.5 · default 0.3");
    expect(constraintText(nodeAt(schema, "matchAuto.startPosition"))).toBe("one of LOADING_ZONE, FAR_SIDE · default LOADING_ZONE");
    expect(constraintText(nodeAt(schema, "shotRangeIn"))).toBe("6 – 144 · null allowed");
    expect(searchText("matchAuto.startPosition", nodeAt(schema, "matchAuto.startPosition"))).toContain("which start square");
  });
  it("lists every violation in a file", () => {
    const bad = validateAll({ matchAuto: { startPosition: "MIDDLE", drivePower: 0.3, ballCount: 9 }, shotRangeIn: null }, schema);
    expect(bad.map((b) => b.key)).toEqual(["matchAuto.startPosition", "matchAuto.ballCount"]);
  });
});
