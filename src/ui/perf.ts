/** Per-section timing of the main loop (exponential moving average), shown in a small overlay when enabled. */
export class Perf {
  private t0 = 0; private tPrev = 0;
  private ema = new Map<string, number>();
  private frameEma = 0;
  private lastDraw = 0;
  private el?: HTMLElement;
  private order: string[] = [];
  begin() { this.t0 = this.tPrev = performance.now(); }
  mark(name: string) {
    const now = performance.now();
    const d = now - this.tPrev; this.tPrev = now;
    const prev = this.ema.get(name);
    if (prev === undefined) { this.ema.set(name, d); this.order.push(name); } else this.ema.set(name, prev * 0.9 + d * 0.1);
  }
  end(show: boolean, fps?: number) {
    const total = performance.now() - this.t0;
    this.frameEma = this.frameEma * 0.9 + total * 0.1;
    if (!show) { if (this.el) { this.el.remove(); this.el = undefined; } return; }
    const now = performance.now();
    if (now - this.lastDraw < 250) return;
    this.lastDraw = now;
    if (!this.el) { this.el = document.createElement("pre"); this.el.id = "perf"; document.getElementById("app")!.append(this.el); }
    const rows = this.order.map((k) => `${k.padEnd(10)} ${this.ema.get(k)!.toFixed(2).padStart(6)} ms`);
    this.el.textContent = `main loop ${this.frameEma.toFixed(2)} ms (budget 16.7 @ 60 fps)${fps ? ` · ${fps.toFixed(0)} fps` : ""}\n` + rows.join("\n");
  }
}
