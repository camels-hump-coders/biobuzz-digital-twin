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
  requiredPower?: number;
  currentPower?: number;
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
  pickupBlocked?: boolean;
  /** at a ball or FLOWER with nothing free: "4/4" */
  pickupFull?: string;
  /** intake state text, whether it runs, and whether manual keys control it */
  intake: string;
  intakeOn: boolean;
  intakeManual: boolean;
  /** what the driver has done this session, for the guide: driven, turned, ever run the intake */
  guide: { moved: boolean; turned: boolean; intakeUsed: boolean };
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
  private open = new Set<string>();
  onAction?: (action: string) => void;
  private updatedAt = 0;
  constructor() {
    this.root.addEventListener("click", e => { const action = (e.target as HTMLElement).closest<HTMLElement>("[data-hud-action]")?.dataset.hudAction; if (action) this.onAction?.(action); });
    try { const saved = localStorage.getItem("biobuzz-hud-open"); if (saved) this.open = new Set(JSON.parse(saved)); } catch { /* ignore */ }
    // <details> toggles do not bubble, so listen in the capture phase on the root (innerHTML re-renders every frame)
    this.root.addEventListener("toggle", (e) => {
      const d = e.target as HTMLDetailsElement; const k = d.dataset.k; if (!k) return;
      if (d.open) this.open.add(k); else this.open.delete(k);
      try { localStorage.setItem("biobuzz-hud-open", JSON.stringify([...this.open])); } catch { /* ignore */ }
    }, true);
  }
  update(d: HudData) {
    const now = performance.now();
    if (now - this.updatedAt < 250) return;
    this.updatedAt = now;
    const focused = document.activeElement as HTMLElement | null;
    const focusAction = focused?.dataset.hudAction;
    const focusSection = focused?.tagName === 'SUMMARY' ? focused.parentElement?.dataset.k : undefined;
    const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    d = { ...d, target: escape(d.target), runtime: escape(d.runtime), cameraName: escape(d.cameraName), notice: d.notice ? escape(d.notice) : undefined, launchBlocked: d.launchBlocked ? escape(d.launchBlocked) : undefined };

    const f = (v: number | undefined, p = 1) => (v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(p));
    const cls = (ok: boolean | undefined) => (ok === undefined ? "" : ok ? "ok" : "bad");
    const tags = d.tags.map((t) => `<span class="tag ${t.visible ? "vis" : t.inFov && t.facing ? "occ" : ""}" title="${t.alliance} ${t.side} · ${f(t.distanceM / 0.0254, 0)} in · ${f(t.pixels, 0)} px">${t.id}</span>`).join("");
    const fold = (k: string, title: string, body: string) => `<details data-k="${k}" ${this.open.has(k) ? "open" : ""}><summary>${title}</summary>${body}</details>`;

    // ---- hero: hit chance from here, colour coded; never waits for the Monte Carlo (shows "computing" until it lands)
    const unreachable = d.requiredSpeed === undefined || !d.rpmOk;
    const p = d.pIdeal;
    const pClass = p === undefined ? (unreachable ? "bad" : "pending") : p > 0.8 ? "ok" : p > 0.4 ? "warn" : "bad";
    const pBig = p === undefined ? (unreachable ? "—" : "…") : `${(p * 100).toFixed(0)}<small>%</small>`;
    // the shot as it would leave right now, when it is materially different: same colour scale as the big number
    const nowClass = d.pHit === undefined ? "" : d.pHit > 0.8 ? "ok" : d.pHit > 0.4 ? "warn" : "bad";
    const nowLine = d.nowReason && d.pHit !== undefined && p !== undefined && Math.abs(d.pHit - p) > 0.1
      ? `<div class="now ${nowClass}"><span class="now-lbl">as fired now</span><span class="now-val">${(d.pHit * 100).toFixed(0)}<small>%</small></span><span class="now-why">${d.nowReason}</span></div>` : "";
    const pSub = p === undefined
      ? (d.requiredSpeed === undefined ? "no arc reaches the cell at this hood" : !d.rpmOk ? `needs ${f(d.requiredRpm, 0)} RPM, over the flywheel's max` : "computing…")
      : `95% CI ${(d.pIdealLo! * 100).toFixed(0)}–${(d.pIdealHi! * 100).toFixed(0)} · n=${d.mcN}${d.idealMissIn ? ` · misses by ${f(d.idealMissIn, 1)} in` : ""}${nowLine}`;
    const predicted = d.hit === undefined ? "–" : d.hit ? "HIT" : "MISS";
    const bearing = `${f(d.bearingErrDeg, 1)}° ${d.turretOk ? "in turret range" : "turn robot"}`;

    const ready = !d.launchBlocked && d.turretOk && d.rpmOk && !!d.actualHit;
    const live = !d.runtime.startsWith('RUNNING') && !d.runtime.startsWith('INIT') && !document.body.classList.contains('is-replaying');
    // guidance order: aim first, then the hood slider in Practice (the one knob a newcomer should touch), then shoot;
    // after the first shot the guide moves on to driving, turning and the intake, the three things a new driver has
    // not touched yet. "Tune shot" with every knob and lever stays a quiet secondary link.
    const afterShot = live && d.shotsFired > 0 && !d.launchBlocked; // turning away from the target is part of the lesson, so aim is not required here
    const next = afterShot && !d.guide.moved ? 'move' : afterShot && !d.guide.turned ? 'turn' : afterShot && !d.guide.intakeUsed && d.intakeManual ? 'intake' : undefined;
    let title = d.launchBlocked ? 'Shot unavailable' : !d.turretOk ? 'Aim toward the target' : unreachable ? 'Try another position' : d.actualHit ? 'Ready to try a shot' : 'Adjust your shot';
    let advice = d.launchBlocked ?? (!d.turretOk ? `Turn ${Math.abs(d.bearingErrDeg).toFixed(0)}° toward the highlighted cell.` : unreachable ? 'No arc reaches the cell from here with this hood angle: slide the Hood angle in the Experiment card, or move.' : !d.actualHit ? 'Slide the Hood angle in the Experiment card and watch the hit chance climb.' : 'The predicted arc enters the cell. Shoot to test it.');
    let primary = !live ? '' : !d.turretOk ? '<button data-hud-action="aim">Aim at target</button>' : (!d.actualHit || unreachable) ? '<button data-hud-action="hood">Adjust hood angle →</button>' : '<button data-hud-action="shoot">Shoot · Space</button>';
    if (next === 'move') { title = 'Now drive'; advice = 'Click the field, then hold W or S to drive forward or back (A / D strafe on mecanum). Watch the hit chance change as you move.'; primary = '<button data-hud-action="focus">Focus field · W S A D</button>'; }
    else if (next === 'turn') { title = 'Now turn'; advice = 'Hold Q or E (or ← / →) to rotate. The aim line shows where the launcher points; R snaps it back onto the target.'; primary = '<button data-hud-action="focus">Focus field · Q E</button>'; }
    else if (next === 'intake') { title = 'Collect a ball'; advice = `Press I to switch the intake feeder on (K runs it while held). Then drive the intake side (green bar) onto a loose ball or under a FLOWER: the side wheels pull it in. You carry ${d.carrying}.`; primary = '<button data-hud-action="intake">Intake on · I</button>'; }
    const html = `
      ${d.launchBlocked ? `<section class="robot-alert shot-blocked" role="alert"><strong>⚠ Shot needs attention</strong><p>${d.launchBlocked}</p></section>` : ''}
      ${d.pickupFull ? `<section class="robot-alert intake-blocked" role="status"><strong>⚠ Not collected · carrying ${d.pickupFull}</strong><p>The robot is full (it starts with 4 POLLEN preloaded). Shoot to make room, then collect.</p></section>` : ''}
      ${d.pickupBlocked ? `<section class="robot-alert intake-blocked" role="status"><strong>⚠ Not collected · intake off</strong><p>You have room for a ball. ${d.intakeManual ? 'Press <b>I</b> to switch the intake feeder on (or hold <b>K</b>), then drive the intake side onto the ball or FLOWER opening so the side wheels touch it.' : 'Turn on the intake motor using your TeamCode controls, then drive the intake over the ball or FLOWER opening.'}</p>${d.intakeManual ? '<div class="hud-actions"><button data-hud-action="intake">Turn intake on · I</button></div>' : ''}</section>` : ''}
      <div class="readiness ${ready ? 'ready' : ''}"><span class="eyebrow">${document.body.classList.contains('is-replaying') ? 'RECORDED FIELD · LIVE SHOT ANALYSIS' : 'SHOT READINESS'}</span><h2>${title}</h2><p>${advice}</p>
      <div class="hud-actions">${primary}<button class="secondary" data-hud-action="analyze" title="Every knob and lever: arc, speed, target, variability">All knobs: Tune shot →</button></div>
      <div class="shot-summary"><span>${d.carrying}</span><span class="intake-state ${d.intakeOn ? 'ok' : ''}" title="${escape(d.intake)}">intake ${d.intakeOn ? '● on' : '○ off'}</span><span>${d.shotsFired} fired · ${d.shotsHit} settled in target</span></div></div>
      <section class="shot-at-glance" aria-label="Shot summary">
        <div><strong class="${pClass}">${p === undefined ? '—' : `${(p * 100).toFixed(0)}%`}</strong> hit chance after aiming</div>
        <div class="as-fired"><strong class="${nowClass}">${d.pHit === undefined ? '—' : `${(d.pHit * 100).toFixed(0)}%`}</strong> as fired now${d.nowReason && d.pHit !== undefined && p !== undefined && Math.abs(d.pHit - p) > 0.1 ? ` <span class="why">· ${d.nowReason}</span>` : ''}</div>
        <div>Required: <b>${f(d.requiredRpm, 0)} RPM</b> · hood <b>${f(d.hoodDeg, 1)}°</b></div>
        <div title="Estimated motor power = RPM / configured free RPM">Power need / now: ${f(d.requiredPower, 2)} / ${f(d.currentPower, 2)}</div>
        <div>Current: ${f(d.currentRpm, 0)} RPM · aim error ${f(d.bearingErrDeg, 1)}°</div>
        <div>Lowest-energy shot: ${f(d.bestAngleDeg, 1)}° · ${f(d.bestRpm, 0)} RPM</div>
      </section>
      <details data-k="prediction" ${this.open.has('prediction') ? 'open' : ''}><summary>Scoring estimate · ${p === undefined ? 'calculating' : `${(p * 100).toFixed(0)}%`} after aiming</summary><div class="hero">
        <div class="tile p ${pClass}"><div class="big">${pBig}</div><div class="lbl">hit chance from here, once aimed &amp; spun up</div><div class="sub">${pSub}</div></div>
        <div class="tile">
          <div class="kv"><span>Predicted${d.aimed ? "" : " once aimed"}</span><b class="${cls(d.hit)}">${predicted}</b></div>
          <div class="kv"><span>Pointed now</span><b class="${cls(d.actualHit)}">${d.actualHit === undefined ? "–" : d.actualHit ? "HIT" : "MISS"}</b></div>
          <div class="kv"><span>Range</span><b>${f(d.rangeIn, 1)} in</b></div>
          <div class="kv"><span>Bearing</span><b class="${cls(d.turretOk)}">${bearing}</b></div>
          <div class="kv"><span>Carrying</span><b class="${d.launchBlocked ? "bad" : ""}">${d.carrying}</b></div>
          <div class="kv"><span>Intake</span><b class="${d.intakeOn ? "ok" : ""}">${escape(d.intake)}</b></div>
        </div>
      </div>
      </details>
      <div class="target">Target: ${d.target}</div>
      <div class="status">
        <span class="pill ${d.matchClass ?? ""}">${d.match}</span>
        <span class="pill rt">${d.runtime}</span>
      </div>
      ${d.notice ? `<details class="performance-notice"><summary>${d.noticeBad ? "Action needed" : "Simulation advice"}</summary><p>${d.notice}</p>${/fps/.test(d.notice) ? `<button data-hud-action="detail">${document.body.classList.contains('visual-detail-reduced') ? 'Restore visual detail' : 'Reduce visual detail'}</button>` : ""}</details>` : ""}
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
    if (html === this.lastHtml) return;
    this.lastHtml = html;
    // patch the existing DOM in place instead of replacing it: hover, focus and open/closed folds survive, and the
    // browser only re-lays-out what changed
    morph(this.root, html);
    if (focusAction && document.activeElement !== focused) this.root.querySelector<HTMLElement>(`[data-hud-action="${focusAction}"]`)?.focus({ preventScroll: true });
    else if (focusSection && document.activeElement !== focused) this.root.querySelector<HTMLElement>(`[data-k="${focusSection}"] > summary`)?.focus({ preventScroll: true });
  }
  private lastHtml = "";
}

const scratch = typeof document !== "undefined" ? document.createElement("template") : undefined;
/** Reconcile `target`'s children with the markup in `html`: matching elements (same tag, same data-k / data-hud-action)
 *  are kept and patched, text is updated in place, anything else is replaced. */
export function morph(target: Element, html: string) {
  if (!scratch) { target.innerHTML = html; return; }
  scratch.innerHTML = html;
  morphChildren(target, scratch.content);
}
function keyOf(n: Node): string {
  if (n.nodeType !== Node.ELEMENT_NODE) return n.nodeType === Node.TEXT_NODE ? "#text" : "#other";
  const e = n as HTMLElement;
  return `${e.tagName}|${e.dataset.k ?? ""}|${e.dataset.hudAction ?? ""}`;
}
function morphChildren(oldParent: Node, newParent: Node) {
  const olds = [...oldParent.childNodes], news = [...newParent.childNodes];
  let i = 0;
  for (; i < news.length; i++) {
    const n = news[i], o = olds[i];
    if (!o) { oldParent.appendChild(n.cloneNode(true)); continue; }
    if (keyOf(o) !== keyOf(n)) { oldParent.replaceChild(n.cloneNode(true), o); continue; }
    if (n.nodeType === Node.TEXT_NODE) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const oe = o as Element, ne = n as Element;
    for (const a of [...oe.attributes]) if (!ne.hasAttribute(a.name)) oe.removeAttribute(a.name);
    for (const a of [...ne.attributes]) if (oe.getAttribute(a.name) !== a.value) oe.setAttribute(a.name, a.value);
    morphChildren(oe, ne);
  }
  for (let j = olds.length - 1; j >= i; j--) oldParent.removeChild(olds[j]);
}
