/**
 * Feeder transit (handoff G04): a feeder command is not a launched ball. One ball at a time travels a throat from the
 * hopper to the flywheel; it only moves while the feeder is powered past its deadband (continuous rotation) or a
 * positional stroke is in progress, it stays where it stopped, and an empty hopper feeds nothing. Pure.
 */

export interface FeedSettings {
  /** hopper exit to flywheel contact, metres */
  throatM: number;
  /** ball speed along the throat at full feeder power, m/s (scales linearly with |power|) */
  feedMps: number;
  /** |power| at or below which a continuous-rotation feeder does not move the ball */
  deadband: number;
  /** a positional feeder servo's stroke: the time one rising edge takes to push a ball the whole throat, s */
  strokeS: number;
  /** flywheel speed lost to each launch, fraction */
  rpmDropFrac: number;
  /** below this flywheel speed the ball leaves the throat but falls out instead of flying */
  minLaunchRpm: number;
  provenance: "estimated" | "user";
}

/** Bracketed by the 2026-10-08 session: 0.4 s at 20 % did not reach the wheel, 1.0 s at 20 % launched (≈ 0.69 s here). */
export const DEFAULT_FEED: FeedSettings = { throatM: 0.09, feedMps: 0.65, deadband: 0.08, strokeS: 0.25, rpmDropFrac: 0.08, minLaunchRpm: 1200, provenance: "estimated" };

export interface FeederState {
  /** the staged ball's distance along the throat, metres; undefined = nothing staged */
  ballPosM?: number;
  /** positional stroke time left, s */
  strokeLeftS: number;
  /** command rising edges seen */
  pulses: number;
  /** balls that reached the wheel */
  launches: number;
  /** last |power| (CR) or position (servo), for edge detection */
  last: number;
  /** why the last step did not move a ball */
  reason?: string;
}
export function createFeederState(): FeederState { return { strokeLeftS: 0, pulses: 0, launches: 0, last: 0 }; }

export interface FeederInput {
  kind: "crservo" | "servo";
  /** signed power for a CR feeder, 0..1 position for a positional one */
  value: number;
  /** positional servos: the threshold whose rising edge starts a stroke */
  threshold?: number;
  /** balls available to feed (hopper inventory) */
  hopper: number;
  dt: number;
}

/** Advance the feeder; `launch` is true when a ball reached the flywheel this step. */
export function stepFeeder(st: FeederState, s: FeedSettings, inp: FeederInput): { launch: boolean; moved: boolean; pulse: boolean } {
  let pulse = false;
  let speed = 0; // m/s along the throat, + toward the wheel
  if (inp.kind === "crservo") {
    const mag = Math.abs(inp.value);
    if (st.last <= s.deadband && mag > s.deadband) { pulse = true; st.pulses++; }
    st.last = mag;
    if (mag > s.deadband) speed = Math.sign(inp.value) * mag * s.feedMps;
  } else {
    const th = inp.threshold ?? 0.5;
    if (st.last < th && inp.value >= th) { pulse = true; st.pulses++; st.strokeLeftS = s.strokeS; }
    st.last = inp.value;
    if (st.strokeLeftS > 0) { speed = s.throatM / s.strokeS; st.strokeLeftS = Math.max(0, st.strokeLeftS - inp.dt); }
  }
  if (speed === 0) {
    // idle keeps the last reason (why the last attempt fed nothing); a command inside the deadband is its own reason
    if (inp.kind === "crservo" && Math.abs(inp.value) > 0) st.reason = `feeder at ${Math.round(Math.abs(inp.value) * 100)} % is inside the ${Math.round(s.deadband * 100)} % deadband`;
    return { launch: false, moved: false, pulse };
  }
  if (st.ballPosM === undefined) {
    if (inp.hopper <= 0) { st.reason = "feeder running with an empty hopper"; return { launch: false, moved: false, pulse }; }
    st.ballPosM = 0;
  }
  st.reason = undefined;
  st.ballPosM = Math.max(0, st.ballPosM + speed * inp.dt);
  if (st.ballPosM >= s.throatM) {
    st.launches++;
    st.ballPosM = inp.hopper > 1 ? 0 : undefined; // the next ball drops to the start of the throat
    return { launch: true, moved: true, pulse };
  }
  return { launch: false, moved: true, pulse };
}

/** Seconds a continuous-rotation feeder at |power| needs to carry a ball from the hopper to the wheel. */
export function transitSeconds(s: FeedSettings, power: number): number {
  const mag = Math.abs(power);
  return mag > s.deadband ? s.throatM / (mag * s.feedMps) : Infinity;
}
