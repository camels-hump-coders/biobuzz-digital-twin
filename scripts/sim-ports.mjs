import { createServer } from 'node:net';

export function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

// The agent API uses the port immediately after the WebSocket runtime.
export async function selectHostPort(value, explicit = false, available = portAvailable) {
  const first = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(first) || first < 1 || first > 65534) {
    throw new Error('--host-port must be an integer between 1 and 65534 (the agent API uses the next port).');
  }
  for (let port = first; port <= Math.min(65534, first + (explicit ? 0 : 100)); port += 2) {
    if (await available(port) && await available(port + 1)) return String(port);
  }
  throw new Error(explicit
    ? `Runtime/API ports ${first}/${first + 1} are unavailable. Stop the process using them or choose another pair with --host-port <port>.`
    : `No available runtime/API port pair near ${first}. Choose another pair with --host-port <port>.`);
}
