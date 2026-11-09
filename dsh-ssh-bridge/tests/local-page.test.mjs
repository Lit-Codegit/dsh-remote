import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Script } from 'node:vm';

import { startLocalPage } from '../lib/local-page.mjs';
import { renderStatusPage } from '../lib/page.mjs';

const status = {
  mode: 'tailscale', state: 'forwarding',
  tailscale: { publicUrl: 'https://workstation.example.ts.net/', localPort: 9301 },
  forward: { bindAddress: '127.0.0.1', remotePort: 9301, target: { host: '127.0.0.1', port: 45123 } },
  stats: { openChannels: 0, totalChannels: 0 },
};
const pairing = {
  mode: 'tailscale', url: status.tailscale.publicUrl,
  tokenUrl: `${status.tailscale.publicUrl}?token=launch-secret`,
};

async function fixture(t, overrides = {}) {
  const messages = [];
  const page = await startLocalPage({
    port: 0, accessKey: 'owner-key', getStatus: () => status,
    getPairing: async () => pairing,
    log: (_level, message) => messages.push(message), ...overrides,
  });
  t.after(() => page.close());
  return { ...page, messages };
}

function request(page, path, { headers, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: page.port, path, method, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('local pairing requires its key, then remembers the owner cookie', async (t) => {
  const page = await fixture(t);
  for (const path of ['/', '/status', '/?rk=wrong']) {
    const response = await request(page, path);
    assert.equal(response.status, 403);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, /launch-secret|owner-key/);
  }
  const response = await request(page, '/?rk=owner-key');
  assert.equal(response.status, 200);
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  const cookie = response.headers['set-cookie'][0];
  assert.match(cookie, /^dsh_pair=owner-key;/);
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  const remembered = await request(page, '/status', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(remembered.status, 200);
  assert.equal(remembered.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(remembered.body).pairing, { ...pairing, hasQr: false });
  assert.doesNotMatch(page.messages.join('\n'), /owner-key|launch-secret|\?rk=/);
});

test('local UI uses its own endpoints and links files through the DSH origin', async (t) => {
  const page = await fixture(t, { reconnect() {} });
  const response = await request(page, '/?rk=owner-key');
  assert.equal(response.status, 200);
  assert.match(response.body, /<html lang="zh-CN">/);
  assert.match(response.body, /<body data-status-url="\/status" data-reconnect-url="\/reconnect">/);
  assert.match(response.body, /入口已就绪/);
  assert.match(response.body, /打开 DSH/);
  assert.match(response.body, /复制配对链接/);
  assert.match(response.body, /<pre id="pair-url">https:\/\/workstation\.example\.ts\.net\/\?token=launch-secret<\/pre>/);
  assert.match(response.body, /data-action="files" href="https:\/\/workstation\.example\.ts\.net\/ssh-bridge\/files"/);
  assert.match(response.body, /<details id="connection-details">/);
  const source = /<script>([\s\S]*?)<\/script>/.exec(response.body)[1];
  assert.doesNotThrow(() => new Script(source), 'the emitted client script parses');
});

test('local retry accepts an authenticated same-origin POST and refuses cross-origin requests', async (t) => {
  let restartCount = 0;
  let restarted;
  const restartedPromise = new Promise((resolve) => { restarted = resolve; });
  const page = await fixture(t, { reconnect() { restartCount += 1; restarted(); } });
  assert.equal((await request(page, '/reconnect', { method: 'POST' })).status, 403);
  const get = await request(page, '/reconnect?rk=owner-key');
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: 'https://attacker.example' },
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
  ]) {
    assert.equal((await request(page, '/reconnect?rk=owner-key', { method: 'POST', headers })).status, 403);
  }
  assert.equal(restartCount, 0);
  const accepted = await request(page, '/reconnect?rk=owner-key', {
    method: 'POST', headers: { origin: `http://127.0.0.1:${page.port}`, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(JSON.parse(accepted.body), { restarting: true });
  await Promise.race([restartedPromise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('reconnect callback was not called')), 1000);
    restartedPromise.then(() => clearTimeout(timer));
  })]);
  assert.equal(restartCount, 1);
});

