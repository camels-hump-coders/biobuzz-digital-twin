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

/** Parameter t in [0,1] where the segment a->b first enters the rectangle, or undefined (Liang-Barsky). */
function segmentHitsRect(a: { x: number; z: number }, b: { x: number; z: number }, o: Obstacle): number | undefined {
  const dx = b.x - a.x, dz = b.z - a.z;
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  if (!clip(-dx, a.x - o.xMin) || !clip(dx, o.xMax - a.x) || !clip(-dz, a.z - o.zMin) || !clip(dz, o.zMax - a.z)) return undefined;
  return t0;
}

/**
 * Next waypoint on the way to `target`: shortest path over the visibility graph of the obstacles' (grown) corners, so
 * robots slide around hive legs, flowers and the player's robot instead of pushing against them. Returns the target
 * itself when the straight line is clear or no route exists.
 */
export function nextWaypoint(pose: Pose, target: { x: number; z: number }, fp: Footprint, obstacles: Obstacle[]): { x: number; z: number } {
  const half = Math.hypot(fp.lengthM, fp.widthM) / 2 + 0.03; // conservative: the chassis may be at any heading
  const grown = obstacles.map((o) => ({ xMin: o.xMin - half, xMax: o.xMax + half, zMin: o.zMin - half, zMax: o.zMax + half }));
  // the chassis really collides (stepPose pushes out) at roughly the inscribed half width; a robot resting against a
  // leg sits inside the conservative rectangle but outside this core one
  const coreHalf = Math.min(fp.lengthM, fp.widthM) / 2 - 0.02;
  const core = obstacles.map((o) => ({ xMin: o.xMin - coreHalf, xMax: o.xMax + coreHalf, zMin: o.zMin - coreHalf, zMax: o.zMax + coreHalf }));
  const inside = (p: { x: number; z: number }, g: Obstacle) => p.x > g.xMin && p.x < g.xMax && p.z > g.zMin && p.z < g.zMax;
  // a segment is clear if it crosses no grown rectangle; when an endpoint is already inside one (pushed out against a
  // leg, or a ball lying close to it) that rectangle only counts if the segment cuts through its core
  const clear = (a: { x: number; z: number }, b: { x: number; z: number }) => grown.every((g, i) => (inside(a, g) || inside(b, g) ? segmentHitsRect(a, b, core[i]) === undefined : segmentHitsRect(a, b, g) === undefined));
  if (clear(pose, target)) return target;
  const pad = 0.06;
  const nodes: { x: number; z: number }[] = [pose, target];
  for (const g of grown) {
    for (const c of [{ x: g.xMin - pad, z: g.zMin - pad }, { x: g.xMax + pad, z: g.zMin - pad }, { x: g.xMin - pad, z: g.zMax + pad }, { x: g.xMax + pad, z: g.zMax + pad }]) {
      if (Math.abs(c.x) > 1.75 || Math.abs(c.z) > 1.75) continue; // off the field
      if (grown.some((o) => inside(c, o))) continue;
      nodes.push(c);
    }
  }
  // Dijkstra from pose (0) to target (1)
  const n = nodes.length;
  const dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity || u === 1) break;
    done[u] = true;
    for (let v = 0; v < n; v++) {
      if (done[v] || !clear(nodes[u], nodes[v])) continue;
      const d = dist[u] + Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z);
      if (d < dist[v]) { dist[v] = d; prev[v] = u; }
    }
  }
  if (dist[1] === Infinity) return target;
  let v = 1;
  while (prev[v] !== 0) v = prev[v];
  // if the first waypoint is already under the robot, aim for the one after it
  if (Math.hypot(nodes[v].x - pose.x, nodes[v].z - pose.z) < 0.08) {
    let w = 1; while (prev[w] !== v && prev[w] !== 0) w = prev[w];
    if (prev[w] === v) return nodes[w];
  }
  return nodes[v];
}

export function stepScripted(r: ScriptedRobot, dt: number, extra: Obstacle[] = []): void {
  if (r.brainDriven) {
    if (!r.target) return;
    const obstacles = [...fieldObstacles(), ...extra];
    const wp = nextWaypoint(r.pose, r.target, r.footprint, obstacles);
    const dx = wp.x - r.pose.x, dz = wp.z - r.pose.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.06) return;
    const want = headingToward(r.pose, wp);
    const err = wrapAngle(want - r.pose.heading);
    const yawRate = Math.max(-2.5, Math.min(2.5, err * 4));
    const fwd = Math.abs(err) < 0.6 ? Math.min(r.speed, Math.max(dist * 2, wp === r.target ? 0 : 0.4)) : 0.15;
    const vx = -Math.sin(r.pose.heading) * fwd, vz = -Math.cos(r.pose.heading) * fwd;
    (r as any).debug = { wp, err: +err.toFixed(2), fwd: +fwd.toFixed(2), dt: +dt.toFixed(3) };
    r.pose = stepPose(r.pose, { vx, vz, yawRate }, dt, r.footprint, obstacles);
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
