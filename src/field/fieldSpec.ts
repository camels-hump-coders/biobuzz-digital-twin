/**
 * BIOBUZZ field constants. Sources: Competition Manual TU02 Section 9 and
 * Event Field Setup Guide v1.0. All values in inches unless suffixed.
 * Scene frame: X toward blue alliance, Y up, +Z toward audience, origin at
 * field centre on the tile surface.
 */
import { inToM } from "../util/units";

export const FIELD = {
  sizeIn: 144,
  tileIn: 24,
  tileThicknessIn: 0.59,
  wallHeightIn: 12,
  wallThicknessIn: 1.0,
} as const;

export const HIVE = {
  frameWidthIn: 49.46, // along X
  frameDepthIn: 38.95, // along Z
  pivotHeightIn: 43.95,
  hiveSpacingIn: 25.5, // centre to centre along X
  armLengthIn: 42.91,
  cellDepthIn: 12.04,
  cellGapIn: 18.84,
  tiltDeg: 30,
  openingWidthIn: 20,
  openingHeightIn: 14,
  openingShoulderIn: 7.61,
  upOpeningBottomIn: 53.5,
  upOpeningTopIn: 65.6,
  lowestPointIn: 30.6,
} as const;

/** Perpendicular offset (in) of the cell floor plane below the pivot axis,
 * fitted so the up-cell opening bottom lands at 53.5 in. */
export function cellFloorOffsetIn(): number {
  const tilt = (HIVE.tiltDeg * Math.PI) / 180;
  const alongArm = HIVE.armLengthIn / 2; // opening is at the arm end
  const h = HIVE.pivotHeightIn + alongArm * Math.sin(tilt);
  return (h - HIVE.upOpeningBottomIn) / Math.cos(tilt);
}

export const FLOWER = {
  topOpeningDiaIn: 4.0,
  topHeightIn: 21.5,
  backstopHeightIn: 1.25,
  retrievalHeightIn: 3.55,
  retrievalDepthIn: 3.57,
  bottomRingIdIn: 2.79,
  bottomRingThickIn: 0.43,
  /** distance from wall inner face to flower axis (estimated from Fig 9-12). */
  axisFromWallIn: 3.6,
  /** [x, z] of the wall seam the flower sits on; walls are at +-72. */
  positions: [
    { wall: "N", x: -24, z: -72 },
    { wall: "E", x: 72, z: -24 },
    { wall: "S", x: 24, z: 72 },
    { wall: "W", x: -72, z: 24 },
  ],
} as const;

export const BALL = {
  pollen: { diaIn: 2.8, massKg: 0.0249, color: 0xf2c200, name: "POLLEN" },
  nectarRed: { diaIn: 3.6, massKg: 0.0413, color: 0xd42a2a, name: "NECTAR (red)" },
  nectarBlue: { diaIn: 3.6, massKg: 0.0413, color: 0x2a5bd4, name: "NECTAR (blue)" },
} as const;
export type BallKind = keyof typeof BALL;

export const ZONES = {
  /** Loading zone: 23 in along the wall by 11 in deep. Red on tile A5 (west wall, scoring side). */
  loadingRed: { xMin: -72, xMax: -61, zMin: -48, zMax: -25 },
  loadingBlue: { xMin: 61, xMax: 72, zMin: 25, zMax: 48 },
  /** Garden tape strip (approx 12 in x 2 in) next to the pollen line in the corner. */
  gardenRedTape: { xMin: -61, xMax: -49, zMin: 70, zMax: 72 },
  gardenBlueTape: { xMin: 49, xMax: 61, zMin: -72, zMax: -70 },
  allianceDepthIn: 54,
  allianceWidthIn: 96,
} as const;

export const APRILTAG = {
  sizeIn: 3.25,
  /** IDs left-to-right when viewed from above with the audience at the bottom. */
  clusters: {
    redScoring: [33, 32, 31, 30],
    redAudience: [34, 35, 36, 37],
    blueAudience: [38, 39, 40, 41],
    blueScoring: [45, 44, 43, 42],
  },
} as const;

export const ROBOT_RULES = {
  startCubeIn: 18,
  expandedIn: { w: 18, l: 24, h: 29 },
  maxHeightIn: 78,
} as const;

export const m = inToM;
