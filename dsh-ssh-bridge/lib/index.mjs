/**
 * dsh-ssh-bridge — control this DSH from a phone, with no public inbound port on the DSH host.
 *
 * Three access modes, one plugin:
 *
 * - ssh   — an outbound SSH connection publishes the DSH listener on the SSH server's
 *             loopback. The phone opens a local forward and browses `127.0.0.1`, which
 *             DSH's trust fence accepts as loopback.
 * - relay — the plugin keeps idle authenticated TLS connections to a relay this package
 *             also ships (`bin/dsh-relay.mjs`). The phone just opens the relay's HTTPS URL
 *             in a browser: the relay swaps its access key for a cookie and pipes bytes.
 *
 * - tailscale — a stable loopback proxy follows the current DSH listener. Tailscale
 *   Serve publishes it privately to the tailnet, without a separate relay server.
 *
 * SSH and relay are outbound-only. Tailscale needs no public inbound listener.
 *
 * See README.md for deployment, the phone procedure, and the security model.
 *
 * @module dsh-ssh-bridge
 */

import os from 'node:os';
import path from 'node:path';
import * as fileSystem from 'node:fs';
import Schema from '@deepseek-ai/schemastery';

import { buildPairing, buildRelayPairing, buildTailscalePairing, describePairing } from './pairing.mjs';
import { renderStatusPage } from './page.mjs';
import { listDirectory, renderFilesPage, resolveWithin } from './files-page.mjs';
import { startLocalPage } from './local-page.mjs';
import { RelayClient } from './relay-client.mjs';
import { tokenEquals } from './relay-protocol.mjs';
import { SshTunnel } from './tunnel.mjs';
import { TailscaleTransport, resolveTailscaleConfig } from './tailscale.mjs';

/** Stable Cordis plugin name. */
export const name = 'ssh-bridge';

/*
 * No `inject` declaration: the bridge is useful without either optional service, so it
 * reads them through `ctx.get()` (an uninjected read) and defers route registration with
 * ctx.inject(['webServer'], …) instead of blocking activation on them.
 */

const AUTH_METHODS = ['auto', 'agent', 'privateKey', 'password'];
const HOST_KEY_POLICIES = ['strict', 'accept-new', 'insecure'];
const TRANSPORTS = ['ssh', 'relay', 'tailscale'];

