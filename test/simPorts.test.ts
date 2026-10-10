import { test, expect } from 'vitest';
import { createServer } from 'node:net';
import { portAvailable, selectHostPort } from '../scripts/sim-ports.mjs';

test('default skips pairs with either runtime or API port occupied', async () => {
  const occupied = new Set([8765, 8768]);
  expect(await selectHostPort('8765', false, async p => !occupied.has(p))).toBe('8769');
  expect(await selectHostPort('8765', false, async () => true)).toBe('8765');
});

test('explicit ports fail clearly and invalid ports are rejected', async () => {
  await expect(selectHostPort('8765', true, async p => p !== 8766)).rejects.toThrow('8765/8766 are unavailable');
  for (const value of [undefined, '0', '65535', 'abc', '8765.5']) {
    await expect(selectHostPort(value)).rejects.toThrow('integer between');
  }
});

test('availability probe detects a real listener and releases its own socket', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try { expect(await portAvailable(port)).toBe(false); }
  finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  expect(await portAvailable(port)).toBe(true);
  expect(await portAvailable(port)).toBe(true);
});
