/**
 * Stable loopback ingress for an independently configured Tailscale Serve.
 * Tailscale owns the private network and HTTPS; this transport follows DSH's
 * changing local web listener without publishing a second management interface.
 *
 * @module dsh-ssh-bridge/tailscale
 */

import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const BIND_ADDRESS = '127.0.0.1';
const DEFAULT_LOCAL_PORT = 9301;

/**
 * Validate a browser-facing HTTP(S) origin. An empty value is allowed while
 * resolving configuration for another transport, but cannot start this one.
 * @param {string} [value] Public Tailscale endpoint.
 * @returns {string} Canonical root URL, or an empty string.
 */
export function normalizeTailscalePublicUrl(value = '') {
  if (typeof value !== 'string') throw new Error('tailscale.publicUrl must be a URL string');
  const input = value.trim();
  if (input === '') return '';
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('tailscale.publicUrl must be an absolute HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '' || !/^https?:\/\//i.test(input)) {
    throw new Error('tailscale.publicUrl must use HTTP or HTTPS');
  }
  if (url.username !== '' || url.password !== '' || /^[^/]+:\/\/[^/]*@/.test(input)) {
    throw new Error('tailscale.publicUrl must not contain credentials');
  }
  if (url.pathname !== '/' || !/^https?:\/\/[^/?#\\]+\/?$/i.test(input)) {
    throw new Error('tailscale.publicUrl must be a root URL without a query or fragment');
  }
  return url.href;
}

/**
 * Resolve only Tailscale configuration; no CLI, network, or account operations.
 * @param {object} [value] Raw Tailscale options.
 * @returns {{ publicUrl: string, localPort: number }} Validated options.
 */
export function resolveTailscaleConfig(value = {}) {
  const publicUrl = normalizeTailscalePublicUrl(value.publicUrl ?? '');
  const localPort = value.localPort ?? DEFAULT_LOCAL_PORT;
  if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
    throw new Error('tailscale.localPort must be an integer between 0 and 65535');
  }
  return { publicUrl, localPort };
}

/** Resolve wildcard listeners locally and refuse any non-loopback upstream. */
function localTarget(value) {
  if (value === undefined || value === null) return undefined;
  const port = value.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Tailscale target must have a valid local port');
  }
  let host = value.host ?? BIND_ADDRESS;
  if (typeof host !== 'string') throw new Error('Tailscale target must be a loopback address');
  host = host.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0') host = BIND_ADDRESS;
  if (host === '::' || host === '[::]') host = '::1';
  if (host === '[::1]') host = '::1';
  if (host.startsWith('::ffff:') && net.isIP(host.slice(7)) === 4) host = host.slice(7);
  if (host !== '::1' && !(net.isIP(host) === 4 && host.startsWith('127.'))) {
    throw new Error('Tailscale target must be a loopback address');
  }
  return { host, port };
}

/** Render the original upgrade request; its remaining bytes use a raw pipe. */
function upgradeRequest(request) {
  let result = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    result += `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`;
  }
  return `${result}\r\n`;
}

/** A local HTTP/WebSocket proxy, exposed to a tailnet by Tailscale Serve. */
export class TailscaleTransport extends EventEmitter {
  #config;
  #resolveTarget;
  #log;
  #server;
  #timer;
  #generation = 0;
  #stopped = true;
  #state = 'stopped';
  #attempt = 0;
  #settings;
  #boundPort;
  #target;
  #connectedAt;
  #forwardedAt;
  #lastError;
  #sockets = new Set();
  #channels = new Set();
  #requests = new Set();
  #stats = { totalChannels: 0, bytesUp: 0, bytesDown: 0 };

  /**
   * @param {object} options Construction inputs.
   * @param {object} options.config Resolved plugin configuration.
   * @param {() => ({host: string, port: number} | undefined)} options.resolveTarget Live DSH listener.
   * @param {(level: string, message: string) => void} [options.log] Lifecycle log sink.
   */
  constructor({ config, resolveTarget, log }) {
    super();
    this.#config = config;
    this.#resolveTarget = resolveTarget;
    this.#log = log ?? (() => {});
  }

