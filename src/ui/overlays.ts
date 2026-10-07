/** Visual overlays: trajectories, FOV footprints, frusta, target highlight. */
import * as THREE from "three";
import type { Vec3, CellFrame } from "../field/hive";
import type { ShotResult } from "../ballistics/solver";
import type { CameraPose, Intrinsics } from "../camera/cameraMath";
import { groundFootprint, cornerRays } from "../camera/cameraMath";
import type { ReachMap } from "../ballistics/reachability";
import type { HitMap } from "../ballistics/hitmap";

function lineFrom(points: Vec3[], color: number, opacity = 1, dashed = false): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.05, gapSize: 0.04, transparent: opacity < 1, opacity })
    : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const line = new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  return line;
}

export class Overlays {
  readonly group = new THREE.Group();
  private trajectory = new THREE.Group();
  private fan = new THREE.Group();
  private fov = new THREE.Group();
  private target = new THREE.Group();
  private aim = new THREE.Group();
  private reach = new THREE.Group();
  private actual = new THREE.Group();
  private cloud = new THREE.Group();
  private hit = new THREE.Group();
  show = { trajectory: true, actualArc: true, dispersion: true, fan: true, footprint: true, frustum: true, target: true, aim: true, reach: false, hitmap: false };

  constructor() {
    this.group.add(this.trajectory, this.fan, this.fov, this.target, this.aim, this.reach, this.actual, this.cloud, this.hit);
  }

  private hitMesh?: THREE.InstancedMesh;

