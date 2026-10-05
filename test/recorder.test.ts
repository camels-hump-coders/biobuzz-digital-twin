import { describe, expect, it } from "vitest";
import { Recorder } from "../src/runtime/recorder";

const sample = (t: number, extra: Partial<Parameters<Recorder["push"]>[0]> = {}) => ({
  t, sim: t / 1000, status: "RUNNING", opMode: "Test", telemetry: ["a : 1"], pose: { xIn: 0, zIn: 0, headingDeg: 0 }, match: "running", carrying: "4P+0N", shots: { fired: 0, hit: 0 }, buttons: "", ...extra,
});

describe("timeline recorder", () => {
  it("keeps a bounded ring buffer and finds the sample at a time", () => {
    const r = new Recorder(5, 5);
    for (let i = 0; i < 8; i++) r.push(sample(1000 + i * 100));
    expect(r.samples).toHaveLength(5);
    expect(r.start).toBe(1300);
    expect(r.at(1450)?.t).toBe(1400);
    expect(r.at(99)?.t).toBe(1300);
  });
  it("derives events from status, buttons and shots", () => {
    const r = new Recorder();
    r.push(sample(1000, { status: "INIT" }));
    r.push(sample(1100, { status: "RUNNING" }));
    r.push(sample(1200, { buttons: "1:guide" }));
    r.push(sample(1300, { buttons: "", shots: { fired: 1, hit: 1 } }));
    expect(r.events.map((e) => e.kind)).toEqual(["status", "button", "shot"]);
  });
  it("writes a markdown snapshot with context, events and deduplicated telemetry", () => {
    const r = new Recorder();
    r.push(sample(1000, { telemetry: ["Aim : SEARCHING"] }));
    r.push(sample(1100, { telemetry: ["Aim : SEARCHING"] }));
    r.push(sample(1200, { telemetry: ["Aim : CENTERED"] }));
    r.event(1150, "log", "hello from the OpMode");
    const md = r.snapshot({ from: 1000, to: 1200, context: { opMode: "Test" } });
    expect(md).toContain("## Context");
    expect(md).toContain("hello from the OpMode");
    expect(md.split("Aim : SEARCHING").length - 1).toBe(1);
    expect(md).toContain("Aim : CENTERED");
  });
});
