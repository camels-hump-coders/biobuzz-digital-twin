import { describe, expect, it } from "vitest";
import { nextWaypoint } from "../src/sim/opponents";
import { hiveFrameObstacles } from "../src/sim/drive";

const fp = { lengthM: 0.43, widthM: 0.43 };

describe("scripted robot detours", () => {
  it("drives straight when nothing is in the way", () => {
    const wp = nextWaypoint({ x: -1.5, z: 1.5, heading: 0 }, { x: -1.5, z: -1.5 }, fp, hiveFrameObstacles());
    expect(wp).toEqual({ x: -1.5, z: -1.5 });
  });
  it("routes around a hive leg instead of pushing against it", () => {
    // Opponent 2's stall: sitting at the south end of the east leg, target due north along the leg line
    const pose = { x: 0.68, z: -0.71, heading: 0 };
    const target = { x: 0.68, z: 1.52 };
    const wp = nextWaypoint(pose, target, fp, hiveFrameObstacles());
    expect(wp).not.toEqual(target);
    // waypoint is outside the leg's x band on the robot's side (east of the leg)
    expect(wp.x).toBeGreaterThan(0.628 + 0.03);
  });
  it("passes between the legs when the target is under the hive", () => {
    const wp = nextWaypoint({ x: 0, z: 1.5, heading: 0 }, { x: 0, z: 0 }, fp, hiveFrameObstacles());
    expect(wp).toEqual({ x: 0, z: 0 });
  });
});
