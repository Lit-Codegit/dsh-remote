/**
 * Type declarations for dsh-ssh-bridge.
 *
 * The plugin is plain ESM; these declarations describe the configuration shape and the
 * service it provides so TypeScript hosts and client packages can talk to it.
 */

/** How the bridge authenticates to the SSH server. */
export type AuthMethod = 'auto' | 'agent' | 'privateKey' | 'password';

/** How strictly the server's host key is checked. */
export type HostKeyPolicy = 'strict' | 'accept-new' | 'insecure';

/** Lifecycle state of the transport. */
export type BridgeState =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'forwarding'
  | 'retrying'
  | 'disconnected'
  | 'failed';

/** Configuration accepted by the plugin row. */
export interface BridgeConfig {
  /** Access mode. Default `'ssh'`. */
  transport?: 'ssh' | 'relay' | 'tailscale';
  /** Keep the transport connected and publish this DSH through it. Default `true`. */
  enabled?: boolean;
  /** Stable loopback proxy published privately by system Tailscale Serve. */
  tailscale?: {
    /** Tailnet origin, normally `https://device.tailnet.ts.net`. */
    publicUrl?: string;
    /** Loopback-only proxy port. Default `9301`. */
    localPort?: number;
  };
  /** Relay this host publishes through, for `transport: 'relay'`. */
  relay?: {
    /** Relay hostname or IP; empty falls back to `ssh.host`. */
    host?: string;
    /** Relay port. Default `8443`. */
    port?: number;
    /** Plain HTTP is opt-in. Default `'https'`. */
    protocol?: 'https' | 'http';
    /** Address the phone uses in the pairing link. */
    publicHost?: string;
    /** Port the phone uses; `0` reuses `port`. */
    publicPort?: number;
    /** Shared secret the relay checks before accepting this host. */
    token?: string;
    /** Access key the relay asks the phone for once. */
    accessToken?: string;
    /** Logical host name; one relay port serves one host. Default `'default'`. */
    hostId?: string;
    /** SHA-256 fingerprint printed by the relay, used to pin the certificate. */
    fingerprint?: string;
    /** TLS server name to send when the certificate is issued for a DNS name. */
    servername?: string;
    /** Accept any relay certificate. Prefer `fingerprint`. */
    insecure?: boolean;
    /** Idle relay connections kept open. Default `32`. */
    poolSize?: number;
    /** Pool top-up interval, ms. Default `300`. */
    refreshMs?: number;
    /** Recycle an idle connection older than this, ms. Default `40000`. */
    idleTtlMs?: number;
    /** Handshake deadline, ms. Default `15000`. */
    timeoutMs?: number;
  };
  ssh?: {
    /** SSH server hostname or IP. Empty disables connecting. Default `''`. */
    host?: string;
    /** SSH server port. Default `22`. */
    port?: number;
    /** Account used for the outbound connection. Default `'dsh'`. */
    username?: string;
    /** Authentication method. Default `'auto'`. */
    authMethod?: AuthMethod;
    /** Private key file; `~` expands. */
    privateKeyPath?: string;
    /** Passphrase for an encrypted private key. */
    privateKeyPassphrase?: string;
    /** Password authentication. */
    password?: string;
    /** SSH agent socket; defaults to `$SSH_AUTH_SOCK` or the Windows OpenSSH pipe. */
    agentPath?: string;
    /** `known_hosts` file. Defaults to `~/.ssh/known_hosts`. */
    knownHostsPath?: string;
    /** Host key policy. Default `'accept-new'`. */
    hostKeyPolicy?: HostKeyPolicy;
    /** Handshake deadline per attempt, ms. Default `20000`. */
    readyTimeoutMs?: number;
    /** Keepalive interval, ms; `0` disables. Default `15000`. */
    keepaliveIntervalMs?: number;
  };
  forward?: {
    /** Address the SSH server publishes on. Default `'127.0.0.1'`. */
    bindAddress?: string;
    /** Port the SSH server publishes this DSH on. Default `9100`. */
    port?: number;
  };
  reconnect?: {
    /** Reconnect after a drop. Default `true`. */
    enabled?: boolean;
    /** First retry delay, ms. Default `1000`. */
    minDelayMs?: number;
    /** Retry delay ceiling, ms. Default `30000`. */
    maxDelayMs?: number;
    /** Backoff growth factor. Default `2`. */
    factor?: number;
  };
  pairing?: {
    /** Fixed loopback port serving a bookmarkable pairing page. `0` disables it. Default `9300`. */
    localPort?: number;
    /** Bind address of the pairing page. Default `'127.0.0.1'`. */
    localHost?: string;
    /** Local port the phone forwards to itself; `0` reuses the published port. */
    phonePort?: number;
    /** Render a QR code when the optional `qrcode` package is installed. Default `true`. */
    qr?: boolean;
  };
  /** Register `/ssh-bridge` and `/ssh-bridge/status`. Default `true`. */
  statusPage?: boolean;
  /** Directory exposed by the authenticated file browser. */
  files?: { enabled?: boolean; root?: string };
}

