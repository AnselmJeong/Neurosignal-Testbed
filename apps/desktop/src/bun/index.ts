// Electrobun main process: loading view -> supervised Python backend -> app window.
import Electrobun, { ApplicationMenu, BrowserWindow, PATHS, Utils } from 'electrobun/bun';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  Backend, LogRing, backendCommand, backendEnv, externalUrl, locateBackend, navigationRules, openLogFile,
} from './backend';
import { errorPageHtml, parseHostAction } from './pages';

const APP_TITLE = 'Neurosignal Testbed';
// ~/Library/Application Support/local.neurosignal.testbed/<channel>/ — all mutable state lives here.
const dataDir = Utils.paths.userData;
const logDir = join(dataDir, 'logs');
const backendLogPath = join(logDir, 'backend.log');
const shellLogPath = join(logDir, 'desktop.log');
mkdirSync(logDir, { recursive: true });

const shellLog = (message: string) => {
  try { appendFileSync(shellLogPath, `${new Date().toISOString()} ${message}\n`); } catch { /* logging must never crash the shell */ }
};
const logFile = openLogFile(backendLogPath);
const ring = new LogRing();
const backendLog = (line: string) => { ring.push(line); logFile.write(`${line}\n`); };

let backend: Backend | undefined;
let origin: string | undefined;
let starting = false;
let quitting = false;
let stopped = false;

const window = new BrowserWindow({
  title: APP_TITLE,
  frame: { width: 1440, height: 900 },
  url: 'views://loading/index.html',
  renderer: 'native',
  sandbox: true, // no RPC into the web app; host-message events still work for the local pages
  navigationRules: JSON.stringify(navigationRules(undefined)),
});
// Electrobun 2.0.6 exposes no minimum-size API; the web layout handles narrow widths.

function showLoading() {
  origin = undefined;
  window.webview.setNavigationRules(navigationRules(undefined));
  window.webview.loadURL('views://loading/index.html');
}

function showError(message: string) {
  origin = undefined;
  window.webview.setNavigationRules(navigationRules(undefined));
  window.webview.loadHTML(errorPageHtml(message, ring.tail(80), backendLogPath));
}

