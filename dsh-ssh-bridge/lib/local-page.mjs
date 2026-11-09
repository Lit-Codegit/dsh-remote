/** A fixed owner-facing pairing listener, separate from DSH's changing web port. */
import http from 'node:http';
import net from 'node:net';

import { renderStatusPage } from './page.mjs';
import { tokenEquals } from './relay-protocol.mjs';

const normalizeHost = (value) => value.toLowerCase().replace(/^\[|\]$/g, '');
const isLoopback = (host) => host === 'localhost' || host === '::1' || (net.isIP(host) === 4 && host.startsWith('127.'));

function allow(request, response, accessKey) {
  if (accessKey === '') return true;
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (tokenEquals(url.searchParams.get('rk'), accessKey)) {
    response.setHeader('set-cookie', `dsh_pair=${accessKey}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    return true;
  }
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === 'dsh_pair' && tokenEquals(part.slice(index + 1).trim(), accessKey)) return true;
  }
  return false;
}

/** Check hostname and actual bound port before serving even the health endpoint. */
function validHost(request, host, port) {
  const raw = request.headers.host;
  if (typeof raw !== 'string' || /[\\/?#@\s,]/.test(raw)) return false;
  try {
    const url = new URL(`http://${raw}`);
    return Number(url.port || 80) === port && [host, 'localhost', '127.0.0.1', '::1'].includes(normalizeHost(url.hostname));
  } catch { return false; }
}

function sameOrigin(request) {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.origin;
  return origin === undefined || origin === `http://${request.headers.host}`;
}

/**
 * @param {object} options
 * @param {string} [options.host]
 * @param {number} options.port
 * @param {string} [options.accessKey]
 * @param {() => object} options.getStatus
 * @param {() => Promise<object | undefined>} options.getPairing
 * @param {() => void | Promise<void>} [options.reconnect]
 * @param {string | null} [options.filesUrl]
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startLocalPage({ host = '127.0.0.1', port, accessKey = '', getStatus, getPairing, reconnect, filesUrl, log = () => {} }) {
  const bindHost = normalizeHost(host);
  if (!isLoopback(bindHost) && accessKey === '') throw new Error('A non-loopback pairing listener requires an access key.');
  const server = http.createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    const send = (code, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(code, { 'content-type': type }); response.end(body);
    };
    const address = server.address();
    if (!validHost(request, bindHost, typeof address === 'object' && address !== null ? address.port : port)) {
      send(403, 'forbidden'); return;
    }
    let pathname;
    try { pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname; }
    catch { send(400, 'bad request'); return; }
    if (!['/', '/status', '/health', ...(reconnect ? ['/reconnect'] : [])].includes(pathname)) {
      send(404, 'not found'); return;
    }
    const method = request.method ?? 'GET';
    if (pathname !== '/reconnect' && method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD'); send(405, 'method not allowed'); return;
    }
    if (pathname === '/health') {
      send(200, `${JSON.stringify({ ok: true, state: getStatus().state })}\n`, 'application/json; charset=utf-8'); return;
    }
    if (!allow(request, response, accessKey)) {
      send(403, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH bridge</title><body style="font:16px/1.6 sans-serif;padding:2rem;max-width:32rem"><h1 style="font-size:1.2rem">需要访问密钥</h1><p>首次打开请在地址后添加 <code>?rk=&lt;访问密钥&gt;</code>。</p></body></html>', 'text/html; charset=utf-8'); return;
    }
    if (pathname === '/reconnect') {
      if (method !== 'POST') {
        response.setHeader('allow', 'POST'); send(405, 'method not allowed');
      } else if (!sameOrigin(request)) { send(403, 'forbidden'); }
      else {
        send(202, '{"restarting":true}\n', 'application/json; charset=utf-8');
        setTimeout(() => {
          Promise.resolve().then(reconnect).catch(() => log('warn', 'ssh-bridge: reconnect request failed'));
        }, 150).unref?.();
      }
      return;
    }
    void (async () => {
      const status = getStatus();
      let pairing;
      try { pairing = await getPairing(); } catch { pairing = undefined; }
      if (pathname === '/status') {
        send(200, `${JSON.stringify({ ...status,
          pairing: pairing === undefined ? null : {
            mode: pairing.mode, url: pairing.url, tokenUrl: pairing.tokenUrl ?? null,
            ...(pairing.mode === 'ssh' ? { sshCommand: pairing.sshCommand, sshConfig: pairing.sshConfig } : {}),
            hasQr: pairing.qrDataUrl !== undefined,
          },
        })}\n`, 'application/json; charset=utf-8');
      } else {
        send(200, renderStatusPage({ status, pairing, statusUrl: '/status', reconnectUrl: reconnect ? '/reconnect' : null, filesUrl }), 'text/html; charset=utf-8');
      }
    })().catch(() => {
      if (!response.headersSent) send(500, 'internal error'); else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, bindHost, resolve);
  });
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  const displayHost = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  log('info', `ssh-bridge: pairing page on http://${displayHost}:${bound}/`);
  return { port: bound, close: () => new Promise((resolve) => server.close(resolve)) };
}
