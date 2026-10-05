/**
 * Timeline recorder: keeps the last minutes of what happened (telemetry, status, host log lines, button presses, pose,
 * match state) in a ring buffer so you can scrub back, read a moment calmly, and copy a snapshot for a teammate or an
 * agent to debug from.
 */
export interface Sample {
  /** wall-clock ms */
  t: number;
  /** simulated match seconds */
  sim: number;
  status: string; opMode: string;
  telemetry: string[];
  pose: { xIn: number; zIn: number; headingDeg: number };
  match: string;
  carrying: string;
  shots: { fired: number; hit: number };
  /** gamepad buttons held this sample (gamepad1 then gamepad2), e.g. "1:guide 2:a" */
  buttons: string;
}
export interface Event { t: number; kind: "status" | "error" | "log" | "button" | "shot" | "foul" | "note" | "hardware"; text: string }

export class Recorder {
  samples: Sample[] = [];
  events: Event[] = [];
  /** when set, the UI shows this wall-clock moment instead of live */
  cursor?: number;
  private readonly maxSamples: number; private readonly maxEvents: number;
  private lastButtons = "";
  private lastStatus = "";
  private lastShots = -1;
  constructor(maxSamples = 6000, maxEvents = 2000) { this.maxSamples = maxSamples; this.maxEvents = maxEvents; }

  push(s: Sample) {
    this.samples.push(s);
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
    // derived events
    if (s.status !== this.lastStatus) { if (this.lastStatus) this.event(s.t, "status", `${s.status}${s.opMode ? " · " + s.opMode : ""}`); this.lastStatus = s.status; }
    if (s.buttons !== this.lastButtons) { if (s.buttons) this.event(s.t, "button", `pressed ${s.buttons}`); this.lastButtons = s.buttons; }
    if (s.shots.fired !== this.lastShots) { if (this.lastShots >= 0) this.event(s.t, "shot", `shot fired (${s.shots.fired} total, ${s.shots.hit} in)`); this.lastShots = s.shots.fired; }
  }
  event(t: number, kind: Event["kind"], text: string) {
    this.events.push({ t, kind, text });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }
  clear() { this.samples = []; this.events = []; this.cursor = undefined; this.lastButtons = ""; this.lastStatus = ""; this.lastShots = -1; }

  get start(): number | undefined { return this.samples[0]?.t; }
  get end(): number | undefined { return this.samples[this.samples.length - 1]?.t; }
  /** the sample at or just before a wall-clock time */
  at(t: number): Sample | undefined {
    let lo = 0, hi = this.samples.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.samples[mid].t <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    return best >= 0 ? this.samples[best] : this.samples[0];
  }
  eventsBetween(a: number, b: number): Event[] { return this.events.filter((e) => e.t >= a && e.t <= b); }

  /** Markdown snapshot of a time window: context, event list, and the telemetry at a few points, ready to paste. */
  snapshot(opts: { from: number; to: number; context: Record<string, unknown>; title?: string }): string {
    const { from, to } = opts;
    const fmt = (t: number) => `${((t - from) / 1000).toFixed(1)}s`;
    const win = this.samples.filter((s) => s.t >= from && s.t <= to);
    const lines: string[] = [];
    lines.push(`# ${opts.title ?? "BIOBUZZ twin snapshot"}`);
    lines.push(`Window: ${new Date(from).toISOString()} → ${new Date(to).toISOString()} (${((to - from) / 1000).toFixed(1)} s, ${win.length} samples)`);
    lines.push("", "## Context", "```json", JSON.stringify(opts.context, null, 2), "```");
    lines.push("", "## Events");
    const evs = this.eventsBetween(from, to);
    if (!evs.length) lines.push("(none)");
    for (const e of evs) lines.push(`- ${fmt(e.t)} [${e.kind}] ${e.text}`);
    lines.push("", "## Telemetry over time");
    // telemetry at the start, every change (deduplicated), and the end: enough to see the story without the flood
    let last = "";
    let shown = 0;
    for (const s of win) {
      const key = s.telemetry.join("\n");
      const isEdge = s === win[0] || s === win[win.length - 1];
      if (key === last && !isEdge) continue;
      last = key;
      if (++shown > 60 && !isEdge) continue;
      lines.push(`### ${fmt(s.t)} · ${s.status}${s.opMode ? " " + s.opMode : ""} · pose (${s.pose.xIn.toFixed(1)}, ${s.pose.zIn.toFixed(1)}) in @ ${s.pose.headingDeg.toFixed(0)}° · ${s.match} · ${s.carrying}${s.buttons ? " · buttons " + s.buttons : ""}`);
      lines.push("```", ...(s.telemetry.length ? s.telemetry : ["(no telemetry)"]), "```");
    }
    if (shown > 60) lines.push(`(…${shown - 60} more telemetry changes omitted; download the full log for everything)`);
    return lines.join("\n");
  }
}
