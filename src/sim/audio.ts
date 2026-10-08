/**
 * Competition audio. Every cue is synthesised with Web Audio (no sample files) and triggered by edge-detecting a
 * snapshot of the world each frame, so no simulation code calls audio directly and a replayed frame cannot
 * double-fire a sound. Cue set follows Competition Manual Table 9-1: Cavalry Charge at MATCH start, buzzer x 3 at
 * the end of AUTO, "Drivers, pick up your controllers, 3-2-1" in the transition, three bells at TELEOP, train whistle
 * at 0:20, a 3-second buzzer at the end, foghorn when a MATCH is stopped. Effects: shot, swallow, hive tip, bounces,
 * and a flywheel hum whose pitch follows RPM.
 */

export interface AudioSettings { master: number; cues: number; effects: number; voice: number }
export const DEFAULT_AUDIO: AudioSettings = { master: 0.8, cues: 1, effects: 1, voice: 1 };

export interface AudioSnapshot {
  phase: "setup" | "running" | "stopped";
  /** seconds left on the 2:30 clock */
  clock: number;
  /** seconds left in the 8 s AUTO→TELEOP transition, undefined outside it */
  transition?: number;
  /** running counters: balls launched by anyone, balls swallowed by any intake, tips started, tips completed */
  shots: number;
  intakes: number;
  tipsStarted: number;
  tipsDone: number;
  /** impact speeds (m/s) of bounces since the last frame */
  bounces: number[];
  /** our flywheel speed */
  rpm: number;
  maxRpm: number;
  /** the simulation is paused for replay: hold every continuous sound */
  replaying: boolean;
}

/** The synthesiser behind MatchAudio; swapped for a recorder in tests. */
export interface Synth {
  cue(name: CueName): void;
  effect(name: EffectName, strength?: number): void;
  say(text: string): void;
  hum(level: number, pitch: number): void;
}
export type CueName = "charge" | "buzzer3" | "bells" | "whistle" | "endBuzzer" | "foghorn" | "beep";
export type EffectName = "shot" | "swallow" | "tipStart" | "tipLand" | "bounce";
export const CUE_LABELS: Record<CueName, string> = { charge: "Cavalry Charge (match start)", buzzer3: "Buzzer × 3 (AUTO ends)", bells: "Three bells (TELEOP begins)", whistle: "Train whistle (0:20)", endBuzzer: "3-second buzzer (match end)", foghorn: "Foghorn (match stopped)", beep: "Countdown beep" };
export const EFFECT_LABELS: Record<EffectName, string> = { shot: "Shot", swallow: "Ball swallowed", tipStart: "Hive breaks away", tipLand: "Hive lands", bounce: "Ball bounce" };

/** Edge detector: compares each snapshot with the previous one and asks the synth for the matching cues. */
export class MatchAudio {
  private prev?: AudioSnapshot;
  private spoken = new Set<string>();
  private whistled = false;
  private lastBounceAt = -1;
  private t = 0;
  private synth: Synth;
  private settings: () => AudioSettings;
  constructor(synth: Synth, settings: () => AudioSettings) { this.synth = synth; this.settings = settings; }

  update(s: AudioSnapshot, dt: number) {
    this.t += dt;
    const p = this.prev;
    this.prev = { ...s, bounces: [] };
    const st = this.settings();
    const on = st.master > 0;
    if (!on) { this.synth.hum(0, 0); return; }
    if (p) {
      // --- match lifecycle
      const started = p.phase !== "running" && s.phase === "running" && s.clock > 120 && p.clock >= 149;
      if (started) { this.spoken.clear(); this.whistled = false; this.synth.cue("charge"); }
      const resumed = p.phase === "stopped" && s.phase === "running" && !started;
      if (resumed) this.synth.cue("bells");
      const endedByClock = p.phase === "running" && s.phase === "stopped" && s.clock <= 0;
      const stoppedEarly = p.phase === "running" && (s.phase === "stopped" || s.phase === "setup") && s.clock > 0;
      if (endedByClock) this.synth.cue("endBuzzer");
      if (stoppedEarly) this.synth.cue("foghorn");
      // --- AUTO → TELEOP: buzzer at the end of AUTO, announcer in the transition, bells when TELEOP begins
      if (s.phase === "running") {
        const autoEnded = p.clock > 120 && s.clock <= 120;
        if (autoEnded) this.synth.cue("buzzer3");
        if (s.transition !== undefined) {
          if (s.transition <= 6.5 && !this.spoken.has("pickup")) { this.spoken.add("pickup"); this.synth.say("Drivers, pick up your controllers"); }
          for (const n of [3, 2, 1]) if (s.transition <= n && !this.spoken.has(`t${n}`)) { this.spoken.add(`t${n}`); this.synth.say(String(n)); }
        }
        if (p.transition !== undefined && s.transition === undefined) this.synth.cue("bells");
        if (p.transition === undefined && s.transition === undefined && autoEnded) this.synth.cue("bells"); // no transition hold configured
        if (s.clock <= 20 && p.clock > 20 && !this.whistled) { this.whistled = true; this.synth.cue("whistle"); }
      }
      // --- effects
      if (s.shots > p.shots) this.synth.effect("shot");
      if (s.intakes > p.intakes) this.synth.effect("swallow");
      if (s.tipsStarted > p.tipsStarted) this.synth.effect("tipStart");
      if (s.tipsDone > p.tipsDone) this.synth.effect("tipLand");
    }
    // bounces: rate-limited, loudness by impact speed
    if (s.bounces.length && this.t - this.lastBounceAt > 0.05) {
      const v = Math.max(...s.bounces);
      if (v > 0.6) { this.lastBounceAt = this.t; this.synth.effect("bounce", Math.min(1, (v - 0.6) / 6)); }
    }
    // flywheel hum
    const f = s.maxRpm > 0 ? s.rpm / s.maxRpm : 0;
    this.synth.hum(s.replaying || f < 0.02 ? 0 : 0.25 + 0.75 * f, f);
  }
}

