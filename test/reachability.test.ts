import { describe, expect, it } from "vitest";
import { computeReachability } from "../src/ballistics/reachability";
import { LAUNCHER_PRESETS } from "../src/ballistics/launcher";
import { upCellFrame } from "../src/field/hive";
import { BALL, m } from "../src/field/fieldSpec";
import { clipToSquare } from "../src/camera/cameraMath";

describe("reachability", () => {
  it("StarterBot fixed hood can score from the audience side but not from behind the hive", () => {
    const frame = upCellFrame({ alliance: "red", upCell: "audience" });
    const ball = { massKg: BALL.pollen.massKg, diameterM: m(BALL.pollen.diaIn), cd: 0.45, cl: 0 };
    const map = computeReachability(frame, LAUNCHER_PRESETS.starterbot, ball, 24);
    const audienceSide = map.cells.filter((c) => c.z > 0.9 && Math.abs(c.x + 0.3) < 0.6);
    const scoringSide = map.cells.filter((c) => c.z < -0.9);
    expect(audienceSide.some((c) => c.rpm !== undefined)).toBe(true);
    expect(scoringSide.every((c) => c.rpm === undefined)).toBe(true);
    for (const c of map.cells) if (c.rpm !== undefined) expect(c.rpm).toBeLessThanOrEqual(map.maxRpm + 1e-6);
  });
});

describe("clipToSquare", () => {
  it("clips a big triangle to the square", () => {
    const poly = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }];
    const out = clipToSquare(poly, 1);
    for (const p of out) { expect(p.x).toBeLessThanOrEqual(1 + 1e-9); expect(p.z).toBeLessThanOrEqual(1 + 1e-9); }
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

describe("incremental reach job", () => {
  it("matches the one-shot map square for square and reports progress", async () => {
    const { ReachJob } = await import("../src/ballistics/reachability");
    const { LAUNCHER_PRESETS } = await import("../src/ballistics/launcher");
    const { upCellFrame } = await import("../src/field/hive");
    const { BALL, m } = await import("../src/field/fieldSpec");
    const frame = upCellFrame({ alliance: "red", upCell: "audience" });
    const ball = { massKg: BALL.pollen.massKg, diameterM: m(BALL.pollen.diaIn), cd: 0.45, cl: 0.2 };
    const once = computeReachability(frame, LAUNCHER_PRESETS.starterbot, ball, 24);
    const job = new ReachJob(frame, LAUNCHER_PRESETS.starterbot, ball, 24);
    expect(job.done).toBe(false);
    expect(job.cells.every((c) => c.computed === false)).toBe(true);
    while (!job.done) job.step(1000);
    expect(job.cells.map((c) => [c.x, c.z, c.rpm, c.elevationDeg])).toEqual(once.cells.map((c) => [c.x, c.z, c.rpm, c.elevationDeg]));
  });
  it("accepts worker results in cell order", async () => {
    const { ReachJob } = await import("../src/ballistics/reachability");
    const { LAUNCHER_PRESETS } = await import("../src/ballistics/launcher");
    const { upCellFrame } = await import("../src/field/hive");
    const { BALL, m } = await import("../src/field/fieldSpec");
    const frame = upCellFrame({ alliance: "blue", upCell: "scoring" });
    const ball = { massKg: BALL.pollen.massKg, diameterM: m(BALL.pollen.diaIn), cd: 0.45, cl: 0.2 };
    const job = new ReachJob(frame, LAUNCHER_PRESETS.starterbot, ball, 24);
    const n = job.cells.length;
    job.accept(0, Array.from({ length: 3 }, () => ({ rpm: 1000, elevationDeg: 55 })));
    expect(job.computed).toBe(3); expect(job.done).toBe(false);
    job.accept(3, Array.from({ length: n - 3 }, () => ({})));
    expect(job.done).toBe(true); expect(job.cells[0].rpm).toBe(1000); expect(job.cells[n - 1].rpm).toBeUndefined();
  });
});
