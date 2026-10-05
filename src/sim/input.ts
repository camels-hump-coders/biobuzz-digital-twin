/** Keyboard + gamepad input -> DriveCommand and action edges. */
import type { DriveCommand } from "./drive";

export interface Actions {
  launch: boolean; // edge
  toggleTarget: boolean;
  toggleFieldCentric: boolean;
  aim: boolean;
  view?: number;
  boost: boolean;
}

export class Input {
  private keys = new Set<string>();
  private edges = new Set<string>();
  private typing = false;

  constructor() {
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      this.typing = !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
      if (this.typing) return;
      if (!this.keys.has(e.code)) this.edges.add(e.code);
      this.keys.add(e.code);
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  private prevButtons = new Set<number>();

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
      this.prevButtons = pressed;
    }
    this.edges.clear();
    const scale = actions.boost ? 1 : 0.6;
    return { cmd: { forward: forward * scale, left: left * scale, turn: turn * scale }, actions };
  }
}