/** Normalised configuration, defaults applied. */
export interface ResolvedBridgeConfig extends BridgeConfig {
  transport: 'ssh' | 'relay' | 'tailscale';
  enabled: boolean;
  tailscale: { publicUrl: string; localPort: number };
  relay: Required<NonNullable<BridgeConfig['relay']>>;
  ssh: Required<Omit<NonNullable<BridgeConfig['ssh']>, 'privateKeyPath' | 'privateKeyPassphrase' | 'password' | 'agentPath'>> & {
    privateKeyPath?: string;
    privateKeyPassphrase?: string;
    password?: string;
    agentPath?: string;
  };
  forward: { bindAddress: string; port: number };
  reconnect: { enabled: boolean; minDelayMs: number; maxDelayMs: number; factor: number };
  pairing: { phonePort: number; qr: boolean; localPort: number; localHost: string };
  statusPage: boolean;
  files: { enabled: boolean; root: string };
}

/** Transport snapshot returned by `status()`. */
export interface BridgeStatus {
  /** Which transport produced this snapshot. */
  mode: 'ssh' | 'relay' | 'tailscale';
  state: BridgeState;
  enabled: boolean;
  attempt: number;
  connectedAt: number | null;
  forwardedAt: number | null;
  uptimeMs: number;
  lastError: string | null;
  authMethod?: string | null;
  ssh?: { host: string; port: number; username: string };
  tailscale?: { publicUrl: string; localPort: number };
  forward: {
    bindAddress: string;
    remotePort: number;
    target: { host: string; port: number } | null;
  };
  stats: { openChannels: number; totalChannels: number; bytesUp: number; bytesDown: number };
}

/** Phone-side instructions for the live forward. */
export interface PairingMaterial {
  /** Which transport these instructions are for. */
  mode: 'ssh' | 'relay' | 'tailscale';
  /** Clean URL the phone opens. */
  url: string;
  /** One-time URL carrying the pairing secrets, when they are known. */
  tokenUrl?: string;
  /** `ssh` command the phone runs (`mode: 'ssh'` only). */
  sshCommand?: string;
  /** Equivalent `~/.ssh/config` block (`mode: 'ssh'` only). */
  sshConfig?: string;
  /** Local port the phone must forward to itself (`mode: 'ssh'` only). */
  phonePort?: number;
  /** QR code of the pairing URL, when the optional `qrcode` package is installed. */
  qrDataUrl?: string;
}

/** The service the plugin provides as `ctx.sshBridge`. */
export interface SshBridgeService {
  status(): BridgeStatus;
  pairing(): Promise<PairingMaterial | undefined>;
  restart(): void;
  stop(): void;
  transport: unknown;
}

/** Stable Cordis plugin name. */
export declare const name: 'ssh-bridge';

/** Schemastery schema for the plugin row. */
export declare const Config: unknown;

/**
 * Normalise a raw configuration object.
 * @param config - Raw plugin configuration.
 */
export declare function resolveConfig(config?: BridgeConfig): ResolvedBridgeConfig;

/**
 * Describe pairing steps in one log-friendly string.
 * @param pairing - Result of `buildPairing`.
 */
export declare function describePairing(pairing: PairingMaterial): string;

/**
 * Cordis plugin entry.
 * @param ctx - Plugin context.
 * @param config - Plugin configuration.
 */
export declare function apply(ctx: unknown, config?: BridgeConfig): Promise<void>;
