import { type AppState } from '../state';
import { clonePreset } from '../robot/presets';
import { CAMERA_PRESETS, presetById } from '../camera/cameraPresets';
import { intrinsicsFor } from '../robot/robot';
import { setStartSide, startSideOf } from '../sim/starts';
import { ConfigHistory, captureConfig, type ConfigSnapshot } from './configHistory';
import { el, type Change, type Panel } from './panel';
import type { RuntimeLink } from '../runtime/link';
import type { Input } from '../sim/input';
import type { Recorder } from '../runtime/recorder';

type Task = 'practice' | 'teamcode' | 'analyze' | 'setup' | 'settings';
type Analysis = 'shots' | 'cameras' | 'replay' | 'calibration';
interface Preferences { task: Task; analysis: Analysis; pins: string[]; welcome: boolean }
const PREFS = 'biobuzz-workspace-v1';
const TITLES: Record<Task, string> = { practice: 'Practice', teamcode: 'Run TeamCode', analyze: 'Tune', setup: 'Robot setup', settings: 'All settings' };
const DESCRIPTIONS: Record<Task, string> = {
  practice: 'Explore the field. Aim, shoot, and try again.',
  teamcode: 'Run your robot program in the simulated field.',
  analyze: 'Tune the launcher and cameras, calibrate shots, and review recorded runs.',
  setup: 'Match the twin to your robot. Exact controls are always available.',
  settings: 'Search every control, or pin the ones you use most.',
};
const GROUPS: Record<string, string[]> = {
  Launcher: ['Motor & flywheel', 'Geometry', 'Shot variability', 'Physics'],
  Cameras: ['Lens & resolution'],
  Robot: ['Dimensions & drive'],
  'Field & target': ['Hive physics', 'Game pieces', 'Starting positions'],
  'Hardware map': ['Devices & roles'],
  'Runtime — run your TeamCode': ['Connection & diagnostics'],
  'View & overlays': ['Overlay details'],
  'Settings & session': ['Import, export & reset'],
};
const button = (label: string, action: () => void, cls = '') => el('button', { type: 'button', class: cls, onclick: action }, label);
const heading = (text: string) => el('h2', {}, text);