  private hitCells?: HitMap["cells"];
  /** Hit-probability map: red (0) -> green (1) per square; squares the selected camera cannot aim from are dimmed; not yet computed = dark. */
  setHitMap(map?: HitMap) {
    this.hit.visible = this.show.hitmap;
    if (!map) { this.hit.clear(); this.hitMesh = undefined; return; }
    if (!this.hitMesh || this.hitMesh.count !== map.cells.length) {
      this.hit.clear();
      const geo = new THREE.PlaneGeometry(map.stepM * 0.96, map.stepM * 0.96);
      geo.rotateX(-Math.PI / 2);
      this.hitMesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }), map.cells.length);
      this.hit.add(this.hitMesh);
      this.hitCells = undefined;
    }
    // each map orders its squares by distance to its own target, so a different map (the other cell after a tip) needs
    // the instance positions rebuilt, not just the colours
    if (this.hitCells !== map.cells) {
      this.hitCells = map.cells;
      const mtx = new THREE.Matrix4();
      map.cells.forEach((c, i) => { mtx.makeTranslation(c.x, 0.004, c.z); this.hitMesh!.setMatrixAt(i, mtx); });
      this.hitMesh.instanceMatrix.needsUpdate = true;
    }
    const col = new THREE.Color();
    map.cells.forEach((c, i) => {
      if (c.pHit === undefined) col.setRGB(0.12, 0.13, 0.15);
      else {
        col.setHSL(c.pHit * 0.33, 0.9, 0.45);
        if (c.visible === false) col.multiplyScalar(0.3); // aim needs the camera to see the cell's tags
      }
      this.hitMesh!.setColorAt(i, col);
    });
    this.hitMesh.instanceColor!.needsUpdate = true;
  }

  /** Arc the launcher would produce right now, along the direction it actually points. Orange. */
  setActualTrajectory(shot?: ShotResult, ballRadius = 0.035) {
    this.actual.clear();
    this.actual.visible = this.show.actualArc;
    if (!shot) return;
    const pts = shot.samples.filter((_, i) => i % 5 === 0).map((s) => s.pos);
    if (pts.length < 2) return;
    const color = shot.hit ? 0xffcc33 : 0xff8800;
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(200, pts.length), ballRadius * 0.3, 6, false), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }));
    this.actual.add(tube);
    const end = pts[pts.length - 1];
    const marker = new THREE.Mesh(new THREE.SphereGeometry(ballRadius, 14, 10), new THREE.MeshBasicMaterial({ color, wireframe: true }));
    marker.position.set(shot.crossing?.x ?? end.x, shot.crossing?.y ?? end.y, shot.crossing?.z ?? end.z);
    this.actual.add(marker);
  }

  /** Monte Carlo crossing points: green hits, red misses. */
  setDispersion(points?: { p: Vec3; hit: boolean }[]) {
    this.cloud.clear();
    this.cloud.visible = this.show.dispersion;
    if (!points || !points.length) return;
    const geo = new THREE.SphereGeometry(0.012, 8, 6);
    const hitM = new THREE.MeshBasicMaterial({ color: 0x33ff88 });
    const missM = new THREE.MeshBasicMaterial({ color: 0xff5533 });
    const hits = new THREE.InstancedMesh(geo, hitM, points.length);
    const misses = new THREE.InstancedMesh(geo, missM, points.length);
    const mtx = new THREE.Matrix4();
    let hi = 0, mi = 0;
    for (const pt of points) {
      mtx.makeTranslation(pt.p.x, Math.max(0.012, pt.p.y), pt.p.z);
      if (pt.hit) hits.setMatrixAt(hi++, mtx); else misses.setMatrixAt(mi++, mtx);
    }
    hits.count = hi; misses.count = mi;
    hits.instanceMatrix.needsUpdate = true; misses.instanceMatrix.needsUpdate = true;
    this.cloud.add(hits, misses);
  }

  /** Colour tiles by required RPM: green (low) -> yellow -> red (near max); unreachable = dark red hatch. */
  setReachMap(map?: ReachMap) {
    this.reach.clear();
    this.reach.visible = this.show.reach;
    if (!map) return;
    const geo = new THREE.PlaneGeometry(map.stepM * 0.96, map.stepM * 0.96);
    const okMat = new Map<number, THREE.MeshBasicMaterial>();
    const badMat = new THREE.MeshBasicMaterial({ color: 0x5a1a1a, transparent: true, opacity: 0.35, depthWrite: false });
    for (const c of map.cells) {
      let mat: THREE.Material = badMat;
      if (c.rpm !== undefined) {
        const f = Math.min(1, c.rpm / map.maxRpm);
        const bucket = Math.round(f * 20);
        let mm = okMat.get(bucket);
        if (!mm) {
          const col = new THREE.Color().setHSL((1 - f) * 0.33, 0.9, 0.5);
          mm = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45, depthWrite: false });
          okMat.set(bucket, mm);
        }
        mat = mm;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(c.x, 0.003, c.z);
      this.reach.add(mesh);
    }
  }

  setTrajectory(shot?: ShotResult, ballRadius = 0.035, aimed = true) {
    this.trajectory.clear();
    this.trajectory.visible = this.show.trajectory;
    if (!shot) return;
    const alpha = aimed ? 1 : 0.35;
    const pts = shot.samples.filter((_, i) => i % 5 === 0).map((s) => s.pos);
    this.trajectory.add(lineFrom(pts, shot.hit ? 0x33ff88 : 0xff5533, alpha));
    // tube for visibility
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(200, pts.length), ballRadius * 0.35, 6, false), new THREE.MeshBasicMaterial({ color: shot.hit ? 0x33ff88 : 0xff5533, transparent: true, opacity: 0.55 * alpha }));
    this.trajectory.add(tube);
    if (shot.crossing) {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(ballRadius, 16, 12), new THREE.MeshBasicMaterial({ color: shot.hit ? 0x33ff88 : 0xff5533, wireframe: true }));
      marker.position.set(shot.crossing.x, shot.crossing.y, shot.crossing.z);
      this.trajectory.add(marker);
    }
  }

  setFan(solutions: ShotResult[]) {
    this.fan.clear();
    this.fan.visible = this.show.fan;
    for (const s of solutions) {
      const pts = s.samples.filter((_, i) => i % 8 === 0).map((p) => p.pos);
      this.fan.add(lineFrom(pts, s.hit ? 0x88ffcc : 0xff9977, s.hit ? 0.5 : 0.25));
    }
  }

  setCameras(cams: { pose: CameraPose; intr: Intrinsics; enabled: boolean; selected: boolean }[]) {
    this.fov.clear();
    for (const c of cams) {
      if (!c.enabled) continue;
      const color = c.selected ? 0x44ddff : 0x2288aa;
      if (this.show.footprint) {
        const fp = groundFootprint(c.pose, c.intr, 6);
        if (fp.length) {
          const shape = new THREE.Shape(fp.map((p) => new THREE.Vector2(p.x, -p.z)));
          const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: c.selected ? 0.22 : 0.12, side: THREE.DoubleSide, depthWrite: false }));
          mesh.rotation.x = -Math.PI / 2;
          mesh.position.y = 0.004;
          this.fov.add(mesh);
          this.fov.add(lineFrom([...fp, fp[0]].map((p) => ({ x: p.x, y: 0.006, z: p.z })), color, 0.9));
        }
      }
      if (this.show.frustum) {
        const rays = cornerRays(c.pose, c.intr);
        const far = 2.5;
        const o = c.pose.position;
        const corners = rays.map((r) => {
          const l = Math.hypot(r.x, r.y, r.z);
          return { x: o.x + (r.x / l) * far, y: o.y + (r.y / l) * far, z: o.z + (r.z / l) * far };
        });
        for (const k of corners) this.fov.add(lineFrom([o, k], color, 0.6));
        this.fov.add(lineFrom([...corners, corners[0]], color, 0.6));
      }
    }
  }

  setTarget(frame?: CellFrame, aimPoint?: Vec3) {
    this.target.clear();
    this.target.visible = this.show.target;
    if (!frame) return;
    const poly = [...frame.openingPolygon, frame.openingPolygon[0]];
    this.target.add(lineFrom(poly, 0xffee33));
    // translucent fill
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(frame.right.x, frame.right.y, frame.right.z),
      new THREE.Vector3(frame.up.x, frame.up.y, frame.up.z),
      new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z),
    );
    const o = frame.floorCenterAtOpening;
    const local = frame.openingPolygon.map((p) => {
      const d = new THREE.Vector3(p.x - o.x, p.y - o.y, p.z - o.z);
      return new THREE.Vector2(d.dot(new THREE.Vector3(frame.right.x, frame.right.y, frame.right.z)), d.dot(new THREE.Vector3(frame.up.x, frame.up.y, frame.up.z)));
    });
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(local)), new THREE.MeshBasicMaterial({ color: 0xffee33, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    mesh.quaternion.setFromRotationMatrix(basis);
    mesh.position.set(o.x, o.y, o.z);
    this.target.add(mesh);
    if (aimPoint) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffee33 }));
      s.position.set(aimPoint.x, aimPoint.y, aimPoint.z);
      this.target.add(s);
    }
  }

  setAim(from?: Vec3, to?: Vec3, ok = true) {
    this.aim.clear();
    this.aim.visible = this.show.aim;
    if (!from || !to) return;
    this.aim.add(lineFrom([{ x: from.x, y: 0.01, z: from.z }, { x: to.x, y: 0.01, z: to.z }], ok ? 0xffffff : 0xff8888, 0.5, true));
  }
}
