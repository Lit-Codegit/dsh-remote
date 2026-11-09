/** A self-contained owner-facing connection page, shared by the plugin and local listener. */

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function webUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '' ? url : undefined;
  } catch { return undefined; }
}

/** Keep credentials out of diagnostic text; the intentional pairing block remains copyable. */
function redact(value, pairing) {
  let text = String(value ?? '');
  const url = webUrl(pairing?.tokenUrl);
  for (const name of ['rk', 'token']) {
    const secret = url?.searchParams.get(name);
    if (secret) text = text.replaceAll(secret, '•••').replaceAll(encodeURIComponent(secret), '•••');
  }
  return text.replace(/([?&](?:rk|token|accessToken)=)[^&\s]*/gi, '$1•••');
}

function stateView(status) {
  switch (status.state) {
    case 'ready': return ['中继已连接', 'ready'];
    case 'forwarding': return [status.mode === 'tailscale' ? '入口已就绪' : '隧道已就绪', 'ready'];
    case 'connecting': return ['正在连接', 'waiting'];
    case 'connected': return ['正在建立入口', 'waiting'];
    case 'retrying': return ['正在重试', 'waiting'];
    case 'failed': return ['连接失败', 'failed'];
    case 'disconnected': return ['连接已断开', 'failed'];
    case 'stopped': return ['已停止', 'stopped'];
    default: return ['等待连接', 'stopped'];
  }
}