/** Accepted configuration and its defaults. */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('Keep the configured transport connected and publish this DSH through it.'),
  transport: Schema.union(TRANSPORTS.map((kind) => Schema.const(kind))).default('ssh')
    .description('"tailscale" uses a private Tailscale Serve URL; "ssh" uses an SSH server; "relay" uses the bundled relay server.'),
  tailscale: Schema.object({
    publicUrl: Schema.string().default('')
      .description('Private HTTPS origin published by Tailscale Serve, for example https://computer.example.ts.net.'),
    localPort: Schema.natural().min(1).max(65535).default(9301)
      .description('Stable loopback proxy port. Point Tailscale Serve at http://127.0.0.1:<localPort>.'),
  }).description('Private access through system Tailscale; no dsh relay server is needed.'),
  ssh: Schema.object({
    host: Schema.string().default('')
      .description('SSH server hostname or IP address. Leave empty to install the plugin without connecting.'),
    port: Schema.natural().min(1).max(65535).default(22)
      .description('SSH server port.'),
    username: Schema.string().default('dsh')
      .description('Account on the SSH server used for the outbound connection.'),
    authMethod: Schema.union(AUTH_METHODS.map((method) => Schema.const(method))).default('auto')
      .description('How to authenticate. "auto" prefers an SSH agent, then a key in ~/.ssh, then a password.'),
    privateKeyPath: Schema.string().default('')
      .description('Private key file. "~" expands to your home directory.'),
    privateKeyPassphrase: Schema.string().default('')
      .description('Passphrase for an encrypted private key.'),
    password: Schema.string().default('')
      .description('Password authentication. Prefer a key or an agent.'),
    agentPath: Schema.string().default('')
      .description('SSH agent socket. Defaults to SSH_AUTH_SOCK, or the OpenSSH agent pipe on Windows.'),
    knownHostsPath: Schema.string().default('')
      .description('known_hosts file used for host key verification. Defaults to ~/.ssh/known_hosts.'),
    hostKeyPolicy: Schema.union(HOST_KEY_POLICIES.map((policy) => Schema.const(policy))).default('accept-new')
      .description('strict requires a known_hosts entry, accept-new records an unknown key but refuses a changed one, insecure disables verification.'),
    readyTimeoutMs: Schema.natural().min(1000).max(300000).default(20000)
      .description('Handshake deadline for one connection attempt.'),
    keepaliveIntervalMs: Schema.natural().min(0).max(300000).default(15000)
      .description('Keepalive interval; 0 disables keepalives.'),
  }).description('SSH server this host dials out to (transport: ssh).'),
  relay: Schema.object({
    host: Schema.string().default('')
      .description('Relay hostname or IP. Empty falls back to ssh.host.'),
    port: Schema.natural().min(1).max(65535).default(8443)
      .description('Relay port.'),
    protocol: Schema.union(['https', 'http'].map((kind) => Schema.const(kind))).default('https')
      .description('https verifies the relay certificate. http speaks plain text: the access key and the DSH launch token then cross the network in the clear, so only pick it on a link you trust.'),
    publicHost: Schema.string().default('')
      .description('Address the phone uses in the pairing link, when it differs from relay.host (for example behind NAT).'),
    publicPort: Schema.natural().min(0).max(65535).default(0)
      .description('Port the phone uses; 0 reuses relay.port.'),
    token: Schema.string().default('')
      .description('Shared secret the relay checks before accepting this host.'),
    accessToken: Schema.string().default('')
      .description('Access key the relay asks the phone for once. Included in the pairing link.'),
    hostId: Schema.string().default('default')
      .description('Logical host name; one relay port serves one host.'),
    fingerprint: Schema.string().default('')
      .description('SHA-256 fingerprint printed by the relay. Strongly recommended: it pins the self-signed certificate.'),
    servername: Schema.string().default('')
      .description('TLS server name to send when the relay certificate is issued for a DNS name.'),
    insecure: Schema.boolean().default(false)
      .description('Accept any relay certificate. Only for a first experiment; prefer fingerprint.'),
    poolSize: Schema.natural().min(1).max(128).default(32)
      .description('Idle relay connections kept open. A browser opens several in parallel for one page, so this must exceed its per-host limit.'),
    refreshMs: Schema.natural().min(100).max(60000).default(300)
      .description('How often the idle pool is topped up.'),
    idleTtlMs: Schema.natural().min(5000).max(600000).default(40000)
      .description('Recycle an idle relay connection older than this, so NAT timeouts cannot strand it.'),
    timeoutMs: Schema.natural().min(1000).max(120000).default(15000)
      .description('Handshake deadline for one relay connection.'),
  }).description('Relay this host publishes through (transport: relay).'),
  forward: Schema.object({
    bindAddress: Schema.string().default('127.0.0.1')
      .description('Address the SSH server publishes on. Keep it on the server loopback unless you really mean to expose the port.'),
    port: Schema.natural().min(1).max(65535).default(9100)
      .description('Port the SSH server publishes this DSH on.'),
  }).description('Where the SSH server publishes this DSH (transport: ssh).'),
  reconnect: Schema.object({
    enabled: Schema.boolean().default(true).description('Reconnect after a dropped connection.'),
    minDelayMs: Schema.natural().min(100).max(600000).default(1000).description('First retry delay.'),
    maxDelayMs: Schema.natural().min(100).max(1800000).default(30000).description('Retry delay ceiling.'),
    factor: Schema.number().min(1).max(10).default(2).description('Backoff growth factor.'),
  }).description('Reconnect policy (transport: ssh).'),
  pairing: Schema.object({
    localPort: Schema.natural().min(0).max(65535).default(9300)
      .description('Fixed loopback port serving a pairing page you can bookmark, so the current link is always reachable without a DSH browser session. 0 disables it.'),
    localHost: Schema.string().default('127.0.0.1')
      .description('Bind address of the pairing page. Keep it on loopback.'),
    phonePort: Schema.natural().min(0).max(65535).default(0)
      .description('Local port the phone forwards to itself (transport: ssh). 0 reuses the published port.'),
    qr: Schema.boolean().default(true).description('Render a QR code for the pairing URL when the optional qrcode package is installed.'),
  }).description('Phone pairing instructions.'),
  statusPage: Schema.boolean().default(true)
    .description('Register /ssh-bridge and /ssh-bridge/status on the DSH web listener.'),
  files: Schema.object({
    enabled: Schema.boolean()
      .description('Expose the authenticated file browser. Defaults to false for Tailscale and true for legacy modes.'),
    root: Schema.string().default('')
      .description('Directory /ssh-bridge/files browses. Empty falls back to the host process directory, which is rarely what you want.'),
  }).description('File browser for other devices.'),
});

