// Python backend supervisor for the desktop shell.
// Pure helpers (READY parser, path candidates, launcher env, navigation allow-list, log ring)
// are exported for tests; nothing here imports the Electrobun SDK.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const READY_PREFIX = 'NEUROSIGNAL_READY ';
export const READY_TIMEOUT_MS = 120_000;
export const STOP_GRACE_MS = 12_000;
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const BACKEND_MODULE = 'neurobridge_api.desktop';
/** Packaged layout: build/python-runtime is copied to <Resources>/app/python-runtime. */
export const PACKAGED_PYTHON = ['python-runtime', 'python', 'bin', 'python3.12'] as const;
export const PACKAGED_WEB = 'web';

export type ReadyInfo = { port: number; pid: number; version: string };

/** Parse the backend's single stdout READY line (`NEUROSIGNAL_READY {"port": …, "pid": …, "version": …}`). */
export function parseReadyLine(line: string): ReadyInfo | null {
  const text = line.trim();
  if (!text.startsWith(READY_PREFIX)) return null;
  let data: unknown;
  try { data = JSON.parse(text.slice(READY_PREFIX.length)); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const { port, pid, version } = data as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
  if (typeof version !== 'string' || !version) return null;
  return { port, pid, version };
}

export type BackendLocation = {
  kind: 'packaged' | 'dev';
  python: string;
  /** Built web app (directory containing index.html), if one exists. */
  webDir: string | undefined;
  cwd: string;
};

export type LocateOptions = {
  /** Electrobun app resources dir: join(PATHS.RESOURCES_FOLDER, 'app'). */
  appResources: string;
  /** NEUROSIGNAL_PROJECT_ROOT (dev). */
  projectRoot?: string | undefined;
  /** Directories to walk upwards from when looking for the repo (dev fallback). */
  searchFrom?: string[];
  exists?: (path: string) => boolean;
};

/** Repo sentinel: pyproject.toml + apps/api. */
export function isProjectRoot(dir: string, exists: (path: string) => boolean = existsSync): boolean {
  return exists(join(dir, 'pyproject.toml')) && exists(join(dir, 'apps', 'api'));
}

function* ancestors(start: string): Generator<string> {
  let dir = resolve(start);
  for (;;) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Ordered candidates: packaged runtime first, then the dev repo .venv (explicit root, then discovered). */
export function backendCandidates(options: LocateOptions): BackendLocation[] {
  const exists = options.exists ?? existsSync;
  const candidates: BackendLocation[] = [];
  const packagedWeb = join(options.appResources, PACKAGED_WEB);
  candidates.push({
    kind: 'packaged',
    python: join(options.appResources, ...PACKAGED_PYTHON),
    webDir: exists(join(packagedWeb, 'index.html')) ? packagedWeb : undefined,
    cwd: options.appResources,
  });
  const roots: string[] = [];
  if (options.projectRoot) roots.push(resolve(options.projectRoot));
  for (const start of options.searchFrom ?? []) {
    for (const dir of ancestors(start)) {
      if (isProjectRoot(dir, exists)) { roots.push(dir); break; }
    }
  }
  for (const root of [...new Set(roots)]) {
    if (!isProjectRoot(root, exists)) continue;
    const devWeb = join(root, 'apps', 'web', 'dist');
    candidates.push({
      kind: 'dev',
      // Keep the venv symlink path: resolving it would lose the venv's site-packages.
      python: join(root, '.venv', 'bin', 'python'),
      webDir: exists(join(devWeb, 'index.html')) ? devWeb : undefined,
      cwd: root,
    });
  }
  return candidates;
}

export function locateBackend(options: LocateOptions): BackendLocation | null {
  const exists = options.exists ?? existsSync;
  return backendCandidates(options).find(candidate => exists(candidate.python)) ?? null;
}

/**
 * The single list of environment variables the launcher sets for the backend.
 * Built from scratch (no inherited shell PATH/PYTHONPATH/VIRTUAL_ENV); layout matches
 * neurobridge_api.desktop._configure_environment. Packaging may extend `extra`.
 */
export function backendEnv(dataDir: string, base: Record<string, string | undefined> = process.env,
  extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING']) {
    const value = base[key];
    if (value) env[key] = value;
  }
  env['LANG'] ??= 'en_US.UTF-8';
  Object.assign(env, {
    PATH: SYSTEM_PATH,
    NEUROSIGNAL_BENCHMARK_ROOT: dataDir,
    NEUROSIGNAL_PROJECTS_DIR: join(dataDir, 'projects'),
    NUMBA_CACHE_DIR: join(dataDir, 'cache', 'numba'),
    MPLCONFIGDIR: join(dataDir, 'cache', 'matplotlib'),
    TVB_USER_HOME: join(dataDir, 'tvb'),
    MNE_DONTWRITE_HOME: 'true',
    MNE_DATA: join(dataDir, 'mne_data'),
    MPLBACKEND: 'Agg',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
  }, extra);
  return env;
}

export function backendCommand(location: Pick<BackendLocation, 'python' | 'webDir'>, dataDir: string,
  parentPid: number = process.pid): string[] {
  return [location.python, '-I', '-u', '-m', BACKEND_MODULE,
    '--data-dir', dataDir, '--port', '0', '--parent-pid', String(parentPid), '--ready-stdout',
    ...(location.webDir ? ['--web-dir', location.webDir] : [])];
}

export function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Native navigation rules: block everything, then allow the backend origin (last match wins). */
export function navigationRules(origin: string | undefined): string[] {
  return origin ? ['^*', origin, `${origin}/*`] : ['^*', 'views://loading/*', 'about:blank', 'about:srcdoc'];
}

/** Only http://127.0.0.1:<port>/… of the running backend may load in the app window. */
export function isAllowedNavigation(url: string, origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && !parsed.username && !parsed.password;
  } catch { return false; }
}

