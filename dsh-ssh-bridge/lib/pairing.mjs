import { normalizeTailscalePublicUrl } from './tailscale.mjs';

/**
 * Phone-side pairing material.
 *
 * Two transports, two shapes:
 *
 * - `ssh`   — the phone opens a local forward to the SSH server's loopback and
 *             browses `http://127.0.0.1:<phonePort>/`, which DSH trusts as loopback.
 * - `relay` — the phone browses `https://<relay>:<port>/` directly; the relay's access
 *             key is exchanged for a cookie, then DSH's own launch token is exchanged
 *             for a DSH cookie. No SSH client, no app.
 *
 * @module dsh-ssh-bridge/pairing
 */

/** Path of the phone's authenticated entry point, relative to the forwarded origin. */
const CLEAN_PATH = '/';

/**
 * Render a QR code for a value, when the optional `qrcode` package is installed.
 * @param {string} value - Payload to encode.
 * @returns {Promise<string | undefined>} PNG data URL, or undefined when unavailable.
 */
export async function renderQr(value) {
  try {
    const module = await import('qrcode');
    const codec = module.default ?? module;
    return await codec.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, scale: 6 });
  } catch {
    return undefined;
  }
}

/**
 * Build the pairing instructions for an SSH-forwarded phone.
 *
 * @param {object} options - Pairing inputs.
 * @param {{ host: string, port: number, username: string }} options.ssh - SSH server.
 * @param {{ bindAddress: string, remotePort: number }} options.forward - Published listener on the server.
 * @param {number} options.phonePort - Local port the phone forwards to itself.
 * @param {(url: string) => string} [options.authenticatedUrl] - Adds the launch token, when DSH offers it.
 * @param {boolean} [options.qr] - Whether to render a QR code.
 * @returns {Promise<object>} Per-phone instructions.
 */
export async function buildPairing({ ssh, forward, phonePort, authenticatedUrl, qr = true }) {
  const url = `http://127.0.0.1:${phonePort}${CLEAN_PATH}`;
  const tokenUrl = typeof authenticatedUrl === 'function' ? authenticatedUrl(url) : undefined;

  const portFlag = ssh.port === 22 ? '' : ` -p ${ssh.port}`;
  const sshCommand = `ssh -N${portFlag} -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 `
    + `-L ${phonePort}:${forward.bindAddress}:${forward.remotePort} ${ssh.username}@${ssh.host}`;

  const sshConfig = [
    'Host dsh-bridge',
    `  HostName ${ssh.host}`,
    `  Port ${ssh.port}`,
    `  User ${ssh.username}`,
    `  LocalForward ${phonePort} ${forward.bindAddress}:${forward.remotePort}`,
    '  ExitOnForwardFailure yes',
    '  ServerAliveInterval 30',
  ].join('\n');

  return {
    mode: 'ssh',
    url,
    tokenUrl,
    sshCommand,
    sshConfig,
    phonePort,
    qrDataUrl: qr && tokenUrl !== undefined ? await renderQr(tokenUrl) : undefined,
  };
}

/**
 * Build the pairing instructions for a relay-backed phone.
 *
 * @param {object} options - Pairing inputs.
 * @param {object} options.relay - Resolved relay configuration.
 * @param {(url: string) => string} [options.authenticatedUrl] - Adds the launch token, when DSH offers it.
 * @param {boolean} [options.qr] - Whether to render a QR code.
 * @returns {Promise<object>} Per-phone instructions.
 */
export async function buildRelayPairing({ relay, authenticatedUrl, qr = true }) {
  const host = relay.publicHost === '' ? relay.host : relay.publicHost;
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  /* Plain HTTP is opt-in; the link scheme must match what the relay actually serves. */
  const scheme = relay.protocol === 'http' ? 'http' : 'https';
  const url = `${scheme}://${authority}:${relay.publicPort}${CLEAN_PATH}`;

  /* The relay trades ?rk= for its own cookie and redirects to the remaining query, so
     the access key and DSH's launch token can travel in one link. */
  const gateUrl = relay.accessToken === ''
    ? url
    : `${url}?rk=${encodeURIComponent(relay.accessToken)}`;
  const tokenUrl = typeof authenticatedUrl === 'function'
    ? authenticatedUrl(gateUrl)
    : (gateUrl === url ? undefined : gateUrl);

  return {
    mode: 'relay',
    url,
    tokenUrl,
    qrDataUrl: qr && tokenUrl !== undefined ? await renderQr(tokenUrl) : undefined,
  };
}

/**
 * Pair directly with DSH through a private tailnet origin. There is no relay key:
 * DSH's launch token is exchanged for its normal browser session.
 * @param {object} options - Pairing inputs.
 * @param {{publicUrl: string}} options.tailscale - Tailnet origin.
 * @param {(url: string) => string} [options.authenticatedUrl] - DSH launch-token builder.
 * @param {boolean} [options.qr] - Whether to render a QR code.
 * @returns {Promise<object>} Pairing material.
 */
export async function buildTailscalePairing({ tailscale, authenticatedUrl, qr = true }) {
  const url = normalizeTailscalePublicUrl(tailscale.publicUrl);
  const tokenUrl = typeof authenticatedUrl === 'function' ? authenticatedUrl(url) : undefined;
  return {
    mode: 'tailscale', url, tokenUrl,
    qrDataUrl: qr && tokenUrl !== undefined ? await renderQr(tokenUrl) : undefined,
  };
}

/**
 * A short, human-readable summary of where the phone should connect.
 * @param {object} pairing - Result of a pairing builder.
 * @returns {string} Multi-line summary for the host log.
 */
export function describePairing(pairing) {
  if (pairing.mode !== 'ssh') {
    return ['phone setup:', `  open: ${pairing.url}`, ...(pairing.tokenUrl === undefined ? [] : [`  first time: ${pairing.tokenUrl}`])].join('\n');
  }
  return [
    'phone setup:',
    `  1. run: ${pairing.sshCommand}`,
    `  2. open: ${pairing.url}`,
    ...(pairing.tokenUrl === undefined ? [] : [`     (first time: ${pairing.tokenUrl})`]),
  ].join('\n');
}

export { CLEAN_PATH };
