/** Startup state shared by the launcher, terminal, and local Vite middleware. */
export function lineReader(onLine) {
  let pending = '';
  return chunk => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/); pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line);
  };
}
export function startupTracker(publish, now = Date.now) {
  let state;
  const set = (phase, message, restart = false) => {
    state = { phase, message, startedAt: restart || !state ? now() : state.startedAt, updatedAt: now() };
    publish(state); return state;
  };
  return {
    set,
    get state() { return state; },
    line(line) {
      if (/BUILD FAILED|Compilation failed/.test(line)) return set('error', 'TeamCode build failed. See the terminal for compiler errors; fix the code to retry.');
      if (/runtime listening on ws:/.test(line)) return set('ready', 'Runtime ready. Choose a program, initialize, then start.');
      if (/sim-host pid \d+ port/.test(line)) return set('starting', 'TeamCode build complete. Starting the runtime and discovering programs…');
      if (/^> Task .*compile.*(?:Java|Kotlin)/.test(line)) return set('compiling', `Building TeamCode and runtime: ${line.replace(/^> Task /, '')}`);
    },
  };
}

export function browserLaunch(platform, browser, url, execPath = process.execPath) {
  if (browser?.toLowerCase().endsWith('.js')) return [execPath, [browser, url]];
  if (platform === 'darwin') return ['open', [...(browser && browser !== 'open' ? ['-a', browser] : []), url]];
  if (browser && browser !== 'open') return [browser, [url]];
  return platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
}