/** https links leaving the app go to the default browser; anything else is dropped. */
export function externalUrl(url: string, origin: string | undefined): string | null {
  if (isAllowedNavigation(url, origin)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch { return null; }
}

/** Bounded in-memory tail of backend output (for the error page). */
export class LogRing {
  private lines: string[] = [];
  constructor(private readonly maxLines = 400, private readonly maxLineChars = 2000) {}
  push(line: string): void {
    this.lines.push(line.length > this.maxLineChars ? line.slice(0, this.maxLineChars) + '…' : line);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }
  tail(count = 60): string[] { return count <= 0 ? [] : this.lines.slice(-count); }
  get size(): number { return this.lines.length; }
  clear(): void { this.lines = []; }
}

/** Append-only log file, rotated once (backend.log -> backend.log.1) when larger than maxBytes. */
export function openLogFile(path: string, maxBytes = 5 * 1024 * 1024): WriteStream {
  mkdirSync(dirname(path), { recursive: true });
  try { if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`); } catch { /* no previous log */ }
  return createWriteStream(path, { flags: 'a' });
}

async function consumeLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { pending += decoder.decode(); if (pending) onLine(pending); return; }
    pending += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      onLine(pending.slice(0, end).replace(/\r$/, ''));
      pending = pending.slice(end + 1);
    }
    if (pending.length > 65536) { onLine(pending); pending = ''; }
  }
}

export type BackendOptions = {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  /** Receives every stdout/stderr line plus supervisor notes. */
  log: (line: string) => void;
  /** Called when the process exits without stop() being requested. */
  onExit: (code: number | null) => void;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  healthPath?: string;
};

export type BackendReady = ReadyInfo & { origin: string };

export class Backend {
  private child: ReturnType<typeof Bun.spawn> | undefined;
  private stopping = false;
  constructor(private readonly options: BackendOptions) {}

  get pid(): number | undefined { return this.child?.pid; }
  get running(): boolean { return !!this.child && this.child.exitCode === null && this.child.signalCode === null; }

  async start(): Promise<BackendReady> {
    const { command, cwd, env, log } = this.options;
    const timeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.stopping = false;
    log(`[supervisor] spawn ${JSON.stringify(command)} cwd=${cwd}`);
    const child = Bun.spawn(command, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    this.child = child;
    void child.exited.then(code => {
      log(`[supervisor] backend exited code=${code} signal=${child.signalCode ?? ''}`);
      if (!this.stopping) this.options.onExit(code);
    });
    void consumeLines(child.stderr, log).catch(error => log(`[supervisor] stderr: ${String(error)}`));
    try {
      const ready = await new Promise<ReadyInfo>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `백엔드가 ${Math.round(timeoutMs / 1000)}초 안에 준비되지 않았습니다. 실행 로그를 확인한 뒤 다시 시작해 주세요.`)), timeoutMs);
        void child.exited.then(code => { clearTimeout(timer); reject(new Error(`백엔드가 시작 중에 종료되었습니다 (종료 코드 ${code}).`)); });
        void consumeLines(child.stdout, line => {
          log(line);
          const info = parseReadyLine(line);
          if (info) { clearTimeout(timer); resolveReady(info); }
        }).catch(reject);
      });
      const origin = originFor(ready.port);
      const healthPath = this.options.healthPath ?? '/api/health';
      for (let attempt = 0; attempt < 100; attempt++) {
        if (this.stopping || !this.running) throw new Error('백엔드가 상태 확인 전에 종료되었습니다.');
        try {
          const response = await fetch(origin + healthPath, { signal: AbortSignal.timeout(1000) });
          if (response.ok) {
            const body = await response.json() as { status?: unknown };
            if (body.status === 'ready') { log(`[supervisor] ready ${origin} pid=${ready.pid} version=${ready.version}`); return { ...ready, origin }; }
          }
        } catch { /* listener up before the app answers; retry */ }
        await Bun.sleep(100);
      }
      throw new Error('백엔드 상태 확인(/api/health)에 실패했습니다.');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** SIGTERM, wait up to stopGraceMs (backend hard-exits 10 s after shutdown starts), then SIGKILL. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        this.options.log('[supervisor] backend ignored SIGTERM; sending SIGKILL');
        child.kill('SIGKILL');
      }
    }, grace);
    await child.exited;
    clearTimeout(timer);
  }

  /** Synchronous last resort for process 'exit': no waiting possible. */
  killNow(): void {
    this.stopping = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
