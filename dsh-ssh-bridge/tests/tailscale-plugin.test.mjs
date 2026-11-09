import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { apply, Config, resolveConfig } from '../lib/index.mjs';
import { buildTailscalePairing, describePairing } from '../lib/pairing.mjs';
import { waitFor } from './helpers/ssh-server.mjs';

const publicUrl = 'https://computer.example.ts.net/';

function request(port, pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers, method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on('error', reject);
    req.end();
  });
}

async function fixture(connection, { enabled = true, filesEnabled = true } = {}) {
  const routes = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://dsh.invalid');
    if (url.pathname === '/') {
      if (url.searchParams.get('token') === 'launch-token') {
        res.writeHead(303, { location: './', 'set-cookie': 'session=paired; Path=/; HttpOnly' });
        res.end();
      } else {
        res.writeHead(req.headers.cookie === 'session=paired' ? 200 : 401);
        res.end('dsh-session');
      }
      return;
    }
    const route = routes.get(url.pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    Promise.resolve(route.handler(req, res)).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const services = new Map();
  const disposers = [];
  const webServer = {
    host: '127.0.0.1',
    port: server.address().port,
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
  };
  services.set('webServer', webServer);
  if (connection) services.set('connection', connection);
  const logger = { info() {}, warn() {}, error() {} };
  const ctx = {
    webServer,
    get: (name) => services.get(name),
    provide: (name, value) => services.set(name, value),
    effect(factory) { const disposer = factory(); if (typeof disposer === 'function') disposers.push(disposer); },
    inject(_deps, callback) { callback(ctx); },
    logger: () => logger,
  };
  await apply(ctx, {
    enabled,
    transport: 'tailscale',
    tailscale: { publicUrl, localPort: 0 },
    pairing: { localPort: 0, qr: false },
    files: { enabled: filesEnabled },
  });
  const service = services.get('sshBridge');
  if (enabled) await waitFor(() => service.status().state === 'forwarding');
  return {
    service,
    webPort: server.address().port,
    get port() { return service.status().forward.remotePort; },
    async disposePlugin() {
      while (disposers.length) await disposers.pop()();
    },
    async close() {
      await this.disposePlugin();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('Tailscale schema and resolved configuration keep old defaults and expose only a loopback port', () => {
  const parsed = Config({ transport: 'tailscale', tailscale: { publicUrl } });
  assert.equal(parsed.tailscale.localPort, 9301);
  assert.equal(resolveConfig({}).transport, 'ssh');
  assert.equal(resolveConfig({}).tailscale.publicUrl, '');
  assert.equal(resolveConfig({}).files.enabled, true);
  assert.equal(resolveConfig({ transport: 'tailscale' }).files.enabled, false);
  assert.equal(resolveConfig({ transport: 'tailscale', tailscale: { publicUrl } }).tailscale.publicUrl, publicUrl);
  assert.throws(() => Config({ tailscale: { localPort: 70000 } }));
  assert.throws(() => resolveConfig({ tailscale: { publicUrl: `${publicUrl}?token=secret` } }));
});

test('Tailscale pairing uses DSH authentication without a relay key or SSH instructions', async () => {
  const material = await buildTailscalePairing({
    tailscale: { publicUrl },
    authenticatedUrl: (url) => `${url}?token=launch-token`,
    qr: false,
  });
  assert.equal(material.mode, 'tailscale');
  assert.equal(material.url, publicUrl);
  assert.equal(material.tokenUrl, `${publicUrl}?token=launch-token`);
  assert.equal(material.sshCommand, undefined);
  assert.equal(material.qrDataUrl, undefined);
  assert.doesNotMatch(describePairing(material), /undefined|ssh -N|rk=/);
});

test('Tailscale plugin pairs a browser through the stable proxy and protects credential routes', async (t) => {
  const bridge = await fixture({
    admit: (req) => req.headers.cookie === 'session=paired' ? { peer: { id: 'paired' } } : { rejection: 401 },
    authenticatedUrl: (url) => `${url}?token=launch-token`,
  });
  t.after(() => bridge.close());
  const material = await bridge.service.pairing();
  assert.equal(material.tokenUrl, `${publicUrl}?token=launch-token`);

  for (const route of ['/ssh-bridge/status', '/ssh-bridge?go=1', '/ssh-bridge/files', '/ssh-bridge/file?p=README.md']) {
    assert.equal((await request(bridge.port, route)).status, 403, route);
  }
  const paired = await request(bridge.port, '/?token=launch-token');
  assert.equal(paired.status, 303);
  assert.equal(paired.headers.location, './');
  const headers = { cookie: paired.headers['set-cookie'][0].split(';')[0] };
  assert.equal((await request(bridge.port, '/', headers)).status, 200);
  const status = await request(bridge.port, '/ssh-bridge/status', headers);
  assert.equal(status.status, 200);
  assert.equal(status.headers['cache-control'], 'no-store');
  const json = JSON.parse(status.body);
  assert.equal(json.mode, 'tailscale');
  assert.equal(json.pairing.tokenUrl, material.tokenUrl);
  assert.equal(json.pairing.sshCommand, undefined);
  const page = await request(bridge.port, '/ssh-bridge', headers);
  assert.equal(page.status, 200);
  assert.match(page.body, /DSH bridge/);
});

test('Tailscale credential routes fail closed if DSH authentication is unavailable', async (t) => {
  const bridge = await fixture();
  t.after(() => bridge.close());
  assert.equal(await bridge.service.pairing(), undefined);
  for (const route of ['/ssh-bridge', '/ssh-bridge/status', '/ssh-bridge/files', '/ssh-bridge/file?p=README.md']) {
    assert.equal((await request(bridge.port, route)).status, 403, route);
  }
});

test('a disabled Tailscale bridge cannot be started through the service or reconnect route', async (t) => {
  const bridge = await fixture({ admit: () => ({ peer: { id: 'paired' } }) }, { enabled: false });
  t.after(() => bridge.close());
  bridge.service.restart();
  assert.equal(bridge.service.status().state, 'stopped');
  const response = await request(bridge.webPort, '/ssh-bridge/reconnect', {}, 'POST');
  assert.equal(response.status, 409);
  assert.equal(bridge.service.status().state, 'stopped');
});

test('a pending reconnect cannot resurrect the proxy after the plugin is disposed', async (t) => {
  const bridge = await fixture({ admit: () => ({ peer: { id: 'paired' } }) });
  t.after(() => bridge.close());
  const response = await request(bridge.port, '/ssh-bridge/reconnect', {}, 'POST');
  assert.equal(response.status, 202);
  await bridge.disposePlugin();
  await new Promise((resolve) => setTimeout(resolve, 200));
  bridge.service.restart();
  assert.equal(bridge.service.status().state, 'stopped');
});

test('file browsing can be disabled without registering routes or exposing navigation', async (t) => {
  const bridge = await fixture({ admit: () => ({ peer: { id: 'paired' } }), authenticatedUrl: (url) => `${url}?token=launch-token` }, { filesEnabled: false });
  t.after(() => bridge.close());
  assert.equal((await request(bridge.port, '/ssh-bridge/files')).status, 404);
  assert.equal((await request(bridge.port, '/ssh-bridge/file?p=README.md')).status, 404);
  const page = await request(bridge.port, '/ssh-bridge');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.body, /id="open-files"/);
});
