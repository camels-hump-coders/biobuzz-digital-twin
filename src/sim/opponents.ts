/** Scripted alliance partner and opponent robots that patrol waypoint loops. */
import { type Pose, type Footprint, headingToward, stepPose, type Obstacle, fieldObstacles } from "./drive";
import { wrapAngle } from "../util/units";
import { m } from "../field/fieldSpec";

export interface ScriptedRobot {
  name: string;
  color: number;
  pose: Pose;
  waypoints: { x: number; z: number }[];
  index: number;
  speed: number; // m/s
  footprint: Footprint;
  /** time to wait at each waypoint (simulated launching / intaking) */
  dwell: number;
  dwellLeft: number;
  /** when set (by the match brain), drive here instead of the waypoint loop; undefined = hold position */
  target?: { x: number; z: number };
  /** true while the match brain controls this robot */
  brainDriven?: boolean;
}

const IN = 0.0254;

export function defaultScriptedRobots(): ScriptedRobot[] {
  const fp = { lengthM: 17 * IN, widthM: 17 * IN };
  const mk = (name: string, color: number, wps: [number, number][], start: Pose): ScriptedRobot => ({
    name, color, pose: start, waypoints: wps.map(([x, z]) => ({ x: m(x), z: m(z) })), index: 0, speed: 0.9, footprint: fp, dwell: 1.5, dwellLeft: 0,
  });
  return [
    // partner: starts by our loading zone (west wall, scoring side) and patrols our half
    mk("Partner", 0xd44a4a, [[-60, -36], [-40, 40], [-20, 55], [-62, 0]], { x: m(-60), z: m(-36), heading: 0 }),
    // opponent 1: patrols the east side
    mk("Opponent 1", 0x4a6ad4, [[60, 36], [40, -40], [20, -55], [62, 0]], { x: m(60), z: m(36), heading: Math.PI }),
    // opponent 2: wanders the scoring side and north flower
    mk("Opponent 2", 0x6a8ae8, [[-20, -58], [30, -30], [50, 10], [10, -40]], { x: m(-20), z: m(-58), heading: Math.PI }),
  ];
}

export function stepScripted(r: ScriptedRobot, dt: number, extra: Obstacle[] = []): void {
  if (r.brainDriven) {
    if (!r.target) return;
    const dx = r.target.x - r.pose.x, dz = r.target.z - r.pose.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.06) return;
    const want = headingToward(r.pose, r.target);
    const err = wrapAngle(want - r.pose.heading);
    const yawRate = Math.max(-2.5, Math.min(2.5, err * 4));
    const fwd = Math.abs(err) < 0.6 ? Math.min(r.speed, dist * 2) : 0.15;
    const vx = -Math.sin(r.pose.heading) * fwd, vz = -Math.cos(r.pose.heading) * fwd;
    r.pose = stepPose(r.pose, { vx, vz, yawRate }, dt, r.footprint, [...fieldObstacles(), ...extra]);
    return;
  }
  if (r.dwellLeft > 0) {
    r.dwellLeft -= dt;
    return;
  }
  const wp = r.waypoints[r.index];
  const dx = wp.x - r.pose.x, dz = wp.z - r.pose.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.08) {
    r.index = (r.index + 1) % r.waypoints.length;
    r.dwellLeft = r.dwell;
    return;
  }
  const want = headingToward(r.pose, wp);
  const err = wrapAngle(want - r.pose.heading);
  const yawRate = Math.max(-2.5, Math.min(2.5, err * 4));
  const fwd = Math.abs(err) < 0.6 ? Math.min(r.speed, dist * 2) : 0.2;
  const vx = -Math.sin(r.pose.heading) * fwd, vz = -Math.cos(r.pose.heading) * fwd;
  r.pose = stepPose(r.pose, { vx, vz, yawRate }, dt, r.footprint, [...fieldObstacles(), ...extra]);
}
