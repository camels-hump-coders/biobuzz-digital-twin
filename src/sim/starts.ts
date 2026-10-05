/** Match start positions. Stored in the red-alliance frame (inches); rotated 180° about the field centre when we play blue,
 * the same way the scripted robots' field is mirrored. */
import type { Pose } from "./drive";
import type { Alliance } from "../field/hive";
import { m } from "../field/fieldSpec";

export type StartKey = "you" | "partner" | "opp1" | "opp2";
export interface StartPose { xIn: number; zIn: number; headingDeg: number }
export type StartPositions = Record<StartKey, StartPose>;

/** Robots start touching their alliance wall (red = west), facing the field; opponents mirrored. */
export function defaultStarts(): StartPositions {
  return {
    you: { xIn: -63, zIn: 36, headingDeg: -90 },
    partner: { xIn: -63, zIn: -36, headingDeg: -90 },
    opp1: { xIn: 63, zIn: -36, headingDeg: 90 },
    opp2: { xIn: 63, zIn: 36, headingDeg: 90 },
  };
}

export const START_LABELS: Record<StartKey, string> = { you: "You", partner: "Partner", opp1: "Opponent 1", opp2: "Opponent 2" };

export function startPose(starts: StartPositions, key: StartKey, alliance: Alliance): Pose {
  const s = starts[key] ?? defaultStarts()[key];
  const p: Pose = { x: m(s.xIn), z: m(s.zIn), heading: (s.headingDeg * Math.PI) / 180 };
  return alliance === "red" ? p : { x: -p.x, z: -p.z, heading: p.heading + Math.PI };
}
