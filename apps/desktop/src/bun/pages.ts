// HTML for the native error state (loaded with loadHTML; Korean copy).
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

export function errorPageHtml(message: string, logTail: string[], logPath: string): string {
  const tail = logTail.length ? escapeHtml(logTail.join('\n')) : '(로그가 비어 있습니다)';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Neurosignal Testbed</title><style>
:root{color-scheme:light dark}
body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;background:#f5f6f8;color:#1d2433;display:grid;place-items:center;min-height:100vh}
main{width:min(860px,92vw);padding:40px 0}
small{letter-spacing:.16em;color:#6b7385;font-weight:600}
h1{font-size:28px;margin:8px 0 12px;letter-spacing:-.5px}
p{margin:0 0 18px;color:#44506a;white-space:pre-wrap}
pre{background:#11161f;color:#d7dde8;padding:16px;border-radius:10px;max-height:46vh;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.row{display:flex;gap:10px;align-items:center;margin:18px 0}
button{font:inherit;padding:9px 18px;border-radius:8px;border:1px solid #c9d0dc;background:#fff;color:#1d2433;cursor:pointer}
button.primary{background:#2457d6;border-color:#2457d6;color:#fff}
code{font:12px ui-monospace,Menlo,monospace;color:#6b7385}
@media (prefers-color-scheme:dark){body{background:#151922;color:#e6e9ef}p{color:#aab3c5}button{background:#232a36;color:#e6e9ef;border-color:#38414f}}
</style></head><body><main>
<small>NEUROSIGNAL TESTBED</small>
<h1>분석 서버가 멈췄습니다</h1>
<p>${escapeHtml(message)}</p>
<div class="row"><button class="primary" id="restart">재시작</button><button id="logs">실행 로그 열기</button></div>
<p>최근 로그 · <code>${escapeHtml(logPath)}</code></p>
<pre>${tail}</pre>
</main><script>
const send = action => { try { window.__electrobunSendToHost({ action }); } catch (e) { console.error(e); } };
document.getElementById('restart').addEventListener('click', event => { event.target.disabled = true; event.target.textContent = '재시작하는 중…'; send('restart'); });
document.getElementById('logs').addEventListener('click', () => send('logs'));
</script></body></html>`;
}

export type HostAction = 'restart' | 'logs';

/** Host messages from the local pages carry only these two actions. */
export function parseHostAction(detail: unknown): HostAction | null {
  let value: unknown = detail;
  if (typeof detail === 'string') {
    try { value = JSON.parse(detail); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || !('action' in value)) return null;
  const action = (value as { action: unknown }).action;
  return action === 'restart' || action === 'logs' ? action : null;
}
