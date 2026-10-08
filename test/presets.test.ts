import { describe, expect, it } from "vitest";
import { PROFILES, ROBOT_PRESETS, clonePreset, matchingProfile, sizingIssues, topSpeedMps } from "../src/robot/presets";

describe("robot profiles", () => {
  it("every card has a preset and every preset matches itself", () => {
    for (const p of PROFILES) expect(ROBOT_PRESETS[p.id], p.id).toBeDefined();
    for (const id of Object.keys(ROBOT_PRESETS)) expect(matchingProfile(clonePreset(id))).toBe(id);
  });
  it("recolouring keeps the profile; changing the build makes it custom", () => {
    const r = clonePreset("starterbotMecanum");
    r.look = { color: 0xd42a2a }; r.color = 0xd42a2a; r.name = "mine";
    expect(matchingProfile(r)).toBe("starterbotMecanum");
    r.wheelRpm = 435;
    expect(matchingProfile(r)).toBeUndefined();
  });
  it("top speed and the 18 in check", () => {
    expect(topSpeedMps({ wheelRpm: 312, wheelDiameterM: 0.096 })).toBeCloseTo(1.568, 2);
    expect(sizingIssues(clonePreset("forager"))).toEqual([]);
    expect(sizingIssues({ lengthM: 0.5, widthM: 0.4, heightM: 0.3 })).toEqual(["length 19.7 in > 18 in"]);
  });
});