/** Web Audio implementation. The context is created on the first user gesture and resumed on every gesture while
 *  suspended; volume is enforced at the gain stage so a muted page still warms up. */
export class WebAudioSynth implements Synth {
  private ctx?: AudioContext;
  private master?: GainNode;
  private humOsc?: OscillatorNode; private humGain?: GainNode; private humOsc2?: OscillatorNode;
  private noiseBuf?: AudioBuffer;
  private settings: () => AudioSettings;
  constructor(settings: () => AudioSettings) {
    this.settings = settings;
    if (typeof window === "undefined") return;
    const unlock = () => { this.ensure(); if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume(); };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, unlock, { passive: true });
  }
  get ready() { return !!this.ctx && this.ctx.state === "running"; }
  private ensure(): AudioContext | undefined {
    if (this.ctx) return this.ctx;
    const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return undefined;
    this.ctx = new AC() as AudioContext;
    this.master = this.ctx.createGain(); this.master.gain.value = 1; this.master.connect(this.ctx.destination);
    return this.ctx;
  }
  private bus(kind: keyof AudioSettings): GainNode | undefined {
    const ctx = this.ensure(); if (!ctx || !this.master) return undefined;
    const s = this.settings();
    const g = ctx.createGain(); g.gain.value = s.master * s[kind]; g.connect(this.master);
    return g;
  }
  /** one oscillator note with an attack/decay envelope */
  private note(out: AudioNode, freq: number, start: number, dur: number, type: OscillatorType, gain = 0.3, decay = 0.08, detune = 0) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(gain, start + 0.01);
    g.gain.setValueAtTime(gain, Math.max(start + 0.01, start + dur - decay)); g.gain.linearRampToValueAtTime(0, start + dur);
    o.connect(g); g.connect(out); o.start(start); o.stop(start + dur + 0.02);
  }
  private noise(out: AudioNode, start: number, dur: number, gain: number, fromHz: number, toHz: number, q = 1) {
    const ctx = this.ctx!;
    if (!this.noiseBuf) { const n = ctx.sampleRate; const b = ctx.createBuffer(1, n, n); const d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; this.noiseBuf = b; }
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = q; f.frequency.setValueAtTime(fromHz, start); f.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), start + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, start); g.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(f); f.connect(g); g.connect(out); src.start(start); src.stop(start + dur + 0.02);
  }

  cue(name: CueName) {
    const out = this.bus("cues"); if (!out || !this.ctx) return;
    const t = this.ctx.currentTime + 0.02;
    switch (name) {
      case "charge": { // bugle: G4 C5 E5 | G5 E5 G5 (the cavalry call), brassy sawtooth with a square under it
        const seq: [number, number][] = [[392, 0.16], [523, 0.16], [659, 0.16], [784, 0.4], [659, 0.16], [784, 0.7]];
        let at = t; for (const [f, d] of seq) { this.note(out, f, at, d * 0.95, "sawtooth", 0.18, 0.05); this.note(out, f / 2, at, d * 0.95, "square", 0.05, 0.05); at += d; }
        break; }
      case "buzzer3": for (let i = 0; i < 3; i++) this.buzz(out, t + i * 0.55, 0.35); break;
      case "endBuzzer": this.buzz(out, t, 3.0); break;
      case "bells": for (let i = 0; i < 3; i++) this.bell(out, t + i * 0.45); break;
      case "whistle": { // steam whistle chord with vibrato
        for (const f of [622, 740, 932]) { const o = this.ctx.createOscillator(); o.type = "triangle"; o.frequency.value = f; const lfo = this.ctx.createOscillator(); lfo.frequency.value = 5.5; const lg = this.ctx.createGain(); lg.gain.value = 6; lfo.connect(lg); lg.connect(o.frequency); const g = this.ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.15); g.gain.setValueAtTime(0.12, t + 1.3); g.gain.linearRampToValueAtTime(0, t + 1.7); o.connect(g); g.connect(out); o.start(t); lfo.start(t); o.stop(t + 1.75); lfo.stop(t + 1.75); }
        this.noise(out, t, 1.7, 0.05, 2500, 1800, 2);
        break; }
      case "foghorn": { const o = this.ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = 92; const o2 = this.ctx.createOscillator(); o2.type = "sawtooth"; o2.frequency.value = 138; const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 350; const g = this.ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.35, t + 0.2); g.gain.setValueAtTime(0.35, t + 1.4); g.gain.linearRampToValueAtTime(0, t + 1.9); o.connect(f); o2.connect(f); f.connect(g); g.connect(out); o.start(t); o2.start(t); o.stop(t + 2); o2.stop(t + 2); break; }
      case "beep": this.note(out, 780, t, 0.14, "square", 0.15, 0.03); break;
    }
  }
  private buzz(out: AudioNode, t: number, dur: number) { this.note(out, 220, t, dur, "square", 0.16, 0.03); this.note(out, 233, t, dur, "sawtooth", 0.12, 0.03); }
  private bell(out: AudioNode, t: number) { for (const [f, g] of [[880, 0.18], [1760, 0.08], [2637, 0.05], [1109, 0.06]] as const) this.note(out, f, t, 1.1, "sine", g, 1.0); }

  effect(name: EffectName, strength = 1) {
    const out = this.bus("effects"); if (!out || !this.ctx) return;
    const t = this.ctx.currentTime + 0.01;
    switch (name) {
      case "shot": this.noise(out, t, 0.13, 0.45, 1800, 400, 0.8); this.note(out, 240, t, 0.11, "sawtooth", 0.12, 0.08); break; // thwump: the ball leaving the wheels
      case "swallow": { const o = this.ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(330, t + 0.08); const g = this.ctx.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.1); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.12); break; }
      case "tipStart": this.note(out, 70, t, 0.25, "triangle", 0.5, 0.2); this.noise(out, t + 0.05, 0.5, 0.12, 900, 300, 0.6); break; // clunk as the detent lets go, balls start to rattle
      case "tipLand": this.note(out, 55, t, 0.35, "triangle", 0.6, 0.3); this.noise(out, t, 0.25, 0.25, 600, 200, 0.7); for (let i = 0; i < 5; i++) this.noise(out, t + 0.15 + i * 0.09 + Math.random() * 0.05, 0.05, 0.08, 1500, 900, 3); break;
      case "bounce": this.noise(out, t, 0.04, 0.05 + 0.3 * strength, 1400, 500, 2); break;
    }
  }
  say(text: string) {
    const s = this.settings();
    if (s.master * s.voice <= 0) return;
    const synth = (window as any).speechSynthesis as SpeechSynthesis | undefined;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") { this.cue("beep"); return; }
    try {
      if (/^\d$/.test(text)) synth.cancel(); // countdown numbers land on the beat
      const u = new SpeechSynthesisUtterance(text);
      u.volume = Math.min(1, s.master * s.voice); u.rate = 1.1; u.pitch = 0.95;
      const voices = synth.getVoices();
      u.voice = voices.find((v) => /Google US English/i.test(v.name)) ?? voices.find((v) => /en/i.test(v.lang) && /Natural|Online/i.test(v.name)) ?? voices.find((v) => /^en/i.test(v.lang)) ?? null;
      synth.speak(u);
    } catch { this.cue("beep"); }
  }
  hum(level: number, pitch: number) {
    if (!this.ctx || !this.master) return; // never create a context for a hum alone
    const s = this.settings();
    const want = level * s.master * s.effects * 0.06;
    if (want <= 0 && !this.humOsc) return;
    if (!this.humOsc) {
      this.humOsc = this.ctx.createOscillator(); this.humOsc.type = "sawtooth";
      this.humOsc2 = this.ctx.createOscillator(); this.humOsc2.type = "sine";
      const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900;
      this.humGain = this.ctx.createGain(); this.humGain.gain.value = 0;
      this.humOsc.connect(f); this.humOsc2.connect(f); f.connect(this.humGain); this.humGain.connect(this.master);
      this.humOsc.start(); this.humOsc2.start();
    }
    const t = this.ctx.currentTime;
    const hz = 60 + 340 * pitch; // a flywheel at full speed whines around 400 Hz
    this.humOsc.frequency.setTargetAtTime(hz, t, 0.15); this.humOsc2!.frequency.setTargetAtTime(hz * 2, t, 0.15);
    this.humGain!.gain.setTargetAtTime(want, t, 0.1);
  }
}
