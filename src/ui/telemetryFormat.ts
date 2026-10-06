/** Best-effort classification of free-form telemetry lines so problems stand out in the panel: FTC telemetry is
 * "caption : value" text with no structure, so this matches the words teams and the SDK actually use. Pure, tested. */
export type TelemetryLevel = "err" | "warn" | "ok" | "";

const ERR = /\b(error|errors|exception|fail(ed|ure)?|fault|crash(ed)?|stopped|abort(ed)?|refus(ed|ing)|cannot|can't|could not|unable|not found|missing|invalid|illegal|mismatch|timeout|timed out|disconnected|unsupported|rejected|outputs stopped|stack ?trace)\b/i;
const WARN = /\b(warn(ing)?|waiting|wait for|blocked|stale|fallback|disabled|not ready|unverified|unknown|no target|not visible|out of range|too (far|close|fast|slow)|low battery|retry(ing)?|skipp?(ed|ing)|off)\b/i;
const OK = /\b(ok|ready|done|complete(d)?|parked|locked|centered|streaming|running|connected|verified|armed|fired|scored|success(ful)?|pass(ed)?|enabled|on)\b/i;

/** Level for a line; the caption counts less than the value so "Driver Control error : none" is not an error. */
export function classifyTelemetryLine(line: string): TelemetryLevel {
  const { key, value } = splitTelemetryLine(line);
  const v = value ?? line;
  if (ERR.test(v)) return "err";
  if (key && /\b(error|exception|fault)\b/i.test(key) && !/^(none|no|ok|-|0|false|clear)$/i.test(v.trim())) return "err";
  if (WARN.test(v)) return "warn";
  if (OK.test(v)) return "ok";
  return "";
}

/** FTC telemetry.addData renders "caption : value"; split on the first " : " (or ": ") when present. */
export function splitTelemetryLine(line: string): { key?: string; value?: string } {
  const m = /^(.{1,60}?)\s*:\s(.*)$/s.exec(line);
  if (!m) return {};
  return { key: m[1].trim(), value: m[2] };
}