async function start() {
  if (starting || quitting) return;
  starting = true;
  try {
    await backend?.stop();
    backend = undefined;
    showLoading();
    const location = locateBackend({
      appResources: join(PATHS.RESOURCES_FOLDER, 'app'),
      projectRoot: process.env['NEUROSIGNAL_PROJECT_ROOT'],
      searchFrom: [process.cwd(), import.meta.dir],
    });
    if (!location) throw new Error('번들된 Python 런타임을 찾지 못했습니다. 앱을 다시 설치해 주세요.');
    if (!location.webDir) throw new Error(`웹 화면 빌드를 찾지 못했습니다 (${location.kind}). 개발 환경이라면 apps/web에서 npm run build를 먼저 실행해 주세요.`);
    backendLog(`[shell] ${new Date().toISOString()} starting ${location.kind} backend, data=${dataDir}`);
    const current = new Backend({
      command: backendCommand(location, dataDir),
      cwd: location.cwd,
      env: backendEnv(dataDir),
      log: backendLog,
      onExit: code => {
        shellLog(`backend exited unexpectedly: ${code}`);
        if (backend === current && !quitting && !starting) showError(`분석 서버가 예기치 않게 종료되었습니다 (종료 코드 ${code}). 재시작을 눌러 다시 실행할 수 있습니다.`);
      },
    });
    backend = current;
    const ready = await current.start();
    if (quitting) { await current.stop(); return; }
    origin = ready.origin;
    window.webview.setNavigationRules(navigationRules(origin));
    window.webview.loadURL(`${origin}/`);
    shellLog(`ready ${origin} backend pid=${ready.pid} version=${ready.version}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    shellLog(`start failed: ${message}`);
    if (!quitting) showError(message);
  } finally {
    starting = false;
  }
}

function openExternal(url: string) {
  const target = externalUrl(url, origin);
  if (target) Utils.openExternal(target);
}

function revealLog() {
  Utils.showItemInFolder(backendLogPath);
}

function reload() {
  if (origin) window.webview.executeJavascript('location.reload()');
  else void start();
}

const webviewId = window.webview.id;
Electrobun.events.on(`host-message-${webviewId}`, (event: { data: { detail: unknown } }) => {
  const action = parseHostAction(event.data.detail);
  if (action === 'restart') void start();
  if (action === 'logs') revealLog();
});
// target=_blank / window.open
Electrobun.events.on(`new-window-open-${webviewId}`, (event: { data: { detail: string | { url: string } } }) => {
  const detail = event.data.detail;
  openExternal(typeof detail === 'string' ? detail : detail.url);
});
// Same-window navigation blocked by the native rules: send https links to the default browser.
window.webview.on('will-navigate', event => {
  const detail = (event as { data?: { detail?: unknown } }).data?.detail;
  try {
    const data = (typeof detail === 'string' ? JSON.parse(detail) : detail) as { url?: unknown; allowed?: unknown };
    if (data && typeof data.url === 'string' && data.allowed === false && origin) openExternal(data.url);
  } catch { /* not a navigation record */ }
});

ApplicationMenu.setApplicationMenu([
  { label: APP_TITLE, submenu: [
    { role: 'about' }, { type: 'separator' },
    { role: 'hide', accelerator: 'h' }, { role: 'hideOthers', accelerator: 'alt+h' }, { role: 'showAll' },
    { type: 'separator' }, { label: `${APP_TITLE} 종료`, role: 'quit', accelerator: 'q' },
  ] },
  { label: '편집', submenu: [
    { role: 'undo', accelerator: 'z' }, { role: 'redo', accelerator: 'shift+z' }, { type: 'separator' },
    { role: 'cut', accelerator: 'x' }, { role: 'copy', accelerator: 'c' }, { role: 'paste', accelerator: 'v' },
    { role: 'selectAll', accelerator: 'a' },
  ] },
  { label: '보기', submenu: [
    { label: '다시 불러오기', action: 'reload', accelerator: 'r' },
    { label: '분석 서버 재시작', action: 'restart' },
    { type: 'separator' },
    { label: '실행 로그 열기', action: 'logs' },
    { type: 'separator' },
    { role: 'toggleFullScreen', accelerator: 'ctrl+f' },
  ] },
  { label: '윈도우', submenu: [{ role: 'minimize', accelerator: 'm' }, { role: 'zoom' }, { role: 'close', accelerator: 'w' }] },
]);
ApplicationMenu.on('application-menu-clicked', event => {
  const action = (event as { data?: { action?: string } }).data?.action;
  if (action === 'reload') reload();
  if (action === 'restart') void start();
  if (action === 'logs') revealLog();
});

// Quit path (menu, Cmd+Q, last window closed): stop the backend first, then let Electrobun exit.
Electrobun.events.on('before-quit', (event: { response?: { allow: boolean } }) => {
  if (stopped) return;
  event.response = { allow: false };
  if (quitting) return;
  quitting = true;
  shellLog('quit requested; stopping backend');
  void (backend?.stop() ?? Promise.resolve())
    .catch(error => shellLog(`backend stop failed: ${String(error)}`))
    .finally(() => { stopped = true; logFile.end(); shellLog('shutdown complete'); Utils.quit(); });
});
process.on('SIGTERM', () => Utils.quit());
process.on('SIGINT', () => Utils.quit());
// Last resort if the process exits without before-quit (the backend's --parent-pid watchdog covers hard kills).
process.on('exit', () => backend?.killNow());

shellLog(`desktop shell started pid=${process.pid} data=${dataDir} logs=${dirname(backendLogPath)}`);
void start();
