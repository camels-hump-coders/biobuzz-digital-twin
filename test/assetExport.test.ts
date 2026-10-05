import { describe, expect, it } from "vitest";
import { applyOverrides, detectIndent, exportChangedAssets, patchJsonText, putDotted } from "../src/runtime/assetExport";

const file = { path: "biobuzz/robot-profile.json", text: '{\n    "robotWidthIn": 17.5,\n    "camera": {\n        "xIn": 0,\n        "pitchDeg": 8\n    },\n    "tagTracking": {\n        "alliance": "RED",\n        "shotRangeIn": null,\n        "powerTable": []\n    }\n}\n' };

describe("asset export", () => {
  it("detects the file's indentation", () => {
    expect(detectIndent(file.text)).toBe("    ");
    expect(detectIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectIndent("{}")).toBe("  ");
  });
  it("writes overrides into nested keys, creating objects like the shim", () => {
    const o: Record<string, unknown> = { a: 1 };
    putDotted(o, "b.c.d", 2); putDotted(o, "a", null);
    expect(o).toEqual({ a: null, b: { c: { d: 2 } } });
  });
  it("keeps key order, indentation and trailing newline; bound values win over manual ones", () => {
    const out = applyOverrides(file, { "camera.pitchDeg": 20, "tagTracking.shotRangeIn": 60 }, { "camera.pitchDeg": 35, "tagTracking.alliance": "BLUE" });
    const json = JSON.parse(out.text);
    expect(Object.keys(json)).toEqual(["robotWidthIn", "camera", "tagTracking"]);
    expect(json.camera.pitchDeg).toBe(35);
    expect(json.tagTracking.shotRangeIn).toBe(60);
    expect(json.tagTracking.alliance).toBe("BLUE");
    expect(out.text.startsWith('{\n    "robotWidthIn": 17.5,')).toBe(true);
    expect(out.text.endsWith("}\n")).toBe(true);
    expect(out.changed.map((c) => `${c.key}:${c.source}`).sort()).toEqual(["camera.pitchDeg:twin", "tagTracking.alliance:twin", "tagTracking.shotRangeIn:manual"]);
    expect(out.changed.find((c) => c.key === "camera.pitchDeg")!.from).toBe(8); // original value, not the manual one
  });
  it("reports no change when the override equals the committed value, and reproduces an untouched file byte for byte", () => {
    const same = applyOverrides(file, { "camera.xIn": 0, "tagTracking.alliance": "RED" });
    expect(same.changed).toEqual([]);
    expect(same.text).toBe(file.text);
    expect(exportChangedAssets([file], { [file.path]: { "camera.xIn": 0 } }, {})).toEqual([]);
    expect(exportChangedAssets([file], { [file.path]: { "camera.xIn": 1 } }, {}).length).toBe(1);
  });
  it("patches values in place: untouched lines stay byte-identical, including 1.0 and array layout", () => {
    const text = '{\n  "maxPower": 1.0,\n  "table": [\n    { "rangeIn": 48, "power": 0.5 }\n  ],\n  "aim": { "tol": 8, "name": "x" }\n}\n';
    const out = patchJsonText(text, [{ key: "aim.tol", value: 12 }]);
    expect(out).toBe('{\n  "maxPower": 1.0,\n  "table": [\n    { "rangeIn": 48, "power": 0.5 }\n  ],\n  "aim": { "tol": 12, "name": "x" }\n}\n');
    expect(patchJsonText(text, [{ key: "maxPower", value: 0.9 }, { key: "aim.name", value: "y" }])).toContain('"maxPower": 0.9');
  });
  it("appends keys that the file lacks, with the parent's indentation", () => {
    const text = '{\n    "camera": {\n        "xIn": 0\n    },\n    "empty": {}\n}\n';
    const out = patchJsonText(text, [{ key: "camera.rollDeg", value: 1.5 }, { key: "empty.a", value: true }, { key: "top", value: "t" }]);
    expect(JSON.parse(out)).toEqual({ camera: { xIn: 0, rollDeg: 1.5 }, empty: { a: true }, top: "t" });
    expect(out).toContain('        "xIn": 0,\n        "rollDeg": 1.5\n    }');
    expect(out.endsWith('"top": "t"\n}\n')).toBe(true);
  });
  it("falls back to re-serialising when a whole parent object is missing", () => {
    const out = patchJsonText('{"a": 1}', [{ key: "b.c.d", value: 2 }]);
    expect(JSON.parse(out)).toEqual({ a: 1, b: { c: { d: 2 } } });
  });
});
