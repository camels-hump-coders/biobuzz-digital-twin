/** Camera FOV conversions and frustum-ground geometry. Pure. */
import type { Vec3 } from "../field/hive";

export interface Intrinsics {
  width: number;
  height: number;
  /** horizontal and vertical FOV, radians */
  hfov: number;
  vfov: number;
}

/** Derive h/v FOV from a diagonal FOV and sensor aspect ratio (rectilinear lens). */
export function fromDiagonal(diagDeg: number, width: number, height: number): Intrinsics {
  const d = (diagDeg * Math.PI) / 180;
  const diag = Math.hypot(width, height);
  const f = diag / 2 / Math.tan(d / 2); // focal length in pixels
  return { width, height, hfov: 2 * Math.atan(width / 2 / f), vfov: 2 * Math.atan(height / 2 / f) };
}

export function fromHorizontal(hfovDeg: number, width: number, height: number): Intrinsics {
  const h = (hfovDeg * Math.PI) / 180;
  const f = width / 2 / Math.tan(h / 2);
  return { width, height, hfov: h, vfov: 2 * Math.atan(height / 2 / f) };
}

export function diagonalDeg(i: Intrinsics): number {
  const f = i.width / 2 / Math.tan(i.hfov / 2);
  return (2 * Math.atan(Math.hypot(i.width, i.height) / 2 / f) * 180) / Math.PI;
}

export interface CameraPose {
  position: Vec3;
  /** unit forward */
  forward: Vec3;
  /** unit up */
  up: Vec3;
  /** unit right */
  right: Vec3;
}

/** Corner rays of the frustum in world space: [top-left, top-right, bottom-right, bottom-left]. */
export function cornerRays(pose: CameraPose, intr: Intrinsics): Vec3[] {
  const tx = Math.tan(intr.hfov / 2), ty = Math.tan(intr.vfov / 2);
  const mk = (sx: number, sy: number): Vec3 => ({
    x: pose.forward.x + pose.right.x * sx * tx + pose.up.x * sy * ty,
    y: pose.forward.y + pose.right.y * sx * tx + pose.up.y * sy * ty,
    z: pose.forward.z + pose.right.z * sx * tx + pose.up.z * sy * ty,
  });
  return [mk(-1, 1), mk(1, 1), mk(1, -1), mk(-1, -1)];
}

/** Intersect the frustum's view with the ground plane y=0 (clipped to a max range).
 * Returns a polygon on the ground (may have 4..6 points) or an empty array if the camera cannot see the ground. */
export function groundFootprint(pose: CameraPose, intr: Intrinsics, maxRange = 8, clipHalf = 1.8288 + 0.6): Vec3[] {
  // Sample the frustum boundary in image space, project each ray to the ground or to the range cap.
  const pts: Vec3[] = [];
  const tx = Math.tan(intr.hfov / 2), ty = Math.tan(intr.vfov / 2);
  const edge: [number, number][] = [];
  const n = 8;
  for (let i = 0; i < n; i++) edge.push([-1 + (2 * i) / n, 1]);
  for (let i = 0; i < n; i++) edge.push([1, 1 - (2 * i) / n]);
  for (let i = 0; i < n; i++) edge.push([1 - (2 * i) / n, -1]);
  for (let i = 0; i < n; i++) edge.push([-1, -1 + (2 * i) / n]);
  let anyGround = false;
  for (const [sx, sy] of edge) {
    const d = {
      x: pose.forward.x + pose.right.x * sx * tx + pose.up.x * sy * ty,
      y: pose.forward.y + pose.right.y * sx * tx + pose.up.y * sy * ty,
      z: pose.forward.z + pose.right.z * sx * tx + pose.up.z * sy * ty,
    };
    const l = Math.hypot(d.x, d.y, d.z);
    d.x /= l; d.y /= l; d.z /= l;
    let t: number;
    if (d.y < -1e-6) {
      t = -pose.position.y / d.y;
      if (t > maxRange) t = maxRange; else anyGround = true;
    } else {
      t = maxRange;
    }
    const p = { x: pose.position.x + d.x * t, y: Math.max(0, pose.position.y + d.y * t), z: pose.position.z + d.z * t };
    // project to the ground for drawing
    pts.push({ x: p.x, y: 0, z: p.z });
  }
  return anyGround ? clipToSquare(pts, clipHalf) : [];
}

/** Sutherland-Hodgman clip of a ground polygon to |x|,|z| <= half. */
export function clipToSquare(poly: Vec3[], half: number): Vec3[] {
  const planes: ((p: Vec3) => number)[] = [(p) => half - p.x, (p) => p.x + half, (p) => half - p.z, (p) => p.z + half];
  let out = poly;
  for (const d of planes) {
    const inp = out;
    out = [];
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length];
      const da = d(a), db = d(b);
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, y: 0, z: a.z + (b.z - a.z) * t });
      }
    }
    if (!out.length) break;
  }
  return out;
}

/** Is a world point inside the frustum (ignoring near/far)? */
export function inFrustum(pose: CameraPose, intr: Intrinsics, p: Vec3): { inside: boolean; depth: number; u: number; v: number } {
  const dx = p.x - pose.position.x, dy = p.y - pose.position.y, dz = p.z - pose.position.z;
  const depth = dx * pose.forward.x + dy * pose.forward.y + dz * pose.forward.z;
  if (depth <= 1e-6) return { inside: false, depth, u: 0, v: 0 };
  const rx = dx * pose.right.x + dy * pose.right.y + dz * pose.right.z;
  const uy = dx * pose.up.x + dy * pose.up.y + dz * pose.up.z;
  const u = rx / depth / Math.tan(intr.hfov / 2);
  const v = uy / depth / Math.tan(intr.vfov / 2);
  return { inside: Math.abs(u) <= 1 && Math.abs(v) <= 1, depth, u, v };
}

/** Apparent size of a tag in pixels, approximate (frontal, at given depth). */
export function tagPixels(intr: Intrinsics, tagSizeM: number, depth: number): number {
  const f = intr.width / 2 / Math.tan(intr.hfov / 2);
  return (tagSizeM * f) / Math.max(1e-6, depth);
}
