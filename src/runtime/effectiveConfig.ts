/**
 * The configuration TeamCode actually reads at INIT, key by key, with where each value came from (SG-001 in the
 * team's simulator-gap ledger): the robot does not read the packaged asset once a profile has been SAVED on the hub,
 * it reads the saved copy, and a saved copy that predates a key leaves that key missing so the code's parser
 * fallback applies. The twin models that with a per-asset `persisted` document (whole file) that replaces the
 * packaged one as the base; manual (panel / scenario) and bound (twin-bindings) overrides sit on top, as before.
 *
 * Sources, in winning order: bound > manual > persisted > packaged. A key the schema declares that none of them
 * carries is reported as `missing` (value undefined, "parser fallback"), distinct from a key that is present with
 * `null` or `false`. Pure, unit tested.
 */
import type { AssetFile } from "./assetExport";
import { flattenDotted } from "./assetExport";
import { isSchemaFile, schemaFor, type SchemaNode } from "./assetSchema";

export type EffectiveSource = "packaged" | "persisted" | "manual" | "bound" | "missing";
export interface EffectiveEntry { value: unknown; source: EffectiveSource; note?: string }
export type EffectiveConfig = Record<string, Record<string, EffectiveEntry>>;

/** Keys TeamCode treats as shooter calibration: a binding on any of them means the run uses the twin's solver as the
 * calibration (synthetic), not a measurement made on the robot. */
export const CALIBRATION_KEY = /^tagTracking\.(shotRangeIn|shotPower|shotTable|powerTable|launchAngleDeg|launchAngleMeasured|exitHeightIn|targetHeightIn|minShotRangeIn|minPower|maxPower)$/;

export interface ProfileSummary {
  /** `persisted` when at least one asset is read from a saved hub document, else `clean-install` */
  mode: "persisted" | "clean-install";
  persistedAssets: string[];
  /** asset -> schema keys no source carries (the code's parser fallback decides their value) */
  missing: Record<string, string[]>;
  /** calibration keys a binding supplies: the run's shot calibration is synthetic (twin solver), not measured */
  boundCalibration: string[];
  calibration: "synthetic (twin bindings)" | "as configured (no bound calibration keys)";
}

/** Dotted leaf keys a schema declares (objects with `properties` are descended; arrays and free-form objects are leaves). */
export function schemaLeafKeys(schema: SchemaNode | undefined, prefix = "", out: string[] = []): string[] {
  if (!schema?.properties) return out;
  for (const [k, node] of Object.entries(schema.properties)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (node && typeof node === "object" && node.properties) schemaLeafKeys(node, key, out); else out.push(key);
  }
  return out;
}

export function effectiveConfig(
  files: AssetFile[],
  persisted: Record<string, Record<string, unknown>> = {},
  manual: Record<string, Record<string, unknown>> = {},
  bound: Record<string, Record<string, unknown>> = {},
): { effective: EffectiveConfig; profile: ProfileSummary } {
  const effective: EffectiveConfig = {};
  const missing: Record<string, string[]> = {};
  const boundCalibration: string[] = [];
  for (const a of files) {
    if (!a.path.endsWith(".json") || isSchemaFile(a.path)) continue;
    let packaged: Record<string, unknown> = {};
    try { packaged = flattenDotted(JSON.parse(a.text)); } catch { continue; }
    const saved = persisted[a.path];
    const base = saved ? flattenDotted(saved) : packaged;
    const baseSource: EffectiveSource = saved ? "persisted" : "packaged";
    const m = manual[a.path] ?? {}, b = bound[a.path] ?? {};
    const file: Record<string, EffectiveEntry> = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(m), ...Object.keys(b)])) {
      file[k] = k in b ? { value: b[k], source: "bound" } : k in m ? { value: m[k], source: "manual" } : { value: base[k], source: baseSource };
      if (file[k].source === "bound" && CALIBRATION_KEY.test(k)) boundCalibration.push(`${a.path.replace(/^.*\//, "")} ${k}`);
    }
    // keys the saved copy never had: present in the schema (or in the packaged file this build ships) but in no source
    const declared = new Set([...schemaLeafKeys(schemaFor(files, a.path)), ...(saved ? Object.keys(packaged) : [])]);
    for (const k of declared) if (!(k in file) && !Object.keys(file).some((have) => have.startsWith(k + "."))) {
      file[k] = { value: undefined, source: "missing", note: saved ? "not in the saved hub profile: the code's parser fallback applies" : "not in the packaged file: the code's parser fallback applies" };
      (missing[a.path] ??= []).push(k);
    }
    effective[a.path] = file;
  }
  const persistedAssets = Object.keys(persisted).filter((p) => files.some((f) => f.path === p));
  return {
    effective,
    profile: {
      mode: persistedAssets.length ? "persisted" : "clean-install",
      persistedAssets,
      missing,
      boundCalibration,
      calibration: boundCalibration.length ? "synthetic (twin bindings)" : "as configured (no bound calibration keys)",
    },
  };
}

/** Build a saved-hub-profile document from a base document: drop keys (dotted) a profile saved before they existed
 * would not have, and set others to what that old build wrote. Used by the panel and by twin-test's `persisted`. */
export function derivePersisted(base: Record<string, unknown>, drop: string[] = [], set: Record<string, unknown> = {}): Record<string, unknown> {
  const doc = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const key of drop) {
    const parts = key.split("."); let o: any = doc;
    for (const p of parts.slice(0, -1)) { o = o?.[p]; if (!o || typeof o !== "object") break; }
    if (o && typeof o === "object") delete o[parts[parts.length - 1]];
  }
  for (const [key, value] of Object.entries(set)) {
    const parts = key.split("."); let o: any = doc;
    for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== "object") o[p] = {}; o = o[p]; }
    o[parts[parts.length - 1]] = value;
  }
  return doc;
}
