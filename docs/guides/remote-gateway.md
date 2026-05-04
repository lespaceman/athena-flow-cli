# Remote Athena Gateway

The gateway can run on a remote host (cloud VM, home server, dev box on a tunnel) and let an Athena CLI elsewhere connect to it. This guide covers the supported exposure modes and the threat model.

## Concepts

- **Local mode (default)** — gateway listens on a Unix domain socket in your `XDG_RUNTIME_DIR`. Filesystem permissions are the auth boundary; no token needed beyond defense-in-depth.
- **Remote mode** — gateway listens on TCP. The Athena CLI dials it. The connection is authenticated by a 32-byte token in `~/.config/athena/gateway/token` on the gateway host; the client side stores it in `~/.config/athena/gateway.json` written by `athena gateway link`.

The gateway is **single-runtime**: only one Athena CLI may register at a time. A second registration is rejected with `already_registered` and the second CLI's reconnect loop becomes terminal until the user intervenes.

## Exposure modes

| Mode                      | Use for                                                            | How                                                      |
| ------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| **Loopback plain WS**     | local smoke tests, dev                                             | `--bind 127.0.0.1:18789` (no `--insecure`, no TLS)       |
| **Non-loopback plain WS** | behind Tailscale / WireGuard / a reverse-proxy that terminates TLS | `--bind 0.0.0.0:18789 --insecure` (token still required) |
| **Native TLS (WSS)**      | direct exposure to a trusted network                               | `--bind 0.0.0.0:18789 --tls-cert <crt> --tls-key <key>`  |

The daemon **refuses** to start with a non-loopback bind unless one of the following is true:

- `--tls-cert`/`--tls-key` are provided (native TLS), or
- `--insecure` is passed and a token is configured.

`--insecure` prints a loud warning on startup and is intended only for "behind trusted tunnel/proxy" deployments. The token itself is sent in the first frame on every connection, so plaintext WS leaks the token to anyone on the wire.

## Recipes

### Loopback dev

```bash
# host
athena-gateway --bind 127.0.0.1:18789 --silent
cat ~/.config/athena/gateway/token   # copy this

# client
athena gateway link ws://127.0.0.1:18789 --token "<token>"
athena
athena gateway status                # confirms binding state and runtime
```

### Tailscale (or WireGuard) tunnel

Tailscale gives every node a private IP and end-to-end encryption. The gateway binds plain WS; the network handles confidentiality.

```bash
# host (Tailscale IP 100.x.y.z)
athena-gateway --bind 100.x.y.z:18789 --insecure --silent
# host startup will print:
#   athena-gateway: WARNING --insecure is set on a non-loopback bind ...

# client (also on the tailnet)
athena gateway link ws://100.x.y.z:18789 --token "<token>"
```

This is the recommended path for personal / single-user setups: fewer moving parts than running a CA, no public internet exposure.

### Caddy / nginx in front

If you already run an HTTPS reverse proxy, terminate TLS there and forward to the gateway over loopback.

```bash
# host
athena-gateway --bind 127.0.0.1:18789 --silent
```

```caddy
# Caddyfile
gateway.example.com {
    reverse_proxy 127.0.0.1:18789
}
```

```bash
# client
athena gateway link wss://gateway.example.com --token "<token>"
```

The client only ever sees `wss://` and a real CA-signed cert; the gateway listens locally with no `--insecure` needed.

### Native TLS, no proxy

If you don't have a reverse proxy and want the gateway to handle TLS itself:

```bash
# host (cert must match the hostname the client uses)
athena-gateway \
    --bind 0.0.0.0:18789 \
    --tls-cert /etc/ssl/gw.crt \
    --tls-key /etc/ssl/gw.key \
    --silent

# client (CA-signed cert: nothing extra needed)
athena gateway link wss://gateway.example.com:18789 --token "<token>"

# client (self-signed cert: pass the CA bundle)
athena gateway link wss://gateway.example.com:18789 \
    --token "<token>" \
    --tls-ca /path/to/ca.pem
```

Mutual TLS (presenting a client cert in addition to the token) is on the R6 roadmap and not supported in this slice — the daemon does not yet expose `--tls-client-ca` and the client transport does not load a client cert/key.

## Operational notes

- **Reconnect** is automatic and indefinite (1, 2, 4, 8, 16, 30s with full jitter). The bridge surfaces state via `getConnectionState()` and the daemon reports `binding=active|stale rebound=<age>` in `gateway status`.
- **Heartbeat:** the gateway pings every 15 s and terminates connections that don't pong within 30 s of the most recent ping.
- **Connect rate limit:** 10 attempts per source IP per minute, in-memory. Defends the token against online brute force. Reset on daemon restart.
- **Disconnect grace window:** TCP listeners default to 60 s — a runtime can drop and reconnect transparently within that window without losing its registration. Tune with `--grace-period-ms`.
- **Token rotation:** run `athena gateway rotate-token` on the host. The command rewrites `~/.config/athena/gateway/token` (mode 0600) and prints the new value once. The running daemon caches the previous token in memory, so restart it to drop existing connections; clients then re-run `athena gateway link --token <new>`. Add `--json` to capture `{ok, token, tokenPath}` from automation.

## Threat model

**In scope (the gateway protects against):**

- Anyone on the network without the token (online brute force is rate-limited).
- Stolen client laptops: revoke by rotating the token on the host.
- TCP-level disconnects: parked inbound channel messages drain on reconnect.

**Out of scope (you must mitigate elsewhere):**

- A compromised gateway host. Channel adapter sidecars (Telegram bot tokens, Slack credentials) live next to the gateway. Treat the host as you would any chat-bot server.
- Multi-tenant routing. The single-runtime guard is enforced; a second CLI cannot connect even with a valid token. A future plan covers tenant-scoped runtimes and per-channel ACLs.
- Untrusted clients on a shared network when running `--insecure`. The token traverses plaintext; only use this mode behind a trusted tunnel.
- Out-of-band token leaks (paste into a chat, commit to git, etc). The token file is mode 0600 in a 0700 directory on the host; protect the client `~/.config/athena/gateway.json` similarly.

## Quick reference

```
athena-gateway
    [--bind <host:port>]
    [--insecure]
    [--tls-cert <path>] [--tls-key <path>]
    [--grace-period-ms <n>]
    [--silent]

# or via the user-facing CLI (spawns the same daemon binary):
athena gateway start
    [--bind <host:port>]
    [--insecure]
    [--tls-cert <path>] [--tls-key <path>]
    [--grace-period-ms <n>]

athena gateway link <ws-or-wss-url>
    --token <t>
    [--tls-ca <path>]

athena gateway unlink
athena gateway status [--json]
athena gateway probe [--json]
athena gateway rotate-token [--json]
```