/**
 * Resolve user configuration into the shape the transports expect.
 * @param {object} [config] - Raw plugin configuration.
 * @returns {object} Normalised configuration.
 */
export function resolveConfig(config = {}) {
  const expand = (value) => {
    if (typeof value !== 'string' || value === '') return '';
    return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
  };

  const ssh = config.ssh ?? {};
  const relay = config.relay ?? {};
  const forward = config.forward ?? {};
  const reconnect = config.reconnect ?? {};
  const pairing = config.pairing ?? {};

  const forwardPort = forward.port ?? 9100;
  const phonePort = pairing.phonePort === undefined || pairing.phonePort === 0 ? forwardPort : pairing.phonePort;

  const relayPort = relay.port ?? 8443;
  const relayHost = (relay.host ?? '').trim() === '' ? (ssh.host ?? '').trim() : relay.host.trim();

  return {
    enabled: config.enabled ?? true,
    transport: TRANSPORTS.includes(config.transport) ? config.transport : 'ssh',
    tailscale: resolveTailscaleConfig(config.tailscale),
    ssh: {
      host: (ssh.host ?? '').trim(),
      port: ssh.port ?? 22,
      username: ssh.username ?? 'dsh',
      authMethod: AUTH_METHODS.includes(ssh.authMethod) ? ssh.authMethod : 'auto',
      privateKeyPath: expand(ssh.privateKeyPath) || undefined,
      privateKeyPassphrase: ssh.privateKeyPassphrase || undefined,
      password: ssh.password || undefined,
      agentPath: ssh.agentPath || undefined,
      knownHostsPath: expand(ssh.knownHostsPath) || path.join(os.homedir(), '.ssh', 'known_hosts'),
      hostKeyPolicy: HOST_KEY_POLICIES.includes(ssh.hostKeyPolicy) ? ssh.hostKeyPolicy : 'accept-new',
      readyTimeoutMs: ssh.readyTimeoutMs ?? 20000,
      keepaliveIntervalMs: ssh.keepaliveIntervalMs ?? 15000,
    },
    relay: {
      host: relayHost,
      port: relayPort,
      protocol: relay.protocol === 'http' ? 'http' : 'https',
      publicHost: (relay.publicHost ?? '').trim(),
      publicPort: relay.publicPort === undefined || relay.publicPort === 0 ? relayPort : relay.publicPort,
      token: relay.token ?? '',
      accessToken: relay.accessToken ?? '',
      hostId: relay.hostId || 'default',
      fingerprint: (relay.fingerprint ?? '').trim().toUpperCase(),
      servername: (relay.servername ?? '').trim() || undefined,
      insecure: relay.insecure === true,
      poolSize: relay.poolSize ?? 32,
      refreshMs: relay.refreshMs ?? 300,
      idleTtlMs: relay.idleTtlMs ?? 40000,
      timeoutMs: relay.timeoutMs ?? 15000,
    },
    forward: {
      bindAddress: forward.bindAddress || '127.0.0.1',
      port: forwardPort,
    },
    reconnect: {
      enabled: reconnect.enabled ?? true,
      minDelayMs: reconnect.minDelayMs ?? 1000,
      maxDelayMs: reconnect.maxDelayMs ?? 30000,
      factor: reconnect.factor ?? 2,
    },
    pairing: {
      phonePort,
      qr: pairing.qr ?? true,
      localPort: pairing.localPort ?? 9300,
      localHost: pairing.localHost || '127.0.0.1',
    },
    statusPage: config.statusPage ?? true,
    files: {
      enabled: config.files?.enabled ?? config.transport !== 'tailscale',
      root: (config.files?.root ?? '').trim(),
    },
  };
}

/**
 * Build a level-tolerant logger from whatever the Cordis context offers.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @returns {(level: string, message: string) => void} Log sink.
 */
function makeLogger(ctx) {
  let scoped;
  try {
    scoped = typeof ctx.logger === 'function' ? ctx.logger('ssh-bridge') : ctx.logger;
  } catch {
    scoped = undefined;
  }

  return (level, message) => {
    try {
      const sink = typeof scoped?.[level] === 'function' ? scoped : ctx.logger;
      if (typeof sink?.[level] === 'function') sink[level](message);
    } catch {
      // Logging must never take the plugin down.
    }
  };
}

