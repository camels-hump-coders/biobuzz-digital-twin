import { describe, expect, it } from "vitest";
import { DEFAULT_FEED, createFeederState, stepFeeder, transitSeconds } from "../src/sim/feeder";

/** run a CR feeder pulse of `power` for `seconds`, then stop for `rest` seconds; returns launches */
function pulse(st = createFeederState(), power: number, seconds: number, rest = 0.6, hopperRef: { n: number } = { n: 4 }) {
  let launches = 0; // the hopper empties as balls launch, as the live inventory does
  for (let t = 0; t < seconds; t += 0.02) if (stepFeeder(st, DEFAULT_FEED, { kind: "crservo", value: power, hopper: hopperRef.n, dt: 0.02 }).launch) { launches++; hopperRef.n--; }
  for (let t = 0; t < rest; t += 0.02) if (stepFeeder(st, DEFAULT_FEED, { kind: "crservo", value: 0, hopper: hopperRef.n, dt: 0.02 }).launch) { launches++; hopperRef.n--; }
  return { st, launches };
}

describe("feeder transit", () => {
  it("0.4 s at 20 % does not reach the wheel; 1.0 s at 20 % does (the physical observation)", () => {
    expect(pulse(undefined, 0.2, 0.4).launches).toBe(0);
    expect(pulse(undefined, 0.2, 1.0).launches).toBe(1);
    expect(transitSeconds(DEFAULT_FEED, 0.2)).toBeGreaterThan(0.4);
    expect(transitSeconds(DEFAULT_FEED, 0.2)).toBeLessThan(1.0);
  });
  it("stopping midway leaves the ball where it is, and a second short pulse completes the transit", () => {
    const { st } = pulse(undefined, 0.2, 0.4);
    expect(st.ballPosM).toBeGreaterThan(0.04);
    expect(st.ballPosM).toBeLessThan(DEFAULT_FEED.throatM);
    expect(pulse(st, 0.2, 0.4).launches).toBe(1);
    expect(st.pulses).toBe(2);
    expect(st.launches).toBe(1);
  });
  it("an empty hopper launches nothing however many pulses are sent", () => {
    const st = createFeederState();
    for (let i = 0; i < 4; i++) pulse(st, 0.2, 1.0, 0.6, { n: 0 });
    expect(st.pulses).toBe(4);
    expect(st.launches).toBe(0);
    expect(st.reason).toMatch(/empty hopper/);
  });
  it("four 1 s pulses with two balls launch exactly two", () => {
    const st = createFeederState();
    const hopper = { n: 2 }; let launches = 0;
    for (let i = 0; i < 4; i++) launches += pulse(st, 0.2, 1.0, 0.6, hopper).launches;
    expect(launches).toBe(2);
    expect(st.pulses).toBe(4);
  });
  it("reverse backs the ball up; the deadband does not move it", () => {
    const { st } = pulse(undefined, 0.2, 0.4);
    const pos = st.ballPosM!;
    stepFeeder(st, DEFAULT_FEED, { kind: "crservo", value: -0.2, hopper: 4, dt: 0.1 });
    expect(st.ballPosM!).toBeLessThan(pos);
    const p2 = st.ballPosM!;
    stepFeeder(st, DEFAULT_FEED, { kind: "crservo", value: 0.05, hopper: 4, dt: 0.5 });
    expect(st.ballPosM).toBe(p2);
    expect(st.reason).toMatch(/deadband/);
  });
  it("a positional servo's rising edge is one stroke that delivers one ball", () => {
    const st = createFeederState();
    let launches = 0;
    const step = (pos: number, dt = 0.02) => { if (stepFeeder(st, DEFAULT_FEED, { kind: "servo", value: pos, threshold: 0.5, hopper: 4, dt }).launch) launches++; };
    step(0); step(1);
    for (let t = 0; t < 0.5; t += 0.02) step(1);
    expect(launches).toBe(1);
    for (let t = 0; t < 0.5; t += 0.02) step(1); // holding the position does not feed again
    expect(launches).toBe(1);
    step(0); step(1);
    for (let t = 0; t < 0.5; t += 0.02) step(1);
    expect(launches).toBe(2);
    expect(st.pulses).toBe(2);
  });
});
