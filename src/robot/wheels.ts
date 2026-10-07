/**
 * Spinning wheels for the CAD chassis. The committed GLBs are one welded mesh, so at load time the triangles that sit
 * inside each wheel's cylinder (outer band of the chassis, at wheel height) are carved out into their own meshes that
 * can rotate about the axle. Pure geometry + kinematics, no scene access, so it is unit-testable.
 */
import * as THREE from "three";

export interface WheelSplitParams {
  /** chassis width (wheel outer faces are near ±width/2) and wheel diameter, metres */
  widthM: number; wheelDiameterM: number;
  /** how far inboard from the outer face the wheel band reaches (wheel width plus hub), metres */
  bandM?: number;
  /** minimum gap along X between two wheel clusters, metres */
  gapM?: number;
}
export interface WheelPart { geometry: THREE.BufferGeometry; x: number; z: number; r: number; /** axle height */ y: number }
export interface WheelSplit { body: THREE.BufferGeometry; wheels: WheelPart[]; /** every crown cluster seen, accepted or not (diagnostics) */ clusters: { side: number; x: number; span: number; n: number; ok: boolean }[] }

/**
 * Split a robot-local geometry (+X forward, +Y up, +Z right, bottom at y=0) into body + wheels. Wheel centres are found
 * from the vertices that lie in the outer lateral band below wheel height, clustered along X.
 */
