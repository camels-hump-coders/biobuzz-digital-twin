/** three.js meshes for the BIOBUZZ field. */
import * as THREE from "three";
import { APRILTAG, BALL, FIELD, FLOWER, HIVE, ZONES, m } from "./fieldSpec";
import { type Alliance, type CellSide, type HiveState, cellFrames, hivePivot, hiveTiltAngle, openingProfile } from "./hive";
import { tag36h11Cells } from "./tag36h11";

const RED = 0xd42a2a, BLUE = 0x2a5bd4;

export interface FieldObjects {
  group: THREE.Group;
  hives: Record<Alliance, HiveObject>;
  /** meshes that occlude camera views (hive, flowers, walls) */
  occluders: THREE.Object3D[];
  tagMeshes: THREE.Mesh[];
  setHiveState(state: HiveState): void;
  /** world positions of the staged nectar in an alliance's up cell (empty if released) */
  stagedNectar(alliance: Alliance): THREE.Vector3[];
  /** hide/show the staged nectar (hidden once the hive has tipped and they fell out) */
  setStagedNectar(alliance: Alliance, visible: boolean): void;
  /** animate the pivot to an arbitrary tilt angle (radians, +audience up) without changing state */
  setHiveTilt(alliance: Alliance, tiltRad: number): void;
  /** POLLEN meshes stacked in each FLOWER (index matches FLOWER.positions), bottom first */
  flowerPollen: THREE.Mesh[][];
  /** POLLEN meshes staged in the two GARDENS; the match converts them to live balls */
  gardenPollen: THREE.Mesh[];
  /** world position of a FLOWER's axis on the floor */
  flowerAxis(i: number): THREE.Vector3;
  /** restore the 4 POLLEN in every FLOWER */
  restockFlowers(): void;
}

export interface HiveObject {
  pivotGroup: THREE.Group; // rotates about X
  state: HiveState;
}

function tileTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#5b5f66";
  g.fillRect(0, 0, 512, 512);
  // subtle foam speckle
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = `rgba(${200 + Math.random() * 40},${200 + Math.random() * 40},${210 + Math.random() * 40},${0.04 + Math.random() * 0.06})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  // seam
  g.strokeStyle = "#2e3034";
  g.lineWidth = 6;
  g.strokeRect(0, 0, 512, 512);
  // interlocking tabs hint
  g.fillStyle = "#44474c";
  for (let i = 0; i < 6; i++) {
    const p = 40 + i * 80;
    g.fillRect(p, 0, 24, 10); g.fillRect(p + 40, 502, 24, 10);
    g.fillRect(0, p, 10, 24); g.fillRect(502, p + 40, 10, 24);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Real tag36h11 image: 8x8 cells (black border + 6x6 data) inside a 1-cell white quiet zone = 10x10 cells. */
export const TAG_CELLS_TOTAL = 10;
function tagTexture(id: number): THREE.CanvasTexture {
  const px = 40; // pixels per cell
  const c = document.createElement("canvas");
  c.width = c.height = px * TAG_CELLS_TOTAL;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  const cells = tag36h11Cells(id);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    g.fillStyle = cells[y][x] ? "#fff" : "#000";
    g.fillRect((x + 1) * px, (y + 1) * px, px, px);
  }
  // tiny id label in the quiet zone below, like the sticker
  g.fillStyle = "#000";
  g.font = `${px * 0.6}px sans-serif`;
  g.textAlign = "center";
  g.fillText(`ID:${id}`, c.width / 2, c.height - px * 0.25);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 8;
  return t;
}

function cellMesh(alliance: Alliance): THREE.Group {
  const grp = new THREE.Group();
  const color = alliance === "red" ? RED : BLUE;
  const prof = openingProfile();
  const depth = m(HIVE.cellDepthIn);
  // translucent panels: floor, two side walls, two roof panels, back skin. Opening faces +Z in local frame.
  const skin = new THREE.MeshPhysicalMaterial({ color: 0xdddddd, transparent: true, opacity: 0.28, side: THREE.DoubleSide, roughness: 0.6, depthWrite: false });
  const frameMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
  const shape = new THREE.Shape(prof.map((p) => new THREE.Vector2(p.r, p.u)));
  // back skin: filled pentagon at z = -depth
  const back = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: 0xeeeeee, side: THREE.DoubleSide, roughness: 0.8 }));
  back.name = "cellBack";
  back.position.z = -depth;
  grp.add(back);
  // side panels: extrude the pentagon outline as thin strips
  for (let i = 0; i < prof.length; i++) {
    const a = prof[i], b = prof[(i + 1) % prof.length];
    const w = Math.hypot(b.r - a.r, b.u - a.u);
    const geo = new THREE.PlaneGeometry(w, depth);
    const mesh = new THREE.Mesh(geo, i === 0 ? new THREE.MeshStandardMaterial({ color: 0xcfd3d8, side: THREE.DoubleSide, roughness: 0.7 }) : skin);
    mesh.name = i === 0 ? "cellFloor" : `cellPanel${i}`;
    const mid = new THREE.Vector3((a.r + b.r) / 2, (a.u + b.u) / 2, -depth / 2);
    mesh.position.copy(mid);
    const ang = Math.atan2(b.u - a.u, b.r - a.r);
    mesh.rotation.set(Math.PI / 2, 0, ang, "ZXY");
    grp.add(mesh);
    // coloured frame tube along the opening edge and the back edge
    for (const z of [0, -depth]) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, w, 10), frameMat);
      tube.name = `cellTube${i}${z === 0 ? "Front" : "Back"}`;
      tube.position.set(mid.x, mid.y, z);
      tube.rotation.z = ang + Math.PI / 2;
      grp.add(tube);
    }
    // depth tubes at corners
    const t2 = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, depth, 8), frameMat);
    t2.position.set(a.r, a.u, -depth / 2);
    t2.rotation.x = Math.PI / 2;
    grp.add(t2);
  }
  return grp;
}

function buildHive(state: HiveState): { pivotGroup: THREE.Group; tags: THREE.Mesh[] } {
  const pivotGroup = new THREE.Group();
  const p = hivePivot(state.alliance);
  pivotGroup.position.set(p.x, p.y, p.z);
  const color = state.alliance === "red" ? RED : BLUE;
  const armMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 });
  // arm along local Z
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, m(HIVE.armLengthIn)), armMat);
  pivotGroup.add(arm);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 16), new THREE.MeshStandardMaterial({ color }));
  hub.rotation.z = Math.PI / 2;
  pivotGroup.add(hub);
  const tags: THREE.Mesh[] = [];
  const frames = cellFrames({ alliance: state.alliance, upCell: "audience" }); // compute in a reference tilt
  const refTilt = hiveTiltAngle({ alliance: state.alliance, upCell: "audience" });
  for (const f of frames) {
    const cell = cellMesh(state.alliance);
    // Place cell in the pivot-local (untilted) frame: undo the reference tilt.
    const local = new THREE.Vector3(f.floorCenterAtOpening.x - p.x, f.floorCenterAtOpening.y - p.y, f.floorCenterAtOpening.z - p.z);
    const unrot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), refTilt); // undo rotation of -refTilt
    local.applyQuaternion(unrot);
    cell.position.copy(local);
    // opening faces along +Z for audience cell, -Z for scoring cell
    if (f.side === "scoring") cell.rotation.y = Math.PI;
    pivotGroup.add(cell);
    // tags on underside of the floor
    for (const t of f.tags) {
      const tex = tagTexture(t.id);
      // the 3.25 in tag size is the black square; the plane includes the white quiet zone (10/8 of that)
      const planeSize = m(APRILTAG.sizeIn) * (TAG_CELLS_TOTAL / 8);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(planeSize, planeSize), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      const lp = new THREE.Vector3(t.center.x - p.x, t.center.y - p.y, t.center.z - p.z).applyQuaternion(unrot);
      mesh.position.copy(lp);
      // orient: plane normal (+Z of PlaneGeometry) -> t.normal, plane +Y -> t.up, all in untilted frame
      const n = new THREE.Vector3(t.normal.x, t.normal.y, t.normal.z).applyQuaternion(unrot);
      const u = new THREE.Vector3(t.up.x, t.up.y, t.up.z).applyQuaternion(unrot);
      const r = new THREE.Vector3().crossVectors(u, n);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, u, n));
      mesh.userData.tagId = t.id;
      mesh.userData.alliance = state.alliance;
      mesh.userData.side = f.side;
      pivotGroup.add(mesh);
      tags.push(mesh);
    }
  }
  return { pivotGroup, tags };
}

function buildFrame(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.7, roughness: 0.35 });
  const w = m(HIVE.frameWidthIn), d = m(HIVE.frameDepthIn), h = m(HIVE.pivotHeightIn);
  const bar = (a: THREE.Vector3, b: THREE.Vector3, r = 0.016) => {
    const l = a.distanceTo(b);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, l, 10), mat);
    mesh.position.copy(a).lerp(b, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    return mesh;
  };
  for (const sx of [-1, 1]) {
    const x = (sx * w) / 2;
    const apex = new THREE.Vector3(x, h, 0);
    const f1 = new THREE.Vector3(x, 0.02, d / 2), f2 = new THREE.Vector3(x, 0.02, -d / 2);
    g.add(bar(apex, f1), bar(apex, f2), bar(f1, f2, 0.012));
    // foot bar across the base to the other side
  }
  g.add(bar(new THREE.Vector3(-w / 2, h, 0), new THREE.Vector3(w / 2, h, 0), 0.02)); // crossbar
  // logo panels
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.5, 0.18), new THREE.MeshStandardMaterial({ color: 0xf2c200, side: THREE.DoubleSide }));
  panel.position.set(0, h - 0.2, 0.06);
  g.add(panel);
  const panel2 = panel.clone();
  panel2.position.z = -0.06;
  g.add(panel2);
  return g;
}

function buildFlower(): THREE.Group {
  const g = new THREE.Group();
  const green = new THREE.MeshStandardMaterial({ color: 0x3e8e2f, roughness: 0.6 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xe0a51a, roughness: 0.5, metalness: 0.2 });
  const black = new THREE.MeshStandardMaterial({ color: 0x222222 });
  const top = m(FLOWER.topHeightIn);
  const rOut = m(FLOWER.topOpeningDiaIn) / 2 + 0.02;
  // top ring (torus-ish) with 4in opening
  const ring = new THREE.Mesh(new THREE.TorusGeometry(m(FLOWER.topOpeningDiaIn) / 2 + 0.01, 0.012, 8, 32), gold);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = top;
  g.add(ring);
  // backstop (wall side = -Z local)
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.11, m(FLOWER.backstopHeightIn), 0.008), gold);
  back.position.set(0, top + m(FLOWER.backstopHeightIn) / 2, -rOut);
  g.add(back);
  // four pipes from mid ring (at retrieval height) to top
  const midY = m(FLOWER.retrievalHeightIn) + m(FLOWER.bottomRingThickIn);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, top - midY, 10), green);
    pipe.position.set(sx * 0.045, (top + midY) / 2, sz * 0.045);
    g.add(pipe);
  }
  const mid = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.01, 8, 24), black);
  mid.rotation.x = Math.PI / 2;
  mid.position.y = midY;
  g.add(mid);
  // bottom ring on the floor
  const bottom = new THREE.Mesh(new THREE.RingGeometry(m(FLOWER.bottomRingIdIn) / 2, 0.065, 24), black);
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.y = m(FLOWER.bottomRingThickIn) / 2 + 0.001;
  g.add(bottom);
  // square extrusion on the wall side connecting mid and bottom
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.025, midY, 0.025), new THREE.MeshStandardMaterial({ color: 0x8a8f96 }));
  post.position.set(0, midY / 2, -0.06);
  g.add(post);
  return g;
}

function ball(kind: keyof typeof BALL): THREE.Mesh {
  const b = BALL[kind];
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(m(b.diaIn) / 2, 20, 14), new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.45 }));
  mesh.castShadow = true;
  return mesh;
}

function tapeRect(z: { xMin: number; xMax: number; zMin: number; zMax: number }, color: number, y = 0.0015): THREE.Mesh {
  const w = m(z.xMax - z.xMin), d = m(z.zMax - z.zMin);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(m((z.xMin + z.xMax) / 2), y, m((z.zMin + z.zMax) / 2));
  return mesh;
}

function tapeOutline(z: { xMin: number; xMax: number; zMin: number; zMax: number }, color: number, widthIn = 2, openSide?: "W" | "E"): THREE.Group {
  const g = new THREE.Group();
  const w = widthIn;
  // three sides, open toward the wall
  g.add(tapeRect({ xMin: z.xMin, xMax: z.xMax, zMin: z.zMin, zMax: z.zMin + w }, color));
  g.add(tapeRect({ xMin: z.xMin, xMax: z.xMax, zMin: z.zMax - w, zMax: z.zMax }, color));
  if (openSide !== "E") g.add(tapeRect({ xMin: z.xMax - w, xMax: z.xMax, zMin: z.zMin, zMax: z.zMax }, color));
  if (openSide !== "W") g.add(tapeRect({ xMin: z.xMin, xMax: z.xMin + w, zMin: z.zMin, zMax: z.zMax }, color));
  return g;
}

export function buildField(initial: Record<Alliance, CellSide> = { red: "audience", blue: "scoring" }): FieldObjects {
  const group = new THREE.Group();
  const occluders: THREE.Object3D[] = [];
  const size = m(FIELD.sizeIn);

  // tiles
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tileTexture(), roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = "floor";
  group.add(floor);

  // perimeter walls (polycarbonate on aluminium)
  const wallH = m(FIELD.wallHeightIn), wallT = m(FIELD.wallThicknessIn);
  const wallMat = new THREE.MeshPhysicalMaterial({ color: 0xbfd6e6, transparent: true, opacity: 0.35, roughness: 0.2, side: THREE.DoubleSide, depthWrite: false });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.4 });
  for (const [x, z, rot] of [[0, -size / 2, 0], [0, size / 2, 0], [-size / 2, 0, Math.PI / 2], [size / 2, 0, Math.PI / 2]] as [number, number, number][]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(size + wallT, wallH, wallT), wallMat);
    wall.position.set(x, wallH / 2, z);
    wall.rotation.y = rot;
    group.add(wall);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(size + wallT, 0.03, wallT + 0.02), railMat);
    rail.position.set(x, wallH, z);
    rail.rotation.y = rot;
    group.add(rail);
    occluders.push(wall);
  }

  // tape zones
  group.add(tapeOutline(ZONES.loadingRed, RED, 2, "W"));
  group.add(tapeOutline(ZONES.loadingBlue, BLUE, 2, "E"));
  group.add(tapeRect(ZONES.gardenRedTape, RED));
  group.add(tapeRect(ZONES.gardenBlueTape, BLUE));
  // alliance areas outside the field
  const aw = m(ZONES.allianceWidthIn), ad = m(ZONES.allianceDepthIn);
  for (const [sx, color] of [[-1, RED], [1, BLUE]] as [number, number][]) {
    const a = new THREE.Mesh(new THREE.PlaneGeometry(ad, aw), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18 }));
    a.rotation.x = -Math.PI / 2;
    a.position.set(sx * (size / 2 + ad / 2 + wallT), -0.004, 0);
    group.add(a);
  }
  // audience label strip
  {
    const c = document.createElement("canvas"); c.width = 1024; c.height = 128;
    const g = c.getContext("2d")!; g.fillStyle = "#ffffff"; g.font = "bold 80px sans-serif"; g.textAlign = "center"; g.fillText("AUDIENCE", 512, 95);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.25), new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.6 }));
    lab.rotation.x = -Math.PI / 2; lab.position.set(0, -0.003, size / 2 + 0.35); group.add(lab);
    const c2 = document.createElement("canvas"); c2.width = 1024; c2.height = 128;
    const g2 = c2.getContext("2d")!; g2.fillStyle = "#ffffff"; g2.font = "bold 80px sans-serif"; g2.textAlign = "center"; g2.fillText("SCORING SIDE", 512, 95);
    const t2 = new THREE.CanvasTexture(c2); t2.colorSpace = THREE.SRGBColorSpace;
    const lab2 = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.25), new THREE.MeshBasicMaterial({ map: t2, transparent: true, opacity: 0.6 }));
    lab2.rotation.x = -Math.PI / 2; lab2.rotation.z = Math.PI; lab2.position.set(0, -0.003, -size / 2 - 0.35); group.add(lab2);
  }

  // hive structure
  const frame = buildFrame();
  group.add(frame);
  occluders.push(frame);
  const hives = {} as Record<Alliance, HiveObject>;
  const tagMeshes: THREE.Mesh[] = [];
  for (const alliance of ["red", "blue"] as Alliance[]) {
    const state: HiveState = { alliance, upCell: initial[alliance] };
    const { pivotGroup, tags } = buildHive(state);
    group.add(pivotGroup);
    occluders.push(pivotGroup);
    tagMeshes.push(...tags);
    hives[alliance] = { pivotGroup, state };
    // staged nectar in the up cell
  }
  const nectarGroup = new THREE.Group();
  group.add(nectarGroup);
  const stagedVisible: Record<Alliance, boolean> = { red: true, blue: true };

  // flowers
  const flowerPollen: THREE.Mesh[][] = [];
  const flowerAxes: THREE.Vector3[] = [];
  for (const f of FLOWER.positions) {
    const fl = buildFlower();
    const off = m(FLOWER.axisFromWallIn);
    let rotY = 0;
    let px = m(f.x), pz = m(f.z);
    switch (f.wall) {
      case "N": pz += off; rotY = Math.PI; break; // wall at -Z; backstop (-Z local) toward wall => rotate 180
      case "S": pz -= off; rotY = 0; break;
      case "E": px -= off; rotY = -Math.PI / 2; break;
      case "W": px += off; rotY = Math.PI / 2; break;
    }
    fl.position.set(px, 0, pz);
    fl.rotation.y = rotY;
    group.add(fl);
    occluders.push(fl);
    flowerAxes.push(new THREE.Vector3(px, 0, pz));
    // 4 pollen stacked inside
    const stack: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const b = ball("pollen");
      const zig = (i % 2 === 0 ? -1 : 1) * 0.008;
      b.position.set(px + zig, m(FLOWER.bottomRingThickIn) + m(BALL.pollen.diaIn) * (0.5 + i * 0.92), pz);
      group.add(b);
      stack.push(b);
    }
    flowerPollen.push(stack);
  }
  function restockFlowers() {
    flowerPollen.forEach((stack, fi) => {
      stack.forEach((b) => b.removeFromParent());
      stack.length = 0;
      const ax = flowerAxes[fi];
      for (let i = 0; i < 4; i++) {
        const b = ball("pollen");
        const zig = (i % 2 === 0 ? -1 : 1) * 0.008;
        b.position.set(ax.x + zig, m(FLOWER.bottomRingThickIn) + m(BALL.pollen.diaIn) * (0.5 + i * 0.92), ax.z);
        group.add(b);
        stack.push(b);
      }
    });
  }

  // garden pollen lines (static until the match converts them into live balls)
  const r = m(BALL.pollen.diaIn) / 2;
  const gardenPollen: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const bRed = ball("pollen");
    bRed.position.set(-size / 2 + r + i * 2 * r, r, size / 2 - r);
    group.add(bRed);
    gardenPollen.push(bRed);
    const bBlue = ball("pollen");
    bBlue.position.set(size / 2 - r - i * 2 * r, r, -size / 2 + r);
    group.add(bBlue);
    gardenPollen.push(bBlue);
  }

  function placeNectar() {
    nectarGroup.clear();
    for (const alliance of ["red", "blue"] as Alliance[]) {
      if (!stagedVisible[alliance]) continue;
      const st = hives[alliance].state;
      const up = cellFrames(st).find((f) => f.isUp)!;
      const rn = m(BALL.nectarRed.diaIn) / 2;
      // against the back skin, lined along the side nearest the alliance wall
      const sideSign = alliance === "red" ? -1 : 1;
      for (let i = 0; i < 3; i++) {
        const b = ball(alliance === "red" ? "nectarRed" : "nectarBlue");
        const back = up.floorCenter; // mid depth; move to back
        const depth = m(HIVE.cellDepthIn);
        const base = {
          x: back.x - up.normal.x * (depth / 2 - rn) + up.up.x * rn,
          y: back.y - up.normal.y * (depth / 2 - rn) + up.up.y * rn,
          z: back.z - up.normal.z * (depth / 2 - rn) + up.up.z * rn,
        };
        const across = sideSign * (m(HIVE.openingWidthIn) / 2 - rn - i * 2 * rn);
        // right vector sign: choose direction so that across>0 moves toward +X
        const rx = up.right.x >= 0 ? 1 : -1;
        b.position.set(base.x + up.right.x * across * rx, base.y + up.right.y * across * rx, base.z + up.right.z * across * rx);
        b.userData.alliance = alliance;
        nectarGroup.add(b);
      }
    }
  }

  function setHiveState(state: HiveState) {
    const h = hives[state.alliance];
    h.state = state;
    h.pivotGroup.rotation.x = -hiveTiltAngle(state); // see hive.ts: along = rotateX(-tilt)
    placeNectar();
  }
  for (const alliance of ["red", "blue"] as Alliance[]) setHiveState(hives[alliance].state);

  function stagedNectar(alliance: Alliance): THREE.Vector3[] {
    return nectarGroup.children.filter((c) => c.userData.alliance === alliance).map((c) => c.position.clone());
  }
  function setStagedNectar(alliance: Alliance, visible: boolean) { stagedVisible[alliance] = visible; placeNectar(); }
  function setHiveTilt(alliance: Alliance, tiltRad: number) { hives[alliance].pivotGroup.rotation.x = -tiltRad; }
  return { group, hives, occluders, tagMeshes, setHiveState, stagedNectar, setStagedNectar, setHiveTilt, flowerPollen, gardenPollen, flowerAxis: (i: number) => flowerAxes[i].clone(), restockFlowers };
}