export class Workspace {
  private prefs: Preferences;
  private root = document.getElementById('panel')!;
  private canvas = document.getElementById('view')!;
  private header = el('header', { id: 'workspace-header' });
  private dock = el('section', { id: 'control-dock', 'aria-label': 'Robot controls' });
  private timeline = el('section', { id: 'replay-dock', 'aria-label': 'Replay timeline', hidden: '' });
  private changingWorkspace = false;
  private sectionOpen = new Map<string, boolean>();
  private detailBackup?: { pip: boolean; stadium: boolean; hitmap: boolean; reach: boolean };
  private compass = el('div', { id: 'drive-compass', 'aria-label': 'Driving direction' }, el('span', { class: 'compass-arrow' }, '↑'), el('span', { class: 'compass-label' }));
  private quick = el('div', { id: 'quick-controls', 'aria-label': 'Quick simulation controls' });
  private legend = el('div', { id: 'map-legend' });
  private markers = el('div', { id: 'field-markers', 'aria-hidden': 'true' });
  private robotMarker = el('span', { class: 'field-marker robot-marker' }, 'Your robot');
  private targetMarker = el('span', { class: 'field-marker target-marker' }, 'Your target');
  private notice = el('div', { id: 'workspace-notice', role: 'status', 'aria-live': 'polite' });
  private history = new ConfigHistory();
  private pending?: ConfigSnapshot;
  private search = '';
  private changedOnly = false;
  private baseline = new Map<string, string>();
  private groupOpen = new Set<string>();
  private sample?: ConfigSnapshot;
  private sampleState?: Pick<AppState, 'pose' | 'alliance' | 'hive' | 'infiniteAmmo' | 'opponents' | 'settingsAutoLoad' | 'selectedCameraId'>;
  private tutorial = 0;
  private tutorialOrigin?: { x: number; z: number };
  private startup?: { phase: string; message: string; startedAt: number };
  private lastStatus = '';
  private lastUpdate = 0;
  private state: AppState;
  private panel: Panel;
  private link: RuntimeLink;
  private input: Input;
  private change: Change;
  constructor(state: AppState, panel: Panel, link: RuntimeLink, input: Input, change: Change) {
    if (new URLSearchParams(location.search).get('sim') === '1') {
      const pollStartup = async () => {
        try {
          const response = await fetch('/__sim/status', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
          const data = response.ok ? await response.json() : undefined;
          this.startup = data && typeof data.phase === 'string' && typeof data.message === 'string' && Number.isFinite(data.startedAt) ? data : undefined;
        } catch { this.startup = undefined; }
      };
      void pollStartup(); setInterval(() => { void pollStartup(); }, 1500);
    }
    this.state = state; if (state.overlays.hitmap && state.overlays.reach) state.overlays.reach = false; this.panel = panel; this.link = link; this.input = input; this.change = change;
    let saved: Partial<Preferences> = {};
    try { saved = JSON.parse(localStorage.getItem(PREFS) ?? '{}'); } catch { /* new profile */ }
    try {
      const backup = JSON.parse(sessionStorage.getItem('biobuzz-sample-backup') ?? 'null');
      if (backup?.config && backup?.state) { this.sample = backup.config; this.sampleState = backup.state; this.tutorial = 4; }
    } catch { /* no recoverable sample */ }
    const task = new URLSearchParams(location.search).get('runtime') === '1' ? 'teamcode' : saved.task;
    this.prefs = { task: task && task in TITLES ? task : 'practice', analysis: ['shots', 'cameras', 'replay', 'calibration'].includes(saved.analysis ?? '') ? saved.analysis! : 'shots', pins: Array.isArray(saved.pins) ? saved.pins : [], welcome: saved.welcome ?? true };
    this.markers.append(this.robotMarker, this.targetMarker);
    document.getElementById('app')!.append(this.header, this.compass, this.quick, this.dock, this.timeline, this.legend, this.markers, this.notice);
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Simulation field. Click or focus here to drive. WASD moves, Q and E turn. R aims and Space shoots in manual control. Tab leaves the field.');
    this.canvas.addEventListener('pointerdown', () => this.canvas.focus({ preventScroll: true }));
    document.addEventListener('panel-visibility', () => this.updateLayout());
    // Capture the values before an explicit user edit, including edits in the settings dialog.
    for (const event of ['change', 'click']) document.addEventListener(event, e => {
      const target = e.target as HTMLElement;
      if (!target.closest('#panel, .settings-dialog') || target.closest('.history-actions, .pin-control, .workspace-toolbar, .workspace-tabs')) return;
      if (event === 'click' && !target.closest('button')) return;
      this.pending ??= captureConfig(this.state);
      setTimeout(() => this.finishEdit(), 0);
    }, true);
    document.addEventListener('open-twin-setting', e => {
      const key = String((e as CustomEvent).detail);
      this.navigate('settings');
      this.search = /camera/.test(key) ? 'Cameras' : /launcher/.test(key) ? 'Launcher' : /hardware|motor/.test(key) ? 'Hardware map' : /alliance|start/.test(key) ? 'Field & target' : 'Robot';
      this.panel.render();
    });
    this.panel.beforeRender = () => { if (this.changingWorkspace || !this.root.querySelector('.workspace-heading')) return; this.root.querySelectorAll<HTMLDetailsElement>('.advanced-group[data-group]').forEach(d => { if (d.open) this.groupOpen.add(d.dataset.group!); else this.groupOpen.delete(d.dataset.group!); }); this.root.querySelectorAll<HTMLDetailsElement>('details[data-title]:not([hidden])').forEach(d => this.sectionOpen.set(`${this.task}/${this.prefs.analysis}/${d.dataset.title}`, d.open)); };
    this.panel.decorate = () => this.decorate();
    this.header.addEventListener('keydown', e => { if (e.key === 'Escape') this.canvas.focus(); });
    this.root.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { this.root.classList.add('hidden'); this.updateLayout(); this.canvas.focus(); } });
    this.buildHeader();
    this.panel.render();
    this.updateLayout();
  }
  get task() { return this.prefs.task; }
  tutorialAction(action: 'aim' | 'shoot') { if (this.tutorial) { this.tutorial = action === 'aim' ? 3 : 4; this.panel.render(); } }
  private savePrefs() { localStorage.setItem(PREFS, JSON.stringify(this.prefs)); }
  private finishEdit() {
    if (!this.pending) return;
    this.history.record(this.pending, captureConfig(this.state)); this.pending = undefined;
    this.refreshHistoryButtons();
  }
  private refreshHistoryButtons() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-history]').forEach(b => b.disabled = b.dataset.history === 'undo' ? !this.history.canUndo : !this.history.canRedo);
  }
  private applyHistory(redo = false) {
    this.pending = undefined;
    if (redo) this.history.redo(this.state); else this.history.undo(this.state);
    for (const kind of ['reset', 'sim', 'hardware', 'assets'] as const) this.change(kind);
    this.panel.render(); this.say(redo ? 'Configuration edit restored.' : 'Configuration edit undone. Live field position is unchanged.');
  }
  navigate(task: Task, analysis?: Analysis) {
    this.panel.beforeRender?.();
    this.changingWorkspace = true;
    this.prefs.task = task;
    if (analysis) this.prefs.analysis = analysis;
    this.search = ''; this.changedOnly = false;
    if (task === 'settings') this.root.querySelectorAll<HTMLDetailsElement>('details[data-title]').forEach(d => d.open = false);
    this.savePrefs(); this.root.classList.remove('hidden');
    this.buildHeader(); this.panel.render(); this.changingWorkspace = false; this.root.scrollTop = 0; this.updateLayout();
  }
  private buildHeader() {
    this.header.replaceChildren(
      el('div', { class: 'brand-lockup' },
        // title line: official BIOBUZZ mark + our "Digital Twin"; presented-by line below; the team logo closes the lockup, spanning both lines
        el('div', { class: 'brand-lines' },
          el('div', { class: 'brand' },
            el('a', { class: 'season-link', href: 'https://ftc.game', target: '_blank', rel: 'noopener noreferrer', title: 'BIOBUZZ, the 2026-27 FIRST Tech Challenge game — official game site', 'aria-label': 'BIOBUZZ official game site' },
              el('img', { class: 'season-hex', src: `${import.meta.env.BASE_URL}biobuzz-hex.png`, alt: '', height: '30' }),
              el('img', { class: 'season-wordmark', src: `${import.meta.env.BASE_URL}biobuzz-wordmark.png`, alt: 'BIOBUZZ', height: '18' })),
            el('a', { class: 'twin-word', href: '#', 'aria-label': 'Digital Twin — practice workspace', onclick: (e: Event) => { e.preventDefault(); this.navigate('practice'); } }, 'Digital Twin')),
          el('a', { class: 'team-credit', href: 'https://camelshumpcoders.org', target: '_blank', rel: 'noopener noreferrer' },
            el('small', {}, 'Presented by '), el('strong', {}, 'Camels Hump Coders #36682'))),
        el('a', { class: 'team-mark', href: 'https://camelshumpcoders.org', target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Camels Hump Coders #36682 — visit team website' },
          el('img', { src: `${import.meta.env.BASE_URL}chc-logo.png`, alt: 'Camels Hump Coders logo', width: '54', height: '54' })),
      ),
      el('nav', { class: 'workspace-tabs', 'aria-label': 'Workspace' }, ...(['practice', 'teamcode', 'analyze'] as Task[]).map(task => el('button', { class: this.task === task ? 'active' : '', 'aria-current': this.task === task ? 'page' : undefined, onclick: () => this.navigate(task) }, TITLES[task]))),
      el('div', { class: 'header-tools' }, button('Robot setup', () => this.navigate('setup'), this.task === 'setup' ? 'active' : ''), button('All settings', () => this.navigate('settings'), this.task === 'settings' ? 'active' : ''), button('Help', () => this.help()), button('About', () => this.panel.openAbout()), button('Hide sidebar', () => this.panel.toggle(), 'panel-toggle')),
    );
  }
  private updateLayout() {
    document.body.dataset.workspace = this.task;
    document.body.dataset.analysis = this.prefs.analysis;
    document.body.classList.toggle('panel-hidden', this.root.classList.contains('hidden'));
    document.body.classList.toggle('wide-workspace', this.task === 'analyze' && this.prefs.analysis === 'calibration');
    const b = this.header.querySelector('.panel-toggle');
    const visible = !this.root.classList.contains('hidden');
    if (b) {
      b.textContent = visible ? 'Hide sidebar' : 'Show sidebar';
      b.setAttribute('aria-expanded', String(visible));
      b.setAttribute('aria-controls', 'panel');
      b.setAttribute('title', `${visible ? 'Hide' : 'Show'} the ${TITLES[this.task]} sidebar`);
      b.classList.toggle('active', visible);
    }
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
  private say(message: string) { this.notice.textContent = message; setTimeout(() => { if (this.notice.textContent === message) this.notice.textContent = ''; }, 6000); }
  /** Give the field keyboard focus without hiding the panel (used when TeamCode starts so controls reach the robot). */
  focusKeyboard(message?: string) {
    if (document.querySelector('dialog[open]')) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active !== this.canvas && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return; // never steal a field being typed in
    this.canvas.focus({ preventScroll: true });
    requestAnimationFrame(() => this.canvas.focus({ preventScroll: true }));
    if (message) this.say(message);
  }
  focusField() {
    if (document.querySelector('dialog[open]')) return;
    this.root.classList.add('hidden'); this.updateLayout();
    this.canvas.focus({ preventScroll: true });
    requestAnimationFrame(() => this.canvas.focus({ preventScroll: true }));
    this.say(this.recorder?.cursor !== undefined ? 'Field focused. Return to live to drive.' : this.link.running ? 'Field focused. Keyboard controls the selected gamepad.' : 'Field focused. WASD to drive; Q/E to turn.');
  }
  private help() {
    const d = el('dialog', { class: 'workspace-dialog', 'aria-label': 'Getting started' });
    d.append(heading('Your first lap'), el('p', {}, 'Choose an activity, then click the field to give it keyboard control. Tab returns to the interface. Your keyboard never drives while you edit a setting.'),
      el('dl', { class: 'shortcut-list' }, ...[['W A S D', 'Move the robot'], ['Q / E', 'Turn'], ['R / Space', 'Aim / shoot in manual control'], ['1 / 2 / 3 / 4', 'Orbit / top / chase / camera view'], ['Shift + click', 'Place the robot on the mat'], ['Escape', 'Leave controls and focus the field']].flatMap(([key, text]) => [el('dt', {}, key), el('dd', {}, text)])),
      el('p', {}, 'When TeamCode is running, keys emulate the selected gamepad. Space sends A; your program decides what A does.'),
      el('div', { class: 'row' }, button('Try a sample setup', () => { d.close(); this.trySample(); }, 'primary'), button('Close', () => d.close())));
    d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal();
  }
  private trySample() {
    if (this.link.running || this.link.status === 'INIT') { this.say('Stop TeamCode before trying the sample setup.'); return; }
    if (!this.sample) {
      this.sample = captureConfig(this.state);
      this.sampleState = structuredClone({ pose: this.state.pose, alliance: this.state.alliance, hive: this.state.hive, infiniteAmmo: this.state.infiniteAmmo, opponents: this.state.opponents, settingsAutoLoad: this.state.settingsAutoLoad, selectedCameraId: this.state.selectedCameraId });
      sessionStorage.setItem('biobuzz-sample-backup', JSON.stringify({ config: this.sample, state: this.sampleState }));
    }
    this.state.robotPresetId = 'starterbotMecanum'; this.state.robot = clonePreset('starterbotMecanum');
    this.state.selectedCameraId = this.state.robot.cameras[0]?.id ?? '';
    this.state.alliance = 'red'; this.state.hive.red = 'audience';
    this.state.pose = { x: -1.55, z: 1.6, heading: 0 }; this.state.opponents = false;
    this.state.autoRpm = true; this.state.infiniteAmmo = true; this.state.autoHood = false;
    this.state.settingsAutoLoad = false;
    this.tutorial = 1; this.tutorialOrigin = { ...this.state.pose };
    this.change('reset'); this.change('sim'); this.navigate('practice');
    this.canvas.focus(); this.say('Sample loaded. Your previous configuration is kept until you restore it.');
  }
  private restoreSample() {
    if (!this.sample || !this.sampleState) return;
    if (this.link.running || this.link.status === 'INIT') { this.say('Stop TeamCode before restoring your setup.'); return; }
    Object.assign(this.state, structuredClone(this.sample));
    const { hive, ...rest } = this.sampleState; Object.assign(this.state, rest); Object.assign(this.state.hive, hive);
    // Auto outputs are omitted from history snapshots; fill them before rebuilding geometry.
    this.state.robot.launcher.rpm ??= 0;
    this.state.robot.launcher.elevationDeg ??= 55;
    this.sample = undefined; this.sampleState = undefined; this.tutorial = 0; sessionStorage.removeItem('biobuzz-sample-backup');
    this.change('reset'); this.change('sim'); this.change('hardware'); this.change('assets'); this.panel.render();
    this.say('Your configuration and position have been restored.');
  }
  private get recorder(): Recorder | undefined { return this.panel.recorder; }
  private returnLive() { if (this.recorder) this.recorder.cursor = undefined; this.panel.refreshTimeline(); this.update(0, true); }
  private modify(action: () => void, what: Parameters<Change>[0]) {
    const before = captureConfig(this.state); action(); this.change(what); this.history.record(before, captureConfig(this.state)); this.panel.render();
  }
  private startControls() {
    const box = el('div', { class: 'start-controls', 'aria-label': 'Alliance and start' }, el('span', { class: 'eyebrow' }, 'STARTING SETUP'));
    const alliances = el('div', { class: 'row', role: 'group', 'aria-label': 'Alliance' });
    for (const alliance of ['red', 'blue'] as const) {
      const b = el('button', { 'aria-pressed': String(this.state.alliance === alliance), class: `alliance-${alliance}`, onclick: () => { this.state.alliance = alliance; this.state.placeAtStartRequest = true; this.change('sim'); this.panel.render(); } }, alliance === 'red' ? 'Red alliance' : 'Blue alliance');
      b.disabled = this.link.running || this.recorder?.cursor !== undefined; alliances.append(b);
    }
    const starts = el('div', { class: 'row', role: 'group', 'aria-label': 'Start square' });
    const current = startSideOf(this.state.starts, this.state.alliance, this.state.hive);
    for (const side of ['loading', 'far'] as const) {
      const b = el('button', { 'aria-pressed': String(current === side), onclick: () => { setStartSide(this.state.starts, side); this.state.placeAtStartRequest = true; this.change('sim'); this.panel.render(); } }, side === 'loading' ? 'Loading zone' : 'Far side');
      b.disabled = this.link.running || this.recorder?.cursor !== undefined; starts.append(b);
    }
    box.append(alliances, starts); return box;
  }
  /** Hood angle and camera field of view, first-class in Practice: the two knobs whose effect on the hit map and on
   *  AprilTag visibility a new user should see before anything else. Bounded sliders; the full controls stay in the
   *  Launcher and Cameras sections. */
  private experimentCard() {
    const l = this.state.robot.launcher;
    const card = el('div', { class: 'experiment', 'aria-label': 'Experiment: robot, hood and camera' }, el('span', { class: 'eyebrow' }, 'EXPERIMENT'));
    // the first big choice: how the robot moves. Both are goBILDA StarterBots, so everything else stays comparable.
    const bots = el('div', { class: 'row', role: 'group', 'aria-label': 'StarterBot drivetrain' });
    for (const [id, label] of [['starterbotMecanum', 'Mecanum'], ['starterbot6wd', '6-wheel tank']] as const) {
      const active = this.state.robotPresetId === id;
      const b = el('button', { class: active ? 'bot-choice active' : 'bot-choice', 'aria-pressed': String(active), title: active ? 'This is the robot on the field' : `Switch the robot on the field to the ${label} StarterBot`, onclick: () => { if (this.state.robotPresetId === id) return; this.modify(() => { this.state.robotPresetId = id; this.state.robot = clonePreset(id); this.state.selectedCameraId = this.state.robot.cameras[0]?.id ?? ''; }, 'robot'); if (this.tutorial === 6) this.tutorial = 7; } }, active ? `✓ ${label} · on the field` : label);
      b.disabled = this.link.running || this.recorder?.cursor !== undefined; bots.append(b);
    }
    card.append(el('div', { class: 'range-row' }, el('label', {}, 'StarterBot drivetrain')), bots,
      el('p', { class: 'note' }, this.state.robot.drivetrain === 'mecanum'
        ? 'Mecanum: strafes with A / D and lines up on the cell without turning, but its rollers give a little when pushed. Switch to the 6-wheel tank to feel the difference.'
        : '6-wheel tank: no strafing (A / D turn), so you line up by turning and driving, but it holds its ground when pushed and climbs the loading-zone edge more surely. Switch to mecanum to compare.'));
    const hoodVal = el('b', {}, `${l.elevationDeg.toFixed(1)}°`);
    const hood = el('input', { type: 'range', min: '0', max: '89', step: '0.5', value: String(l.elevationDeg), 'aria-label': 'Hood angle (degrees)' }) as HTMLInputElement;
    const before = { config: captureConfig(this.state) };
    hood.oninput = () => { const v = Math.min(89, Math.max(0, parseFloat(hood.value))); l.elevationDeg = v; if (l.elevationMinDeg === l.elevationMaxDeg) l.elevationMinDeg = l.elevationMaxDeg = v; hoodVal.textContent = `${v.toFixed(1)}°`; this.change('launcher'); if (this.tutorial === 4) this.tutorial = 5; };
    hood.onchange = () => { this.history.record(before.config, captureConfig(this.state)); before.config = captureConfig(this.state); this.panel.render(); };
    card.append(el('div', { class: 'range-row' }, el('label', {}, 'Hood angle'), hoodVal), hood,
      el('p', { class: 'note' }, 'Too flat or too steep and nothing scores from anywhere; in between there is a sweet spot. Watch the hit chance tile and the hit map as you slide.'));
    const cam = this.state.robot.cameras.find(c => c.id === this.state.selectedCameraId) ?? this.state.robot.cameras[0];
    if (cam) {
      const sel = el('select', { 'aria-label': 'Camera model' }) as HTMLSelectElement;
      for (const p of CAMERA_PRESETS) sel.append(el('option', { value: p.id, ...(p.id === cam.presetId ? { selected: '' } : {}) }, p.name));
      sel.onchange = () => this.modify(() => { cam.presetId = sel.value; cam.diagFovDeg = undefined; cam.hfovDeg = undefined; cam.width = undefined; cam.height = undefined; }, 'cameras');
      const intr = intrinsicsFor(cam);
      const diag = cam.diagFovDeg ?? (Math.atan(Math.hypot(Math.tan(intr.hfov / 2), Math.tan(intr.vfov / 2))) * 2 * 180) / Math.PI;
      const fovVal = el('b', {}, `${diag.toFixed(0)}° diagonal`);
      const fov = el('input', { type: 'range', min: '30', max: '160', step: '1', value: String(Math.round(diag)), 'aria-label': 'Camera diagonal field of view (degrees)' }) as HTMLInputElement;
      fov.oninput = () => {
        // a hand-set field of view makes this a Custom camera (keeping the resolution it had), so the picker says so
        const v = parseFloat(fov.value);
        if (cam.presetId !== 'custom') { const was = intrinsicsFor(cam); cam.width = was.width; cam.height = was.height; cam.presetId = 'custom'; sel.value = 'custom'; }
        cam.diagFovDeg = v; cam.hfovDeg = undefined; fovVal.textContent = `${v.toFixed(0)}° diagonal`; this.change('cameras'); if (this.tutorial === 4) this.tutorial = 5;
      };
      fov.onchange = () => { this.history.record(before.config, captureConfig(this.state)); before.config = captureConfig(this.state); this.panel.render(); };
      card.append(el('div', { class: 'range-row' }, el('label', {}, `Camera · ${cam.name}`), sel), el('div', { class: 'range-row' }, el('label', {}, 'Field of view'), fovVal), fov,
        el('p', { class: 'note' }, `Wider sees more of the field but each AprilTag gets fewer pixels; narrower reads tags further away but loses them sooner when you turn. ${cam.presetId === 'custom' ? 'Pick a real camera to go back to its own lens.' : `Sliding makes this a Custom camera; ${presetById(cam.presetId).name} itself is ${presetById(cam.presetId).diagFovDeg ?? presetById(cam.presetId).hfovDeg}°.`} Watch the camera preview and the AprilTags row.`));
      // mount: where the camera looks decides which tags it can see at all
      const pitchVal = el('b', {}, `${cam.pitchDeg.toFixed(0)}° ${cam.pitchDeg >= 0 ? 'down' : 'up'}`);
      const pitch = el('input', { type: 'range', min: '-60', max: '60', step: '1', value: String(cam.pitchDeg), 'aria-label': 'Camera mount pitch (degrees, positive down)' }) as HTMLInputElement;
      pitch.oninput = () => { const v = parseFloat(pitch.value); cam.pitchDeg = v; pitchVal.textContent = `${v.toFixed(0)}° ${v >= 0 ? 'down' : 'up'}`; this.change('cameras'); if (this.tutorial === 5) this.tutorial = 6; };
      pitch.onchange = () => { this.history.record(before.config, captureConfig(this.state)); before.config = captureConfig(this.state); this.panel.render(); };
      const heightVal = el('b', {}, `${(cam.heightM / 0.0254).toFixed(1)} in`);
      const height = el('input', { type: 'range', min: '2', max: '29', step: '0.5', value: String(cam.heightM / 0.0254), 'aria-label': 'Camera mount height (inches)' }) as HTMLInputElement;
      height.oninput = () => { const v = parseFloat(height.value); cam.heightM = v * 0.0254; heightVal.textContent = `${v.toFixed(1)} in`; this.change('cameras'); if (this.tutorial === 5) this.tutorial = 6; };
      height.onchange = () => { this.history.record(before.config, captureConfig(this.state)); before.config = captureConfig(this.state); this.panel.render(); };
      card.append(el('div', { class: 'range-row' }, el('label', {}, 'Mount pitch'), pitchVal), pitch, el('div', { class: 'range-row' }, el('label', {}, 'Mount height'), heightVal), height,
        el('p', { class: 'note' }, 'Tilt down to keep the near tags and the floor in view; tilt up (or mount higher) to see the raised cell\u2019s tags from across the field. The camera preview and the viewing cone on the field show what changes.'));
    }
    return card;
  }
  private practiceCard() {
    const box = el('section', { class: 'task-card' }, el('span', { class: 'eyebrow' }, 'FREE PRACTICE'), heading('Make your first shot'), el('p', {}, 'Click the field to drive. Aim toward the highlighted cell, then launch a ball.'));
    const disabled = this.link.running || this.recorder?.cursor !== undefined;
    const aim = button('Aim at target · R', () => { this.state.aimRequest = true; if (this.tutorial) { this.tutorial = 3; this.panel.render(); } this.canvas.focus(); }, 'primary');
    const shoot = button('Shoot · Space', () => { this.state.shootRequest = true; if (this.tutorial) { this.tutorial = 4; this.panel.render(); } this.canvas.focus(); });
    aim.disabled = disabled; shoot.disabled = disabled;
    box.append(el('div', { class: 'practice-actions' }, aim, shoot), el('p', { class: 'note' }, disabled ? 'Manual actions are unavailable during TeamCode control or replay.' : this.state.robot.drivetrain === 'tank' ? 'W / S drive · A / D or Q / E turn (tank drive cannot strafe) · Shift for more speed' : 'WASD move · Q / E turn · Shift for more speed'),
      el('div', { class: 'row' }, button('Focus field to drive', () => this.focusField()), button('Reset position', () => { if (this.link.running || this.recorder?.cursor !== undefined) return; this.state.placeAtStartRequest = true; this.change('sim'); this.canvas.focus(); })));
    box.querySelectorAll<HTMLButtonElement>('button').forEach(b => { if (b.textContent === 'Reset position') b.disabled = disabled; });
    box.append(this.startControls());
    box.append(this.experimentCard());
    if (this.sample) box.append(el('div', { class: 'sample-banner' }, el('b', {}, 'Sample setup active'), el('p', {}, ['','1 / 7 · Move a little with WASD.','2 / 7 · Aim toward the highlighted target.','3 / 7 · Shoot and watch the flight.','4 / 7 · Try another position. Tune adjusts the launcher; the field overlay explains your shot.','5 / 7 · Experiment below: slide the hood angle and watch the hit chance and hit map move, then change the camera and its field of view and watch which AprilTags stay in view.','6 / 7 · Now tilt the camera mount and change its height: the viewing cone on the field and the AprilTags row show which tags you can still see.','7 / 7 · Finally switch the StarterBot drivetrain between mecanum and 6-wheel tank and drive a lap of each: strafing versus turning is the biggest design choice on the robot.'][this.tutorial] || 'Explore at your own pace.'), button('Restore my setup', () => this.restoreSample()), button('Tune this shot', () => this.navigate('analyze', 'shots'))));
    else box.append(button('Try a sample setup', () => this.trySample(), 'text-button'));
    return box;
  }
  decorate() {
    // Sections are the original controls, moved into contextual layouts. No shadow copies of settings.
    const sections = [...this.root.querySelectorAll<HTMLDetailsElement>(':scope > details[data-title]')];
    const legacy = [...this.root.children].filter(e => !e.matches('details[data-title]'));
    legacy.forEach(e => e.remove());
    sections.forEach(e => e.remove());
    this.timeline.replaceChildren(); this.timeline.hidden = true;
    const top = el('div', { class: 'workspace-heading' }, el('span', { class: 'eyebrow' }, this.task === 'setup' ? 'CONFIGURATION' : 'WORKSPACE'), heading(TITLES[this.task]), el('p', {}, DESCRIPTIONS[this.task]));
    this.root.prepend(top);
    if (this.sample && this.task !== 'practice') top.append(el('div', { class: 'sample-banner' }, 'Sample setup active · restore your team setup before saving.', button('Restore my setup', () => this.restoreSample())));
    if (this.prefs.welcome && this.task === 'practice') {
      const welcome = el('section', { class: 'welcome-card' }, el('b', {}, 'A field to experiment in.'), el('p', {}, 'Start with a sample robot, or use your own configuration. Every advanced control is still in All settings.'), el('div', { class: 'row' }, button('Show me how', () => this.trySample(), 'primary'), button('Dismiss', () => { this.prefs.welcome = false; this.savePrefs(); this.panel.render(); })));
      top.after(welcome);
    }
    const history = el('div', { class: 'history-actions', 'aria-label': 'Configuration history' }, el('button', { 'data-history': 'undo', onclick: () => this.applyHistory() }, '↶ Undo edit'), el('button', { 'data-history': 'redo', onclick: () => this.applyHistory(true) }, '↷ Redo'));
    this.root.append(history);
    if (this.task === 'practice') history.before(this.practiceCard());
    if (this.task === 'teamcode') history.before(el('section', { class: 'runtime-guidance task-card', role: 'status', 'aria-live': 'polite' }), this.startControls());
    if (this.task === 'analyze') {
      const tabs = el('nav', { class: 'analysis-tabs', 'aria-label': 'Tuning view' }, ...(['shots', 'cameras', 'replay', 'calibration'] as Analysis[]).map(a => el('button', { class: this.prefs.analysis === a ? 'active' : '', 'aria-current': this.prefs.analysis === a ? 'page' : undefined, onclick: () => this.navigate('analyze', a) }, a[0].toUpperCase() + a.slice(1))));
      top.after(tabs);
    }
    if (this.task === 'settings') {
      const search = el('input', { type: 'search', placeholder: 'Find a setting, e.g. hood, camera, motor…', 'aria-label': 'Search all settings', value: this.search });
      search.oninput = () => { this.search = search.value; this.filterSettings(); };
      const changed = el('button', { 'aria-pressed': String(this.changedOnly), onclick: () => { this.changedOnly = !this.changedOnly; changed.setAttribute('aria-pressed', String(this.changedOnly)); this.filterSettings(); } }, 'Changed this visit');
      history.before(el('div', { class: 'workspace-toolbar' }, search, changed, el('p', { class: 'note' }, 'Search opens matching sections. Pin a field for quick access. Reset returns to its first value this visit.')));
    }
    const allowed: Record<Task, string[]> = {
      practice: ['Field & target'], teamcode: ['Runtime — run your TeamCode', 'TeamCode settings (assets)', 'Hardware map'],
      analyze: this.prefs.analysis === 'shots' ? ['Launcher'] : this.prefs.analysis === 'cameras' ? ['Cameras'] : this.prefs.analysis === 'replay' ? ['Timeline & logs'] : ['Shooter calibration'],
      setup: ['Robot', 'Launcher', 'Cameras', 'Hardware map', 'Settings & session'], settings: sections.map(s => s.dataset.title!),
    };
    this.root.append(...sections);
    for (const section of sections) {
      const title = section.dataset.title!;
      this.refineSection(section, title);
      const visible = allowed[this.task].includes(title);
      section.hidden = !visible;
      const openKey = `${this.task}/${this.prefs.analysis}/${title}`;
      if (visible && this.task !== 'settings') section.open = this.sectionOpen.get(openKey) ?? !['Hardware map', 'Settings & session', ...(this.task === 'practice' ? ['Field & target'] : [])].includes(title);
      section.addEventListener('toggle', () => { if (section.isConnected && visible) this.sectionOpen.set(openKey, section.open); });
      if (title === 'Timeline & logs' && this.task === 'analyze' && this.prefs.analysis === 'replay') {
        this.timeline.append(section); this.timeline.hidden = false;
        const events = section.querySelector<HTMLElement>('.tl-events');
        if (events) this.root.append(el('section', { class: 'replay-log' }, heading('Events & telemetry'), events));
        const telemetry = sections.find(s => s.dataset.title === 'Runtime — run your TeamCode')?.querySelector('.telemetry-box');
        if (telemetry) this.root.querySelector('.replay-log')?.append(telemetry);

        history.before(el('section', { class: 'task-card' }, heading('Review a recorded moment'), el('p', {}, 'Use the timeline below the field. Replay pauses the simulation; Return to live resumes it.'), button('Return to live', () => this.returnLive(), 'primary'), el('p', { class: 'note' }, 'Logs and telemetry belong to the selected moment. Driving keys cannot silently leave replay.')));
      }
    }
    if (this.link.connected) {
      const saves = el('section', { class: 'connection-saves', 'aria-label': 'Project sync and save' });
      const config = this.root.querySelector<HTMLElement>('.robot-config-sync');
      if (config) saves.append(config);
      else saves.append(el('section', { class: 'robot-config-sync' }, el('b', {}, 'Robot configuration'), el('p', { class: 'note' }, 'Waiting for the host to report its configuration file.')));
      const assets = sections.find(s => s.dataset.title === 'TeamCode settings (assets)');
      if (assets) {
        const card = el('section', { class: 'teamcode-sync' }, el('b', {}, 'TeamCode settings'));
        const body = assets.querySelector<HTMLElement>(':scope > .body')!;
        for (const child of [...body.children]) card.append(child);
        assets.hidden = true; saves.append(card);
      } else saves.append(el('section', { class: 'teamcode-sync' }, el('b', {}, 'TeamCode settings'), el('p', { class: 'note' }, 'No settings assets reported by the host.')));
      const guidance = this.root.querySelector('.runtime-guidance');
      if (guidance) guidance.after(saves); else top.after(saves);
    }
    if (this.task === 'teamcode') {
      const telemetry = this.root.querySelector<HTMLElement>('.telemetry-box');
      if (telemetry) this.root.querySelector('.runtime-guidance')?.after(
        el('section', { class: 'runtime-logs task-card', 'aria-label': 'Logs and telemetry' }, heading('Logs & telemetry'), telemetry),
      );
    }
    if (this.task === 'teamcode' && !this.link.connected && new URLSearchParams(location.search).get('sim') !== '1') history.before(el('section', { class: 'task-card' }, heading('Connect your TeamCode'), el('p', {}, 'In this project’s terminal, start the local host:'), el('code', {}, 'pnpm sim --team /path/to/FtcRobotController'), el('p', {}, 'The connection retries automatically. Host address and diagnostics are below.')));
    if (this.task === 'setup') history.before(el('div', { class: 'row setup-links' }, button('Calibrate launcher', () => this.navigate('analyze', 'calibration')), button('TeamCode settings', () => { this.navigate('teamcode'); if (this.link.connected && this.link.assets.length) this.panel.openAssetDialog(); else this.say('Connect your runtime host and load a program with settings assets to open the editor.'); })));
    this.addPinned(sections, history);
    const view = this.buildViewTools(); this.root.append(view);
    this.root.append(el('footer', { class: 'workspace-footer' }, button('Settings & files', () => { this.navigate('settings'); this.panel.openSection('Settings & session'); const s = this.root.querySelector<HTMLDetailsElement>('[data-title="Settings & session"]'); if (s) { s.open = true; s.scrollIntoView({ block: 'start' }); } })));
    this.refreshHistoryButtons(); this.filterSettings(); this.updateLayout(); this.update(0, true);
  }
  private refineSection(section: HTMLDetailsElement, title: string) {
    const body = section.querySelector<HTMLElement>(':scope > .body')!;
    body.classList.remove('adv-hidden'); body.querySelector(':scope > .more')?.remove();
    const advanced = [...body.querySelectorAll<HTMLElement>(':scope > .adv')];
    const groups = new Map<string, HTMLDetailsElement>();
    const groupFor = (name: string) => {
      if (title === 'Launcher') return /noise|error|variation|Monte Carlo|sigma|variability/i.test(name) ? 'Shot variability' : /drag|spin|Exit speed/i.test(name) ? 'Physics' : /Flywheel|Max RPM|Efficiency/i.test(name) ? 'Motor & flywheel' : 'Geometry';
      if (title === 'Field & target') return /start|position|heading| x | z |square/i.test(name) ? 'Starting positions' : /tip|Hives|calibrat|load/i.test(name) ? 'Hive physics' : 'Game pieces';
      return GROUPS[title]?.[0] ?? 'Advanced settings';
    };
    let activeGroup = '';
    for (const item of advanced) {
      if (title === 'Hardware map') {
        if (item.classList.contains('sub')) activeGroup = item.textContent ?? 'Devices';
        else if (!activeGroup) activeGroup = 'Connection hints';
        else if (item.classList.contains('row') && item.textContent?.includes('+ motor')) activeGroup = 'Add devices';
        else if (item.textContent?.includes('AprilTag noise')) activeGroup = 'Sensor noise';
      } else if (item.tagName === 'LABEL' || item.classList.contains('sub') || !activeGroup) activeGroup = groupFor(item.textContent ?? '');
      if (!groups.has(activeGroup)) {
        const key = `${title}/${activeGroup}`;
        const group = el('details', { class: 'advanced-group full', 'data-group': key, ...(this.groupOpen.has(key) ? { open: '' } : {}) }, el('summary', {}, activeGroup), el('div', { class: 'body' }));
        group.addEventListener('toggle', () => { if (!group.isConnected) return; if (group.open) this.groupOpen.add(key); else this.groupOpen.delete(key); });
        groups.set(activeGroup, group); body.append(group);
      }
      item.classList.remove('adv'); groups.get(activeGroup)!.querySelector('.body')!.append(item);
    }
    // Everyday controls should match a task; geometry and alternate field states stay under advanced controls.
    if (title === 'Field & target') {
      for (const label of body.querySelectorAll<HTMLElement>(':scope > label')) {
        if (/hive up cell/i.test(label.textContent ?? '')) {
          let group = groups.get('Hive physics');
          if (!group) { group = el('details', { class: 'advanced-group full', 'data-group': 'Field & target/Hive physics', ...(this.groupOpen.has('Field & target/Hive physics') ? { open: '' } : {}) }, el('summary', {}, 'Hive state & physics'), el('div', { class: 'body' })); groups.set('Hive physics', group); body.append(group); }
          const input = label.nextElementSibling; group.querySelector('.body')!.append(label); if (input) group.querySelector('.body')!.append(input);
        }
      }
      if (this.link.running || this.link.status === 'INIT') body.querySelectorAll<HTMLButtonElement>('button').forEach(b => { if (/Start match|Stop|Reset to start/.test(b.textContent ?? '')) b.disabled = true; });
      body.querySelectorAll<HTMLButtonElement>('button').forEach(b => { if (/^▶ Start match$|^■ Stop$/.test(b.textContent ?? '')) b.hidden = true; });
      body.prepend(el('p', { class: 'note full' }, 'Free practice has no clock. Start match begins a scored 2:30 match. TeamCode uses the persistent run controls instead.'));
    }
    if (title === 'Runtime — run your TeamCode') {
      // Run controls live in the persistent dock; preserve the originals for integrations and tests.
      body.querySelectorAll<HTMLElement>('.rt-pill, #rt-status, .row:has(button.init)').forEach(e => e.hidden = true);
      const selector = [...body.querySelectorAll<HTMLSelectElement>('select')].find(s => s.getAttribute('aria-label') === 'OpMode');
      if (selector) {
        const options = [...selector.options].map(o => ({ value: o.value, text: o.text, selected: o.selected })); selector.replaceChildren();
        for (const type of ['Autonomous', 'TeleOp']) { const group = el('optgroup', { label: type }); for (const o of options.filter(o => o.text.startsWith(`[${type}]`))) group.append(el('option', { value: o.value, selected: o.selected ? '' : undefined }, o.text.replace(/^\[.*?\] /, ''))); selector.append(group); }
        selector.classList.add('full');
        const label = body.querySelector('label[for="' + selector.id + '"]'); label?.classList.add('full');
      }
    }
    if (title === 'Launcher' && this.link.running) {
      body.prepend(el('div', { class: 'ownership-note full' }, 'Controlled by TeamCode. Flywheel RPM, feeding, and any mapped hood servo follow your program. Auto-RPM applies only to manual shots.'));
      for (const input of body.querySelectorAll<HTMLInputElement>('input')) if (/Commanded RPM|Auto-RPM|Auto-hood/.test(input.getAttribute('aria-label') ?? '')) { input.disabled = true; input.title = 'Controlled by the running TeamCode program'; }
    }
    if (title === 'Shooter calibration') {
      // A real stepper: retain all measurements and fit state between steps.
      this.buildCalibrationSteps(body);
    }
    // Wrap label/control pairs into accessible, searchable rows, preserving original handlers.
    const seen = new Map<string, number>();
    for (const label of [...body.querySelectorAll<HTMLLabelElement>('label')]) {
      const control = label.nextElementSibling as HTMLInputElement | null;
      if (!control?.matches('input,select,textarea')) continue;
      const name = label.textContent?.trim() || 'Setting';
      if (!control.id) control.id = `ws-${Math.random().toString(36).slice(2)}`;
      label.htmlFor = control.id; control.setAttribute('aria-label', name);
      const count = seen.get(name) ?? 0; seen.set(name, count + 1);
      const key = `${title}/${name}/${count}`;
      const automatic = (name === 'Commanded RPM' && this.state.autoRpm) || (name === 'Hood angle (°)' && this.state.autoHood);
      if (automatic) { control.disabled = true; control.title = 'Automatic value. Turn off Auto-RPM or Auto-hood to set it manually.'; }
      const value = control.type === 'checkbox' ? String(control.checked) : control.value;
      if (!this.baseline.has(key)) this.baseline.set(key, value);
      const row = el('div', { class: 'setting-row full', 'data-control-key': key, 'data-search': `${title} ${name}`.toLowerCase() });
      row.hidden = label.hidden || control.hidden;
      label.before(row); row.append(label, control);
      const reset = button('↺', () => { if (control.type === 'checkbox') control.checked = this.baseline.get(key) === 'true'; else control.value = this.baseline.get(key)!; control.dispatchEvent(new Event('change', { bubbles: true })); }, 'reset-control');
      reset.title = 'Reset to the value when first opened this visit'; reset.setAttribute('aria-label', `Reset ${name}`); reset.disabled = control.disabled || value === this.baseline.get(key);
      const pin = button(this.prefs.pins.includes(key) ? '★' : '☆', () => { this.prefs.pins = this.prefs.pins.includes(key) ? this.prefs.pins.filter(p => p !== key) : [...this.prefs.pins, key]; this.savePrefs(); this.panel.render(); }, 'pin-control');
      pin.title = 'Pin to your workspace'; pin.setAttribute('aria-label', `Pin ${name}`); pin.setAttribute('aria-pressed', String(this.prefs.pins.includes(key)));
      if (automatic) row.append(el('small', { class: 'automatic-note full' }, name === 'Commanded RPM' ? 'Automatic · turn off Auto-RPM to set manually' : 'Automatic · turn off Auto-hood to set manually'));
      row.dataset.changed = String(!automatic && value !== this.baseline.get(key)); row.append(el('div', { class: 'setting-actions' }, reset, pin));
    }
    for (const group of groups.values()) {
      const resets = [...group.querySelectorAll<HTMLElement>('[data-control-key]')].map(e => e.dataset.controlKey!);
      if (resets.length) group.querySelector('.body')!.append(button('Reset group', () => {
        for (const key of resets) {
          const row = [...this.root.querySelectorAll<HTMLElement>('[data-control-key]')].find(e => e.dataset.controlKey === key);
          const control = row?.querySelector<HTMLInputElement>('input,select,textarea');
          if (!control || control.disabled) continue;
          if (control.type === 'checkbox') control.checked = this.baseline.get(key) === 'true'; else control.value = this.baseline.get(key)!;
          control.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, 'reset-group full'));
    }
    for (const field of body.querySelectorAll<HTMLInputElement>('input,select,textarea')) if (!field.labels?.length && !field.getAttribute('aria-label')) field.setAttribute('aria-label', field.getAttribute('placeholder') || field.title || `${title} value`);
  }
  private calibrationStep = 0;
  private buildCalibrationSteps(body: HTMLElement) {
    const children = [...body.children] as HTMLElement[];
    const steps = ['Setup', 'Measure', 'Review & apply'];
    const nav = el('nav', { class: 'calibration-steps full', 'aria-label': 'Calibration step' });
    steps.forEach((text, i) => nav.append(el('button', { class: i === this.calibrationStep ? 'active' : '', 'aria-current': i === this.calibrationStep ? 'step' : undefined, onclick: () => { this.calibrationStep = i; this.panel.render(); } }, `${i + 1}. ${text}`)));
    let step = 0;
    for (const child of children) {
      if (child.classList.contains('sub')) { const text = child.textContent ?? ''; if (text.startsWith('2')) step = 1; else if (/^[34]/.test(text)) step = 2; }
      child.dataset.calStep = String(step); child.hidden = step !== this.calibrationStep;
    }
    const measurementHeader = children.find(e => e.classList.contains('sub') && e.textContent?.startsWith('3'));
    const table = children.find(e => e.classList.contains('cal-table'));
    if (measurementHeader) {
      const measurements = el('details', { class: 'full calibration-measurements' }, el('summary', {}, `Measurements (${this.state.calibration.shots.length})`));
      measurements.hidden = this.calibrationStep !== 2;
      if (table) { table.hidden = false; measurements.append(table); }
      else measurements.append(el('p', { class: 'note' }, 'No measurements recorded yet. Start in the Measure step.'));
      measurementHeader.remove(); body.append(measurements);
    }
    const outputStart = children.findIndex(e => e.textContent?.startsWith("For TeamCode's"));
    if (outputStart >= 0) {
      const output = el('details', { class: 'full calibration-output' }, el('summary', {}, 'Advanced: TeamCode output'));
      output.hidden = this.calibrationStep !== 2;
      for (const child of children.slice(outputStart)) { child.hidden = false; output.append(child); }
      body.append(output);
    }
    body.prepend(nav);
    body.append(el('div', { class: 'row full cal-navigation' }, el('button', { disabled: this.calibrationStep === 0 ? '' : undefined, onclick: () => { this.calibrationStep--; this.panel.render(); } }, 'Back'), button(this.calibrationStep < 2 ? 'Next step →' : 'Back to robot setup', () => { if (this.calibrationStep < 2) { this.calibrationStep++; this.panel.render(); } else this.navigate('setup'); }, 'primary')));
  }
  private addPinned(sections: HTMLDetailsElement[], before: HTMLElement) {
    if (!this.prefs.pins.length || this.task === 'settings') return;
    const pinned = el('section', { class: 'pinned-settings' }, heading('Pinned controls'));
    for (const key of this.prefs.pins) {
      const row = sections.flatMap(s => [...s.querySelectorAll<HTMLElement>('.setting-row')]).find(r => r.dataset.controlKey === key);
      if (!row || !row.closest('details[data-title]')?.hasAttribute('hidden')) continue;
      pinned.append(row); // move the real control; no stale duplicate input
    }
    if (pinned.children.length > 1) before.before(pinned);
  }
  private filterSettings() {
    if (this.task !== 'settings') return;
    const query = this.search.trim().toLowerCase();
    let count = 0;
    this.root.querySelectorAll<HTMLDetailsElement>(':scope > details[data-title]').forEach(section => {
      const rows = [...section.querySelectorAll<HTMLElement>('.setting-row')];
      const matches = rows.filter(r => (!query || ((r.dataset.search ?? '') + ' ' + (r.querySelector<HTMLInputElement>('input,select')?.value ?? '') + ' ' + (r.closest('.advanced-group')?.getAttribute('data-group') ?? '')).toLowerCase().includes(query)) && (!this.changedOnly || r.dataset.changed === 'true'));
      const matchesText = !this.changedOnly && (section.textContent ?? '').toLowerCase().includes(query);
      section.hidden = query || this.changedOnly ? !matches.length && !matchesText : false;
      if (!section.hidden) count++;
      if ((query || this.changedOnly) && !section.hidden) {
        section.open = true;
        section.querySelectorAll<HTMLDetailsElement>('.advanced-group').forEach(d => d.open = true);
      }
      rows.forEach(row => row.hidden = (query || this.changedOnly) ? !matches.includes(row) : false);
    });
    let empty = this.root.querySelector<HTMLElement>('.search-empty');
    if (!empty) { empty = el('p', { class: 'search-empty note' }); this.root.querySelector('.workspace-toolbar')?.after(empty); }
    empty.textContent = count ? '' : this.changedOnly ? 'No settings changed since you opened this visit.' : 'No matching settings. Try “hood”, “camera”, or “motor”.';
  }
  toggleVisualDetail() {
    if (this.detailBackup) {
      const saved = this.detailBackup;
      this.state.pip = saved.pip; this.state.stadium = saved.stadium;
      this.state.overlays.hitmap = saved.hitmap; this.state.overlays.reach = saved.reach;
      this.detailBackup = undefined;
      this.say('Previous visual settings restored.');
    } else {
      this.detailBackup = { pip: this.state.pip, stadium: this.state.stadium, hitmap: this.state.overlays.hitmap, reach: this.state.overlays.reach };
      this.state.pip = false; this.state.stadium = false; this.state.overlays.hitmap = false; this.state.overlays.reach = false;
      this.say('Visual detail reduced. Restore visual detail returns your previous settings.');
    }
    document.body.classList.toggle('visual-detail-reduced', !!this.detailBackup);
    this.change('view'); this.change('overlays'); this.panel.render();
  }
  updateCompass(dx: number, dy: number) {
    this.compass.hidden = this.state.robot.drivetrain !== 'mecanum';
    const previews = document.getElementById('pips');
    const cameraHeight = previews?.classList.contains('upper-right') && previews.getClientRects().length ? previews.getBoundingClientRect().height : 0;
    this.compass.style.top = `calc(var(--header-height) + ${cameraHeight > 0 ? cameraHeight + 20 : 10}px)`;
    this.compass.querySelector<HTMLElement>('.compass-arrow')!.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
    this.compass.querySelector<HTMLElement>('.compass-label')!.textContent = this.link.running ? 'TeamCode controls direction' : this.state.fieldCentric ? `W / ↑ · away from ${this.state.alliance} alliance` : 'W / ↑ · robot forward';
  }
  private overlaySelector() {
    const select = el('select', { 'aria-label': 'Field overlay', 'data-overlay-select': '' }, ...[['none', 'No overlay'], ['hitmap', 'Hit map'], ['reach', 'Reachability']].map(([value, label]) => el('option', { value }, label)));
    select.value = this.state.overlays.hitmap ? 'hitmap' : this.state.overlays.reach ? 'reach' : 'none';
    select.onchange = () => { this.state.overlays.hitmap = select.value === 'hitmap'; this.state.overlays.reach = select.value === 'reach'; this.change('overlays'); this.panel.render(); };
    return select;
  }
  private viewToolsOpen = false;
  private buildViewTools() {
    // the box is rebuilt on every change; remember whether the user had it open so toggling a setting does not close it
    const box = el('details', { class: 'view-tools', ...(this.viewToolsOpen ? { open: '' } : {}) }, el('summary', {}, 'Field view')); // the panel's "View & overlays" section holds every overlay checkbox
    box.addEventListener('toggle', () => { this.viewToolsOpen = box.open; });
    const views = el('div', { class: 'view-buttons' });
    for (const [value, label] of [['orbit', 'Orbit'], ['top', 'Top'], ['chase', 'Chase'], ['robot', 'Camera']] as const) views.append(el('button', { 'aria-pressed': String(this.state.view === value), onclick: () => this.modify(() => this.state.view = value, 'view') }, label));
    box.append(views, this.overlaySelector());
    const choices = [['trajectory', 'Predicted shot'], ['actualArc', 'Current direction'], ['frustum', 'Camera viewing cone'], ['footprint', 'Camera footprint']] as const;
    for (const [key, label] of choices) box.append(el('button', { class: 'overlay-choice', 'aria-pressed': String(this.state.overlays[key]), onclick: () => this.modify(() => this.state.overlays[key] = !this.state.overlays[key], 'overlays') }, `${this.state.overlays[key] ? '✓ ' : ''}${label}`));
    box.append(el('div', { class: 'row' }, button(this.state.pip ? 'Hide camera preview' : 'Show camera preview', () => this.modify(() => this.state.pip = !this.state.pip, 'view')), button(this.detailBackup ? 'Restore visual detail' : 'Reduce visual detail', () => this.toggleVisualDetail())));
    // visual extras (each costs frames, all off by default except the stands)
    const extras = [
      ['Stadium', 'Audience stands, banner and lighting truss around the field', () => this.state.stadium, (v: boolean) => { this.state.stadium = v; }, 'view'],
      ['Spinning wheels', 'Carve the CAD wheels out and turn them with the drive', () => this.state.wheelSpin, (v: boolean) => { this.state.wheelSpin = v; }, 'view'],
      ['CAD other robots', 'Partner and opponents use the goBILDA CAD, tinted in their alliance colour', () => this.state.opponentsCad, (v: boolean) => { this.state.opponentsCad = v; }, 'sim'],
    ] as const;
    box.append(el('div', { class: 'row', 'aria-label': 'Visual extras' }, ...extras.map(([label, title, get, set, what]) => el('button', { class: 'overlay-choice', title, 'aria-pressed': String(get()), onclick: () => this.modify(() => set(!get()), what) }, `${get() ? '✓ ' : ''}${label}`))));
    return box;
  }
  update(now: number, force = false) {
    if (!force && now - this.lastUpdate < 200) return; this.lastUpdate = now;
    const replay = this.recorder?.cursor !== undefined;
    const runtime = this.link.running || this.link.status === 'INIT';
    document.body.classList.toggle('is-replaying', replay);
    if (this.tutorial === 1 && this.tutorialOrigin && Math.hypot(this.state.pose.x - this.tutorialOrigin.x, this.state.pose.z - this.tutorialOrigin.z) > 0.12) { this.tutorial = 2; this.panel.render(); return; }
    const status = `${this.task}/${this.link.connected}/${this.link.status}/${this.link.currentOpMode}/${this.panel.selectedOpMode}/${this.state.runtimeEnabled}/${replay}/${this.state.matchPhase}/${this.input.keyboardPad}/${document.activeElement === this.canvas}`;
    if (force || status !== this.lastStatus) {
      this.lastStatus = status;
      const ownership = replay ? 'REPLAY · simulation paused' : runtime ? `TEAMCODE · ${this.link.currentOpMode || this.panel.selectedOpMode}` : this.task === 'teamcode' && this.link.connected ? 'HOST CONNECTED · ready to initialize' : document.activeElement === this.canvas ? 'FIELD FOCUSED · keyboard driving' : 'MANUAL · click the field to drive';
      const statusText = el('div', { class: 'control-status' }, el('span', { class: 'status-dot' }), el('div', {}, el('strong', {}, ownership), el('small', {}, runtime ? this.link.status === 'INIT' ? 'Initialized · press Start to run your program' : `Running · Keyboard → Gamepad ${this.input.keyboardPad} · Stop ends the run` : replay ? 'Choose Return to live to resume driving.' : this.task === 'teamcode' ? this.link.connected ? 'Host connected · choose a program, then Initialize' : 'Waiting for local host' : 'WASD move · Q/E turn · R aim · Space shoot')));
      const actions = el('div', { class: 'dock-actions' });
      if (replay) actions.append(button('Return to live', () => this.returnLive(), 'primary'));
      if (this.task === 'teamcode' || runtime) {
        const initialize = button('Initialize (INIT)', () => { if (this.panel.selectedOpMode) this.link.init(this.panel.selectedOpMode); }, 'init'); initialize.disabled = replay || !!this.sample || !this.link.connected || !this.panel.selectedOpMode || !['IDLE', 'STOPPED', 'ERROR'].includes(this.link.status);
        const start = button('Start', () => this.link.start(), 'start'); start.disabled = replay || this.link.status !== 'INIT';
        const stop = button('Stop', () => this.link.stop(), 'stop'); stop.disabled = !runtime;
        if (this.task === 'teamcode') actions.append(initialize, start);
        actions.append(stop);
        const pad = el('select', { 'aria-label': 'Keyboard gamepad' }, el('option', { value: '1' }, 'Gamepad 1'), el('option', { value: '2' }, 'Gamepad 2')); pad.value = String(this.input.keyboardPad); pad.onchange = () => { this.input.keyboardPad = Number(pad.value) as 1 | 2; this.update(0, true); }; actions.append(pad);
      } else if (!replay) actions.append(button('Focus field', () => this.focusField()), button(this.state.matchPhase === 'running' ? 'Stop match' : this.state.matchPhase === 'stopped' && (this.state.matchClock ?? 0) > 0 ? 'Resume match' : 'Start timed match', () => { this.state.matchRequest = this.state.matchPhase === 'running' ? 'stop' : 'start'; this.change('sim'); this.panel.render(); }));
      const display = el('div', { class: 'match-display' });
      const score = document.getElementById('match-score');
      if (score) display.append(score);
      display.append(el('div', { class: 'match-clock', role: 'timer', 'aria-label': 'Match clock' }));
      const tip = document.getElementById('tip-needed');
      if (tip) display.append(tip);
      this.dock.replaceChildren(statusText, display, actions);
    }
    const clock = this.dock.querySelector<HTMLElement>('.match-clock');
    const remaining = Math.ceil(this.state.matchClock ?? 150);
    if (clock) {
      const mmss = (t: number) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      const running = this.state.matchPhase === 'running';
      const inAuto = running && remaining > 120;
      // what the driver has to watch: in AUTO the seconds left before TELEOP, afterwards the time left in the match
      const shown = inAuto ? remaining - 120 : remaining;
      const urgency = !running ? 'idle' : shown <= 5 ? 'now' : shown <= (inAuto ? 10 : 30) ? 'soon' : 'calm';
      const phase = replay ? 'LIVE MATCH' : !running ? (this.state.matchPhase === 'stopped' ? (remaining === 0 ? 'MATCH ENDED' : 'MATCH STOPPED') : 'MATCH READY') : inAuto ? 'AUTO' : remaining <= 30 ? 'ENDGAME' : 'TELEOP';
      const sub = inAuto ? `teleop in ${shown} s · ${mmss(remaining)} left` : running ? (remaining <= 30 ? 'match ends' : 'time left') : '2:30 match';
      clock.replaceChildren(el('span', { class: 'phase' }, phase), el('span', { class: 'time' }, inAuto ? `0:${String(shown).padStart(2, '0')}` : mmss(remaining)), el('span', { class: 'sub' }, sub));
      clock.dataset.running = String(running); clock.dataset.urgency = urgency; clock.dataset.auto = String(inAuto);
    }
    const connected = this.link.connected;
    let title = !this.state.runtimeEnabled ? 'Runtime disabled' : !connected ? 'Waiting for runtime host' : this.link.status === 'RUNNING' ? 'Program running' : this.link.status === 'INIT' ? 'Initialized · ready to start' : this.link.status === 'ERROR' ? 'Runtime error' : 'Runtime connected';
    let next = !this.state.runtimeEnabled ? 'Enable the runtime connection here to run TeamCode.' : !connected ? 'Start your local host with pnpm sim. This page connects automatically.' : this.link.status === 'RUNNING' ? 'TeamCode controls the robot. Use Stop in the bottom bar to end the run.' : this.link.status === 'INIT' ? 'Use Start in the bottom bar to run your program.' : this.link.status === 'ERROR' ? 'Check Connection & diagnostics below, then initialize again.' : this.panel.selectedOpMode ? 'Choose a program, initialize it, then start.' : 'No programs available. Check the host build and program discovery.';
    if (this.state.runtimeEnabled && !connected && this.startup) {
      const labels: Record<string, string> = { compiling: 'Building TeamCode', starting: 'Starting runtime', restarting: 'Rebuilding runtime', ready: 'Runtime ready · connecting', error: 'Runtime startup failed' };
      title = labels[this.startup.phase] ?? 'Starting runtime';
      next = this.startup.message;
    }
    const loading = this.state.runtimeEnabled && !connected && !!this.startup && ['compiling', 'starting', 'restarting', 'ready'].includes(this.startup.phase);
    const startupFailed = this.state.runtimeEnabled && !connected && this.startup?.phase === 'error';
    const guidance = this.root.querySelector('.runtime-guidance');
    if (guidance && guidance.getAttribute('data-message') !== title + next + replay + !!this.sample) {
      guidance.setAttribute('data-message', title + next + replay + !!this.sample);
      const selector = this.root.querySelector<HTMLSelectElement>('select[aria-label="OpMode"]');
      const program = selector?.closest<HTMLElement>('.setting-row');
      const focused = document.activeElement === selector;
      guidance.classList.toggle('runtime-loading', loading);
      guidance.classList.toggle('runtime-failed', startupFailed);
      if (loading) {
        guidance.replaceChildren(
          el('div', { class: 'startup-heading' }, el('span', { class: 'startup-spinner', 'aria-hidden': 'true' }), el('span', { class: 'startup-kicker' }, 'STARTING YOUR ROBOT')),
          el('h3', { class: 'startup-title' }, title),
          el('p', { class: 'startup-message' }, next),
          el('div', { class: 'startup-footer' }, el('span', { class: 'startup-elapsed', role: 'timer', 'aria-live': 'off', 'aria-label': 'Startup elapsed time' }), el('span', {}, 'Connects automatically when ready')),
        );
      } else guidance.replaceChildren(el('b', {}, title), el('p', {}, next));
      if (connected && program) {
        program.classList.add('runtime-program');
        program.querySelector('.setting-actions')?.remove();
        guidance.append(program);
        if (focused) selector?.focus({ preventScroll: true });
      }
      if (!this.state.runtimeEnabled) guidance.append(button('Enable runtime', () => { this.state.runtimeEnabled = true; this.change('runtime'); this.panel.render(); }, 'primary'));
      else if (connected) {
        const running = this.link.status === 'RUNNING', initialized = this.link.status === 'INIT';
        const action = button(running ? 'Stop program' : initialized ? 'Start program' : 'Initialize program', () => { if (running) this.link.stop(); else if (initialized) this.link.start(); else if (this.panel.selectedOpMode) this.link.init(this.panel.selectedOpMode); }, 'primary');
        action.disabled = !running && (!!this.sample || replay || (!initialized && !this.panel.selectedOpMode));
        guidance.append(action);
        if (this.sample) guidance.append(el('p', {}, 'Restore your setup before initializing TeamCode.'));
      } else if (!this.startup || this.startup.phase === 'error') guidance.append(el('code', {}, 'pnpm sim'));

    }
    const elapsedBadge = guidance?.querySelector<HTMLElement>('.startup-elapsed');
    if (elapsedBadge && this.startup) {
      const seconds = Math.max(0, Math.floor((Date.now() - this.startup.startedAt) / 1000));
      elapsedBadge.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} elapsed`;
    }
    let badge = this.header.querySelector<HTMLElement>('.runtime-availability');
    if (!badge) { badge = el('button', { class: 'runtime-availability', onclick: () => this.navigate('teamcode') }); this.header.querySelector('.header-tools')!.prepend(badge); }
    badge.classList.toggle('runtime-loading-badge', loading);
    badge.textContent = title; badge.dataset.connected = String(connected); badge.setAttribute('aria-label', `${title}. Open Run TeamCode`);
    if (!this.quick.childElementCount) {
      for (const [key, label, overlay] of [['infiniteAmmo', 'Infinite ammo', false], ['opponents', 'Opponents', false], ['pip', 'Cameras', false]] as const) {
        this.quick.append(el('button', { 'data-quick': key, onclick: () => {
          this.state[key] = !this.state[key];
          this.change(overlay ? 'overlays' : key === 'pip' ? 'view' : 'sim'); this.panel.render();
        } }, label));
      }
    }
    if (!this.quick.querySelector('select')) this.quick.append(this.overlaySelector());
    document.querySelectorAll<HTMLSelectElement>('[data-overlay-select]').forEach(s => s.value = this.state.overlays.hitmap ? 'hitmap' : this.state.overlays.reach ? 'reach' : 'none');
    this.root.querySelectorAll<HTMLButtonElement>('button').forEach(b => { if (b.textContent === 'Return to live') b.disabled = !replay; });
    this.quick.querySelectorAll<HTMLButtonElement>('button[data-quick]').forEach(b => {
      const key = b.dataset.quick!;
      const value = key === 'hitmap' || key === 'reach' ? this.state.overlays[key] : this.state[key as 'infiniteAmmo' | 'opponents' | 'pip'];
      b.setAttribute('aria-pressed', String(value));
      b.disabled = replay && (key === 'infiniteAmmo' || key === 'opponents');
    });
    let restore = this.quick.querySelector<HTMLButtonElement>('[data-restore-detail]');
    if (this.detailBackup && !restore) { restore = button('Restore visual detail', () => this.toggleVisualDetail()); restore.dataset.restoreDetail = ''; this.quick.append(restore); }
    if (!this.detailBackup) restore?.remove();
    this.legend.replaceChildren();
    if (this.state.overlays.hitmap || this.state.overlays.reach) this.legend.append(el('b', {}, this.state.overlays.hitmap ? 'Scoring chance after aiming' : 'Flywheel RPM required'), el('div', { class: this.state.overlays.hitmap ? 'legend-scale' : 'legend-scale rpm' }), el('span', {}, this.state.overlays.hitmap ? 'Low ← → High · dimmed: target tags not visible' : 'Low ← → Near limit · dark: unreachable'));
    if (this.task === 'analyze' && this.prefs.analysis === 'shots') this.legend.append(el('small', {}, 'Green/red arc: predicted shot · orange: current direction'));
    this.legend.hidden = !this.legend.childElementCount;
    this.root.querySelectorAll<HTMLInputElement>('[aria-label="Commanded RPM"], [aria-label="Auto-RPM to target (keyboard shots)"], [aria-label="Auto-hood to best angle"], [aria-label="Hood angle (°)"]').forEach(i => {
      const name = i.getAttribute('aria-label');
      i.disabled = this.link.running || (name === 'Commanded RPM' && this.state.autoRpm) || (name === 'Hood angle (°)' && this.state.autoHood);
      if (name === 'Commanded RPM' && i.disabled) i.value = String(Math.round(this.state.robot.launcher.rpm));
      if (name === 'Hood angle (°)' && i.disabled) i.value = String(Math.round(this.state.robot.launcher.elevationDeg * 10) / 10);
    });
  }
  projectMarkers(robot: { x: number; y: number; visible: boolean }, target: { x: number; y: number; visible: boolean }) {
    this.markers.hidden = this.state.view === 'robot' || this.task === 'settings' || this.task === 'setup';
    for (const [element, point] of [[this.robotMarker, robot], [this.targetMarker, target]] as const) { element.hidden = !point.visible; element.style.left = `${point.x}px`; element.style.top = `${point.y}px`; }
  }
}
