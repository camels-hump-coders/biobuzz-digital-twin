/**
 * Difficulty tiers for the scripted partner and opponents. One policy (match.driveScripted), one table of numbers:
 * a tier changes how well a robot executes, never what it can see, and every tier keeps the same safety behaviour
 * (stuck watchdog, pin back-off). Modelled on the approach DSIM takes: misses come from where and how carefully the
 * robot shoots, weakness from hesitation, reaction lag, slow driving, small volleys and sloppy target choice.
 */
export type AiTier = "easy" | "medium" | "hard";
export const AI_TIERS: AiTier[] = ["easy", "medium", "hard"];

export interface TierKnobs {
  /** top drive speed, m/s (the scripted chassis's own limit is 1.5) */
  speedMps: number;
  /** seconds a new mode or target waits before it takes effect */
  reactS: number;
  /** chance per 0.1 s decision of freezing for that decision (the robot stops briefly) */
  hesitate: number;
  /** balls collected before driving off to shoot (capped at capacity) */
  volleyAt: number;
  /** where it shoots from: distance band from the cell opening (in) and the largest angle off the mouth normal */
  standMinIn: number; standMaxIn: number; standAngleDeg: number;
  /** aim error, 1σ: launch yaw (deg) and exit speed (fraction) */
  yawSigmaDeg: number; speedSigma: number;
  /** seconds between shots */
  fireIntervalS: number;
  /** seconds it keeps working a source that yields nothing before giving up on it */
  patienceS: number;
  /** stable random seconds added to each candidate source's cost, so it sometimes picks a worse one */
  choiceNoiseS: number;
  /** counts toward the tip: stops firing once the cell plus balls in flight will tip, and re-targets while it swings */
  tipSense: boolean;
  /** parks in the LOADING ZONE at the end of the match / of AUTO */
  parksEnd: boolean; parksAuto: boolean;
  /** with nothing to collect, stands on the opposing alliance's shooting spot */
  defends: boolean;
}

export const TIERS: Record<AiTier, TierKnobs> = {
  easy: { speedMps: 0.55, reactS: 0.8, hesitate: 0.35, volleyAt: 2, standMinIn: 40, standMaxIn: 80, standAngleDeg: 45, yawSigmaDeg: 4, speedSigma: 0.06, fireIntervalS: 1.6, patienceS: 15, choiceNoiseS: 3, tipSense: false, parksEnd: false, parksAuto: false, defends: false },
  medium: { speedMps: 0.9, reactS: 0.3, hesitate: 0.15, volleyAt: 3, standMinIn: 50, standMaxIn: 70, standAngleDeg: 25, yawSigmaDeg: 2, speedSigma: 0.03, fireIntervalS: 0.9, patienceS: 9, choiceNoiseS: 1.2, tipSense: true, parksEnd: true, parksAuto: false, defends: false },
  hard: { speedMps: 1.3, reactS: 0, hesitate: 0, volleyAt: 4, standMinIn: 56, standMaxIn: 64, standAngleDeg: 8, yawSigmaDeg: 1, speedSigma: 0.015, fireIntervalS: 0.6, patienceS: 6, choiceNoiseS: 0, tipSense: true, parksEnd: true, parksAuto: true, defends: true },
};

export const TIER_LABELS: Record<AiTier, { title: string; blurb: string }> = {
  easy: { title: "Easy", blurb: "Slow and hesitant, shoots two at a time from wherever it stops, never parks." },
  medium: { title: "Medium", blurb: "Solid cycles of three, counts to the tip, parks at the end." },
  hard: { title: "Hard", blurb: "Fast full volleys from the sweet spot, parks in AUTO and at the end, defends when idle." },
};

export function coerceTier(v: unknown): AiTier { return v === "easy" || v === "hard" ? v : "medium"; }

/** Deterministic noise in [0, 1) for a candidate at (x, z) during a 3 s epoch: stable while the robot works, so it
 *  picks a worse target rather than flickering between targets. */
export function choiceNoise(x: number, z: number, timeS: number, seed: number): number {
  const epoch = Math.floor(timeS / 3);
  let h = (Math.round(x * 20) * 73856093) ^ (Math.round(z * 20) * 19349663) ^ (epoch * 83492791) ^ (seed * 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
