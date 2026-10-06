import type { TagVisibility } from "../camera/robotCamera";

export interface HudData {
  poseIn: { x: number; z: number; headingDeg: number };
  speedMps: number;
  drivetrain: string;
  fieldCentric: boolean;
  target: string;
  rangeIn: number;
  bearingErrDeg: number;
  turretOk: boolean;
  hoodDeg: number;
  requiredSpeed?: number;
  requiredRpm?: number;
  rpmOk: boolean;
  currentRpm: number;
  currentSpeed: number;
  hit?: boolean;
  aimed: boolean;
  heightErrorIn?: number;
  entryAngleDeg?: number;
  bestAngleDeg?: number;
  bestSpeed?: number;
  bestRpm?: number;
  flightTime?: number;
  apexIn?: number;
  pHit?: number;
  pLo?: number;
  pHi?: number;
  mcN?: number;
  meanMissIn?: number;
  actualHit?: boolean;
  shotsFired: number;
  shotsHit: number;
  cellLoad: string;
  tips: number;
  /** alliance totals and our robot's LEAVE / PARK status (Table 10-2) */
  score: string;
  tipping?: string;
  carrying: string;
  supply: string;
  theirHive: string;
  launchBlocked?: string;
  /** match phase + clock */
  match: string;
  matchClass?: string;
  /** robot-vs-robot contact / pin count / fouls */
  contact?: string;
  contactBad?: boolean;
  tags: TagVisibility[];
  cameraName: string;
  modelStatus: string;
  /** runtime link: status, OpMode, which gamepad the keyboard drives */
  runtime: string;
  /** transient advice (intake off, flywheel stopped, powered motor without a role, low frame rate); a 2-line slot is always reserved */
  notice?: string;
  noticeBad?: boolean;
}

export class Hud {
  private root = document.getElementById("hud")!;
  update(d: HudData) {
    const f = (v: number | undefined, p = 1) => (v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(p));
    const cls = (ok: boolean | undefined) => (ok === undefined ? "" : ok ? "ok" : "bad");
    const tags = d.tags.map((t) => `<span class="tag ${t.visible ? "vis" : t.inFov && t.facing ? "occ" : ""}" title="${t.alliance} ${t.side} · ${f(t.distanceM / 0.0254, 0)} in · ${f(t.pixels, 0)} px">${t.id}</span>`).join("");
    this.root.innerHTML = `
      <h2>Robot</h2>
      <table>
        <tr><td>Position</td><td>${f(d.poseIn.x)} , ${f(d.poseIn.z)} in · ${f(d.poseIn.headingDeg, 0)}°</td></tr>
        <tr><td>Speed</td><td>${f(d.speedMps, 2)} m/s · ${d.drivetrain}${d.fieldCentric ? " · field-centric" : ""}</td></tr>
        <tr><td>Chassis</td><td>${d.modelStatus}</td></tr>
        <tr><td>Runtime</td><td class="two">${d.runtime}</td></tr>
        <tr><td>Match</td><td class="two ${d.matchClass ?? ""}">${d.match}</td></tr>
        <tr><td>Notice</td><td class="two clamp ${d.notice ? (d.noticeBad ? "bad" : "warn") : "quiet"}">${d.notice ?? "—"}</td></tr>
      </table>
      <h2 style="margin-top:8px">Shot → ${d.target}</h2>
      <table>
        <tr><td>Range (horizontal)</td><td>${f(d.rangeIn, 1)} in</td></tr>
        <tr><td>Bearing error</td><td class="${cls(d.turretOk)}">${f(d.bearingErrDeg, 1)}° ${d.turretOk ? "(in turret range)" : "(turn robot)"}</td></tr>
        <tr><td>Hood angle</td><td>${f(d.hoodDeg, 1)}°</td></tr>
        <tr><td>Exit speed need / now</td><td class="${cls(d.rpmOk)}">${f(d.requiredSpeed, 2)} m/s (${f(d.requiredRpm, 0)} RPM) / ${f(d.currentSpeed, 2)} m/s (${f(d.currentRpm, 0)} RPM)</td></tr>
        <tr><td>Predicted${d.aimed ? "" : " (once aimed)"}</td><td class="${cls(d.hit)}">${d.hit === undefined ? "–" : d.hit ? "HIT" : "MISS"} · Δh ${f(d.heightErrorIn, 1)} in · entry ${f(d.entryAngleDeg, 0)}°</td></tr>
        <tr><td>Flight</td><td>${f(d.flightTime, 2)} s · apex ${f(d.apexIn, 0)} in</td></tr>
        <tr><td>Lowest-energy</td><td>${d.bestAngleDeg === undefined ? "no feasible angle in hood range" : `${f(d.bestAngleDeg, 1)}° @ ${f(d.bestSpeed, 2)} m/s (${f(d.bestRpm, 0)} RPM)`}</td></tr>
        <tr><td>As pointed now</td><td class="${cls(d.actualHit)}">${d.actualHit === undefined ? "–" : d.actualHit ? "HIT" : "MISS"}</td></tr>
        <tr><td>Hit probability</td><td class="two ${d.pHit === undefined ? "" : d.pHit > 0.8 ? "ok" : d.pHit > 0.4 ? "warn" : "bad"}">${d.pHit === undefined ? "–" : `${(d.pHit * 100).toFixed(0)}% (95% CI ${(d.pLo! * 100).toFixed(0)}–${(d.pHi! * 100).toFixed(0)}, n=${d.mcN})`}${d.meanMissIn ? ` · misses by ${f(d.meanMissIn, 1)} in` : ""}</td></tr>
        <tr><td>Carrying · fired/hit</td><td class="${d.launchBlocked ? "bad" : ""}">${d.carrying} · ${d.shotsFired}/${d.shotsHit}</td></tr>
        <tr><td>Our up cell</td><td class="two ${d.tipping ? "warn" : ""}">${d.tipping ?? d.cellLoad} · ${d.tips} tip${d.tips === 1 ? "" : "s"} (${d.tips * 20} pts)</td></tr>
        <tr><td>Their hive</td><td>${d.theirHive}</td></tr>
        <tr><td>Score</td><td class="two clamp">${d.score}</td></tr>
        <tr><td>Robot contact</td><td class="two ${d.contact ? (d.contactBad ? "bad" : "warn") : "quiet"}">${d.contact ?? "none"}</td></tr>
        <tr><td>Field supply</td><td class="two">${d.supply}</td></tr>
      </table>
      <h2 style="margin-top:8px">AprilTags — ${d.cameraName}</h2>
      <div class="tags">${tags || '<span class="tag">no camera</span>'}</div>
    `;
  }
}