/**
 * Read the live DSH web listener, which binds after plugin activation.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @returns {{ host: string, port: number } | undefined} Loopback target, when bound.
 */
function readWebTarget(ctx) {
  const webServer = ctx.get?.('webServer');
  if (webServer === undefined || webServer === null) return undefined;

  if (typeof webServer.port === 'number' && webServer.port > 0 && typeof webServer.host === 'string') {
    return { host: webServer.host, port: webServer.port };
  }

  try {
    const url = new URL(webServer.getOrigin());
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isFinite(port) ? { host: url.hostname, port } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a request may read bridge state.
 *
 * Two credentials are accepted: an authenticated DSH browser session, or the relay's
 * access key in `?rk=`. The second exists because the Desktop shell renders over
 * `file://` and never holds a browser cookie, so an owner sitting in the app has no
 * session to present. The access key is the same secret the pairing link already
 * carries, and this route only ever surfaces that link.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {import('node:http').IncomingMessage} request - HTTP request.
 * @param {string} [accessKey] - Relay access key accepted as an alternative.
 * @returns {boolean} Whether the caller may proceed.
 */
function isAuthorized(ctx, request, accessKey, requireConnection = false) {
  if (typeof accessKey === 'string' && accessKey !== '') {
    try {
      const url = new URL(request.url ?? '/', 'http://dsh.invalid');
      if (tokenEquals(url.searchParams.get('rk'), accessKey)) return true;
    } catch {
      // Fall through to the session check.
    }
  }

  const connection = ctx.get?.('connection');
  if (connection === undefined || typeof connection.admit !== 'function') return !requireConnection;
  try {
    return !('rejection' in connection.admit(request));
  } catch {
    return false;
  }
}

/**
 * Reject a cross-site browser request for a mutating route.
 * @param {import('node:http').IncomingMessage} request - HTTP request.
 * @returns {boolean} Whether the request looks same-origin.
 */
function isSameSite(request) {
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

/**
 * Plugin body: build the transport, publish a service, and register the status routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {object} config - Resolved plugin configuration.
 */
export async function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {});
  const log = makeLogger(ctx);
  const mode = resolved.transport;
  const accessKey = mode === 'tailscale' ? '' : resolved.relay.accessToken;
  const transports = { ssh: SshTunnel, relay: RelayClient, tailscale: TailscaleTransport };
  const transport = new transports[mode]({ config: resolved, resolveTarget: () => readWebTarget(ctx), log });

  let cachedPairing;
  let cachedAt = 0;
  let announced = false;
  let disposed = false;
  const restart = () => {
    if (!resolved.enabled || disposed) return;
    cachedPairing = undefined;
    transport.restart();
  };

  /**
   * Pairing material for the current transport.
   * @returns {Promise<object | undefined>} Instructions, or undefined when not ready.
   */
  const pairing = async () => {
    const connection = ctx.get?.('connection');
    const authenticatedUrl = typeof connection?.authenticatedUrl === 'function'
      ? (url) => connection.authenticatedUrl(url)
      : undefined;

    if (mode === 'tailscale') {
      if (transport.status().state !== 'forwarding' || authenticatedUrl === undefined) return undefined;
      if (cachedPairing !== undefined && Date.now() - cachedAt < 60_000) return cachedPairing;
      cachedPairing = await buildTailscalePairing({ tailscale: resolved.tailscale, authenticatedUrl, qr: resolved.pairing.qr });
      cachedAt = Date.now();
      return cachedPairing;
    }

    if (mode === 'relay') {
      if (resolved.relay.host === '') return undefined;
      if (cachedPairing !== undefined && Date.now() - cachedAt < 60_000) return cachedPairing;
      cachedPairing = await buildRelayPairing({
        relay: resolved.relay,
        authenticatedUrl,
        qr: resolved.pairing.qr,
      });
      cachedAt = Date.now();
      return cachedPairing;
    }

    const status = transport.status();
    if (status.state !== 'forwarding' || status.forward.target === null) return undefined;
    if (cachedPairing !== undefined && Date.now() - cachedAt < 60_000) return cachedPairing;

    cachedPairing = await buildPairing({
      ssh: resolved.ssh,
      forward: {
        bindAddress: resolved.forward.bindAddress,
        remotePort: status.forward.remotePort,
      },
      phonePort: resolved.pairing.phonePort,
      authenticatedUrl,
      qr: resolved.pairing.qr,
    });
    cachedAt = Date.now();
    return cachedPairing;
  };

  /** Announce the phone procedure once, as soon as it is knowable. */
  const announce = async () => {
    if (announced) return;
    const material = await pairing().catch(() => undefined);
    if (material === undefined) return;
    announced = true;
    log('info', mode === 'tailscale'
      ? `ssh-bridge: Tailscale entry ${material.url}; pair from the local pairing page`
      : `ssh-bridge: ${describePairing(material)}`);
  };

  /* A fixed loopback address an owner can bookmark. The DSH listener's port is chosen per
     launch and the Desktop shell has no browser session, so this is the only stable way to
     reach the current pairing link. */
  let localPage;
  if (resolved.pairing.localPort > 0) {
    try {
      localPage = await startLocalPage({
        host: resolved.pairing.localHost,
        port: resolved.pairing.localPort,
        accessKey,
        reconnect: resolved.enabled ? restart : undefined,
        filesUrl: resolved.files.enabled ? undefined : null,
        getStatus: () => transport.status(),
        getPairing: pairing,
        log,
      });
    } catch (error) {
      log('warn', `ssh-bridge: pairing page could not bind ${resolved.pairing.localHost}:${resolved.pairing.localPort}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  ctx.effect(() => () => {
    void localPage?.close();
  }, 'ssh-bridge: pairing page');

  const service = {
    /** @returns {object} Transport snapshot. */
    status: () => transport.status(),
    /** @returns {Promise<object | undefined>} Phone instructions. */
    pairing,
    /** Reconnect from a clean state. */
    restart,
    /** Stop reconnecting and close the connection. */
    stop: () => transport.stop(),
    /** The underlying transport, for advanced use and tests. */
    transport,
  };

  try {
    ctx.provide('sshBridge', service);
  } catch (error) {
    log('warn', `ssh-bridge: could not provide the sshBridge service: ${error instanceof Error ? error.message : String(error)}`);
  }

  ctx.effect(() => () => {
    disposed = true;
    transport.stop();
  }, 'ssh-bridge: transport');

  for (const event of ['forwarding', 'disconnected', 'ready', 'unavailable']) {
    transport.on(event, () => {
      cachedPairing = undefined;
    });
  }
  transport.on('forwarding', () => void announce());
  transport.on('ready', () => void announce());

  if (resolved.enabled) {
    if (mode === 'tailscale') {
      transport.start();
    } else if (mode === 'relay') {
      if (resolved.relay.host === '') {
        log('error', 'ssh-bridge: transport is "relay" but relay.host (or ssh.host) is empty; not connecting');
      } else if (resolved.relay.token === '') {
        log('error', 'ssh-bridge: transport is "relay" but relay.token is empty; the relay will refuse this host');
      } else {
        transport.start();
      }
    } else if (resolved.ssh.host === '') {
      log('error', 'ssh-bridge: enabled but ssh.host is empty; the bridge will not connect until it is set');
    } else {
      transport.start();
    }
  } else {
    log('info', 'ssh-bridge: installed but disabled; set enabled to publish this DSH');
  }

  if (!resolved.statusPage) return;

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/ssh-bridge/status',
      handler: async (request, response) => {
        if (!isAuthorized(webCtx, request, accessKey, mode === 'tailscale')) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('forbidden');
          return;
        }
        const status = transport.status();
        let material;
        try {
          material = await pairing();
        } catch {
          material = undefined;
        }
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(`${JSON.stringify({
          ...status,
          pairing: material === undefined
            ? null
            : {
              mode: material.mode,
              url: material.url,
              tokenUrl: material.tokenUrl ?? null,
              ...(material.mode === 'ssh'
                ? { sshCommand: material.sshCommand, sshConfig: material.sshConfig, phonePort: material.phonePort }
                : {}),
              hasQr: material.qrDataUrl !== undefined,
            },
        }, null, 2)}\n`);
      },
    }), 'ssh-bridge: status route');

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/ssh-bridge',
      handler: async (request, response) => {
        if (!isAuthorized(webCtx, request, accessKey, mode === 'tailscale')) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('forbidden');
          return;
        }
        const status = transport.status();
        let material;
        try {
          material = await pairing();
        } catch {
          material = undefined;
        }

        /* `go` turns this page into a plain HTTP hand-off: browsers and installed apps
           follow a 302 without needing any script, which is the only reliable way to get
           from the pairing page into DSH inside a WebView. */
        let wantsGo = false;
        try {
          wantsGo = new URL(request.url ?? '/', 'http://dsh.invalid').searchParams.has('go');
        } catch {
          wantsGo = false;
        }
        if (wantsGo && material?.tokenUrl !== undefined) {
          response.writeHead(302, {
            location: material.tokenUrl,
            'cache-control': 'no-store',
            /* Force a fresh connection for the next hop. The relay authenticates only the
               first request on a connection and then becomes a blind byte pipe, so without
               this the follow-up would ride the already-bridged connection, reach DSH
               directly, and never collect the relay's own access cookie. */
            connection: 'close',
          });
          response.end();
          return;
        }

        let hint;
        if (!resolved.enabled) hint = '连接入口已停用，请在插件配置中启用。';
        else if (mode === 'tailscale') {
          hint = resolved.tailscale.publicUrl === ''
            ? '请配置 Tailscale Serve 地址。'
            : '等待 DSH Web 服务就绪。';
        } else if (mode === 'relay') {
          hint = resolved.relay.host === ''
            ? 'relay.host is empty; set it in the plugin configuration.'
            : 'Waiting for the first idle connection to the relay…';
        } else {
          hint = resolved.ssh.host === ''
            ? 'ssh.host is empty; set it in the plugin configuration.'
            : 'Connecting to the SSH server…';
        }

        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(renderStatusPage({ status, pairing: material, hint, reconnectUrl: resolved.enabled ? '/ssh-bridge/reconnect' : null, filesUrl: resolved.files.enabled ? undefined : null }));
      },
    }), 'ssh-bridge: status page');

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/ssh-bridge/reconnect',
      handler: (request, response) => {
        const method = request.method ?? 'GET';
        if (method !== 'POST') {
          response.writeHead(405, { allow: 'POST' });
          response.end();
          return;
        }
        if (!isAuthorized(webCtx, request, accessKey, mode === 'tailscale') || !isSameSite(request)) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('forbidden');
          return;
        }
        if (!resolved.enabled) {
          response.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end('{"error":"bridge disabled"}\n');
          return;
        }
        cachedPairing = undefined;
        response.writeHead(202, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end('{"restarting":true}\n');
        /* Restart after the response is flushed: tearing the connection down first would
           cut the very channel carrying this reply. */
        setTimeout(restart, 150).unref?.();
      },
    }), 'ssh-bridge: reconnect route');

    /* A file browser for other devices. The chat's file cards are rendered by the desktop
       client and only offer "open with <a local program>", which is meaningless from a phone,
       so this serves the workspace over HTTP with a real attachment download. */
    if (!resolved.files.enabled) return;
    const filesRoot = resolved.files.root === '' ? process.cwd() : resolved.files.root;
    const filesKey = (request) => {
      try {
        return new URL(request.url ?? '/', 'http://dsh.invalid').searchParams.get('rk') ?? '';
      } catch {
        return '';
      }
    };

    webCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/ssh-bridge/files',
      handler: (request, response) => {
        if (!isAuthorized(webCtx, request, accessKey, mode === 'tailscale')) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('forbidden');
          return;
        }
        let relative = '';
        try {
          relative = (new URL(request.url ?? '/', 'http://dsh.invalid').searchParams.get('d') ?? '')
            .replace(/^\/+|\/+$/g, '');
        } catch {
          relative = '';
        }
        const target = resolveWithin(filesRoot, relative);
        if (target === undefined) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('outside the workspace');
          return;
        }
        let entries;
        try {
          entries = listDirectory(target, filesRoot);
        } catch {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('not found');
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(renderFilesPage({ relative, entries, key: filesKey(request) }));
      },
    }), 'ssh-bridge: files page');

    webCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/ssh-bridge/file',
      handler: (request, response) => {
        if (!isAuthorized(webCtx, request, accessKey, mode === 'tailscale')) {
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('forbidden');
          return;
        }
        let requested = '';
        try {
          requested = new URL(request.url ?? '/', 'http://dsh.invalid').searchParams.get('p') ?? '';
        } catch {
          requested = '';
        }
        const target = resolveWithin(filesRoot, requested);
        if (target === undefined) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('outside the workspace');
          return;
        }
        let stat;
        try {
          stat = fileSystem.statSync(target);
        } catch {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('not found');
          return;
        }
        if (!stat.isFile()) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('not a file');
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': stat.size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
          'cache-control': 'no-store',
        });
        fileSystem.createReadStream(target).pipe(response);
      },
    }), 'ssh-bridge: file download');
  });
}

export { describePairing };
