import { ballsToTip, type AllianceScore } from '../sim/scoring';
import type { Alliance } from '../field/hive';

/** Persistent, compact scoring beside the match controls; detail disclosure survives updates. */
export class MatchScoreView {
  private root = document.createElement('section');
  private last = '';
  private tip = document.createElement('div');
  private lastTip = '';
  private trigger = document.createElement('button');
  private detail = document.createElement('div');
  constructor() {
    this.root.id = 'match-score';
    this.root.setAttribute('aria-label', 'Your alliance score');
    this.trigger.className = 'score-trigger';
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', 'score-breakdown');
    this.detail.id = 'score-breakdown';
    this.detail.className = 'score-breakdown';
    this.detail.hidden = true;
    const show = (visible: boolean) => { this.detail.hidden = !visible; this.trigger.setAttribute('aria-expanded', String(visible)); };
    this.root.addEventListener('mouseenter', () => show(true));
    this.root.addEventListener('mouseleave', () => { if (!this.root.contains(document.activeElement)) show(false); });
    this.root.addEventListener('focusin', () => show(true));
    this.root.addEventListener('focusout', e => { if (!this.root.contains(e.relatedTarget as Node)) show(false); });
    this.trigger.addEventListener('click', () => show(true));
    this.root.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); this.trigger.focus(); show(false); } });
    document.addEventListener('pointerdown', e => { if (!this.root.contains(e.target as Node)) show(false); });
    this.root.append(this.trigger, this.detail);
    this.tip.id = 'tip-needed';
    this.tip.setAttribute('aria-label', 'Balls needed to tip your cell');
    this.tip.title = 'Additional balls that must land and remain in your raised cell. Pollen and nectar are alternatives; mixed loads also count toward the configured mass threshold.';
    document.body.append(this.root, this.tip);
  }
  update(s: AllianceScore, alliance: Alliance, phase: string, clock: number, robots: number, replay: boolean, infinite: boolean, load: { massKg: number; thresholdKg: number; tipping: boolean; autoTip: boolean }) {
    const display = document.querySelector('.match-display');
    if (display && this.root.parentElement !== display) display.prepend(this.root);
    if (display && this.tip.parentElement !== display) display.append(this.tip);
    this.tip.hidden = replay;
    const needed = ballsToTip(load.massKg, load.thresholdKg);
    const tipKey = JSON.stringify([needed, load.tipping, load.autoTip]);
    if (tipKey !== this.lastTip) {
      this.lastTip = tipKey;
      this.tip.innerHTML = `<span>${load.tipping ? 'CELL TIPPING' : 'TO TIP OUR CELL'}</span><strong>${load.tipping ? 'Tipping…' : needed.pollen === 0 ? 'Load reached' : `${needed.pollen} pollen`}</strong><span>${load.tipping ? 'Next cell loading soon' : !load.autoTip ? `or ${needed.nectar} nectar · auto-tip off` : needed.pollen === 0 ? 'Ready to tip' : `or ${needed.nectar} nectar`}</span>`;
    }
    this.root.hidden = replay;
    if (this.root.hidden) return;
    const auto = clock > 120, ended = clock <= 0;
    const key = JSON.stringify([s, alliance, phase, auto, ended, robots, infinite]);
    if (key === this.last) return;
    this.last = key;
    this.root.dataset.alliance = alliance;
    this.trigger.innerHTML = `<span>${alliance.toUpperCase()}</span><strong>${s.total}<small> pts</small></strong><span>${s.tips} tips · ${s.bonusRp}/3 RP</span>`;
    this.trigger.setAttribute('aria-label', `${alliance} alliance: ${s.total} points, ${s.tips} tips, ${s.bonusRp} bonus ranking points. Show score breakdown`);
    const progress = (label: string, value: number, target: number) => `<span class="${value >= target ? 'earned' : ''}">${value >= target ? '✓ ' : ''}${label} ${value}/${target}</span>`;
    this.detail.innerHTML = `
      <div class="score-heading">${alliance.toUpperCase()} ALLIANCE · ${phase === 'setup' ? 'PRACTICE ESTIMATE' : ended ? 'END-STATE ESTIMATE' : phase === 'stopped' ? 'PAUSED' : 'LIVE ESTIMATE'}</div>
      <div class="score-totals"><strong>${s.total}<small> points</small></strong><b>${s.bonusRp}/3 <small>bonus RP</small></b></div>
      <div class="score-auto">AUTO ${s.auto} pts · ${auto ? 'first 30s · provisional' : 'locked'}<br>Leave wall ${s.leave}/${robots} · Return to loading ${s.autoPark}/${robots} · Tips ${s.autoTips}</div>
      <div class="score-rp">${progress('SWARM', s.swarmPoints, 16)}${progress('P1 tips', s.tips, 4)}${progress('P2 tips', s.tips, 7)}</div>
      <div class="score-details">
        <dl><dt>AUTO leave wall · ${s.leave} × 3</dt><dd>${s.leave * 3}</dd>
        <dt>AUTO return to loading · ${s.autoPark} × 5</dt><dd>${s.autoPark * 5}</dd>
        <dt>AUTO hive tips · ${s.autoTips} × 20</dt><dd>${s.autoTips * 20}</dd>
        <dt>TELEOP hive tips · ${s.tips - s.autoTips} × 20</dt><dd>${(s.tips - s.autoTips) * 20}</dd>
        <dt>End park · ${s.teleopPark} × 5${ended ? '' : ' (preview)'}</dt><dd>${s.teleopPark * 5}</dd>
        <dt>Remaining in cell · ${s.cellBalls} × 2</dt><dd>${s.cellBalls * 2}</dd>
        <dt>Garden · ${s.garden} × 1</dt><dd>${s.garden}</dd>
        <dt>Flowers</dt><dd>Not simulated</dd></dl>
        <p>LEAVE and AUTO PARK lock at 0:30 elapsed. End park, cell and garden points are previews until the match ends and pieces settle.</p>
        <p>SWARM: 16 combined leave + AUTO park + end park points. POLLINATOR 1/2: 4/7 tips. Each earns 1 RP; win/tie RP excluded.</p>
        <p>${robots === 1 ? 'Solo practice: SWARM requires an alliance partner. ' : 'Includes your simulated alliance partner. '}${infinite ? 'Infinite ammo enabled. ' : ''}Flower points and penalties are not simulated. The clock skips the official 8-second AUTO transition.</p>
        <a href="https://ftc-resources.firstinspires.org/ftc/archive/2027/game/manual-10" target="_blank" rel="noopener noreferrer">TU03 scoring · All Other Events thresholds ↗</a>
      </div>`;
  }
}
