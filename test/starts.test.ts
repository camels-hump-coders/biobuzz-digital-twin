import { describe, expect, it } from "vitest";
import { defaultStarts, startPose } from "../src/sim/starts";

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
