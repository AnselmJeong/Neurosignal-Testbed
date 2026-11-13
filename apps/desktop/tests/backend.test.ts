import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Backend, LogRing, READY_TIMEOUT_MS, STOP_GRACE_MS, SYSTEM_PATH, backendCandidates, backendCommand, backendEnv,
  externalUrl, isAllowedNavigation, locateBackend, navigationRules, openLogFile, parseReadyLine,
} from '../src/bun/backend';
import { errorPageHtml, escapeHtml, parseHostAction } from '../src/bun/pages';

const scratch = await mkdtemp(join(tmpdir(), 'nst-desktop-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe('READY line', () => {
  test('parses the exact backend format', () => {
    expect(parseReadyLine('NEUROSIGNAL_READY {"port": 58518, "pid": 81077, "version": "0.2.5"}'))
      .toEqual({ port: 58518, pid: 81077, version: '0.2.5' });
    expect(parseReadyLine('NEUROSIGNAL_READY {"port": 1, "pid": 2, "version": "1.0.0rc1"}\r')?.port).toBe(1);
  });
  test('rejects anything else', () => {
    for (const line of ['', 'INFO: Uvicorn running', 'NEUROSIGNAL_READY', 'NEUROSIGNAL_READY {bad json',
      'NEUROSIGNAL_READY {"port": 0, "pid": 2, "version": "x"}', 'NEUROSIGNAL_READY {"port": 70000, "pid": 2, "version": "x"}',
      'NEUROSIGNAL_READY {"port": 80.5, "pid": 2, "version": "x"}', 'NEUROSIGNAL_READY {"port": "80", "pid": 2, "version": "x"}',
      'NEUROSIGNAL_READY {"port": 80, "version": "x"}', 'NEUROSIGNAL_READY {"port": 80, "pid": 2, "version": ""}',
      'NEUROSIGNAL_READY null', 'BIOART_READY {"port": 80, "pid": 2, "version": "x"}'])
      expect(parseReadyLine(line)).toBeNull();
  });
});

describe('backend location', () => {
  const files = (paths: string[]) => { const set = new Set(paths); return (p: string) => set.has(p); };
  const res = '/Apps/Neurosignal Testbed.app/Contents/Resources/app';
  const repo = '/src/Neurosignal-Testbed';
  const repoFiles = [`${repo}/pyproject.toml`, `${repo}/apps/api`, `${repo}/.venv/bin/python`, `${repo}/apps/web/dist/index.html`];

  test('packaged runtime comes first and uses the real python3.12 binary', () => {
    const exists = files([`${res}/python-runtime/python/bin/python3.12`, `${res}/web/index.html`, ...repoFiles]);
    const location = locateBackend({ appResources: res, projectRoot: repo, exists });
    expect(location).toEqual({ kind: 'packaged', python: `${res}/python-runtime/python/bin/python3.12`, webDir: `${res}/web`, cwd: res });
  });
  test('dev falls back to the repo .venv via NEUROSIGNAL_PROJECT_ROOT', () => {
    const location = locateBackend({ appResources: res, projectRoot: repo, exists: files(repoFiles) });
    expect(location).toEqual({ kind: 'dev', python: `${repo}/.venv/bin/python`, webDir: `${repo}/apps/web/dist`, cwd: repo });
  });
  test('dev root is discovered by walking up to the pyproject.toml + apps/api sentinel', () => {
    const candidates = backendCandidates({ appResources: res, searchFrom: [`${repo}/apps/desktop/build/dev-macos-arm64/x.app/Contents/MacOS`], exists: files(repoFiles) });
    expect(candidates.map(c => c.kind)).toEqual(['packaged', 'dev']);
    expect(candidates[1]?.cwd).toBe(repo);
  });
  test('a root without the sentinel is ignored; nothing found means null', () => {
    const exists = files([`/elsewhere/pyproject.toml`, `/elsewhere/.venv/bin/python`]);
    expect(backendCandidates({ appResources: res, projectRoot: '/elsewhere', exists }).map(c => c.kind)).toEqual(['packaged']);
    expect(locateBackend({ appResources: res, projectRoot: '/elsewhere', exists })).toBeNull();
  });
  test('missing web build leaves webDir undefined', () => {
    const exists = files([`${res}/python-runtime/python/bin/python3.12`]);
    expect(locateBackend({ appResources: res, exists })?.webDir).toBeUndefined();
  });
});

