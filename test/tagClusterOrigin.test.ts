import { describe, expect, it } from "vitest";
import { cellFrames, add, cross, dot, scale, sub, len, type Vec3 } from "../src/field/hive";

/** SDK 12 BIOBUZZ library: each tag sits at (X[(id-30)%4], 7.1874, -5.622) in from the cluster origin, in the tag's own
 * axes (x right along the tag, y down the tag, z into the tag). A consumer recovers the origin as t - R·offset. */
const X = [-6.5, -2.75, 2.75, 6.5], Y = 7.1874, Z = -5.622, IN = 0.0254;
const sdkOffset = (id: number) => ({ x: X[(id - 30) % 4], y: Y, z: Z });

describe("the twin's tag strips agree with the SDK 12 cluster geometry", () => {
  for (const alliance of ["red", "blue"] as const) for (const upCell of ["audience", "scoring"] as const) {
    it(`${alliance} hive, ${upCell} cell up: every tag of a cell recovers the same cluster origin, in the opening plane`, () => {
      for (const f of cellFrames({ alliance, upCell })) {
        const origins: Vec3[] = f.tags.map((t) => {
          const o = sdkOffset(t.id);
          // the scene builds each sticker as a plane with +Z = t.normal and +Y = t.up, so its +X (the tag x axis) is up × normal
          const tagX = cross(t.up, t.normal), tagYdown = scale(t.up, -1), tagZinto = scale(t.normal, -1);
          return sub(t.center, add(add(scale(tagX, o.x * IN), scale(tagYdown, o.y * IN)), scale(tagZinto, o.z * IN)));
        });
        for (const o of origins) expect(len(sub(o, origins[0])) / IN, `${f.side} tags ${f.tags.map((t) => t.id)}`).toBeLessThan(0.05);
        // the origin lies in the opening plane (7.19 in in front of the strip), 5.6 in above the strip: 1.5 in below the opening centre
        const d = sub(origins[0], f.openingCenter);
        expect(Math.abs(dot(d, f.normal)) / IN, `${f.side} origin ahead of/behind the opening plane`).toBeLessThan(0.1);
        expect(Math.abs(dot(d, f.right)) / IN, `${f.side} origin off the cell centreline`).toBeLessThan(0.1);
        expect(dot(d, f.up) / IN, `${f.side} origin below the opening centre`).toBeGreaterThan(-2);
        expect(dot(d, f.up) / IN).toBeLessThan(0);
      }
    });
  }
});
