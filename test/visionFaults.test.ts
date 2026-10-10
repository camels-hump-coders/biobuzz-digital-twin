import { describe, expect, it } from "vitest";
import { LatencyQueue, NO_FAULTS, applyFaults } from "../src/runtime/visionFaults";
import type { TagPacket } from "../src/runtime/link";

const pkt = (id: number, x = 0, y = 60, z = 30): TagPacket => ({ id, cx: 320, cy: 240, x, y, z, yaw: 0, pitch: 0, roll: 0, range: Math.hypot(x, y, z), bearing: 0, elevation: 0, robotX: 0, robotY: 0, robotYaw: 0, R: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
const upper = [42, 43, 44, 45].map((id, i) => pkt(id, (i - 1.5) * 4, 60, 30));

describe("camera faults", () => {
  it("no faults passes packets through untouched", () => {
    const r = applyFaults(upper, NO_FAULTS, { yawRateDps: 0 });
    expect(r.out).toEqual(upper);
    expect(r.applied).toEqual([]);
  });
  it("a misread relabels the decoded id but keeps the physical tag's pose", () => {
    const r = applyFaults(upper, { ...NO_FAULTS, misreadIds: { "44": 45 } }, { yawRateDps: 0 });
    expect(r.out.map((p) => p.id)).toEqual([42, 43, 45, 45]);
    expect(r.out[2].x).toBe(upper[2].x);
    expect(r.applied).toContain("misread");
  });
  it("a duplicate adds a second, perturbed copy", () => {
    const r = applyFaults(upper, { ...NO_FAULTS, duplicateIds: [45] }, { yawRateDps: 0 });
    expect(r.out.filter((p) => p.id === 45)).toHaveLength(2);
    expect(r.out[4].range).not.toBe(r.out[3].range);
  });
  it("blur while turning fast drops every detection; dropout is random but seeded", () => {
    expect(applyFaults(upper, { ...NO_FAULTS, blurAboveDps: 90 }, { yawRateDps: 120 }).out).toHaveLength(0);
    expect(applyFaults(upper, { ...NO_FAULTS, blurAboveDps: 90 }, { yawRateDps: 30 }).out).toHaveLength(4);
    let seq = 0; const rnd = () => (seq++ % 2 === 0 ? 0.1 : 0.9);
    expect(applyFaults(upper, { ...NO_FAULTS, dropoutProb: 0.5 }, { yawRateDps: 0, rnd }).out).toHaveLength(2);
  });
  it("small tags are not decoded", () => {
    const r = applyFaults(upper, { ...NO_FAULTS, minPixels: 20 }, { yawRateDps: 0, pixelsById: { 42: 10, 43: 25, 44: 25, 45: 25 } });
    expect(r.out.map((p) => p.id)).toEqual([43, 44, 45]);
  });
  it("latency delays delivery and reports the frame's true age", () => {
    const q = new LatencyQueue();
    expect(q.push(0, upper, 500)).toBeUndefined();
    expect(q.push(300, upper, 500, 300)).toBeUndefined();
    const due = q.push(520, upper, 500, 520)!;
    expect(due).toBeDefined();
    expect(due[0].ageMs).toBe(520);
    expect(q.push(900, upper, 500, 900)![0].ageMs).toBe(600);
  });
});