describe('launcher contract', () => {
  const data = '/Users/u/Library/Application Support/local.neurosignal.testbed/stable';
  test('env is one explicit list under the data dir with a system PATH', () => {
    const env = backendEnv(data, { HOME: '/Users/u', PATH: '/opt/homebrew/bin:/usr/bin', PYTHONPATH: '/x', VIRTUAL_ENV: '/v', TMPDIR: '/tmp/x/' });
    expect(env).toEqual({
      HOME: '/Users/u', TMPDIR: '/tmp/x/', LANG: 'en_US.UTF-8', PATH: SYSTEM_PATH,
      NEUROSIGNAL_BENCHMARK_ROOT: data,
      NEUROSIGNAL_PROJECTS_DIR: `${data}/projects`,
      NUMBA_CACHE_DIR: `${data}/cache/numba`,
      MPLCONFIGDIR: `${data}/cache/matplotlib`,
      TVB_USER_HOME: `${data}/tvb`,
      MNE_DONTWRITE_HOME: 'true',
      MNE_DATA: `${data}/mne_data`,
      MPLBACKEND: 'Agg',
      PYTHONUNBUFFERED: '1',
      PYTHONNOUSERSITE: '1',
    });
    expect(backendEnv(data, {}, { EXTRA: '1' })['EXTRA']).toBe('1');
  });
  test('command runs the module isolated with the agreed flags', () => {
    expect(backendCommand({ python: '/r/python3.12', webDir: '/r/web' }, data, 42)).toEqual([
      '/r/python3.12', '-I', '-u', '-m', 'neurobridge_api.desktop', '--data-dir', data, '--port', '0',
      '--parent-pid', '42', '--ready-stdout', '--web-dir', '/r/web']);
    expect(backendCommand({ python: '/p', webDir: undefined }, data, 1)).not.toContain('--web-dir');
  });
  test('timeouts cover a cold first launch and the backend hard-exit window', () => {
    expect(READY_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(STOP_GRACE_MS).toBeGreaterThan(10_000);
  });
});

describe('navigation', () => {
  const origin = 'http://127.0.0.1:51234';
  test('only the running backend origin is allowed', () => {
    for (const url of [`${origin}/`, `${origin}/labs/flow?x=1#a`, origin]) expect(isAllowedNavigation(url, origin)).toBe(true);
    for (const url of ['http://127.0.0.1:51235/', 'http://localhost:51234/', 'https://127.0.0.1:51234/',
      'http://user:pw@127.0.0.1:51234/', 'https://example.org/', 'file:///etc/passwd', 'javascript:alert(1)', 'nonsense'])
      expect(isAllowedNavigation(url, origin)).toBe(false);
    expect(isAllowedNavigation(`${origin}/`, undefined)).toBe(false);
  });
  test('external https links go to the browser; other schemes and own origin do not', () => {
    expect(externalUrl('https://mne.tools/stable/index.html', origin)).toBe('https://mne.tools/stable/index.html');
    for (const url of [`${origin}/x`, 'http://example.org/', 'file:///etc/passwd', 'javascript:alert(1)',
      'https://user:secret@example.org/', 'mailto:a@b.c', ''])
      expect(externalUrl(url, origin)).toBeNull();
  });
  test('native rules block everything except the backend (last match wins)', () => {
    expect(navigationRules(origin)).toEqual(['^*', origin, `${origin}/*`]);
    expect(navigationRules(undefined)[0]).toBe('^*');
    expect(navigationRules(undefined)).toContain('views://loading/*');
  });
});

describe('log ring buffer', () => {
  test('keeps the last N lines and truncates huge lines', () => {
    const ring = new LogRing(3, 5);
    for (const line of ['a', 'b', 'c', 'd', '0123456789']) ring.push(line);
    expect(ring.size).toBe(3);
    expect(ring.tail(2)).toEqual(['d', '01234…']);
    expect(ring.tail(10)).toEqual(['c', 'd', '01234…']);
    expect(ring.tail(0)).toEqual([]);
    ring.clear();
    expect(ring.tail()).toEqual([]);
  });
  test('log file appends and rotates once when oversized', async () => {
    const path = join(scratch, 'logs', 'backend.log');
    const first = openLogFile(path, 10);
    first.write('0123456789abcdef\n');
    await new Promise(done => first.end(done));
    const second = openLogFile(path, 10);
    second.write('new\n');
    await new Promise(done => second.end(done));
    expect(await readFile(path, 'utf8')).toBe('new\n');
    expect(await readFile(`${path}.1`, 'utf8')).toBe('0123456789abcdef\n');
  });
});

describe('error page', () => {
  test('escapes message and log tail and wires the restart action', () => {
    const html = errorPageHtml('<b>종료</b>', ['Traceback <script>x</script>'], '/tmp/a&b/backend.log');
    expect(html).toContain('&lt;b&gt;종료&lt;/b&gt;');
    expect(html).toContain('Traceback &lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('/tmp/a&amp;b/backend.log');
    expect(html).toContain('재시작');
    expect(escapeHtml(`"'`)).toBe('&quot;&#39;');
  });
  test('host messages accept only restart/logs', () => {
    expect(parseHostAction('{"action":"restart"}')).toBe('restart');
    expect(parseHostAction({ action: 'logs' })).toBe('logs');
    for (const value of ['{"action":"exec"}', 'nope', null, 3, {}]) expect(parseHostAction(value)).toBeNull();
  });
});

describe('supervisor', () => {
  const fakeBackend = async (body: string) => {
    const path = join(scratch, `fake-${Math.random().toString(36).slice(2)}.ts`);
    await writeFile(path, body);
    return path;
  };

  test('waits for READY + health, then stops the child', async () => {
    const script = await fakeBackend(`
      console.error('booting');
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req =>
        new URL(req.url).pathname === '/api/health' ? Response.json({ status: 'ready' }) : new Response('nope', { status: 404 }) });
      console.log('NEUROSIGNAL_READY ' + JSON.stringify({ port: server.port, pid: process.pid, version: '9.9.9' }));
      process.on('SIGTERM', () => { console.error('bye'); process.exit(0); });`);
    const lines: string[] = [];
    let unexpected = false;
    const backend = new Backend({ command: [process.execPath, script], cwd: scratch, env: backendEnv(join(scratch, 'data')),
      log: line => lines.push(line), onExit: () => { unexpected = true; } });
    const ready = await backend.start();
    expect(ready.version).toBe('9.9.9');
    expect(ready.origin).toBe(`http://127.0.0.1:${ready.port}`);
    expect((await fetch(`${ready.origin}/api/health`)).status).toBe(200);
    expect(backend.running).toBe(true);
    await backend.stop();
    expect(backend.running).toBe(false);
    expect(unexpected).toBe(false);
    expect(lines).toContain('booting');
  });

  test('early exit rejects with a Korean error and keeps stderr', async () => {
    const script = await fakeBackend(`console.error('ImportError: boom'); process.exit(3);`);
    const lines: string[] = [];
    const backend = new Backend({ command: [process.execPath, script], cwd: scratch, env: {}, log: line => lines.push(line), onExit: () => {} });
    await expect(backend.start()).rejects.toThrow('종료 코드 3');
    expect(lines).toContain('ImportError: boom');
  });

  test('times out without READY and kills a child that ignores SIGTERM', async () => {
    const script = await fakeBackend(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
    const backend = new Backend({ command: [process.execPath, script], cwd: scratch, env: {}, log: () => {}, onExit: () => {},
      readyTimeoutMs: 300, stopGraceMs: 300 });
    await expect(backend.start()).rejects.toThrow('초 안에 준비되지 않았습니다');
    expect(backend.running).toBe(false);
  });

  test('reports a crash after READY through onExit', async () => {
    const script = await fakeBackend(`
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ status: 'ready' }) });
      console.log('NEUROSIGNAL_READY ' + JSON.stringify({ port: server.port, pid: process.pid, version: '1' }));
      setTimeout(() => process.exit(7), 300);`);
    const exited = Promise.withResolvers<number | null>();
    const backend = new Backend({ command: [process.execPath, script], cwd: scratch, env: {}, log: () => {}, onExit: exited.resolve });
    await backend.start();
    expect(await exited.promise).toBe(7);
  });
});
