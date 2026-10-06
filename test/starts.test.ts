import { describe, expect, it } from "vitest";
import { defaultStarts, setStartSide, startPose, startSideOf } from "../src/sim/starts";

const IN = 0.0254;
describe("start positions follow the raised cell", () => {
  it("red at match start (red audience cell up) starts on the audience half, partner on the other", () => {
    const hive = { red: "audience" as const, blue: "scoring" as const };
    expect(startPose(defaultStarts(), "you", "red", hive).z).toBeCloseTo(36 * IN, 6);
    expect(startPose(defaultStarts(), "partner", "red", hive).z).toBeCloseTo(-36 * IN, 6);
    // blue's raised cell is the scoring one (world -z): their robots split so one is on that half
    expect(startPose(defaultStarts(), "opp1", "red", hive).z).toBeCloseTo(-36 * IN, 6);
  });
  it("after our hive tipped (scoring cell up) we start on the scoring half", () => {
    const hive = { red: "scoring" as const, blue: "scoring" as const };
    expect(startPose(defaultStarts(), "you", "red", hive).z).toBeCloseTo(-36 * IN, 6);
  });
  it("blue at match start (blue scoring cell up) starts on the scoring half at the east wall", () => {
    const hive = { red: "audience" as const, blue: "scoring" as const };
    const p = startPose(defaultStarts(), "you", "blue", hive);
    expect(p.x).toBeCloseTo(63 * IN, 6);
    expect(p.z).toBeCloseTo(-36 * IN, 6);
  });
  it("can be switched off", () => {
    const st = { ...defaultStarts(), followUpCell: false };
    expect(startPose(st, "you", "red", { red: "scoring", blue: "scoring" }).z).toBeCloseTo(36 * IN, 6);
  });
});

describe("start side (quick bar)", () => {
  const hive = { red: "audience", blue: "scoring" } as const;
  it("reads the side the default start lands on: red follows its up cell (audience half = far side)", () => {
    expect(startSideOf(defaultStarts(), "red", hive)).toBe("far");
    // the field is rotationally symmetric: blue's raised cell also faces away from blue's LOADING ZONE at match start
    expect(startSideOf(defaultStarts(), "blue", hive)).toBe("far");
  });
  it("pins a side for either alliance and gives the partner the other square", () => {
    for (const alliance of ["red", "blue"] as const) for (const side of ["loading", "far"] as const) {
      const s = setStartSide(defaultStarts(), side);
      expect(s.followUpCell).toBe(false);
      expect(startSideOf(s, alliance, hive)).toBe(side);
      expect(Math.sign(s.partner.zIn)).toBe(-Math.sign(s.you.zIn));
    }
  });
  it("the loading-zone start is on the scoring-side half, next to the alliance's LOADING ZONE", () => {
    const p = startPose(setStartSide(defaultStarts(), "loading"), "you", "red", hive);
    expect(p.z).toBeLessThan(0); expect(p.x).toBeLessThan(0); // red wall is west, loading zone z -48..-25 in
  });
});
