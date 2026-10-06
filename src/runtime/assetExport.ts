/** Export TeamCode JSON assets with the twin's overrides applied, in the file's own format, ready to commit.
 * Mirrors the shim's AssetManager merge (dotted keys, intermediate objects created, null kept) but preserves the
 * file's key order, indentation and trailing newline so the diff in the team repo shows only the changed values. */

export interface AssetFile { path: string; text: string }

/** Indentation the file uses: a run of spaces or a tab from its first indented line; two spaces when there is none. */
export function detectIndent(text: string): string {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : "  ";
}

/** Set `value` at the dotted `key` inside `obj`, creating objects on the way (same semantics as the shim). */
export function putDotted(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = o[parts[i]];
    if (!next || typeof next !== "object" || Array.isArray(next)) { const fresh: Record<string, unknown> = {}; o[parts[i]] = fresh; o = fresh; }
    else o = next as Record<string, unknown>;
  }
  o[parts[parts.length - 1]] = value === undefined ? null : value;
}

export function getDotted(obj: unknown, key: string): unknown {
  let o: unknown = obj;
  for (const p of key.split(".")) { if (!o || typeof o !== "object") return undefined; o = (o as Record<string, unknown>)[p]; }
  return o;
}

export interface ExportedAsset {
  path: string;
  /** merged file text in the original format */
  text: string;
  /** dotted keys whose value differs from the committed file */
  changed: { key: string; from: unknown; to: unknown; source: "manual" | "twin" }[];
}

/** Merge the overrides into the file. `bound` (twin bindings) wins over `manual`, as it does at INIT. */
export function applyOverrides(file: AssetFile, manual: Record<string, unknown> = {}, bound: Record<string, unknown> = {}): ExportedAsset {
  const json = JSON.parse(file.text) as Record<string, unknown>;
  const changed: ExportedAsset["changed"] = [];
  const all: [string, unknown, "manual" | "twin"][] = [...Object.entries(manual).map(([k, v]) => [k, v, "manual"] as [string, unknown, "manual"]), ...Object.entries(bound).map(([k, v]) => [k, v, "twin"] as [string, unknown, "twin"])];
  for (const [key, value, source] of all) {
    const from = getDotted(json, key);
    if (JSON.stringify(from) === JSON.stringify(value ?? null)) continue;
    putDotted(json, key, value);
    const i = changed.findIndex((c) => c.key === key);
    const rec = { key, from, to: value ?? null, source };
    if (i >= 0) changed[i] = { ...rec, from: changed[i].from }; else changed.push(rec);
  }
  // patch the original text value by value, so untouched lines stay byte-identical (1.0 stays 1.0, arrays keep their
  // layout); fall back to re-serialising only when a value cannot be located
  const text = patchJsonText(file.text, changed.map((c) => ({ key: c.key, value: c.to })));
  return { path: file.path, text, changed };
}

/** Spans of every member value in a JSON text, by dotted path, plus each object's span (for inserting new keys). */
function jsonSpans(text: string): { values: Map<string, [number, number]>; objects: Map<string, [number, number]> } {
  const values = new Map<string, [number, number]>(), objects = new Map<string, [number, number]>();
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = (): string => { // at opening quote
    let j = i + 1, out = "";
    while (j < text.length && text[j] !== '"') { if (text[j] === "\\") { out += text[j] + text[j + 1]; j += 2; } else out += text[j++]; }
    i = j + 1;
    return JSON.parse('"' + out + '"');
  };
  const value = (path: string): void => {
    ws();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++; ws();
      if (text[i] === "}") i++;
      else for (;;) { ws(); const k = str(); ws(); i++; /* : */ value(path ? `${path}.${k}` : k); ws(); if (text[i] === ",") { i++; continue; } i++; /* } */ break; }
      objects.set(path, [start, i]);
    } else if (c === "[") {
      i++; ws();
      if (text[i] === "]") i++;
      else for (;;) { value(path + "[]"); ws(); if (text[i] === ",") { i++; continue; } i++; break; }
    } else if (c === '"') str();
    else { while (i < text.length && !/[\s,\]}]/.test(text[i])) i++; }
    if (path && !path.endsWith("[]")) values.set(path, [start, i]);
  };
  value("");
  return { values, objects };
}

/** Write new values into the JSON text in place. Keys that do not exist yet are appended to their parent object with
 * the parent's indentation; if even the parent is missing, the text is re-serialised with the file's indentation. */
