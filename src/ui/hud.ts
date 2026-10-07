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
  /** hit probability from this spot once aimed and spun up to the required speed (what the hit map shows) */
  pIdeal?: number;
  pIdealLo?: number;
  pIdealHi?: number;
  idealMissIn?: number;
  /** why the shot as it would be fired right now differs from that (not aimed, flywheel speed) */
  nowReason?: string;
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
  /** which fold-out sections are open; remembered across reloads */
  private open = new Set<string>(["tags"]);
  constructor() {
    try { const saved = localStorage.getItem("biobuzz-hud-open"); if (saved) this.open = new Set(JSON.parse(saved)); } catch { /* ignore */ }
    // <details> toggles do not bubble, so listen in the capture phase on the root (innerHTML re-renders every frame)
    this.root.addEventListener("toggle", (e) => {
      const d = e.target as HTMLDetailsElement; const k = d.dataset.k; if (!k) return;
      if (d.open) this.open.add(k); else this.open.delete(k);
      try { localStorage.setItem("biobuzz-hud-open", JSON.stringify([...this.open])); } catch { /* ignore */ }
    }, true);
  }
  update(d: HudData) {
    const f = (v: number | undefined, p = 1) => (v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(p));
    const cls = (ok: boolean | undefined) => (ok === undefined ? "" : ok ? "ok" : "bad");
    const tags = d.tags.map((t) => `<span class="tag ${t.visible ? "vis" : t.inFov && t.facing ? "occ" : ""}" title="${t.alliance} ${t.side} · ${f(t.distanceM / 0.0254, 0)} in · ${f(t.pixels, 0)} px">${t.id}</span>`).join("");
    const fold = (k: string, title: string, body: string) => `<details data-k="${k}" ${this.open.has(k) ? "open" : ""}><summary>${title}</summary>${body}</details>`;

    // ---- hero: hit chance from here, colour coded; never waits for the Monte Carlo (shows "computing" until it lands)
    const unreachable = d.requiredSpeed === undefined || !d.rpmOk;
    const p = d.pIdeal;
    const pClass = p === undefined ? (unreachable ? "bad" : "pending") : p > 0.8 ? "ok" : p > 0.4 ? "warn" : "bad";
    const pBig = p === undefined ? (unreachable ? "—" : "…") : `${(p * 100).toFixed(0)}<small>%</small>`;
    const nowLine = d.nowReason && d.pHit !== undefined && p !== undefined && Math.abs(d.pHit - p) > 0.1 ? `<div class="now">as fired now ${(d.pHit * 100).toFixed(0)}% · ${d.nowReason}</div>` : "";
    const pSub = p === undefined
      ? (d.requiredSpeed === undefined ? "no arc reaches the cell at this hood" : !d.rpmOk ? `needs ${f(d.requiredRpm, 0)} RPM, over the flywheel's max` : "computing…")
      : `95% CI ${(d.pIdealLo! * 100).toFixed(0)}–${(d.pIdealHi! * 100).toFixed(0)} · n=${d.mcN}${d.idealMissIn ? ` · misses by ${f(d.idealMissIn, 1)} in` : ""}${nowLine}`;
    const predicted = d.hit === undefined ? "–" : d.hit ? "HIT" : "MISS";
    const bearing = `${f(d.bearingErrDeg, 1)}° ${d.turretOk ? "in turret range" : "turn robot"}`;

    this.root.innerHTML = `
      <div class="hero">
        <div class="tile p ${pClass}"><div class="big">${pBig}</div><div class="lbl">hit chance from here, once aimed &amp; spun up</div><div class="sub">${pSub}</div></div>
        <div class="tile">
          <div class="kv"><span>Predicted${d.aimed ? "" : " once aimed"}</span><b class="${cls(d.hit)}">${predicted}</b></div>
          <div class="kv"><span>Pointed now</span><b class="${cls(d.actualHit)}">${d.actualHit === undefined ? "–" : d.actualHit ? "HIT" : "MISS"}</b></div>
          <div class="kv"><span>Range</span><b>${f(d.rangeIn, 1)} in</b></div>
          <div class="kv"><span>Bearing</span><b class="${cls(d.turretOk)}">${bearing}</b></div>
          <div class="kv"><span>Carrying</span><b class="${d.launchBlocked ? "bad" : ""}">${d.carrying}</b></div>
        </div>
      </div>
      <div class="target">Target: ${d.target}</div>
      <div class="status">
        <span class="pill ${d.matchClass ?? ""}">${d.match}</span>
        <span class="pill rt">${d.runtime}</span>
      </div>
      ${d.notice ? `<div class="notice ${d.noticeBad ? "bad" : "warn"}">${d.notice}</div>` : ""}
      ${fold("shot", `Shot details · hood ${f(d.hoodDeg, 1)}° · ${f(d.requiredRpm, 0)} RPM needed`, `<table>
        <tr><td>Hood angle</td><td>${f(d.hoodDeg, 1)}°</td></tr>
        <tr><td>Exit speed need / now</td><td class="${cls(d.rpmOk)}">${f(d.requiredSpeed, 2)} m/s (${f(d.requiredRpm, 0)} RPM) / ${f(d.currentSpeed, 2)} m/s (${f(d.currentRpm, 0)} RPM)</td></tr>
        <tr><td>Entry</td><td>Δh ${f(d.heightErrorIn, 1)} in · entry ${f(d.entryAngleDeg, 0)}°</td></tr>
        <tr><td>Flight</td><td>${f(d.flightTime, 2)} s · apex ${f(d.apexIn, 0)} in</td></tr>
        <tr><td>Lowest-energy</td><td>${d.bestAngleDeg === undefined ? "no feasible angle in hood range" : `${f(d.bestAngleDeg, 1)}° @ ${f(d.bestSpeed, 2)} m/s (${f(d.bestRpm, 0)} RPM)`}</td></tr>
        <tr><td>Fired / hit</td><td>${d.shotsFired} / ${d.shotsHit}</td></tr>
      </table>`)}
      ${fold("match", `Match & field · ${d.tipping ?? d.cellLoad.replace(/ = .*$/, "")} · ${d.tips} tip${d.tips === 1 ? "" : "s"}`, `<table>
        <tr><td>Our up cell</td><td class="${d.tipping ? "warn" : ""}">${d.tipping ?? d.cellLoad} · ${d.tips} tip${d.tips === 1 ? "" : "s"} (${d.tips * 20} pts)</td></tr>
        <tr><td>Their hive</td><td>${d.theirHive}</td></tr>
        <tr><td>Score</td><td>${d.score}</td></tr>
        <tr><td>Robot contact</td><td class="${d.contact ? (d.contactBad ? "bad" : "warn") : "quiet"}">${d.contact ?? "none"}</td></tr>
        <tr><td>Field supply</td><td>${d.supply}</td></tr>
      </table>`)}
      ${fold("robot", `Robot · ${f(d.poseIn.x)}, ${f(d.poseIn.z)} in · ${f(d.poseIn.headingDeg, 0)}° · ${f(d.speedMps, 2)} m/s`, `<table>
        <tr><td>Position</td><td>${f(d.poseIn.x)} , ${f(d.poseIn.z)} in · ${f(d.poseIn.headingDeg, 0)}°</td></tr>
        <tr><td>Speed</td><td>${f(d.speedMps, 2)} m/s · ${d.drivetrain}${d.fieldCentric ? " · field-centric" : ""}</td></tr>
        <tr><td>Chassis</td><td>${d.modelStatus}</td></tr>
      </table>`)}
      ${fold("tags", `AprilTags · ${d.cameraName} · ${d.tags.filter((t) => t.visible).length} visible`, `<div class="tags">${tags || '<span class="tag">no camera</span>'}</div>`)}
    `;
  }
}
