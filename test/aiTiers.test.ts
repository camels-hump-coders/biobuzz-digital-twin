import { describe, expect, it } from "vitest";
import { AI_TIERS, TIERS, choiceNoise, coerceTier } from "../src/sim/aiTiers";

describe("AI tiers", () => {
  it("get stronger in every execution knob from easy to hard, and never change what the robot can see", () => {
    const [e, m, h] = AI_TIERS.map((t) => TIERS[t]);
    expect(e.speedMps).toBeLessThan(m.speedMps); expect(m.speedMps).toBeLessThan(h.speedMps);
    expect(e.reactS).toBeGreaterThan(m.reactS); expect(m.reactS).toBeGreaterThan(h.reactS);
    expect(e.hesitate).toBeGreaterThan(m.hesitate); expect(h.hesitate).toBe(0);
    expect(e.volleyAt).toBeLessThan(m.volleyAt); expect(m.volleyAt).toBeLessThan(h.volleyAt);
    expect(e.standAngleDeg).toBeGreaterThan(m.standAngleDeg); expect(m.standAngleDeg).toBeGreaterThan(h.standAngleDeg);
    expect(e.yawSigmaDeg).toBeGreaterThan(h.yawSigmaDeg); expect(e.fireIntervalS).toBeGreaterThan(h.fireIntervalS);
    expect(e.tipSense).toBe(false); expect(h.tipSense).toBe(true);
    expect(e.parksEnd).toBe(false); expect(h.parksAuto).toBe(true); expect(h.defends).toBe(true);
  });
  it("coerces unknown tiers to medium", () => {
    expect(coerceTier("hard")).toBe("hard"); expect(coerceTier("nope")).toBe("medium"); expect(coerceTier(undefined)).toBe("medium");
  });
  it("choice noise is stable within a 3 s epoch and changes between epochs and robots", () => {
    const a = choiceNoise(1.2, -0.4, 10.0, 7), b = choiceNoise(1.2, -0.4, 11.9, 7), c = choiceNoise(1.2, -0.4, 12.1, 7), d = choiceNoise(1.2, -0.4, 10.0, 8);
    expect(a).toBe(b); expect(a).not.toBe(c); expect(a).not.toBe(d);
    for (const v of [a, c, d]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});
