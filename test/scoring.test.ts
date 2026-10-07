import { describe, expect, it } from "vitest";
import { AUTO_SECONDS, ballsToTip, LOADING_ZONE, Scoreboard, ballInGarden, inZone, touchesWall, type RobotState } from "../src/sim/scoring";

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
    sb.update("running", M - AUTO_SECONDS, M, [mid], { red: 1, blue: 0 }); // exact AUTO assessment
    sb.update("running", M - AUTO_SECONDS - 1, M, [atWall], { red: 1, blue: 0 }); // later motion cannot change LEAVE
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


describe("scoring boundaries and bonus RP", () => {
  it("assesses the current pose at exactly 30 seconds, not the previous frame", () => {
    const sb = new Scoreboard();
    sb.update("running", 120.01, 150, [mid], { red: 0, blue: 0 });
    sb.update("running", 120, 150, [atWall], { red: 1, blue: 0 });
    expect(sb.score("red", [atWall], 1, 0, 0)).toMatchObject({ leave: 0, autoTips: 1, auto: 20 });
  });
  it("pause does not latch end park; expiry uses the final pose", () => {
    const sb = new Scoreboard();
    sb.update("running", 130, 150, [parked], { red: 0, blue: 0 });
    expect(sb.score("red", [parked], 0, 0, 0).teleopPark).toBe(0);
    sb.update("running", 120, 150, [parked], { red: 1, blue: 0 });
    sb.update("stopped", 50, 150, [parked], { red: 1, blue: 0 });
    expect(sb.endAssessed).toBe(false);
    sb.update("running", 1, 150, [mid], { red: 1, blue: 0 });
    sb.update("stopped", 0, 150, [parked], { red: 1, blue: 0 });
    expect(sb.score("red", [parked], 1, 0, 0).teleopPark).toBe(1);
    sb.update("stopped", 0, 150, [mid], { red: 1, blue: 0 });
    expect(sb.score("red", [mid], 1, 0, 0).teleopPark).toBe(1);
  });
  it("SWARM includes end park, and tip bonuses stack at 4 and 7", () => {
    const sb = new Scoreboard();
    const pair = [mid, { ...mid, id: 'partner' }];
    sb.update("running", 120, 150, pair, { red: 0, blue: 0 });
    expect(sb.score("red", pair, 3, 0, 0)).toMatchObject({ swarmPoints: 6, bonusRp: 0 });
    expect(sb.score("red", pair, 4, 0, 0).bonusRp).toBe(1);
    const parkedPair = [parked, { ...parked, id: 'partner' }];
    sb.update("stopped", 0, 150, parkedPair, { red: 7, blue: 0 });
    expect(sb.score("red", parkedPair, 7, 0, 0)).toMatchObject({ swarmPoints: 16, swarmRp: 1, pollinator1Rp: 1, pollinator2Rp: 1, bonusRp: 3 });
    sb.reset();
    expect(sb.score("red", pair, 0, 0, 0)).toMatchObject({ total: 0, bonusRp: 0 });
  });
});


it("calculates additional pollen or nectar from staged, mixed and threshold loads", () => {
  expect(ballsToTip(3 * .0413, .195)).toEqual({ pollen: 3, nectar: 2 });
  expect(ballsToTip(3 * .0413 + 2 * .0249, .195)).toEqual({ pollen: 1, nectar: 1 });
  expect(ballsToTip(0, .195)).toEqual({ pollen: 8, nectar: 5 });
  expect(ballsToTip(.195, .195)).toEqual({ pollen: 0, nectar: 0 });
  expect(ballsToTip(.25, .195)).toEqual({ pollen: 0, nectar: 0 });
  expect(ballsToTip(0, .249)).toEqual({ pollen: 10, nectar: 7 });
});