export function splitWheelGeometry(geo: THREE.BufferGeometry, p: WheelSplitParams): WheelSplit | undefined {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return undefined;
  const r = p.wheelDiameterM / 2, band = p.bandM ?? Math.max(0.05, p.wheelDiameterM * 0.5), gap = p.gapM ?? 0.04; // crown arcs are dense; strays are sparse
  const zOut = p.widthM / 2;
  const index = geo.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  // 1) wheel centres. Chassis rails run the whole length of the outer band at wheel height, so clustering every band
  //    vertex along X would merge the wheels; only a wheel reaches the crown height (above 1.8 r), so cluster those.
  const centres: { x: number; z: number; zMin: number; zMax: number; r: number; cy: number }[] = [];
  const clusters: WheelSplit["clusters"] = [];
  for (const side of [-1, 1]) {
    const crown: { x: number; z: number; y: number }[] = [];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), zs = pos.getZ(i) * side;
      if (y > r * 1.8 && y <= p.wheelDiameterM * 1.02 && zs >= zOut - band && zs <= zOut + 0.03) crown.push({ x: pos.getX(i), z: pos.getZ(i), y });
    }
    if (crown.length < 3) continue;
    crown.sort((a, b) => a.x - b.x);
    let start = 0;
    for (let i = 1; i <= crown.length; i++) {
      if (i === crown.length || crown[i].x - crown[i - 1].x > gap) {
        const cl = crown.slice(start, i);
        const span = cl[cl.length - 1].x - cl[0].x;
        // a wheel crown is a short dense arc (about 1.2 r wide for the top 10 % of the wheel). Stray bolt heads can chain
        // a sparse tail onto it, so judge the dense core around the median; a rail top is chassis-long and has no core.
        const median = cl[Math.floor(cl.length / 2)].x;
        const core = cl.filter((c) => Math.abs(c.x - median) <= r * 0.9);
        const ok = core.length >= 3 && core.length >= 0.8 * cl.length;
        clusters.push({ side, x: median, span, n: cl.length, ok });
        if (ok) {
          const cx0 = core.reduce((a, c) => a + c.x, 0) / core.length;
          const zMin = Math.min(...core.map((c) => c.z)), zMax = Math.max(...core.map((c) => c.z));
          // refine the circle inside this wheel's lateral slice: a narrow vertical column through the rough centre gives
          // top and bottom (radius and axle height), a narrow row at axle height gives the x extent (axle x). Narrow
          // strips are far less polluted by bumpers or intake rollers sharing the slice than the whole extent would be.
          let top = -Infinity, bottom = Infinity;
          for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            if (z < zMin - 0.004 || z > zMax + 0.004 || Math.abs(x - cx0) > r * 0.3 || y > p.wheelDiameterM * 1.1) continue;
            if (y > top) top = y; if (y < bottom) bottom = y;
          }
          const rr = (top - bottom) / 2, cy = (top + bottom) / 2;
          let xMin = Infinity, xMax = -Infinity;
          for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            if (z < zMin - 0.004 || z > zMax + 0.004 || Math.abs(y - cy) > rr * 0.3 || Math.abs(x - cx0) > rr * 1.3) continue;
            if (x < xMin) xMin = x; if (x > xMax) xMax = x;
          }
          // a drive wheel: about the configured size and standing on the floor (intake rollers sit higher, bumpers are flat)
          const plausible = Number.isFinite(rr) && Math.abs(rr - r) < r * 0.2 && bottom < 0.015 && Number.isFinite(xMin);
          clusters[clusters.length - 1].ok = plausible;
          if (plausible) centres.push({ x: (xMin + xMax) / 2, z: (zMin + zMax) / 2, zMin, zMax, r: rr, cy });
        }
        start = i;
      }
    }
  }
  if (!centres.length) return undefined;
  // 2) partition triangles: all three vertices inside a wheel cylinder -> that wheel
  const normal = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const buckets: number[][] = centres.map(() => []);
  const bodyTris: number[] = [];
  // membership: inside the wheel's cylinder, within the lateral extent its own crown showed (plus a little for the hub)
  const inWheel = (i: number, c: { x: number; z: number; zMin: number; zMax: number; r: number; cy: number }) => {
    const dx = pos.getX(i) - c.x, dy = pos.getY(i) - c.cy, z = pos.getZ(i);
    return Math.hypot(dx, dy) <= c.r * 1.08 && z >= c.zMin - 0.006 && z <= c.zMax + 0.006;
  };
  for (let t = 0; t < triCount; t++) {
    let hit = -1;
    for (let w = 0; w < centres.length && hit < 0; w++) if (inWheel(vi(t, 0), centres[w]) && inWheel(vi(t, 1), centres[w]) && inWheel(vi(t, 2), centres[w])) hit = w;
    (hit >= 0 ? buckets[hit] : bodyTris).push(t);
  }
  const build = (tris: number[], ox: number, oy: number, oz: number) => {
    const P = new Float32Array(tris.length * 9), N = normal ? new Float32Array(tris.length * 9) : undefined;
    let k = 0;
    for (const t of tris) for (let q = 0; q < 3; q++) {
      const i = vi(t, q);
      P[k] = pos.getX(i) - ox; P[k + 1] = pos.getY(i) - oy; P[k + 2] = pos.getZ(i) - oz;
      if (N && normal) { N[k] = normal.getX(i); N[k + 1] = normal.getY(i); N[k + 2] = normal.getZ(i); }
      k += 3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(P, 3));
    if (N) g.setAttribute("normal", new THREE.BufferAttribute(N, 3)); else g.computeVertexNormals();
    return g;
  };
  const wheels: WheelPart[] = centres.map((c, w) => ({ geometry: build(buckets[w], c.x, c.cy, c.z), x: c.x, z: c.z, r: c.r, y: c.cy })).filter((w) => w.geometry.getAttribute("position").count > 0);
  return { body: build(bodyTris, 0, 0, 0), wheels, clusters };
}

/**
 * Angular speed (rad/s, positive = rolling forward) of a wheel at robot-local (x, z) for a body moving with forward
 * speed, leftward speed and yaw rate (CCW positive). Mecanum rollers make strafing spin the wheels in an X pattern.
 */
export function wheelAngularSpeed(x: number, z: number, r: number, fwd: number, left: number, yaw: number, drivetrain: "mecanum" | "tank"): number {
  const v = fwd + yaw * z; // ω × (x, 0, z) along X = ω·z (left wheels, z<0, slow down in a left turn)
  const strafe = drivetrain === "mecanum" ? left * ((x >= 0) === (z < 0) ? -1 : 1) : 0;
  return (v + strafe) / r;
}
