import { settingsForFile, type AppState } from '../state';

/** History tracks configuration only. Replaying an edit never rewinds live physics or view preferences. */
const keys = ['robotPresetId', 'robot', 'noise', 'hardware', 'capacity', 'canPollen', 'canNectar', 'autoRpm', 'autoHood', 'drag', 'monteCarloN', 'tagNoiseIn', 'assetOverrides', 'starts', 'calibration', 'tipMassG', 'autoTip'] as const;
export type ConfigSnapshot = Record<string, unknown>;
export function captureConfig(state: AppState): ConfigSnapshot {
  const settings = settingsForFile(state);
  return structuredClone(Object.fromEntries(keys.map(key => [key, settings[key]])));
}
export interface Edit { path: string[]; before: unknown; after: unknown }
export function editsBetween(before: ConfigSnapshot, after: ConfigSnapshot, path: string[] = []): Edit[] {
  const edits: Edit[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key], b = after[key], here = [...path, key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) edits.push(...editsBetween(a as ConfigSnapshot, b as ConfigSnapshot, here));
    else edits.push({ path: here, before: a, after: b });
  }
  return edits;
}
export function applyEdits(state: AppState, edits: Edit[], direction: 'before' | 'after') {
  for (const edit of edits) {
    let target = state as unknown as Record<string, any>;
    for (const part of edit.path.slice(0, -1)) target = target[part] ??= {};
    const key = edit.path.at(-1)!;
    if (edit[direction] === undefined && edit.path.join('.') === 'robot.launcher.rpm') continue;
    if (edit[direction] === undefined && edit.path.join('.') === 'robot.launcher.elevationDeg') continue;
    if (edit[direction] === undefined) delete target[key];
    else target[key] = structuredClone(edit[direction]);
  }
}
export class ConfigHistory {
  private past: Edit[][] = [];
  private future: Edit[][] = [];
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  record(before: ConfigSnapshot, after: ConfigSnapshot) {
    const edits = editsBetween(before, after);
    if (edits.length) { this.past.push(edits); this.past = this.past.slice(-30); this.future = []; }
  }
  undo(state: AppState) { const edits = this.past.pop(); if (edits) { applyEdits(state, edits, 'before'); this.future.push(edits); } }
  redo(state: AppState) { const edits = this.future.pop(); if (edits) { applyEdits(state, edits, 'after'); this.past.push(edits); } }
}
