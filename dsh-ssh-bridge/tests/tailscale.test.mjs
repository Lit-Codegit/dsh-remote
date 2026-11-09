/** Real loopback HTTP and WebSocket traffic through the Tailscale ingress. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

import { TailscaleTransport, normalizeTailscalePublicUrl, resolveTailscaleConfig } from '../lib/tailscale.mjs';

const PUBLIC_URL = 'https://device.tailnet.ts.net/';

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function listener(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    sockets,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

function bridge(resolveTarget, tailscale = {}) {
  return new TailscaleTransport({
    config: { enabled: true, tailscale: { publicUrl: PUBLIC_URL, localPort: 0, ...tailscale } },
    resolveTarget,
  });
}

async function start(transport) {
  transport.start();
  await waitFor(() => transport.status().connectedAt !== null || transport.state === 'failed');
  return transport.status().tailscale.localPort;
}

function request(port, options = {}, body) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path: '/', agent: false, ...options }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('HTTP request timed out')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function frame(text, masked = false) {
  const payload = Buffer.from(text);
  assert.ok(payload.length < 126);
  if (!masked) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const mask = Buffer.from([11, 22, 33, 44]);
  const encoded = Buffer.from(payload);
  for (let index = 0; index < encoded.length; index += 1) encoded[index] ^= mask[index % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, encoded]);
}

function readFrames(buffer, onMessage) {
  while (buffer.length >= 2) {
    const masked = (buffer[1] & 0x80) !== 0;
    const length = buffer[1] & 0x7f;
    const offset = masked ? 6 : 2;
    if (buffer.length < offset + length) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (masked) {
      for (let index = 0; index < length; index += 1) payload[index] ^= buffer[2 + index % 4];
    }
    onMessage(payload.toString());
    buffer = buffer.subarray(offset + length);
  }
  return buffer;
}

async function websocket(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  const messages = [];
  let buffer = Buffer.alloc(0);
  let handshake;
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (handshake === undefined) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      handshake = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 4);
    }
    buffer = readFrames(buffer, (message) => messages.push(message));
  });
  await once(socket, 'connect');
  const headers = [
    'GET /events?token=opaque%2Bvalue HTTP/1.1',
    'Host: device.tailnet.ts.net',
    'Origin: https://device.tailnet.ts.net',
    'Cookie: session=existing',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    '', '',
  ].join('\r\n');
  // A frame in the same write exercises the HTTP server's upgrade `head` bytes.
  socket.write(Buffer.concat([Buffer.from(headers), frame('initial', true)]));
  await waitFor(() => handshake !== undefined);
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
  return { socket, messages, send: (text) => socket.write(frame(text, true)) };
}

test('validates Tailscale URLs and ports while allowing unused empty config', () => {
  assert.deepEqual(resolveTailscaleConfig(), { publicUrl: '', localPort: 9301 });
  assert.equal(normalizeTailscalePublicUrl('https://device.tailnet.ts.net'), PUBLIC_URL);
  assert.equal(normalizeTailscalePublicUrl('http://100.64.0.2:9301/'), 'http://100.64.0.2:9301/');
  assert.equal(resolveTailscaleConfig({ publicUrl: PUBLIC_URL, localPort: 0 }).localPort, 0);
  for (const publicUrl of ['not-a-url', 'file:///tmp/a', 'https:device', 'https://user:pass@device/', 'https://@device/', 'https://device/path', 'https://device/..', 'https://device/?', 'https://device/#', 'https://device/?token=value']) {
    assert.throws(() => normalizeTailscalePublicUrl(publicUrl), /tailscale.publicUrl/);
  }
  for (const localPort of [-1, 65536, 1.5, '9301']) {
    assert.throws(() => resolveTailscaleConfig({ localPort }), /tailscale.localPort/);
  }
});

test('streams HTTP with original path, query, Host, Origin, cookies, and redirects', async (t) => {
  let seen;
  const target = await listener(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    seen = { method: incoming.method, url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString() };
    response.writeHead(302, {
      location: 'https://device.tailnet.ts.net/next?key=abc%2Bdef',
      'set-cookie': ['session=updated; Path=/; Secure; HttpOnly', 'other=kept; Path=/'],
      'content-type': 'text/plain',
    });
    response.end('redirect-body');
  });
  const transport = bridge(() => ({ host: '127.0.0.1', port: target.port }));
  t.after(async () => { transport.stop(); await target.close(); });
  let ready = 0;
  transport.on('ready', () => { ready += 1; });
  const port = await start(transport);
  transport.start();
  assert.equal(transport.status().tailscale.localPort, port);
  const result = await request(port, {
    method: 'POST',
    path: '/api/send?x=a%2Bb&x=second',
    headers: { Host: 'device.tailnet.ts.net', Origin: 'https://device.tailnet.ts.net', Cookie: 'session=old; preference=dark', 'content-type': 'text/plain' },
  }, 'hello-dsh');
  assert.deepEqual(seen, {
    method: 'POST', url: '/api/send?x=a%2Bb&x=second', body: 'hello-dsh',
    headers: { host: 'device.tailnet.ts.net', origin: 'https://device.tailnet.ts.net', cookie: 'session=old; preference=dark', 'content-type': 'text/plain', connection: 'close', 'content-length': '9' },
  });
  assert.equal(result.status, 302);
  assert.equal(result.body, 'redirect-body');
  assert.equal(result.headers.location, 'https://device.tailnet.ts.net/next?key=abc%2Bdef');
  assert.deepEqual(result.headers['set-cookie'], ['session=updated; Path=/; Secure; HttpOnly', 'other=kept; Path=/']);
  const status = transport.status();
  assert.equal(status.state, 'forwarding');
  assert.equal(status.forward.bindAddress, '127.0.0.1');
  assert.equal(status.forward.target.port, target.port);
  assert.equal(status.mode, 'tailscale');
  assert.equal(ready, 1);
  assert.ok(status.stats.bytesUp > 0);
  assert.ok(status.stats.bytesDown > 0);
});

test('forwards response chunks before the upstream response ends', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const target = await listener(async (_incoming, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    await gate;
    response.end('data: second\n\n');
  });
  const transport = bridge(() => ({ host: '127.0.0.1', port: target.port }));
  t.after(async () => { release(); transport.stop(); await target.close(); });
  const port = await start(transport);
  const chunks = [];
  const completion = new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, agent: false }, (response) => {
      response.on('data', (chunk) => chunks.push(chunk.toString()));
      response.on('end', resolve);
      response.on('error', reject);
    }).on('error', reject);
  });
  await waitFor(() => chunks.length > 0);
  assert.equal(chunks.join(''), 'data: first\n\n');
  release();
  await completion;
  assert.equal(chunks.join(''), 'data: first\n\ndata: second\n\n');
});

test('proxies a real WebSocket handshake, upgrade heads, and frames both ways', async (t) => {
  let seen;
  const target = await listener();
  target.server.on('upgrade', (incoming, socket, head) => {
    socket.once('end', () => socket.end());
    seen = { url: incoming.url, headers: incoming.headers };
    const accept = createHash('sha1').update(`${incoming.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const handshake = `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
    // The first server frame follows the handshake in the same packet too.
    socket.write(Buffer.concat([Buffer.from(handshake), frame('greeting')]));
    let buffer = head;
    const read = (chunk = Buffer.alloc(0)) => {
      buffer = readFrames(Buffer.concat([buffer, chunk]), (text) => socket.write(frame(`echo:${text}`)));
    };
    read();
    socket.on('data', read);
  });
  const transport = bridge(() => ({ host: '127.0.0.1', port: target.port }));
  t.after(async () => { transport.stop(); await target.close(); });
  const port = await start(transport);
  const client = await websocket(port);
  t.after(() => client.socket.destroy());
  await waitFor(() => client.messages.includes('echo:initial'));
  assert.ok(client.messages.includes('greeting'));
  client.send('after-upgrade');
  await waitFor(() => client.messages.includes('echo:after-upgrade'));
  assert.equal(seen.url, '/events?token=opaque%2Bvalue');
  assert.equal(seen.headers.host, 'device.tailnet.ts.net');
  assert.equal(seen.headers.origin, 'https://device.tailnet.ts.net');
  assert.equal(seen.headers.cookie, 'session=existing');
  assert.equal(transport.status().stats.openChannels, 1);
  const closed = once(client.socket, 'close');
  transport.stop();
  await closed;
  await waitFor(() => target.sockets.size === 0);
  assert.equal(transport.status().stats.openChannels, 0);
});

test('keeps a stable ingress while the DSH listener changes ports', async (t) => {
  const first = await listener((_request, response) => response.end('first'));
  const second = await listener((_request, response) => response.end('second'));
  let targetPort = first.port;
  const transport = bridge(() => ({ host: '0.0.0.0', port: targetPort }));
  t.after(async () => { transport.stop(); await first.close(); await second.close(); });
  const port = await start(transport);
  assert.equal((await request(port)).body, 'first');
  await first.close();
  targetPort = second.port;
  assert.equal((await request(port)).body, 'second');
  assert.equal(transport.status().tailscale.localPort, port);
  assert.deepEqual(transport.status().forward.target, { host: '127.0.0.1', port: second.port });
});

test('returns 503 without a target and discovers a newly started listener', async (t) => {
  const target = await listener((_request, response) => response.end('ready'));
  let current;
  const transport = bridge(() => current);
  t.after(async () => { transport.stop(); await target.close(); });
  const port = await start(transport);
  assert.equal(transport.state, 'connecting');
  assert.equal((await request(port)).status, 503);
  current = { host: 'localhost', port: target.port };
  await waitFor(() => transport.state === 'forwarding');
  assert.equal((await request(port)).body, 'ready');
  current = undefined;
  assert.equal((await request(port)).status, 503);
  assert.equal(transport.status().state, 'connecting');
  assert.equal(transport.status().forward.target, null);
});

test('refuses non-loopback upstreams and recovers when the resolver is corrected', async (t) => {
  const target = await listener((_request, response) => response.end('local'));
  let host = '192.0.2.1';
  const transport = bridge(() => ({ host, port: target.port }));
  t.after(async () => { transport.stop(); await target.close(); });
  const port = await start(transport);
  assert.equal((await request(port)).status, 503);
  assert.equal(transport.state, 'failed');
  assert.match(transport.status().lastError, /loopback/);
  host = '127.0.0.1';
  assert.equal((await request(port)).body, 'local');
  assert.equal(transport.state, 'forwarding');
  assert.equal(transport.status().lastError, null);
});

test('stop and restart close active HTTP sockets and release the listener', async (t) => {
  const target = await listener((_request, response) => response.write('streaming'));
  const transport = bridge(() => ({ host: '127.0.0.1', port: target.port }));
  t.after(async () => { transport.stop(); await target.close(); });
  const firstPort = await start(transport);
  let incoming;
  const outgoing = http.get({ host: '127.0.0.1', port: firstPort, agent: false }, (response) => {
    incoming = response;
    response.on('error', () => {});
    response.resume();
  });
  outgoing.on('error', () => {});
  await waitFor(() => incoming !== undefined);
  transport.stop();
  transport.stop();
  await waitFor(() => incoming.destroyed && target.sockets.size === 0);
  assert.equal(transport.status().state, 'stopped');
  assert.equal(transport.status().connectedAt, null);
  assert.equal(transport.status().uptimeMs, 0);
  assert.equal(transport.status().stats.openChannels, 0);
  await assert.rejects(request(firstPort), /ECONNREFUSED/);
  transport.restart();
  await waitFor(() => transport.state === 'forwarding');
  const restartedPort = transport.status().tailscale.localPort;
  assert.ok(restartedPort > 0);
  transport.restart();
  await waitFor(() => transport.state === 'forwarding');
  assert.equal(transport.running, true);
});

test('a bind conflict reports failure without throwing and can be restarted', async (t) => {
  const blocker = await listener((_request, response) => response.end('occupied'));
  const target = await listener((_request, response) => response.end('recovered'));
  const transport = bridge(() => ({ host: '127.0.0.1', port: target.port }), { localPort: blocker.port });
  t.after(async () => { transport.stop(); await blocker.close(); await target.close(); });
  assert.doesNotThrow(() => transport.start());
  await waitFor(() => transport.state === 'failed');
  assert.match(transport.status().lastError, /EADDRINUSE/);
  assert.equal(transport.status().connectedAt, null);
  await blocker.close();
  transport.restart();
  await waitFor(() => transport.state === 'forwarding');
  assert.equal((await request(blocker.port)).body, 'recovered');
});

test('missing public URL fails safely, and stopping before listen does not leak a server', async (t) => {
  const invalid = bridge(() => undefined, { publicUrl: '' });
  t.after(() => invalid.stop());
  assert.doesNotThrow(() => invalid.start());
  assert.equal(invalid.state, 'failed');
  assert.match(invalid.status().lastError, /publicUrl is required/);
  const target = await listener((_request, response) => response.end('after-race'));
  const transport = bridge(() => ({ host: '127.0.0.1', port: target.port }));
  t.after(async () => { transport.stop(); await target.close(); });
  transport.start();
  transport.stop();
  transport.start();
  await waitFor(() => transport.state === 'forwarding');
  assert.equal((await request(transport.status().tailscale.localPort)).body, 'after-race');
});

test('an unavailable upstream returns 502 and a resolver error stays contained', async (t) => {
  const released = await listener();
  const port = released.port;
  await released.close();
  let throwFromResolver = false;
  const transport = bridge(() => {
    if (throwFromResolver) throw new Error('listener lookup failed');
    return { host: '127.0.0.1', port };
  });
  t.after(() => transport.stop());
  const ingress = await start(transport);
  assert.equal((await request(ingress)).status, 502);
  assert.equal(transport.state, 'failed');
  assert.match(transport.status().lastError, /ECONNREFUSED/);
  throwFromResolver = true;
  assert.equal((await request(ingress)).status, 503);
  assert.match(transport.status().lastError, /listener lookup failed/);
});
