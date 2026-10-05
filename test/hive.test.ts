import { describe, expect, it } from "vitest";
import { aimPoint, cellFrames, pointInOpening, upCellFrame } from "../src/field/hive";
import { HIVE, cellFloorOffsetIn } from "../src/field/fieldSpec";
import { mToIn } from "../src/util/units";

describe("hive geometry", () => {
  it("up cell opening spans 53.5 to 65.6 in above tiles (manual Fig 9-10)", () => {
    const f = upCellFrame({ alliance: "red", upCell: "audience" });
    const ys = f.openingPolygon.map((p) => mToIn(p.y));
    expect(Math.min(...ys)).toBeCloseTo(HIVE.upOpeningBottomIn, 1);
    expect(Math.max(...ys)).toBeCloseTo(HIVE.upOpeningTopIn, 0);
  });
  it("audience-up cell is on the +Z side and higher than the scoring cell", () => {
    const [aud, sco] = cellFrames({ alliance: "blue", upCell: "audience" });
    expect(aud.side).toBe("audience");
    expect(aud.openingCenter.z).toBeGreaterThan(0);
    expect(aud.openingCenter.y).toBeGreaterThan(sco.openingCenter.y);
    expect(aud.normal.y).toBeGreaterThan(0); // opening faces up and outward
    expect(aud.normal.z).toBeGreaterThan(0);
  });
  it("red hive is on -X, blue on +X, 25.5 in apart", () => {
    const r = upCellFrame({ alliance: "red", upCell: "scoring" });
    const b = upCellFrame({ alliance: "blue", upCell: "scoring" });
    expect(mToIn(b.openingCenter.x - r.openingCenter.x)).toBeCloseTo(HIVE.hiveSpacingIn, 3);
  });
  it("opening is 20 in wide", () => {
    const f = upCellFrame({ alliance: "red", upCell: "audience" });
    const xs = f.openingPolygon.map((p) => mToIn(p.x));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 3);
  });
  it("aim point is inside the opening and the lip is outside", () => {
    const f = upCellFrame({ alliance: "red", upCell: "audience" });
    expect(pointInOpening(f, aimPoint(f, 0))).toBe(true);
    const lip = f.openingPolygon[0];
    expect(pointInOpening(f, lip, 0.02)).toBe(false);
  });
  it("floor offset is small and positive", () => {
    const o = cellFloorOffsetIn();
    expect(o).toBeGreaterThan(0);
    expect(o).toBeLessThan(3);
  });
  it("tags sit under the floor and face downward with bottom edge toward the pivot", () => {
    const f = upCellFrame({ alliance: "blue", upCell: "scoring" });
    expect(f.tags.map((t) => t.id)).toEqual([45, 44, 43, 42]);
    for (const t of f.tags) {
      expect(t.normal.y).toBeLessThan(0);
    }
    // ids run -X to +X as in the manual's top view: 45 is leftmost (most negative x)
    const xs = f.tags.map((t) => mToIn(t.center.x));
    expect(xs[0]).toBeLessThan(xs[3]);
    expect(xs[3] - xs[0]).toBeCloseTo(13, 1);
    expect(xs[2] - xs[1]).toBeCloseTo(5.5, 1);
  });
});