  get running() { return !this.#stopped; }
  get state() { return this.#state; }

  /** Start once. Configuration and bind errors are published, never thrown. */
  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#state = 'connecting';
    this.#attempt = 1;
    this.#lastError = undefined;
    const generation = ++this.#generation;
    try {
      this.#settings = resolveTailscaleConfig(this.#config.tailscale);
      if (this.#settings.publicUrl === '') {
        throw new Error('tailscale.publicUrl is required to start the Tailscale transport');
      }
      const server = http.createServer((request, response) => this.#proxyHttp(request, response));
      this.#server = server;
      server.on('connection', (socket) => {
        if (generation !== this.#generation || this.#stopped) return socket.destroy();
        this.#channels.add(socket);
        this.#stats.totalChannels += 1;
        this.#trackSocket(socket, 'bytesUp');
        socket.once('close', () => this.#channels.delete(socket));
      });
      server.on('upgrade', (request, socket, head) => this.#proxyUpgrade(request, socket, head));
      server.on('error', (error) => {
        if (generation !== this.#generation || this.#stopped) return;
        this.#fail(error);
        this.#closeListener();
      });
      server.listen(this.#settings.localPort, BIND_ADDRESS, () => {
        if (generation !== this.#generation || this.#stopped) {
          server.close();
          return;
        }
        this.#boundPort = server.address().port;
        this.#connectedAt = Date.now();
        this.#refreshTarget();
        this.#timer = setInterval(() => this.#refreshTarget(), 1000);
        this.#timer.unref?.();
      });
    } catch (error) {
      this.#fail(error);
      this.#closeListener();
    }
  }

  /** Close both sides of every active request, including upgraded sockets. */
  stop() {
    this.#stopped = true;
    this.#generation += 1;
    this.#state = 'stopped';
    this.#closeListener();
  }

  /** Rebind from a clean state, including after a failed bind. */
  restart() {
    this.stop();
    this.start();
  }

  /** @returns {object} JSON-serialisable status compatible with bridge pages. */
  status() {
    const localPort = this.#boundPort ?? this.#settings?.localPort ?? this.#config.tailscale?.localPort ?? DEFAULT_LOCAL_PORT;
    return {
      mode: 'tailscale',
      state: this.#state,
      enabled: this.#config.enabled,
      attempt: this.#attempt,
      connectedAt: this.#connectedAt ?? null,
      forwardedAt: this.#forwardedAt ?? null,
      uptimeMs: this.#connectedAt === undefined ? 0 : Date.now() - this.#connectedAt,
      lastError: this.#lastError ?? null,
      forward: { bindAddress: BIND_ADDRESS, remotePort: localPort, target: this.#target ? { ...this.#target } : null },
      tailscale: { publicUrl: this.#settings?.publicUrl ?? this.#config.tailscale?.publicUrl ?? '', localPort },
      stats: { openChannels: this.#channels.size, ...this.#stats },
    };
  }

  #closeListener() {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const request of this.#requests) request.destroy();
    this.#requests.clear();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#channels.clear();
    const server = this.#server;
    this.#server = undefined;
    server?.close();
    this.#boundPort = undefined;
    this.#target = undefined;
    this.#connectedAt = undefined;
    this.#forwardedAt = undefined;
  }

  #fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.#lastError) this.#log('warn', `ssh-bridge: tailscale: ${message}`);
    this.#lastError = message;
    this.#state = 'failed';
    this.emit('unavailable', { error: message });
  }

  #trackSocket(socket, direction) {
    this.#sockets.add(socket);
    socket.on('error', () => {});
    socket.on('data', (chunk) => { this.#stats[direction] += chunk.length; });
    socket.once('close', () => this.#sockets.delete(socket));
  }

  /** Re-evaluate on every request as well as while waiting for DSH to start. */
  #refreshTarget() {
    if (this.#stopped || !this.#server?.listening) return undefined;
    let target;
    try {
      target = localTarget(this.#resolveTarget());
      if (target?.port === this.#boundPort && target.host === BIND_ADDRESS) {
        throw new Error('Tailscale proxy cannot forward to itself');
      }
    } catch (error) {
      this.#target = undefined;
      this.#forwardedAt = undefined;
      this.#fail(error);
      return undefined;
    }
    const changed = this.#target?.host !== target?.host || this.#target?.port !== target?.port;
    this.#target = target;
    this.#lastError = undefined;
    if (target === undefined) {
      if (this.#state === 'forwarding') this.emit('unavailable', { error: 'DSH web listener is not ready' });
      this.#state = 'connecting';
      this.#forwardedAt = undefined;
      return undefined;
    }
    if (this.#state !== 'forwarding' || changed) {
      this.#state = 'forwarding';
      this.#forwardedAt = Date.now();
      const details = { bindAddress: BIND_ADDRESS, remotePort: this.#boundPort, target: { ...target } };
      this.emit('forwarding', details);
      this.emit('ready', details);
    }
    return target;
  }

  #proxyHttp(request, response) {
    const target = this.#refreshTarget();
    if (target === undefined) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' });
      response.end('DSH web listener is not ready');
      return;
    }
    const upstream = http.request({
      hostname: target.host,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: request.rawHeaders,
      agent: false,
    }, (incoming) => {
      if (response.destroyed) return incoming.destroy();
      response.writeHead(incoming.statusCode, incoming.statusMessage, incoming.rawHeaders);
      incoming.on('error', () => response.destroy());
      incoming.pipe(response);
    });
    this.#requests.add(upstream);
    upstream.once('close', () => this.#requests.delete(upstream));
    upstream.on('socket', (socket) => {
      if (this.#stopped) return socket.destroy();
      this.#trackSocket(socket, 'bytesDown');
    });
    upstream.on('error', (error) => {
      if (this.#stopped || response.destroyed) return;
      this.#fail(error);
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('DSH web listener is unavailable');
      }
    });
    request.on('aborted', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  }

  #proxyUpgrade(request, socket, head) {
    const target = this.#refreshTarget();
    if (target === undefined) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.pause();
    const upstream = net.connect({ host: target.host, port: target.port });
    this.#trackSocket(upstream, 'bytesDown');
    let connected = false;
    upstream.once('connect', () => {
      if (this.#stopped || socket.destroyed) return upstream.destroy();
      connected = true;
      upstream.write(upgradeRequest(request));
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', (error) => {
      if (this.#stopped || socket.destroyed) return;
      this.#fail(error);
      if (connected) socket.destroy();
      else socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => { if (connected) socket.destroy(); });
  }
}