function connectionRows(status, pairing) {
  const target = status.forward?.target;
  const rows = [['连接方式', { tailscale: 'Tailscale', relay: '中继', ssh: 'SSH' }[status.mode] ?? status.mode]];
  if (status.mode === 'relay') {
    rows.push(['中继地址', `${status.relay?.host ?? ''}:${status.relay?.port ?? ''}`],
      ['可用连接', `${status.idle ?? 0} / ${status.poolSize ?? 0}`],
      ['证书校验', status.relay?.pinned ? '固定指纹' : '系统信任库'], ['已处理请求', status.stats?.served ?? 0]);
  } else if (status.mode === 'tailscale') {
    rows.push(['访问地址', status.tailscale?.publicUrl ?? pairing?.url ?? '未配置'],
      ['本机入口', `${status.forward?.bindAddress ?? '127.0.0.1'}:${status.tailscale?.localPort ?? status.forward?.remotePort ?? ''}`]);
    if (target) rows.push(['DSH 地址', `${target.host}:${target.port}`]);
  } else {
    rows.push(['SSH 服务器', `${status.ssh?.username ?? ''}@${status.ssh?.host ?? ''}:${status.ssh?.port ?? ''}`],
      ['转发入口', `${status.forward?.bindAddress ?? ''}:${status.forward?.remotePort ?? ''}`],
      ['DSH 地址', target ? `${target.host}:${target.port}` : '等待启动'],
      ['认证方式', status.authMethod ?? '尚未连接'], ['重试次数', status.attempt ?? 0]);
  }
  return rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(redact(value, pairing))}</dd>`).join('');
}

function fileAddress(pairing) {
  const base = webUrl(pairing?.url);
  if (!base) return undefined;
  const url = new URL('/ssh-bridge/files', base);
  const key = webUrl(pairing?.tokenUrl)?.searchParams.get('rk');
  if (key) url.searchParams.set('rk', key);
  return url.href;
}

/**
 * Render a complete connection page. Optional endpoints keep the original API compatible.
 * `null` disables an endpoint; relative endpoints refer to the listener rendering this page.
 * @param {object} options
 * @param {object} options.status
 * @param {object} [options.pairing]
 * @param {string} [options.hint]
 * @param {string | null} [options.statusUrl]
 * @param {string | null} [options.reconnectUrl]
 * @param {string | null} [options.filesUrl]
 * @returns {string}
 */
export function renderStatusPage({ status, pairing, hint, statusUrl = '/ssh-bridge/status', reconnectUrl = '/ssh-bridge/reconnect', filesUrl }) {
  const [stateLabel, stateClass] = stateView(status);
  const launch = webUrl(pairing?.tokenUrl ?? pairing?.url);
  const files = filesUrl === null ? undefined : webUrl(filesUrl ?? fileAddress(pairing));
  const error = redact(status.lastError, pairing);
  const qr = typeof pairing?.qrDataUrl === 'string' && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(pairing.qrDataUrl) ? pairing.qrDataUrl : undefined;
  const ssh = pairing?.mode === 'ssh';
  const retry = reconnectUrl === null ? '' : '<button id="reconnect-button" type="button" class="quiet" data-action="reconnect">重试连接</button>';
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>DSH bridge · 远程访问</title>
<style>
  :root { color-scheme:light dark; --bg:#f4f3ee; --ink:#18251e; --muted:#667269; --line:#d7dcd4;
    --accent:#245c40; --on-accent:#fff; --surface:#e9ece4; --danger:#a73529; --waiting:#9a651b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .shell { width:min(100%, 56rem); margin:0 auto; padding:3.5rem 2rem 2.5rem; }
  header { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding-bottom:1.5rem; border-bottom:1px solid var(--line); }
  h1 { margin:0; font:600 1.2rem/1.3 "Avenir Next", "PingFang SC", sans-serif; letter-spacing:-.04em; }
  h2 { margin:0 0 1.25rem; font-size:clamp(1.45rem, 4vw, 2rem); font-weight:500; letter-spacing:-.04em; overflow-wrap:anywhere; line-height:1.3; }
  .status-row { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin:1.6rem 0 2rem; }
  .state { display:inline-flex; align-items:center; gap:.55rem; font-size:.92rem; }
  .state::before { content:""; width:.5rem; height:.5rem; border-radius:50%; background:var(--muted); }
  .state.ready::before { background:var(--accent); box-shadow:0 0 0 4px color-mix(in srgb, var(--accent) 10%, transparent); }
  .state.waiting::before { background:var(--waiting); } .state.failed::before { background:var(--danger); }
  button, .button { display:inline-flex; align-items:center; justify-content:center; min-height:2.8rem; padding:.65rem 1.05rem;
    border:1px solid var(--line); border-radius:.35rem; background:transparent; color:var(--ink); text-decoration:none; font:inherit; font-size:.88rem; cursor:pointer; }
  button:hover, .button:hover { border-color:var(--ink); } button:disabled { cursor:wait; opacity:.55; }
  .primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); }
  .primary:hover { border-color:var(--accent); filter:brightness(1.12); }
  .quiet { border:0; min-height:2.75rem; padding:.4rem .2rem; color:var(--muted); }
  :focus-visible { outline:2px solid var(--accent); outline-offset:4px; }
  .connection { display:grid; grid-template-columns:minmax(0, 1fr) 12.5rem; align-items:center; gap:2.5rem; min-height:13rem; margin-bottom:2rem; }
  .connection.no-qr { grid-template-columns:minmax(0, 1fr); }
  .actions { display:flex; gap:.6rem; flex-wrap:wrap; }
  .qr { display:block; width:100%; height:auto; padding:.65rem; background:#fff; border-radius:.35rem; }
  .empty { padding:1rem 0 2rem; } .empty h2 { margin-bottom:.6rem; }
  .muted, .empty p { color:var(--muted); font-size:.88rem; }
  .error { color:var(--danger); font-size:.9rem; white-space:pre-wrap; overflow-wrap:anywhere; margin:0 0 1.5rem; }
  .ssh-setup { margin-bottom:2rem; }
  .block-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:.6rem; }
  .block-head h3 { font-size:.9rem; font-weight:500; margin:0; }
  pre { margin:0; padding:.9rem 1rem; background:var(--surface); border-radius:.3rem; white-space:pre-wrap; overflow-wrap:anywhere; font:.78rem/1.65 "SFMono-Regular", Consolas, monospace; }
  details { border-top:1px solid var(--line); padding:1.1rem 0; } summary { cursor:pointer; font-size:.88rem; color:var(--muted); }
  details[open] summary { color:var(--ink); margin-bottom:1.3rem; }
  dl { display:grid; grid-template-columns:auto minmax(0, 1fr); gap:.55rem 2rem; font-size:.83rem; margin:1.4rem 0 0; }
  dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
  .detail-block + .detail-block { margin-top:1.3rem; }
  #feedback { min-height:1.55em; margin:.9rem 0 0; color:var(--muted); font-size:.84rem; }
  @media (prefers-color-scheme:dark) { :root { --bg:#141c19; --ink:#e4eae3; --muted:#9daaa0; --line:#334139; --accent:#a7d4b0; --on-accent:#10291a; --surface:#202c25; --danger:#f49787; --waiting:#dfb56e; } }
  @media (max-width:560px) { .shell { padding:1.5rem 1.2rem 2rem; } .connection { grid-template-columns:1fr; gap:1.8rem; } .qr { width:11.5rem; } h2 { font-size:1.55rem; } dl { gap:.5rem 1rem; } }
  @media (prefers-reduced-motion:no-preference) { button, .button { transition:background .15s, border-color .15s; } }
</style></head>
<body${statusUrl === null ? '' : ` data-status-url="${escapeHtml(statusUrl)}"`}${reconnectUrl === null ? '' : ` data-reconnect-url="${escapeHtml(reconnectUrl)}"`}>
<div class="shell">
<header><h1>DSH bridge</h1><button type="button" class="quiet" data-action="refresh">刷新</button></header>
<main id="bridge-view" data-state="${escapeHtml(status.state)}" data-mode="${escapeHtml(status.mode)}" data-error="${escapeHtml(error)}">
  <div class="status-row"><span class="state ${stateClass}" role="status">${stateLabel}</span>${retry}</div>
  ${error === '' ? '' : `<p class="error">${escapeHtml(error)}</p>`}
  ${ssh ? `<section class="ssh-setup"><div class="block-head"><h3>先建立 SSH 隧道</h3><button id="copy-command" type="button" class="quiet" data-copy="ssh-command">复制命令</button></div><pre id="ssh-command">${escapeHtml(pairing.sshCommand)}</pre></section>` : ''}
  ${launch ? `<section class="connection${qr ? '' : ' no-qr'}"><div><h2>${escapeHtml(launch.host)}</h2><div class="actions">
    <a id="open-dsh" class="button primary" data-action="open" href="${escapeHtml(launch.href)}" referrerpolicy="no-referrer">打开 DSH</a>
    <button id="copy-link" type="button" data-copy="pair-url">复制配对链接</button>
    ${files ? `<a id="open-files" class="button" data-action="files" href="${escapeHtml(files.href)}" referrerpolicy="no-referrer" title="先打开 DSH 完成登录">文件</a>` : ''}
    </div></div>${qr ? `<img class="qr" src="${qr}" alt="用手机扫码配对" width="200" height="200">` : ''}</section>`
    : '<section class="empty"><h2>等待 DSH 入口</h2><p>连接就绪后将在这里显示配对链接。</p></section>'}
  <details id="connection-details"><summary id="connection-summary">连接详情</summary>
    ${launch ? `<div class="detail-block"><div class="block-head"><h3>配对链接</h3><button id="copy-link-detail" type="button" class="quiet" data-copy="pair-url">复制</button></div><pre id="pair-url">${escapeHtml(launch.href)}</pre></div>` : ''}
    ${ssh ? `<div class="detail-block"><div class="block-head"><h3>SSH 配置</h3><button id="copy-config" type="button" class="quiet" data-copy="ssh-config">复制</button></div><pre id="ssh-config">${escapeHtml(pairing.sshConfig)}</pre></div>` : ''}
    <dl>${connectionRows(status, pairing)}${hint === undefined ? '' : `<dt>提示</dt><dd>${escapeHtml(redact(hint, pairing))}</dd>`}</dl>
  </details>
</main><p id="feedback" role="status" aria-live="polite"></p>
</div>
<script>
(() => {
  let busy = false;
  const feedback = document.getElementById('feedback');
  const say = (message) => { feedback.textContent = message; };
  const endpoint = (path) => {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin) throw new Error('Unexpected endpoint');
    const key = new URL(location.href).searchParams.get('rk');
    if (key && !url.searchParams.has('rk')) url.searchParams.set('rk', key);
    return url;
  };
  const redact = (value, pairing) => {
    let text = String(value ?? '');
    try {
      const url = new URL(pairing?.tokenUrl ?? pairing?.url);
      for (const key of ['rk', 'token']) {
        const secret = url.searchParams.get(key);
        if (secret) text = text.split(secret).join('•••').split(encodeURIComponent(secret)).join('•••');
      }
    } catch {}
    return text.replace(/([?&](?:rk|token|accessToken)=)[^&\\s]*/gi, '$1•••');
  };
  const request = async (url, options = {}, format = 'json') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { cache:'no-store', credentials:'same-origin', ...options, signal:controller.signal });
      if (!response.ok) throw new Error('Request failed');
      return format === 'text' ? await response.text() : await response.json();
    } finally { clearTimeout(timer); }
  };
  async function refresh(force = false) {
    if (busy || (!force && document.hidden)) return;
    busy = true;
    const button = document.querySelector('[data-action="refresh"]');
    button.disabled = true;
    try {
      const current = document.getElementById('bridge-view');
      let changed = force;
      if (document.body.dataset.statusUrl) {
        const snapshot = await request(endpoint(document.body.dataset.statusUrl));
        const pairing = snapshot.pairing;
        changed ||= snapshot.state !== current.dataset.state || snapshot.mode !== current.dataset.mode
          || redact(snapshot.lastError, pairing) !== current.dataset.error
          || (pairing?.tokenUrl ?? pairing?.url ?? '') !== (document.getElementById('pair-url')?.textContent ?? '')
          || (pairing?.sshCommand !== undefined && pairing.sshCommand !== document.getElementById('ssh-command')?.textContent);
      } else if (!force) return;
      if (changed) {
        if (!force && window.getSelection()?.toString()) return;
        const url = new URL(location.href); url.searchParams.delete('go');
        const html = await request(url, {}, 'text');
        const next = new DOMParser().parseFromString(html, 'text/html').getElementById('bridge-view');
        if (!next) throw new Error('Invalid page');
        const open = document.getElementById('connection-details')?.open;
        const focused = document.activeElement;
        const focusId = focused?.id;
        const action = focused?.dataset.action;
        const copy = focused?.dataset.copy;
        current.replaceWith(next);
        document.getElementById('connection-details').open = Boolean(open);
        const restore = (focusId ? document.getElementById(focusId) : null)
          ?? (action ? document.querySelector('[data-action="' + action + '"]')
            : copy ? document.querySelector('[data-copy="' + copy + '"]') : null);
        restore?.focus({ preventScroll:true });
      }
      if (force) say('已刷新');
    } catch { say('刷新失败，请稍后重试。'); }
    finally { busy = false; button.disabled = false; }
  }
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.copy) {
      const element = document.getElementById(button.dataset.copy);
      if (!element) return;
      try { await navigator.clipboard.writeText(element.textContent ?? ''); say('已复制'); }
      catch {
        document.getElementById('connection-details').open = true;
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        say('已选中文字，请复制。');
      }
    } else if (button.dataset.action === 'refresh') {
      await refresh(true);
    } else if (button.dataset.action === 'reconnect' && !busy) {
      busy = true; button.disabled = true; say('正在重试连接…');
      try {
        await request(endpoint(document.body.dataset.reconnectUrl), { method:'POST' });
        setTimeout(() => { void refresh(true); }, 500);
      } catch { say('重试失败，请刷新后再试。'); }
      finally { busy = false; button.disabled = false; }
    }
  });
  async function tick() { await refresh(); setTimeout(tick, 4000); }
  setTimeout(tick, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
})();
</script></body></html>`;
}
