import { test } from 'vitest';
import assert from 'node:assert/strict';
import { lineReader, startupTracker, browserLaunch } from '../scripts/sim-startup.mjs';
test('split host output preserves startup and readiness events', () => {
  const states=[]; const tracker=startupTracker(s=>states.push(s),()=>1000);
  tracker.set('compiling','Building',true);
  const read=lineReader(line=>tracker.line(line));
  read('> Task :team:com'); read('pileJava\nsim-host pid 12 po');
  read('rt 8765\nBIOBUZZ runtime listening on ws:'); read('//127.0.0.1:8765\n');
  assert.deepEqual(states.map(s=>s.phase),['compiling','compiling','starting','ready']);
});
test('failure is surfaced and rebuild starts a new elapsed clock', () => {
  let now=1000; const tracker=startupTracker(()=>{},()=>now);
  tracker.set('compiling','Building',true); tracker.line('BUILD FAILED');
  assert.equal(tracker.state.phase,'error');
  now=5000; tracker.set('compiling','Rebuilding',true);
  assert.equal(tracker.state.startedAt,5000);
});
test('macOS uses the native opener, with explicit browser and script support', () => {
  assert.deepEqual(browserLaunch('darwin',undefined,'http://localhost:5173'),['open',['http://localhost:5173']]);
  assert.deepEqual(browserLaunch('darwin','Google Chrome','http://localhost:5173'),['open',['-a','Google Chrome','http://localhost:5173']]);
  assert.deepEqual(browserLaunch('linux','browser.js','http://localhost:5173','node'),['node',['browser.js','http://localhost:5173']]);
});
