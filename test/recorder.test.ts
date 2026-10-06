import { describe, expect, it } from "vitest";
import { type Sample, Recorder } from "../src/runtime/recorder";

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

describe("runs and stepping", () => {
  const smp = (t: number, status: string, opMode = "", match = "setup"): Sample => ({ t, sim: 0, status, opMode, telemetry: [], pose: { xIn: 0, zIn: 0, headingDeg: 0 }, match, carrying: "", shots: { fired: 0, hit: 0 }, buttons: "" });
  it("opens a run at INIT and closes it when the OpMode stops", () => {
    const r = new Recorder();
    r.push(smp(1000, "IDLE")); r.push(smp(1100, "INIT", "Drive")); r.push(smp(1200, "RUNNING", "Drive")); r.push(smp(1300, "RUNNING", "Drive")); r.push(smp(1400, "STOPPED", "Drive")); r.push(smp(1500, "IDLE"));
    expect(r.runs).toEqual([{ start: 1100, end: 1400, opMode: "Drive" }]);
    expect(r.latestRun()?.opMode).toBe("Drive");
    expect(r.runAt(1250)?.start).toBe(1100); expect(r.runAt(1500)).toBeUndefined();
    r.push(smp(1600, "INIT", "Auto")); expect(r.runs.length).toBe(2); expect(r.latestRun()?.end).toBeUndefined();
  });
  it("counts a keyboard match as a run too, and steps by samples", () => {
    const r = new Recorder();
    r.push(smp(0, "DISCONNECTED", "", "setup")); r.push(smp(100, "DISCONNECTED", "", "running 2:30")); r.push(smp(200, "DISCONNECTED", "", "running 2:29")); r.push(smp(300, "DISCONNECTED", "", "stopped"));
    expect(r.runs).toEqual([{ start: 100, end: 300, opMode: "" }]);
    expect(r.step(200, -1)?.t).toBe(100); expect(r.step(200, 5)?.t).toBe(300); expect(r.indexAt(250)).toBe(2);
  });
});