export function patchJsonText(text: string, edits: { key: string; value: unknown }[]): string {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  let out = text;
  let fallback = false;
  // apply from the end of the text backwards so earlier spans stay valid; recompute spans after each insertion
  const pending = [...edits];
  while (pending.length) {
    const { values, objects } = jsonSpans(out);
    // pick the edit whose target sits latest in the text
    let best = -1, bestPos = -1;
    pending.forEach((e, idx) => { const span = values.get(e.key); const parent = e.key.includes(".") ? e.key.slice(0, e.key.lastIndexOf(".")) : ""; const obj = objects.get(parent); const pos = span ? span[0] : obj ? obj[1] : -1; if (pos > bestPos) { bestPos = pos; best = idx; } });
    if (best < 0) { fallback = true; break; }
    const e = pending.splice(best, 1)[0];
    const lit = JSON.stringify(e.value ?? null);
    const span = values.get(e.key);
    if (span) { out = out.slice(0, span[0]) + lit + out.slice(span[1]); continue; }
    const parent = e.key.includes(".") ? e.key.slice(0, e.key.lastIndexOf(".")) : "";
    const obj = objects.get(parent)!;
    const name = e.key.slice(parent ? parent.length + 1 : 0);
    const body = out.slice(obj[0] + 1, obj[1] - 1);
    const empty = body.trim() === "";
    const indentM = /\n([ \t]*)"/.exec(body);
    const indent = indentM ? indentM[1] : (/\n([ \t]*)$/.exec(out.slice(0, obj[0]))?.[1] ?? "") + detectIndent(out);
    const closeIndent = /\n([ \t]*)$/.exec(body)?.[1] ?? "";
    const insert = (empty ? "" : (body.trimEnd() === body ? "," : ",")) + eol + indent + JSON.stringify(name) + ": " + lit;
    const cut = obj[1] - 1 - (body.length - body.trimEnd().length); // before the closing brace's preceding whitespace
    out = out.slice(0, cut) + insert + eol + closeIndent + out.slice(obj[1] - 1);
  }
  if (fallback) {
    const json = JSON.parse(text) as Record<string, unknown>;
    for (const e of edits) putDotted(json, e.key, e.value);
    out = JSON.stringify(json, null, detectIndent(text)).replace(/\n/g, eol) + (/\n$/.test(text) ? eol : "");
  }
  return out;
}

/** Every asset that would differ from its committed file once the overrides are applied. */
export function exportChangedAssets(files: AssetFile[], manual: Record<string, Record<string, unknown>>, bound: Record<string, Record<string, unknown>>): ExportedAsset[] {
  const out: ExportedAsset[] = [];
  for (const f of files) {
    if (!f.path.endsWith(".json")) continue;
    try {
      const e = applyOverrides(f, manual[f.path], bound[f.path]);
      if (e.changed.length) out.push(e);
    } catch { /* not JSON: nothing to export */ }
  }
  return out;
}

/** Trigger a browser download of `text` named after the asset's file name. */
export function downloadText(name: string, text: string, type = "application/json"): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Flatten a nested object into dotted keys (arrays stay whole, as the override merge treats them as values). */
export function flattenDotted(obj: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenDotted(v as Record<string, unknown>, key, out); else out[key] = v;
  }
  return out;
}

/** Parse settings a person pasted from an agent's message: a JSON object, a JSON fragment of `"key": value,` lines
 * (trailing commas, comments and prose around it tolerated), or `key: value` / `key = value` lines. Returns dotted
 * keys. A leading `path/to/file.json` or a line mentioning one is returned as `asset`. */
export function parsePastedSettings(text: string): { asset?: string; values: Record<string, unknown> } {
  const assetM = /([\w./-]+\.json)/.exec(text);
  const asset = assetM ? assetM[1] : undefined;
  const tryJson = (t: string): Record<string, unknown> | undefined => { try { const j = JSON.parse(t); return j && typeof j === "object" && !Array.isArray(j) ? j : undefined; } catch { return undefined; } };
  let obj = tryJson(text.trim());
  if (!obj) {
    // keep only lines that look like assignments; strip comments and trailing commas; wrap in braces
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim()).filter((l) => /^"?[\w.[\]-]+"?\s*[:=]/.test(l));
    const norm = lines.map((l) => {
      const m = /^"?([\w.[\]-]+)"?\s*[:=]\s*(.*?)[,;]?\s*$/.exec(l);
      if (!m) return "";
      let v = m[2].trim();
      if (!/^(".*"|-?\d+(\.\d+)?([eE][-+]?\d+)?|true|false|null|\[.*\]|\{.*\})$/.test(v)) v = JSON.stringify(v.replace(/^'(.*)'$/, "$1"));
      return `"${m[1]}": ${v}`;
    }).filter(Boolean);
    obj = tryJson(`{${norm.join(",")}}`);
  }
  return { asset, values: obj ? flattenDotted(obj) : {} };
}

/** Which asset file the pasted keys belong to: the one whose JSON already has most of them; undefined when none match. */
export function guessAssetFor(keys: string[], files: AssetFile[]): string | undefined {
  let best: { path: string; n: number } | undefined;
  for (const f of files) {
    if (!f.path.endsWith(".json")) continue;
    let json: unknown; try { json = JSON.parse(f.text); } catch { continue; }
    // a key matches when it exists, or when its parent object exists (new key under a known section)
    const n = keys.filter((k) => getDotted(json, k) !== undefined || (k.includes(".") && getDotted(json, k.slice(0, k.lastIndexOf("."))) !== undefined)).length;
    if (n > 0 && (!best || n > best.n)) best = { path: f.path, n };
  }
  return best?.path;
}
