/** Match scoreboard: Competition Manual §10.5 (TU03), Table 10-2.
 *  AUTO:   LEAVE 3 (robot no longer touching the perimeter wall at the end of AUTO), AUTO PARK 5 (at least partially in
 *          its alliance's LOADING ZONE at the end of AUTO), HIVE TIP 20 (tips completed before TELEOP).
 *  TELEOP: HIVE TIP 20, TELEOP PARK 5 (end of match), POLLEN/NECTAR left in an up CELL 2 each, GARDEN 1 each.
 *  FLOWER scoring is not modelled (robots in the twin do not place into FLOWERS). Pure, unit-tested. */
import type { Alliance } from "../field/hive";
import { FIELD, ZONES } from "../field/fieldSpec";
import type { Pose } from "./drive";

const IN = 0.0254;
export const AUTO_SECONDS = 30;
export const POINTS = { leave: 3, park: 5, tip: 20, cellBall: 2, garden: 1 } as const;

export interface Rect { xMin: number; xMax: number; zMin: number; zMax: number }
export interface Footprint { lengthM: number; widthM: number }

const rectM = (r: { xMin: number; xMax: number; zMin: number; zMax: number }): Rect => ({ xMin: r.xMin * IN, xMax: r.xMax * IN, zMin: r.zMin * IN, zMax: r.zMax * IN });
export const LOADING_ZONE: Record<Alliance, Rect> = { red: rectM(ZONES.loadingRed), blue: rectM(ZONES.loadingBlue) };
/** GARDEN volume: 23 in along the wall by 2 in, outside edge of the corner tape (arena §9, Figure 9-2). */
export const GARDEN_ZONE: Record<Alliance, Rect> = { red: rectM({ xMin: -72, xMax: -49, zMin: 70, zMax: 72 }), blue: rectM({ xMin: 49, xMax: 72, zMin: -72, zMax: -70 }) };
const HALF = (FIELD.sizeIn / 2) * IN;

/** Points on the chassis rectangle (corners, edge midpoints and a coarse interior grid), world frame. */
export function footprintPoints(pose: Pose, fp: Footprint, n = 4): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const f = (i / n - 0.5) * fp.lengthM, l = (j / n - 0.5) * fp.widthM; // forward, left in the robot frame
    // forward is -Z at heading 0 (heading 0 faces the scoring side); left is -X
    const fx = -s, fz = -c, lx = -c, lz = s;
    out.push({ x: pose.x + f * fx + l * lx, z: pose.z + f * fz + l * lz });
  }
  return out;
}

/** LEAVE requires no contact with the perimeter wall: true while any part of the chassis is within `tol` of it. */
export function touchesWall(pose: Pose, fp: Footprint, tol = 0.02): boolean {
  return footprintPoints(pose, fp).some((p) => Math.abs(p.x) >= HALF - tol || Math.abs(p.z) >= HALF - tol);
}

/** PARK requires the robot to be at least partially inside the (infinitely tall) zone, tape included. */
export function inZone(pose: Pose, fp: Footprint, zone: Rect): boolean {
  return footprintPoints(pose, fp, 6).some((p) => p.x >= zone.xMin && p.x <= zone.xMax && p.z >= zone.zMin && p.z <= zone.zMax);
}

export function ballInGarden(x: number, z: number, radius: number, alliance: Alliance): boolean {
  const g = GARDEN_ZONE[alliance];
  return x + radius >= g.xMin && x - radius <= g.xMax && z + radius >= g.zMin && z - radius <= g.zMax;
}

export interface RobotState { id: string; alliance: Alliance; pose: Pose; footprint: Footprint }
export interface RobotScore { leave: boolean; autoPark: boolean; teleopPark: boolean; /** live, not yet latched */ offWallNow: boolean; inZoneNow: boolean }

export interface AllianceScore {
  tips: number; autoTips: number;
  leave: number; autoPark: number; teleopPark: number; // robots
  cellBalls: number; garden: number;
  auto: number; teleop: number; total: number;
}

/** Latches AUTO achievements when the AUTO period ends and TELEOP PARK when the match ends; everything else is live. */
export class Scoreboard {
  robots = new Map<string, RobotScore>();
  autoAssessed = false;
  endAssessed = false;
  autoTips: Record<Alliance, number> = { red: 0, blue: 0 };
  reset() { this.robots.clear(); this.autoAssessed = false; this.endAssessed = false; this.autoTips = { red: 0, blue: 0 }; }

  /** @param clock seconds left on the match clock (counts down from `matchSeconds`); phase as in AppState */
  update(phase: "setup" | "running" | "stopped", clock: number, matchSeconds: number, robots: RobotState[], tips: Record<Alliance, number>) {
    const inAuto = phase === "running" && clock > matchSeconds - AUTO_SECONDS;
    for (const r of robots) {
      const rs = this.robots.get(r.id) ?? { leave: false, autoPark: false, teleopPark: false, offWallNow: false, inZoneNow: false };
      rs.offWallNow = !touchesWall(r.pose, r.footprint);
      rs.inZoneNow = inZone(r.pose, r.footprint, LOADING_ZONE[r.alliance]);
      if (inAuto) { rs.leave = rs.offWallNow; rs.autoPark = rs.inZoneNow; } // live preview; latched below
      if (!this.endAssessed && phase === "running") rs.teleopPark = rs.inZoneNow;
      this.robots.set(r.id, rs);
    }
    if (phase === "running" && !inAuto && !this.autoAssessed) { this.autoAssessed = true; this.autoTips = { ...tips }; }
    if (phase === "stopped" && !this.endAssessed) this.endAssessed = true;
    if (phase === "setup") this.reset();
  }

  score(alliance: Alliance, robots: RobotState[], tips: number, cellBalls: number, garden: number): AllianceScore {
    const mine = robots.filter((r) => r.alliance === alliance).map((r) => this.robots.get(r.id)).filter((x): x is RobotScore => !!x);
    const leave = mine.filter((r) => r.leave).length, autoPark = mine.filter((r) => r.autoPark).length, teleopPark = mine.filter((r) => r.teleopPark).length;
    const autoTips = this.autoAssessed ? this.autoTips[alliance] : tips;
    const auto = leave * POINTS.leave + autoPark * POINTS.park + autoTips * POINTS.tip;
    const teleop = (tips - autoTips) * POINTS.tip + teleopPark * POINTS.park + cellBalls * POINTS.cellBall + garden * POINTS.garden;
    return { tips, autoTips, leave, autoPark, teleopPark, cellBalls, garden, auto, teleop, total: auto + teleop };
  }
}

export function describeScore(s: AllianceScore, robots: number): string {
  const parts = [`${s.tips} tip${s.tips === 1 ? "" : "s"}`];
  parts.push(`LEAVE ${s.leave}/${robots}`, `AUTO PARK ${s.autoPark}/${robots}`, `PARK ${s.teleopPark}/${robots}`);
  if (s.cellBalls) parts.push(`${s.cellBalls} in cell`);
  if (s.garden) parts.push(`garden ${s.garden}`);
  return parts.join(" · ");
}
