import { describe, it, expect } from 'vitest';
import { defaultState } from '../src/state';
import { captureConfig, ConfigHistory } from '../src/ui/configHistory';

describe('configuration history', () => {
  it('undoes configuration without rewinding live pose, hive, or automatic RPM', () => {
    const s = defaultState(), h = new ConfigHistory();
    const before = captureConfig(s);
    s.robot.launcher.efficiency = 0.42;
    s.pose.x = 1.4; s.robot.launcher.rpm = 3200; s.hive.red = 'scoring';
    h.record(before, captureConfig(s)); h.undo(s);
    expect(s.robot.launcher.efficiency).toBe(defaultState().robot.launcher.efficiency);
    expect(s.pose.x).toBe(1.4); expect(s.robot.launcher.rpm).toBe(3200); expect(s.hive.red).toBe('scoring');
    h.redo(s); expect(s.robot.launcher.efficiency).toBe(0.42);
  });
  it('restores added and deleted asset overrides and clears redo on a new edit', () => {
    const s = defaultState(), h = new ConfigHistory();
    const before = captureConfig(s); s.assetOverrides['robot.json'] = { power: 0.6 };
    h.record(before, captureConfig(s)); h.undo(s);
    expect(s.assetOverrides).toEqual({}); h.redo(s);
    expect(s.assetOverrides['robot.json'].power).toBe(0.6);
    h.undo(s); const next = captureConfig(s); s.capacity = 6; h.record(next, captureConfig(s));
    expect(h.canRedo).toBe(false);
  });
  it('ignores automatic outputs and view changes when detecting edits', () => {
    const s = defaultState(), h = new ConfigHistory(); const before = captureConfig(s);
    s.robot.launcher.rpm = 4000; s.view = 'top'; s.hive.blue = 'audience';
    h.record(before, captureConfig(s)); expect(h.canUndo).toBe(false);
  });
});
