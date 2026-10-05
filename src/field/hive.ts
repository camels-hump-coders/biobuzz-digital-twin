/**
 * Pure geometry for the HIVE structure. No three.js dependency so it can be
 * unit tested. Vectors are plain {x,y,z} in metres in the scene frame.
 */
import { APRILTAG, HIVE, cellFloorOffsetIn, m } from "./fieldSpec";
import { deg } from "../util/units";

export type Vec3 = { x: number; y: number; z: number };
export type Alliance = "red" | "blue";
/** Which end of the hive arm a cell is on. +Z is the audience side. */
export type CellSide = "audience" | "scoring";

export interface HiveState {
  alliance: Alliance;
  /** Which cell is currently tilted up. */
  upCell: CellSide;
}

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a: Vec3): number => Math.sqrt(dot(a, a));
export const norm = (a: Vec3): Vec3 => scale(a, 1 / len(a));

export function hivePivot(alliance: Alliance): Vec3 {
  const x = (alliance === "red" ? -1 : 1) * (HIVE.hiveSpacingIn / 2);
  return { x: m(x), y: m(HIVE.pivotHeightIn), z: 0 };
}

/** Signed tilt angle about +X. Positive rotates the +Z (audience) end upward. */
export function hiveTiltAngle(state: HiveState): number {
  return (state.upCell === "audience" ? 1 : -1) * deg(HIVE.tiltDeg);
}

/** Local cell frame for one end of the arm. `along` points from the pivot out
 * through the cell toward its opening; `up` is the cell's floor normal. */
export interface CellFrame {
  side: CellSide;
  isUp: boolean;
  /** centre of the opening polygon (world, metres) */
  openingCenter: Vec3;
  /** outward normal of the opening plane (points away from the pivot) */
  normal: Vec3;
  /** unit vector across the opening (along the pivot axis) */
  right: Vec3;
  /** unit vector up the opening (perpendicular to right and normal) */
  up: Vec3;
  /** centre of the cell floor at the opening edge */
  floorCenterAtOpening: Vec3;
  /** the cell floor plane centre (mid depth) */
  floorCenter: Vec3;
  /** polygon of the opening (pentagon) in world coordinates, CCW seen from outside */
  openingPolygon: Vec3[];
  /** AprilTag centres on the underside of the floor, outward-facing normal = -up */
  tags: { id: number; center: Vec3; normal: Vec3; right: Vec3; up: Vec3 }[];
}

/** Pentagon profile in (right, up) local coordinates, metres, origin at floor centre. */
export function openingProfile(): { r: number; u: number }[] {
  const w = m(HIVE.openingWidthIn) / 2;
  const s = m(HIVE.openingShoulderIn);
  const h = m(HIVE.openingHeightIn);
  return [
    { r: -w, u: 0 },
    { r: w, u: 0 },
    { r: w, u: s },
    { r: 0, u: h },
    { r: -w, u: s },
  ];
}

export function cellFrames(state: HiveState): CellFrame[] {
  const pivot = hivePivot(state.alliance);
  const tilt = hiveTiltAngle(state);
  const frames: CellFrame[] = [];
  const halfArm = m(HIVE.armLengthIn / 2);
  const cellDepth = m(HIVE.cellDepthIn);
  const floorOff = m(cellFloorOffsetIn());
  for (const side of ["audience", "scoring"] as CellSide[]) {
    const sgn = side === "audience" ? 1 : -1; // +Z end or -Z end
    // arm direction toward this cell, rotated about +X by tilt
    // unrotated along = (0,0,sgn). Rotation about X by angle t: z' = z cos t, y' = -z sin t? Use:
    // rotateX(t): y' = y cos t - z sin t ; z' = y sin t + z cos t. For +Z end to go up with t>0 we need y'>0 => use -t.
    const t = -tilt;
    const along = { x: 0, y: -sgn * Math.sin(t), z: sgn * Math.cos(t) };
    const up = { x: 0, y: Math.cos(t), z: Math.sin(t) }; // rotated +Y
    const right = cross(up, along); // completes a right-handed (right, up, along) when viewed from outside
    const floorCenterAtOpening = add(pivot, add(scale(along, halfArm), scale(up, -floorOff)));
    const floorCenter = add(floorCenterAtOpening, scale(along, -cellDepth / 2));
    const h = m(HIVE.openingHeightIn);
    const openingCenter = add(floorCenterAtOpening, scale(up, h / 2));
    const poly = openingProfile().map((p) => add(floorCenterAtOpening, add(scale(right, p.r), scale(up, p.u))));
    // tags: 4 across the underside, bottom edge toward field centre (toward pivot), facing -up
    const ids = tagIdsFor(state.alliance, side);
    const pitch = m(HIVE.openingWidthIn) / 4;
    const tags = ids.map((id, i) => {
      const r = (i - 1.5) * pitch;
      const center = add(floorCenter, add(scale(right, r), scale(up, -0.004)));
      // viewed from below, the tag "up" direction points away from field centre (bottom edge toward centre)
      return { id, center, normal: scale(up, -1), right: scale(right, -1), up: along };
    });
    frames.push({
      side,
      isUp: side === state.upCell,
      openingCenter,
      normal: along,
      right,
      up,
      floorCenterAtOpening,
      floorCenter,
      openingPolygon: poly,
      tags,
    });
  }
  return frames;
}

export function tagIdsFor(alliance: Alliance, side: CellSide): readonly number[] {
  if (alliance === "red") return side === "audience" ? APRILTAG.clusters.redAudience : APRILTAG.clusters.redScoring;
  return side === "audience" ? APRILTAG.clusters.blueAudience : APRILTAG.clusters.blueScoring;
}

export function upCellFrame(state: HiveState): CellFrame {
  return cellFrames(state).find((f) => f.isUp)!;
}

/** Point-in-polygon test in the opening plane using (right, up) coordinates. */
export function pointInOpening(frame: CellFrame, p: Vec3, inset = 0): boolean {
  const d = sub(p, frame.floorCenterAtOpening);
  const r = dot(d, frame.right);
  const u = dot(d, frame.up);
  const poly = openingProfile();
  // shrink polygon toward its centroid by `inset` (approximation good for small insets)
  const cx = 0;
  const cy = poly.reduce((s, q) => s + q.u, 0) / poly.length;
  const shrunk = poly.map((q) => {
    const vx = q.r - cx;
    const vy = q.u - cy;
    const l = Math.hypot(vx, vy) || 1;
    return { r: q.r - (vx / l) * inset, u: q.u - (vy / l) * inset };
  });
  let inside = false;
  for (let i = 0, j = shrunk.length - 1; i < shrunk.length; j = i++) {
    const a = shrunk[i];
    const b = shrunk[j];
    if (a.u > u !== b.u > u && r < ((b.r - a.r) * (u - a.u)) / (b.u - a.u) + a.r) inside = !inside;
  }
  return inside;
}

/** Default aim point: centre of the up-cell opening, pushed `insideM` metres into the cell. */
export function aimPoint(frame: CellFrame, insideM = 0.05): Vec3 {
  return add(frame.openingCenter, scale(frame.normal, -insideM));
}
