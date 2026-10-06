/** JSON Schema sidecars for TeamCode assets: `foo.schema.json` next to `foo.json` describes each setting (description,
 * type, enum, minimum/maximum, integer, default) so the settings panel can show help, offer the right control and
 * validate. A pragmatic subset of JSON Schema draft-07 is honoured: properties, items, additionalProperties,
 * patternProperties, type, enum, const, minimum, maximum, exclusiveMinimum/Maximum, multipleOf, default, description,
 * title, readOnly, deprecated, examples. Pure, unit-tested. */
import type { AssetFile } from "./assetExport";

export interface SchemaNode {
  type?: string | string[];
  description?: string;
  title?: string;
  enum?: unknown[];
  const?: unknown;
  minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; multipleOf?: number;
  default?: unknown;
  examples?: unknown[];
  readOnly?: boolean;
  deprecated?: boolean;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: SchemaNode | boolean;
  patternProperties?: Record<string, SchemaNode>;
  [k: string]: unknown;
}

export const isSchemaFile = (path: string) => path.endsWith(".schema.json");
export const schemaPathFor = (assetPath: string) => assetPath.replace(/\.json$/, ".schema.json");

/** The parsed schema for an asset, if a sidecar exists and parses. */
export function schemaFor(files: AssetFile[], assetPath: string): SchemaNode | undefined {
  const f = files.find((x) => x.path === schemaPathFor(assetPath));
  if (!f) return undefined;
  try { const j = JSON.parse(f.text); return j && typeof j === "object" ? (j as SchemaNode) : undefined; } catch { return undefined; }
}

/** The schema node for a dotted key (array indices as `name.0`), following properties / items / additional / pattern. */
export function nodeAt(schema: SchemaNode | undefined, key: string): SchemaNode | undefined {
  let node: SchemaNode | undefined = schema;
  if (!node) return undefined;
  if (key === "") return node;
  for (const part of key.split(".")) {
    if (!node) return undefined;
    let next: SchemaNode | undefined;
    if (/^\d+$/.test(part) && node.items) next = node.items;
    else if (node.properties && part in node.properties) next = node.properties[part];
    else if (node.patternProperties) { for (const [re, sub] of Object.entries(node.patternProperties)) if (new RegExp(re).test(part)) { next = sub; break; } }
    if (!next && node.additionalProperties && typeof node.additionalProperties === "object") next = node.additionalProperties;
    node = next;
  }
  return node;
}

const typesOf = (n: SchemaNode): string[] => (n.type === undefined ? [] : Array.isArray(n.type) ? n.type : [n.type]);
export const nullable = (n: SchemaNode) => typesOf(n).includes("null");
export const isNumeric = (n: SchemaNode) => typesOf(n).some((t) => t === "number" || t === "integer") || (n.enum !== undefined && n.enum.every((v) => typeof v === "number" || v === null) && n.enum.some((v) => typeof v === "number"));
export const isInteger = (n: SchemaNode) => typesOf(n).includes("integer");
export const hasRange = (n: SchemaNode) => (n.minimum ?? n.exclusiveMinimum) !== undefined && (n.maximum ?? n.exclusiveMaximum) !== undefined;

/** Error text when `value` violates the node; undefined when it fits (or there is no schema). */
export function validate(node: SchemaNode | undefined, value: unknown): string | undefined {
  if (!node) return undefined;
  if (value === null) return nullable(node) || typesOf(node).length === 0 || node.enum?.includes(null) ? undefined : "null is not allowed here";
  if (node.const !== undefined && JSON.stringify(value) !== JSON.stringify(node.const)) return `must be ${JSON.stringify(node.const)}`;
  if (node.enum && !node.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return `one of ${node.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  const types = typesOf(node).filter((t) => t !== "null");
  if (types.length) {
    const actual = Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return `expected ${types.join(" or ")}, got ${actual}`;
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) return `minimum ${node.minimum}`;
    if (node.maximum !== undefined && value > node.maximum) return `maximum ${node.maximum}`;
    if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum) return `must be above ${node.exclusiveMinimum}`;
    if (node.exclusiveMaximum !== undefined && value >= node.exclusiveMaximum) return `must be below ${node.exclusiveMaximum}`;
    if (node.multipleOf !== undefined && Math.abs(value / node.multipleOf - Math.round(value / node.multipleOf)) > 1e-9) return `multiple of ${node.multipleOf}`;
  }
  return undefined;
}

/** One-line constraint summary for the help text, e.g. "0.1 – 0.5 · default 0.3" or "one of LEFT, RIGHT". */
export function constraintText(node: SchemaNode | undefined): string {
  if (!node) return "";
  const parts: string[] = [];
  if (node.enum) parts.push(`one of ${node.enum.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(", ")}`);
  else {
    const lo = node.minimum ?? node.exclusiveMinimum, hi = node.maximum ?? node.exclusiveMaximum;
    if (lo !== undefined || hi !== undefined) parts.push(`${lo !== undefined ? (node.minimum === undefined ? ">" : "") + lo : "…"} – ${hi !== undefined ? (node.maximum === undefined ? "<" : "") + hi : "…"}`);
    if (isInteger(node)) parts.push("whole number");
  }
  if (node.default !== undefined) parts.push(`default ${typeof node.default === "string" ? node.default : JSON.stringify(node.default)}`);
  if (nullable(node)) parts.push("null allowed");
  if (node.readOnly) parts.push("read-only");
  if (node.deprecated) parts.push("deprecated");
  return parts.join(" · ");
}

/** Text the settings filter should match for a key: name, description, title, enum values. */
export function searchText(key: string, node: SchemaNode | undefined): string {
  return [key, node?.title ?? "", node?.description ?? "", ...(node?.enum ?? []).map((e) => String(e))].join(" ").toLowerCase();
}

/** Every leaf key in an asset that violates its schema: for a file-level badge and for agents. */
export function validateAll(json: unknown, schema: SchemaNode | undefined): { key: string; error: string }[] {
  const out: { key: string; error: string }[] = [];
  if (!schema) return out;
  const walk = (v: unknown, key: string) => {
    if (v && typeof v === "object" && !Array.isArray(v)) { for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, key ? `${key}.${k}` : k); return; }
    const e = validate(nodeAt(schema, key), v);
    if (e) out.push({ key, error: e });
  };
  walk(json, "");
  return out;
}
