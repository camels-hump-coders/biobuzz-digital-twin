/**
 * Stadium backdrop: tiered audience stands on all four sides filled with a colourful crowd, a lighting truss above the
 * field with colour-cycling fixtures, and a pair of coloured spotlights that sweep the stands. Pure decoration: nothing
 * here touches the field model, the AprilTag occluders or the robot cameras' geometry, and the field itself keeps its
 * neutral white light (the sweeping spots point at the crowd, not the mat). Toggle with the Stadium switch.
 */
import * as THREE from "three";
import { FIELD, m } from "./fieldSpec";

export interface Venue { group: THREE.Group; update(dt: number, now: number): void }

const rand = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();

export function buildVenue(): Venue {
  const group = new THREE.Group();
  group.name = "venue";
  const half = m(FIELD.sizeIn) / 2;
  const floorY = -m(FIELD.tileThicknessIn);

  // ---- stands: 7 tiers per side, starting 2.2 m beyond the field perimeter, each tier a step up and back
  const tiers = 8, standStart = half + 4.6, stepRise = 0.45, stepRun = 0.85, standLen = half * 2 + 2 * standStart;
  const stepMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.95 });
  const stepGeo = new THREE.BoxGeometry(standLen, stepRise, stepRun);
  const steps = new THREE.InstancedMesh(stepGeo, stepMat, tiers * 4);
  const seats = 56; // per tier per side
  const crowdGeo = new THREE.CapsuleGeometry(0.13, 0.3, 3, 6); // a seated person, roughly
  const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, tiers * 4 * seats);
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();
  const palette = [0xc9a227, 0xa8403a, 0x3a6aa8, 0x3f9a63, 0xc77a2a, 0xcfd3d8, 0x7a4f9b, 0x2f8f85, 0x2a2e35, 0x5a6270, 0x8a3f6a];
  let si = 0, ci = 0;
  const crowdPhase: number[] = [];
  for (let side = 0; side < 4; side++) {
    const rot = (side * Math.PI) / 2;
    for (let t = 0; t < tiers; t++) {
      const dist = standStart + t * stepRun + stepRun / 2, y = floorY + stepRise / 2 + t * stepRise;
      tmp.position.set(0, y, dist); tmp.rotation.set(0, 0, 0); tmp.scale.set(1, 1, 1);
      tmp.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), rot); tmp.rotation.y = rot; tmp.updateMatrix();
      steps.setMatrixAt(si++, tmp.matrix);
      for (let k = 0; k < seats; k++) {
        if (rand() < 0.18) continue; // empty seats
        const along = -standLen / 2 + 0.6 + (k + 0.5 + (rand() - 0.5) * 0.4) * ((standLen - 1.2) / seats);
        tmp.position.set(along, y + stepRise / 2 + 0.3, dist - 0.1 + (rand() - 0.5) * 0.15); tmp.rotation.set(0, 0, 0);
        tmp.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), rot); tmp.rotation.y = rot + Math.PI; tmp.scale.setScalar(0.85 + rand() * 0.3); tmp.updateMatrix();
        crowd.setMatrixAt(ci, tmp.matrix);
        crowd.setColorAt(ci, col.setHex(palette[Math.floor(rand() * palette.length)]));
        crowdPhase.push(rand() * Math.PI * 2);
        ci++;
      }
    }
  }
  steps.count = si; crowd.count = ci;
  steps.castShadow = false; steps.receiveShadow = false; crowd.castShadow = false;
  group.add(steps, crowd);

  // ---- banner behind the far stands: BIOBUZZ in the season gold
  const canvas = document.createElement("canvas"); canvas.width = 1024; canvas.height = 192;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#11151b"; ctx.fillRect(0, 0, 1024, 192);
    ctx.fillStyle = "#f2c200"; ctx.font = "bold 120px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("BIOBUZZ", 512, 96);
    ctx.fillStyle = "#8b949e"; ctx.font = "bold 36px system-ui, sans-serif"; ctx.fillText("FIRST TECH CHALLENGE 2026-27", 512, 168);
  }
  const bannerTex = new THREE.CanvasTexture(canvas); bannerTex.colorSpace = THREE.SRGBColorSpace;
  const bannerMat = new THREE.MeshBasicMaterial({ map: bannerTex });
  const bannerDist = standStart + tiers * stepRun + 0.3, bannerY = floorY + tiers * stepRise + 1.6;
  for (const rot of [0, Math.PI]) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.9), bannerMat);
    b.position.set(0, bannerY, bannerDist).applyAxisAngle(new THREE.Vector3(0, 1, 0), rot); b.rotation.y = rot + Math.PI;
    group.add(b);
  }

  // ---- lighting truss: a square of dark beams above the field with fixtures whose glow cycles colour
  const trussY = 6.5, trussHalf = half + 1.0;
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.6, metalness: 0.4 });
  for (let i = 0; i < 4; i++) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(trussHalf * 2 + 0.3, 0.25, 0.25), beamMat);
    beam.position.set(0, trussY, trussHalf).applyAxisAngle(new THREE.Vector3(0, 1, 0), (i * Math.PI) / 2); beam.rotation.y = (i * Math.PI) / 2;
    group.add(beam);
  }
  const fixtures: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; hue: number; rate: number }[] = [];
  const fixGeo = new THREE.CylinderGeometry(0.12, 0.18, 0.3, 10);
  const perBeam = 7;
  for (let i = 0; i < 4; i++) for (let k = 0; k < perBeam; k++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffffff, emissiveIntensity: 1.5, roughness: 0.4 });
    const mesh = new THREE.Mesh(fixGeo, mat);
    const along = -trussHalf + ((k + 0.5) * trussHalf * 2) / perBeam;
    mesh.position.set(along, trussY - 0.3, trussHalf).applyAxisAngle(new THREE.Vector3(0, 1, 0), (i * Math.PI) / 2);
    mesh.rotation.x = 0.35; mesh.rotation.y = (i * Math.PI) / 2;
    group.add(mesh);
    fixtures.push({ mesh, mat, hue: (i * perBeam + k) / (4 * perBeam), rate: 0.05 + rand() * 0.05 });
  }

  // ---- two coloured spots that sweep the stands (not the field, so the mat and camera views stay neutral)
  const spots: { light: THREE.SpotLight; phase: number; side: number }[] = [];
  for (let i = 0; i < 2; i++) {
    const light = new THREE.SpotLight(0xffffff, 60, 30, 0.35, 0.6, 1.2);
    light.castShadow = false;
    light.position.set(i === 0 ? -trussHalf : trussHalf, trussY - 0.4, 0);
    light.target.position.set(0, 1, 0);
    group.add(light, light.target);
    spots.push({ light, phase: i * Math.PI, side: i === 0 ? 1 : -1 });
  }

  // ---- slow, gentle animation (nothing flashes faster than about once a second)
  const crowdCol = new THREE.Color();
  let crowdTick = 0;
  function update(dt: number, now: number) {
    if (!group.visible) return;
    const t = now / 1000;
    for (const f of fixtures) {
      const h = (f.hue + t * f.rate) % 1;
      f.mat.emissive.setHSL(h, 0.9, 0.6);
      f.mat.emissiveIntensity = 1.2 + 0.8 * Math.sin(t * 1.3 + f.hue * 6.28);
    }
    for (const s of spots) {
      s.light.color.setHSL((t * 0.04 + s.phase / 6.28) % 1, 0.9, 0.6);
      const a = t * 0.25 + s.phase;
      const standR = standStart + tiers * stepRun * 0.5;
      s.light.target.position.set(Math.cos(a) * standR, 1.5, Math.sin(a) * standR);
    }
    // the crowd does the wave: a slow brightness ripple around the stands (cheap: recolour a slice per frame)
    crowdTick += dt;
    if (crowdTick > 0.12) {
      crowdTick = 0;
      const wave = t * 0.8;
      for (let i = 0; i < crowd.count; i++) {
        crowd.getColorAt(i, crowdCol);
        const hsl = { h: 0, s: 0, l: 0 }; crowdCol.getHSL(hsl);
        const lift = 0.5 + 0.5 * Math.sin(wave + crowdPhase[i]);
        crowdCol.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(0.26 + 0.14 * lift + (hsl.l > 0.7 ? 0.3 : 0), 0.08, 0.9));
        crowd.setColorAt(i, crowdCol);
      }
      if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true;
    }
  }
  return { group, update };
}
