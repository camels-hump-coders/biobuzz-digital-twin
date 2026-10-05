/** Match start positions. Stored in the red-alliance frame (inches); rotated 180° about the field centre when we play blue,
 * the same way the scripted robots' field is mirrored. */
import type { Pose } from "./drive";
import type { Alliance, CellSide } from "../field/hive";
import { m } from "../field/fieldSpec";

export type StartKey = "you" | "partner" | "opp1" | "opp2";
export interface StartPose { xIn: number; zIn: number; headingDeg: number }
export type StartPositions = Record<StartKey, StartPose> & {
  /** our robot starts on the half of the field where our hive's raised cell faces (default); partner takes the other half */
  followUpCell?: boolean;
};

/** Robots start touching their alliance wall (red = west), facing the field; opponents mirrored. */
export function defaultStarts(): StartPositions {
  return {
    you: { xIn: -63, zIn: 36, headingDeg: -90 },
    partner: { xIn: -63, zIn: -36, headingDeg: -90 },
    opp1: { xIn: 63, zIn: -36, headingDeg: 90 },
    opp2: { xIn: 63, zIn: 36, headingDeg: 90 },
    followUpCell: true,
  };
}

export const START_LABELS: Record<StartKey, string> = { you: "You", partner: "Partner", opp1: "Opponent 1", opp2: "Opponent 2" };

export function startPose(starts: StartPositions, key: StartKey, alliance: Alliance, hive?: Record<Alliance, CellSide>): Pose {
  const s = starts[key] ?? defaultStarts()[key];
  let zIn = s.zIn;
  if ((starts.followUpCell ?? true) && hive) {
    // world half each alliance's raised cell faces: audience = +z. Starts are kept in the red frame and rotated 180° for
    // blue, so convert world signs into that frame (flip when we are blue).
    const frame = alliance === "red" ? 1 : -1;
    const worldSide = (a: Alliance) => (hive[a] === "audience" ? 1 : -1);
    const ours = worldSide(alliance) * frame, theirs = worldSide(alliance === "red" ? "blue" : "red") * frame;
    if (key === "you") zIn = ours * Math.abs(s.zIn);
    else if (key === "partner") zIn = -ours * Math.abs(s.zIn);
    else if (key === "opp1") zIn = theirs * Math.abs(s.zIn);
    else if (key === "opp2") zIn = -theirs * Math.abs(s.zIn);
  }
  const p: Pose = { x: m(s.xIn), z: m(zIn), heading: (s.headingDeg * Math.PI) / 180 };
  return alliance === "red" ? p : { x: -p.x, z: -p.z, heading: p.heading + Math.PI };
}
