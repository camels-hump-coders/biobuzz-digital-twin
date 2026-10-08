/** Keyboard + gamepad input -> DriveCommand and action edges. */
import type { DriveCommand } from "./drive";
import { emptyGamepad, type GamepadPacket } from "../runtime/link";

export interface Actions {
  launch: boolean; // edge
  toggleTarget: boolean;
  toggleFieldCentric: boolean;
  aim: boolean;
  view?: number;
  boost: boolean;
  /** I / LB: flip the intake on or off (edge) */
  intakeToggle: boolean;
  /** K / LT: run the intake while held */
  intakeHold: boolean;
}

export class Input {
  private keys = new Set<string>();
  private edges = new Set<string>();
  private fieldFocused() {
    return document.activeElement?.id === "view" && !document.querySelector("dialog[open]");
  }

  constructor() {
    window.addEventListener("keydown", (e) => {
      // Drive shortcuts belong to the field. Native form and dialog navigation must remain intact.
      if (!this.fieldFocused() || e.metaKey || e.altKey) return;
      if (e.code === "Tab" || e.code === "Escape") { this.keys.clear(); return; }
      if (!this.keys.has(e.code)) this.edges.add(e.code);
      this.keys.add(e.code);
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
    window.addEventListener("focusin", () => { if (!this.fieldFocused()) { this.keys.clear(); this.edges.clear(); } });
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  private prevButtons = new Set<number>();
  /** which gamepad the keyboard emulates; selected explicitly in the workspace */
  keyboardPad: 1 | 2 = 1;
  /** values injected by a test script (pnpm twin-test); they override keyboard/gamepad fields until cleared */
  private injected: { 1: Partial<GamepadPacket>; 2: Partial<GamepadPacket> } = { 1: {}, 2: {} };
  inject(pad: 1 | 2, values: Partial<GamepadPacket>) { Object.assign(this.injected[pad], values); }
  clearInjected(pad?: 1 | 2) { if (pad) this.injected[pad] = {}; else this.injected = { 1: {}, 2: {} }; }

  /** gamepad1/gamepad2 packets for the runtime. With no physical gamepad, the keyboard emulates gamepad1:
   * WASD = left stick, Q/E = right stick X, Space = A, Shift = right trigger, B/X/Y keys = buttons, arrows = dpad. */
  gamepads(): { g1: GamepadPacket; g2: GamepadPacket } {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter((p): p is Gamepad => !!p && p.connected) : [];
    const fromPad = (p: Gamepad): GamepadPacket => {
      const dz = (v: number) => (Math.abs(v) < 0.08 ? 0 : v);
      const bt = (i: number) => !!p.buttons[i]?.pressed;
      const tv = (i: number) => p.buttons[i]?.value ?? 0;
      return { lx: dz(p.axes[0] ?? 0), ly: dz(p.axes[1] ?? 0), rx: dz(p.axes[2] ?? 0), ry: dz(p.axes[3] ?? 0), lt: tv(6), rt: tv(7),
        a: bt(0), b: bt(1), x: bt(2), y: bt(3), lb: bt(4), rb: bt(5), back: bt(8), start: bt(9), guide: bt(16), ls: bt(10), rs: bt(11), du: bt(12), dd: bt(13), dl: bt(14), dr: bt(15) };
    };
    const k = this.keys;
    const kb: GamepadPacket = { ...emptyGamepad(),
      lx: (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0),
      ly: (k.has("KeyS") ? 1 : 0) - (k.has("KeyW") ? 1 : 0),
      rx: (k.has("KeyE") ? 1 : 0) - (k.has("KeyQ") ? 1 : 0),
      rt: k.has("ShiftLeft") || k.has("ShiftRight") ? 1 : 0,
      lt: k.has("ControlLeft") || k.has("ControlRight") ? 1 : 0,
      a: k.has("Space"), b: k.has("KeyB"), x: k.has("KeyX"), y: k.has("KeyY"),
      lb: k.has("KeyZ"), rb: k.has("KeyC"),
      guide: k.has("KeyG"), start: k.has("Enter"), back: k.has("Backspace"), ls: k.has("KeyV"), rs: k.has("KeyN"),
      du: k.has("ArrowUp"), dd: k.has("ArrowDown"), dl: k.has("ArrowLeft"), dr: k.has("ArrowRight"),
    };
    // physical pads take their slots; the keyboard fills whichever slot it is assigned to (control bar selects) if free
    let g1 = pads[0] ? fromPad(pads[0]) : emptyGamepad();
    let g2 = pads[1] ? fromPad(pads[1]) : emptyGamepad();
    if (this.keyboardPad === 1 && !pads[0]) g1 = kb; else if (this.keyboardPad === 2 && !pads[1]) g2 = kb; else if (!pads[0]) g1 = kb;
    g1 = { ...g1, ...this.injected[1] }; g2 = { ...g2, ...this.injected[2] };
    return { g1, g2 };
  }

  poll(): { cmd: DriveCommand; actions: Actions } {
    const k = this.keys;
    let forward = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    let left = (k.has("KeyA") ? 1 : 0) - (k.has("KeyD") ? 1 : 0);
    let turn = (k.has("KeyQ") || k.has("ArrowLeft") ? 1 : 0) - (k.has("KeyE") || k.has("ArrowRight") ? 1 : 0);
    const actions: Actions = {
      launch: this.edges.has("Space"),
      toggleTarget: this.edges.has("KeyT"),
      toggleFieldCentric: this.edges.has("KeyF"),
      aim: this.edges.has("KeyR"),
      boost: k.has("ShiftLeft") || k.has("ShiftRight"),
      intakeToggle: this.edges.has("KeyI"),
      intakeHold: k.has("KeyK"),
    };
    for (let i = 1; i <= 5; i++) if (this.edges.has(`Digit${i}`)) actions.view = i;
    const pad = this.pad();
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
      const lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0), rx = dz(pad.axes[2] ?? 0);
      if (lx || ly || rx) {
        forward = -ly;
        left = -lx;
        turn = -rx;
      }
      const pressed = new Set<number>();
      pad.buttons.forEach((b, i) => { if (b.pressed) pressed.add(i); });
      const edge = (i: number) => pressed.has(i) && !this.prevButtons.has(i);
      if (edge(0)) actions.launch = true; // A / cross
      if (edge(3)) actions.toggleTarget = true; // Y
      if (edge(2)) actions.toggleFieldCentric = true; // X
      if (edge(1)) actions.aim = true; // B
      if (pressed.has(5) || pressed.has(7)) actions.boost = true;
      if (edge(4)) actions.intakeToggle = true; // LB
      if (pressed.has(6)) actions.intakeHold = true; // LT
      this.prevButtons = pressed;
    }
    this.edges.clear();
    const scale = actions.boost ? 1 : 0.6;
    return { cmd: { forward: forward * scale, left: left * scale, turn: turn * scale }, actions };
  }
}
