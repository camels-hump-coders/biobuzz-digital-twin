import { describe, expect, it } from "vitest";
import { AUTO_SECONDS, LOADING_ZONE, Scoreboard, ballInGarden, inZone, touchesWall, type RobotState } from "../src/sim/scoring";

const IN = 0.0254;
const fp = { lengthM: 18 * IN, widthM: 18 * IN };
const atWall: RobotState = { id: "you", alliance: "red", pose: { x: -72 * IN + fp.widthM / 2, z: 0, heading: 0 }, footprint: fp };
const mid: RobotState = { id: "you", alliance: "red", pose: { x: -30 * IN, z: 0, heading: 0.4 }, footprint: fp };
const redZone = LOADING_ZONE.red;
const parked: RobotState = { id: "you", alliance: "red", pose: { x: redZone.xMax + fp.widthM / 2 - 2 * IN, z: (redZone.zMin + redZone.zMax) / 2, heading: 1.2 }, footprint: fp };

describe("geometry", () => {
  it("knows when the chassis touches the perimeter wall", () => {
    expect(touchesWall(atWall.pose, fp)).toBe(true);
    expect(touchesWall({ ...atWall.pose, x: atWall.pose.x + 0.05 }, fp)).toBe(false);
    expect(touchesWall(mid.pose, fp)).toBe(false);
    // rotated robot in a corner touches with a corner
    expect(touchesWall({ x: -60 * IN, z: -60 * IN, heading: Math.PI / 4 }, fp)).toBe(true);
  });
  it("counts a robot partially over the LOADING ZONE tape as parked", () => {
    expect(inZone(parked.pose, fp, redZone)).toBe(true);
    expect(inZone(mid.pose, fp, redZone)).toBe(false);
    expect(inZone(parked.pose, fp, LOADING_ZONE.blue)).toBe(false);
  });
  it("garden balls count when partially in the zone", () => {
    expect(ballInGarden(-60 * IN, 71 * IN, 1.4 * IN, "red")).toBe(true);
    expect(ballInGarden(-60 * IN, 66 * IN, 1.4 * IN, "red")).toBe(false);
    expect(ballInGarden(60 * IN, -71 * IN, 1.4 * IN, "blue")).toBe(true);
  });
});

describe("scoreboard", () => {
  const M = 150;
  it("latches LEAVE and AUTO PARK at the end of AUTO, PARK at the end of the match", () => {
    const sb = new Scoreboard();
    sb.update("setup", M, M, [atWall], { red: 0, blue: 0 });
    sb.update("running", M - 5, M, [atWall], { red: 0, blue: 0 });
    expect(sb.score("red", [atWall], 0, 0, 0).leave).toBe(0);
    sb.update("running", M - 20, M, [mid], { red: 1, blue: 0 });           // left the wall during AUTO
    expect(sb.score("red", [mid], 1, 0, 0).auto).toBe(3 + 20);
    sb.update("running", M - AUTO_SECONDS - 1, M, [atWall], { red: 1, blue: 0 }); // back at the wall after AUTO ended: LEAVE stays
    const s = sb.score("red", [atWall], 2, 0, 0);
    expect(s.leave).toBe(1); expect(s.autoTips).toBe(1); expect(s.auto).toBe(23); expect(s.teleop).toBe(20); expect(s.total).toBe(43);
    sb.update("running", 5, M, [parked], { red: 2, blue: 0 });
    expect(sb.score("red", [parked], 2, 3, 4).teleopPark).toBe(1);
    expect(sb.score("red", [parked], 2, 3, 4).total).toBe(23 + 20 + 5 + 6 + 4);
    sb.update("stopped", 0, M, [parked], { red: 2, blue: 0 });
    sb.update("stopped", 0, M, [mid], { red: 2, blue: 0 });                 // moved after the end: PARK stays latched
    expect(sb.score("red", [mid], 2, 0, 0).teleopPark).toBe(1);
    sb.update("setup", M, M, [atWall], { red: 0, blue: 0 });
    expect(sb.score("red", [atWall], 0, 0, 0).total).toBe(0);
  });
  it("scores AUTO PARK and per-alliance robots separately", () => {
    const sb = new Scoreboard();
    const partner: RobotState = { ...parked, id: "Partner" };
    const foe: RobotState = { ...mid, id: "Foe", alliance: "blue" };
    sb.update("running", M - 10, M, [atWall, partner, foe], { red: 0, blue: 0 });
    sb.update("running", M - 31, M, [atWall, partner, foe], { red: 0, blue: 0 });
    expect(sb.score("red", [atWall, partner, foe], 0, 0, 0)).toMatchObject({ leave: 1, autoPark: 1, auto: 8 });
    expect(sb.score("blue", [atWall, partner, foe], 0, 0, 0)).toMatchObject({ leave: 1, autoPark: 0, auto: 3 });
  });
});
