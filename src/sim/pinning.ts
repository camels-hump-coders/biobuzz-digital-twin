/**
 * G421: a 3-count on PINS. A robot may not prevent an opponent's movement by contact (direct or transitive, e.g.
 * against a field element) for more than 3 s. The count ends after the robots are 2 ft apart for 3 s, after either
 * has moved 2 ft from where the pin started for 3 s, or when the pinner is itself pinned. Violation: MAJOR FOUL, and
 * another for every further 3 s.
 */
import type { Pose } from "./drive";

export const PIN_LIMIT_S = 3;
const APART_M = 2 * 0.3048;

export interface PinState {
  pinner: string; pinned: string;
  count: number;
  startPinner: Pose; startPinned: Pose;
  /** time the end criteria (apart / moved away) have been continuously satisfied */
  release: number;
  fouls: number;
  /** last frame in which pushing contact was observed */
  lastContact: number;
}

export class PinTracker {
  pins = new Map<string, PinState>();
  /** fouls per robot name */
  fouls = new Map<string, number>();
  private time = 0;
  /** latest foul call for the HUD */
  lastCall?: { text: string; at: number };

  /**
   * Report one pair each frame. `pushing` is set when `pinner` is driving into `pinned` and `pinned` is held
   * (cannot move, by traction or the wall); undefined when there is no such contact.
   */
  update(dt: number, pair: { a: string; b: string; poseA: Pose; poseB: Pose; pushing?: { pinner: "a" | "b"; held: boolean } }) {
    this.time += dt;
    const key = `${pair.a}|${pair.b}`;
    let p = this.pins.get(key);
    const active = pair.pushing && pair.pushing.held;
    if (active) {
      const pinner = pair.pushing!.pinner === "a" ? pair.a : pair.b, pinned = pinner === pair.a ? pair.b : pair.a;
      const posePinner = pinner === pair.a ? pair.poseA : pair.poseB, posePinned = pinner === pair.a ? pair.poseB : pair.poseA;
      if (!p || p.pinner !== pinner) p = { pinner, pinned, count: 0, startPinner: posePinner, startPinned: posePinned, release: 0, fouls: 0, lastContact: this.time };
      p.count += dt; p.release = 0; p.lastContact = this.time;
      this.pins.set(key, p);
      const due = Math.floor(p.count / PIN_LIMIT_S);
      if (due > p.fouls) {
        p.fouls = due;
        this.fouls.set(pinner, (this.fouls.get(pinner) ?? 0) + 1);
        this.lastCall = { text: `MAJOR FOUL · ${pinner} pinned ${pinned} for ${Math.round(p.count)} s (G421)`, at: this.time };
      }
      return;
    }
    if (!p) return;
    // not pushing right now: the count holds until an end criterion has been met for 3 s
    const d = Math.hypot(pair.poseA.x - pair.poseB.x, pair.poseA.z - pair.poseB.z);
    const pinnerPose = p.pinner === pair.a ? pair.poseA : pair.poseB, pinnedPose = p.pinner === pair.a ? pair.poseB : pair.poseA;
    const movedAway = Math.hypot(pinnerPose.x - p.startPinner.x, pinnerPose.z - p.startPinner.z) > APART_M || Math.hypot(pinnedPose.x - p.startPinned.x, pinnedPose.z - p.startPinned.z) > APART_M;
    if (d > APART_M || movedAway) p.release += dt; else p.release = 0;
    if (p.release > 3 || this.time - p.lastContact > 6) this.pins.delete(key);
  }

  /** The pin involving `name` with the highest count, for the HUD. */
  current(name: string): PinState | undefined {
    let best: PinState | undefined;
    for (const p of this.pins.values()) if ((p.pinner === name || p.pinned === name) && (!best || p.count > best.count)) best = p;
    return best;
  }
}
