import { describe, expect, it } from "vitest";
import { DEFAULT_AUDIO, MatchAudio, type AudioSnapshot, type Synth } from "../src/sim/audio";

function rig() {
  const log: string[] = [];
  const synth: Synth = { cue: (n) => log.push(`cue:${n}`), effect: (n) => log.push(`fx:${n}`), say: (t) => log.push(`say:${t}`) };
  const a = new MatchAudio(synth, () => ({ ...DEFAULT_AUDIO }));
  const base: AudioSnapshot = { phase: "setup", clock: 150, shots: 0, intakes: 0, tipsStarted: 0, tipsDone: 0, bounces: [] };
  return { log, a, base, step: (o: Partial<AudioSnapshot>) => a.update({ ...base, ...o }, 0.1) };
}

describe("competition audio cues (Table 9-1)", () => {
  it("plays the whole match sequence once, in order", () => {
    const { log, step } = rig();
    step({}); step({ phase: "running", clock: 149.9 });
    expect(log).toEqual(["cue:charge"]);
    step({ phase: "running", clock: 121 }); step({ phase: "running", clock: 120, transition: 8 });
    expect(log.at(-1)).toBe("cue:buzzer3");
    step({ phase: "running", clock: 120, transition: 6.4 }); expect(log.at(-1)).toBe("say:Drivers, pick up your controllers");
    step({ phase: "running", clock: 120, transition: 2.9 }); expect(log.at(-1)).toBe("say:3");
    step({ phase: "running", clock: 120, transition: 1.9 }); step({ phase: "running", clock: 120, transition: 0.5 });
    expect(log.slice(-2)).toEqual(["say:2", "say:1"]);
    step({ phase: "running", clock: 119.9 }); expect(log.at(-1)).toBe("cue:bells");
    step({ phase: "running", clock: 20.5 }); step({ phase: "running", clock: 19.9 }); expect(log.at(-1)).toBe("cue:whistle");
    step({ phase: "running", clock: 0.1 }); step({ phase: "stopped", clock: 0 }); expect(log.at(-1)).toBe("cue:endBuzzer");
    expect(log.filter((l) => l === "cue:charge")).toHaveLength(1);
  });
  it("without the transition hold the bells follow the buzzer directly; stopping early sounds the foghorn", () => {
    const { log, step } = rig();
    step({}); step({ phase: "running", clock: 149.9 }); step({ phase: "running", clock: 120.1 }); step({ phase: "running", clock: 119.9 });
    expect(log.slice(-2)).toEqual(["cue:buzzer3", "cue:bells"]);
    step({ phase: "stopped", clock: 80 }); expect(log.at(-1)).toBe("cue:foghorn");
    step({ phase: "running", clock: 79.9 }); expect(log.at(-1)).toBe("cue:bells"); // resume
  });
  it("effects edge on counters and bounces are rate-limited by strength", () => {
    const { log, step } = rig();
    step({}); step({ shots: 1, intakes: 1, tipsStarted: 1 }); step({ shots: 1, intakes: 1, tipsStarted: 1, tipsDone: 1 });
    expect(log).toEqual(["fx:shot", "fx:swallow", "fx:tipStart", "fx:tipLand"]);
    step({ bounces: [0.2] }); expect(log.at(-1)).toBe("fx:tipLand"); // too soft
    step({ bounces: [3] }); expect(log.at(-1)).toBe("fx:bounce");
  });
  it("is silent when the master volume is 0", () => {
    const log: string[] = [];
    const a = new MatchAudio({ cue: (n) => log.push(n), effect: (n) => log.push(n), say: (t) => log.push(t) }, () => ({ ...DEFAULT_AUDIO, master: 0 }));
    const base: AudioSnapshot = { phase: "setup", clock: 150, shots: 0, intakes: 0, tipsStarted: 0, tipsDone: 0, bounces: [] };
    a.update(base, 0.1); a.update({ ...base, phase: "running", clock: 149.9, shots: 3 }, 0.1);
    expect(log).toEqual([]);
  });
});
