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
export interface WheelSplit { body: THREE.BufferGeometry; wheels: WheelPart[]; /** every crown cluster seen, accepted or not (diagnostics) */ clusters: { side: number; x: number; span: number; n: number; ok: boolean; fit?: { n: number; cx: number; cy: number; r: number } }[] }

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
          // refine the circle from the wheel's bottom arc: at floor level in this lateral slice nothing but the tyre
          // exists (brackets and motor mounts sit higher), so an algebraic circle fit through those points gives the
          // axle and radius without bias. The slice's own z extent at the bottom is the tyre width.
          let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0, n = 0, zLo = Infinity, zHi = -Infinity;
          for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            if (z < zMin - 0.006 || z > zMax + 0.006 || Math.abs(x - cx0) > r * 1.1 || y > r * 0.35) continue;
            const q = x * x + y * y;
            sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * q; syz += y * q; sz += q; n++;
            if (z < zLo) zLo = z; if (z > zHi) zHi = z;
          }
          // Kåsa fit for the axle x (robust: the arc is symmetric about it even on mecanum rollers)
          let plausible = n >= 12, cx = cx0, cy = r, rr = r, zLoW = zLo, zHiW = zHi;
          if (plausible) {
            const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], B = [-sxz, -syz, -sz];
            const sol = solve3(A, B);
            if (sol) cx = -sol[0] / 2; else plausible = false;
          }
          // radius and axle height from the tyre's own top and bottom: within the tyre's lateral extent (taken from
          // the bottom arc, so hubs and brackets inboard of the tyre are excluded) the highest point directly above the
          // axle is the tyre top. Chord fits on mecanum rollers overshoot by millimetres; this does not.
          if (plausible) {
            let bottom = Infinity, zLo = Infinity, zHi = -Infinity;
            for (let i = 0; i < pos.count; i++) {
              const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
              if (z < zMin - 0.006 || z > zMax + 0.006 || Math.abs(x - cx) > r * 0.6 || y > r * 0.35) continue;
              if (y < bottom) bottom = y; if (z < zLo) zLo = z; if (z > zHi) zHi = z;
            }
            let top = -Infinity;
            for (let i = 0; i < pos.count; i++) {
              const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
              if (z < zLo || z > zHi || Math.abs(x - cx) > r * 0.15 || y > p.wheelDiameterM * 1.15) continue;
              if (y > top) top = y;
            }
            if (Number.isFinite(bottom) && Number.isFinite(top)) { rr = (top - bottom) / 2; cy = (top + bottom) / 2; } else plausible = false;
            plausible = plausible && bottom < 0.015;
            if (plausible) { zLoW = zLo; zHiW = zHi; }
          }
          // a drive wheel: about the configured size, standing on the floor, axle where the crown said
          plausible = plausible && Math.abs(rr - r) < r * 0.2 && Math.abs(cx - cx0) < r * 0.5;
          clusters[clusters.length - 1].ok = plausible; clusters[clusters.length - 1].fit = { n, cx, cy, r: rr };
          const zMinW = Number.isFinite(zLoW) ? zLoW : zMin, zMaxW = Number.isFinite(zHiW) ? zHiW : zMax;
          if (plausible) centres.push({ x: cx, z: (zMinW + zMaxW) / 2, zMin: zMinW, zMax: zMaxW, r: rr, cy });
        }
        start = i;
      }
    }
  }
  if (!centres.length) return { body: geo, wheels: [], clusters };
  // 2) partition triangles: all three vertices inside a wheel cylinder -> that wheel
  const normal = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const buckets: number[][] = centres.map(() => []);
  const bodyTris: number[] = [];
  // membership: inside the wheel's cylinder, within the lateral extent its own crown showed (plus a little for the hub)
  const inWheel = (i: number, c: { x: number; z: number; zMin: number; zMax: number; r: number; cy: number }) => {
    const dx = pos.getX(i) - c.x, dy = pos.getY(i) - c.cy, z = pos.getZ(i);
    return Math.hypot(dx, dy) <= c.r * 1.06 && z >= c.zMin - 0.003 && z <= c.zMax + 0.003;
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

/** 3x3 linear solve by Cramer's rule; undefined when singular. */
function solve3(A: number[][], B: number[]): number[] | undefined {
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-18) return undefined;
  const col = (k: number) => A.map((row, i) => row.map((v, j) => (j === k ? B[i] : v)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
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

export interface IntakeSplitParams {
  /** robot footprint, metres */
  lengthM: number; widthM: number;
  /** which edge the intake is on and how wide the mouth is */
  side: "front" | "rear" | "left" | "right"; mouthWidthM: number;
}
export interface IntakePart {
  geometry: THREE.BufferGeometry;
  /** axle centre, robot-local metres; the axle runs along the intake edge (Z for front/rear, X for left/right) */
  x: number; y: number; z: number;
  /** sweep radius, metres */
  r: number;
  /** lateral extent along the edge, robot-local metres */
  vMin: number; vMax: number;
}
export interface IntakeSplit { body: THREE.BufferGeometry; roller?: IntakePart; diag: { candidates: number; vMin?: number; vMax?: number; box?: number[] } }

/**
 * Carve the intake roller out of a robot-local geometry (+X forward, +Y up, +Z right, bottom at y=0). The roller is the
 * cylinder just inside the intake edge whose cross-section is a circle (a Hough fit around the mouth centre gives the
 * axle and radius); its lateral extent is the run of 5 mm bins that still hold roller geometry and have nothing hanging
 * below them (the corner wheels and brackets do). Triangles entirely inside that cylinder become the roller mesh,
 * positioned on its axle so it can spin about the edge direction. Returns the geometry untouched when nothing
 * roller-like is there.
 */
export function splitIntakeRoller(geo: THREE.BufferGeometry, p: IntakeSplitParams): IntakeSplit {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return { body: geo, diag: { candidates: 0 } };
  // (u, v): u is the coordinate out through the intake edge, v along the edge
  const edge = p.side === "front" || p.side === "rear" ? p.lengthM / 2 : p.widthM / 2;
  const uv = (i: number): [number, number] => {
    const x = pos.getX(i), z = pos.getZ(i);
    switch (p.side) { case "front": return [x, z]; case "rear": return [-x, z]; case "right": return [z, x]; default: return [-z, x]; }
  };
  const depth = 0.12, yLo = 0.03, yHi = 0.22;
  const inSlab = (i: number) => { const [u] = uv(i); const y = pos.getY(i); return u > edge - depth && u <= edge + 0.02 && y > yLo && y < yHi; };
  // 1) the roller's circle in the (u, y) cross-section around the mouth centre (|v| <= 6 cm): a coarse Hough over
  //    axle positions on a 2 mm grid, scoring how many vertices sit on each radius; brackets and channels above the
  //    roller are flat and score nothing on a circle
  const slab: { u: number; v: number; y: number }[] = [];
  for (let i = 0; i < pos.count; i++) if (inSlab(i)) { const [u, v] = uv(i); if (Math.abs(v) <= p.mouthWidthM / 2 + 0.02) slab.push({ u, v, y: pos.getY(i) }); }
  const candidates = slab.length;
  if (candidates < 300) return { body: geo, diag: { candidates } };
  const central = slab.filter((q) => Math.abs(q.v) <= 0.06);
  if (central.length < 150) return { body: geo, diag: { candidates } };
  const sample = central.length > 2500 ? central.filter((_, i) => i % Math.ceil(central.length / 2500) === 0) : central;
  let best = { score: 0, uc: 0, yc: 0, r: 0 };
  const rBins = new Int32Array(40);
  for (let uc = edge - depth; uc <= edge; uc += 0.002) for (let yc = yLo; yc <= yHi; yc += 0.002) {
    rBins.fill(0);
    for (const q of sample) { const k = Math.round(Math.hypot(q.u - uc, q.y - yc) / 0.002); if (k >= 7 && k < 40) rBins[k]++; }
    for (let k = 7; k < 40; k++) if (rBins[k] > best.score) best = { score: rBins[k], uc, yc, r: k * 0.002 };
  }
  if (best.score < Math.max(40, sample.length * 0.04)) return { body: geo, diag: { candidates, box: [best.uc, best.yc, best.r, best.score] } };
  const uc = best.uc, yc = best.yc;
  // carve radius: the outermost of the ring's own vertices (98th percentile inside 1.3 r), plus a little
  const ring = central.map((q) => Math.hypot(q.u - uc, q.y - yc)).filter((d) => d <= best.r * 1.3).sort((a, b) => a - b);
  const r = ring[Math.min(ring.length - 1, Math.floor(0.98 * ring.length))] + 0.002;
  // 2) lateral extent: walk 5 mm bins outward while a bin still has roller geometry (>= 8 vertices inside the carve
  //    cylinder) and nothing hanging below it (the corner wheels and brackets reach the floor; the roller does not).
  //    Flaps on a shaft leave gaps of a centimetre or so between them: tolerate up to two empty bins in a row.
  const bins = new Map<number, { n: number; below: number }>();
  for (const q of slab) {
    const k = Math.floor(q.v / 0.005);
    const b = bins.get(k) ?? { n: 0, below: 0 };
    if (Math.hypot(q.u - uc, q.y - yc) <= r) b.n++;
    else if (Math.abs(q.u - uc) <= r && q.y < yc - r - 0.012) b.below++;
    bins.set(k, b);
  }
  const ok = (k: number) => { const b = bins.get(k); return !!b && b.n >= 8 && b.below < 5; };
  const blocked = (k: number) => { const b = bins.get(k); return !!b && b.below >= 5; };
  if (!ok(0) && !ok(-1)) return { body: geo, diag: { candidates, box: [uc, yc, r] } };
  const walk = (from: number, step: number) => { let k = from, last = from; for (let miss = 0; miss <= 2 && !blocked(k); k += step) { if (ok(k)) { last = k; miss = 0; } else miss++; } return last; };
  const kLo = walk(0, -1), kHi = walk(-1, 1);
  const vMin = kLo * 0.005, vMax = (kHi + 1) * 0.005;
  if (vMax - vMin < 0.08) return { body: geo, diag: { candidates, vMin, vMax, box: [uc, yc, r] } };
  // 3) partition triangles: all vertices inside the carve cylinder (and the lateral run) -> roller
  const index = geo.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const grow = 0.004;
  const inCyl = (i: number) => { const [u, v] = uv(i); return Math.hypot(u - uc, pos.getY(i) - yc) <= r && v >= vMin - grow && v <= vMax + grow; };
  const roll: number[] = [], bodyTris: number[] = [];
  for (let t = 0; t < triCount; t++) (inCyl(vi(t, 0)) && inCyl(vi(t, 1)) && inCyl(vi(t, 2)) ? roll : bodyTris).push(t);
  if (roll.length < 50) return { body: geo, diag: { candidates, vMin, vMax, box: [uc, yc, r] } };
  // axle in robot coordinates
  const toXZ = (u: number, v: number): [number, number] => { switch (p.side) { case "front": return [u, v]; case "rear": return [-u, v]; case "right": return [v, u]; default: return [v, -u]; } };
  const [ax, az] = toXZ(uc, 0);
  const normal = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
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
  // the axle runs along the edge: for front/rear the roller mesh is centred on (ax, yc) and keeps its z; for left/right
  // it is centred on (yc, az) and keeps its x
  const alongZ = p.side === "front" || p.side === "rear";
  const roller: IntakePart = { geometry: build(roll, alongZ ? ax : 0, yc, alongZ ? 0 : az), x: alongZ ? ax : 0, y: yc, z: alongZ ? 0 : az, r, vMin, vMax };
  return { body: build(bodyTris, 0, 0, 0), roller, diag: { candidates, vMin, vMax, box: [uc, yc, r] } };
}