test('a read-only local page hides retry and refuses unknown paths', async (t) => {
  const page = await fixture(t, { accessKey: '' });
  const response = await request(page, '/');
  assert.equal(response.status, 200);
  assert.match(response.body, /<body data-status-url="\/status">/);
  assert.doesNotMatch(response.body, /<button[^>]*data-action="reconnect"/);
  for (const path of ['/reconnect', '/missing', '/ssh-bridge/files']) {
    assert.equal((await request(page, path)).status, 404);
  }
  const post = await request(page, '/status', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('health has no pairing secrets and an unavailable pairing remains a safe empty state', async (t) => {
  const page = await fixture(t, { getPairing: async () => { throw new Error('launch-secret'); } });
  const health = await request(page, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(health.body), { ok: true, state: 'forwarding' });
  const response = await request(page, '/status?rk=owner-key');
  assert.equal(JSON.parse(response.body).pairing, null);
  assert.doesNotMatch(response.body, /launch-secret/);
  const empty = await request(page, '/?rk=owner-key');
  assert.match(empty.body, /等待 DSH 入口/);
  assert.doesNotMatch(empty.body, /data-action="open" href=/);
});

test('local Host validation rejects rebinding names and wrong ports, including on health', async (t) => {
  const page = await fixture(t, { accessKey: '' });
  for (const host of [`localhost:${page.port}`, `127.0.0.1:${page.port}`, `[::1]:${page.port}`]) {
    assert.equal((await request(page, '/status', { headers: { host } })).status, 200);
  }
  for (const host of [`attacker.example:${page.port}`, '127.0.0.1:1', `127.0.0.1:${page.port}@attacker.example`, `localhost:${page.port}/`]) {
    for (const path of ['/status', '/health']) {
      const response = await request(page, path, { headers: { host } });
      assert.equal(response.status, 403, `${host} on ${path}`);
      assert.doesNotMatch(response.body, /launch-secret/);
    }
  }
});

test('a non-loopback bind requires a nonempty access key before opening a listener', async () => {
  for (const host of ['0.0.0.0', '::', '192.0.2.1', 'attacker.example']) {
    await assert.rejects(startLocalPage({ host, port: 0, getStatus: () => status, getPairing: async () => pairing }), /requires an access key/);
  }
});

test('a keyed wildcard listener still rejects unrecognized request hosts', async (t) => {
  const page = await fixture(t, { host: '0.0.0.0' });
  assert.equal((await request(page, '/?rk=owner-key')).status, 200);
  assert.equal((await request(page, '/?rk=owner-key', { headers: { host: `attacker.example:${page.port}` } })).status, 403);
});

test('shared renderer preserves SSH selectors, escapes content, and keeps launch tokens off file URLs', () => {
  const ssh = renderStatusPage({ status: { ...status, mode: 'ssh', ssh: { host: 'host', username: 'owner', port: 22 } },
    pairing: { ...pairing, mode: 'ssh', sshCommand: 'ssh -N <host>', sshConfig: 'Host dsh-bridge',
      tokenUrl: `${pairing.url}?rk=relay-secret&token=launch-secret` },
    hint: '<script>alert(1)</script>',
  });
  assert.match(ssh, /DSH bridge/);
  assert.match(ssh, /<pre id="ssh-command">ssh -N &lt;host&gt;<\/pre>/);
  assert.match(ssh, /<pre id="ssh-config">Host dsh-bridge<\/pre>/);
  assert.match(ssh, /href="https:\/\/workstation\.example\.ts\.net\/ssh-bridge\/files\?rk=relay-secret"/);
  assert.doesNotMatch(ssh, /ssh-bridge\/files[^"\s]*token=/);
  assert.match(ssh, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const unsafe = renderStatusPage({ status: { ...status, lastError: 'failed ?token=launch-secret&rk=owner-key' },
    pairing: { mode: 'tailscale', url: 'javascript:alert(1)' }, reconnectUrl: null });
  assert.doesNotMatch(unsafe, /href="javascript:|launch-secret|owner-key/);
});
