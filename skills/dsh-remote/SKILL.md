---
name: dsh-remote
description: Configure or diagnose phone access to DSH through private Tailscale Serve, a self-hosted relay, or SSH forwarding. Use when the user wants to connect a phone, repair pairing, or restore a remote DSH connection.
---

# DSH remote access

Inspect the existing DSH profile and running services before changing them. Preserve a
working deployment and its address. Resolve this skill directory's symlink to locate the
checkout; read its root `README.md` and `dsh-ssh-bridge/README.md` for configuration.

## Choose the connection

| Mode | Requirements | Phone |
| --- | --- | --- |
| `tailscale` | Both devices on the same tailnet; system Tailscale + Serve | Browser |
| `relay` | A separately deployed dsh relay server | Browser or configured Android shell |
| `ssh` | An SSH server and forwarding on both ends | SSH client + browser |

Use an existing configured mode. For a new setup, prefer Tailscale when the user wants no
separate relay server and can connect both devices to the same tailnet. Tailscale may use
DERP; this mode removes the dsh relay requirement, not every possible relay path.

## Tailscale

1. Read `tailscale status --json` and `tailscale serve status --json`. Obtain the current
   device's DNS name without printing account or peer inventories. Preserve unrelated Serve
   handlers; use another HTTPS port if the intended port is already occupied.
2. Load the bridge in the intended DSH profile using `transport: tailscale`, the current
   `tailscale.publicUrl`, and a stable `tailscale.localPort` (default `9301`). Keep the
   pairing listener on loopback (default `127.0.0.1:9300`). Add only the exact external
   authority to DSH `connection.trustedHosts`, retaining existing entries.
3. Point private Serve at the bridge's stable loopback port:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:9301
   ```

   Adapt the HTTPS port and URL to the reviewed configuration. Use Serve, not public
   Funnel. The bridge follows DSH's changing listener; do not publish the pairing page.
4. Send the owner to `http://127.0.0.1:9300/` on the DSH host. The phone connects to
   Tailscale and scans the current QR code. Bookmark the clean HTTPS address after login.
   DSH restart can invalidate the login token; retrieve a fresh link from the local page.

The mode needs no `relay.token` or `relay.accessToken`. File routes default to disabled;
enable them only for an explicitly requested directory. The Android shell currently uses
relay-specific build configuration; use a phone browser for Tailscale.

## Relay or SSH

Follow the matching bridge README section for the installed version. A local checkout may
be loaded by its absolute `lib/index.mjs` path after installing its locked dependencies.
Back up the profile before editing; preserve its other plugin settings.

For relay, configure host/access credentials and certificate verification, ensure a
sufficient idle connection pool, and allow the exact external authority in `trustedHosts`.
For SSH, retain host-key verification and check the phone's local forwarding destination.
Neither deployment procedure authorizes changing existing SSH credentials or firewall
rules outside the requested service.

## Verify the actual path

- Confirm the local pairing page has current material; `forwarding` in Tailscale mode
  means the local proxy is ready, not that the phone is reachable.
- Validate HTTPS with normal certificate checks. First-time token exchange must redirect
  to a clean URL, set the DSH session cookie, and allow the actual GUI to load.
- Verify `/api/remote.mux` establishes a WebSocket and receives frames. HTML 200 alone is
  insufficient. Check unauthenticated requests remain rejected.
- On Tailscale/Clash conflicts, compare system DNS, Quad100 (`100.100.100.100`), and the
  correct tailnet IP. A fake-IP answer identifies a DNS path issue. Keep tailnet DNS and
  traffic on Tailscale using narrow persistent rules; preserve unrelated proxy settings.
- In relay mode, inspect relay health, certificate trust, host availability and pool
  capacity before changing the frontend. Existing probe scripts may print credentials
  or disable certificate checks; inspect them before use and treat that output accordingly.

Keep launch tokens, pairing URLs, cookies, access keys and private keys out of logs and git.
Report the clean access URL, the local pairing page, what was tested, and any device-side
step still required. Installing this skill alone does not deploy a new service.
