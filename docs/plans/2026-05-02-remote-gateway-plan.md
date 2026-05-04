# Plan: Remote Athena Gateway (cloud-host gateway, client-initiated transport)

## Implementation review findings (added 2026-05-02)

These corrections supersede any conflicting detail below during implementation:

1. **Keep R1 boring.** R1 extracts socket/framing transport only. It must not add reconnect semantics, endpoint config, heartbeat frames, or request replay.
2. **Do not change the control wire shape in R1/R2.** WebSocket messages should carry the existing JSON control frames directly. Avoid the proposed `{kind: 'envelope', envelope: ...}` wrapper unless a later milestone explicitly migrates both peers.
3. **Public bind safety must arrive before public bind UX.** Plain WS is acceptable only for loopback tests. Do not expose a user-facing non-loopback listener until the token/TLS/insecure bind guard exists.
4. **Token placement must be explicit.** Prefer keeping the existing first-frame `connect` token for continuity. Avoid query-string tokens because they leak into logs.
5. **Reconnect replay needs per-request classification.** Before implementing replay, classify each control request kind as replayable, non-replayable, or deduped by idempotency key.
6. **Preserve local-mode disconnect semantics unless intentionally changed.** The 60 s grace window is valuable for remote transport, but local UDS should not unexpectedly block a fresh runtime after a crash.
7. **Treat gateway-global `channel_messages` as a separate data-model milestone.** Do not bury it inside R2 transport work.
8. **Split R6 hardening.** mTLS, token rotation, and rate limiting are independent surfaces; rate limiting should land with public listener support, while mTLS can follow later.
9. **Use native WebSocket ping/pong where possible.** App-level ping frames add protocol complexity and conflict with the “unchanged envelope” goal.
10. **Do not overextend lock semantics.** Keep the lock for daemon state ownership. Let TCP bind failures diagnose host/port collisions.

## Multi-tenancy compatibility constraints (added 2026-05-02)

The current plan remains **single-runtime / single-tenant for v1**. Do not implement full multi-tenancy in R1-R10 unless a later plan explicitly replaces this scope. However, each milestone should preserve a clean path to multi-tenancy:

1. **Name state by runtime, not singleton, where touched.** Prefer `runtimeId`, `registration`, `binding`, `targetRuntimeId`, and `runtimeConnections` over concepts that imply one permanent global runtime.
2. **Keep protocol fields extensible.** New endpoint/config/status shapes should be able to grow a `runtimeId`, `tenantId`, or `clientId` field without breaking existing local mode. Do not make the gateway token the only possible identity concept.
3. **Do not hide singleton assumptions in shared storage.** When touching gateway-owned queues/tables, consider whether rows are gateway-global, runtime-owned, or channel-owned. If runtime-owned data is introduced, carry `runtime_id` from the start.
4. **Reconnect should rebind by `runtimeId`.** R4 must not just reopen "the current connection"; it should explicitly bind a connection to the existing registration for the same `runtimeId`.
5. **Status and telemetry should be list-friendly.** V1 can return one runtime, but field names and internal structures should not preclude reporting multiple runtime bindings later.
6. **Routing remains single-target for now.** Do not add channel claim routing, ACLs, tenant admin UI, or per-tenant channel secrets in this plan. Those require a dedicated multi-tenancy plan.
7. **Safety beats premature sharing.** If a choice would make a remote gateway accidentally shared before proper auth/routing exists, keep the single-runtime guard and document the later migration point.

## Execution checkpoint (updated 2026-05-02 before merge to `main`)

Branch: `remote-gateway` in worktree `/Users/nadeem/athena/cli/.worktrees/remote-gateway`.
Base branch: `gateway-integration`; target merge branch: `main`.

Implemented and ready to merge as the first remote-gateway slice:

- **R1 complete:** control framing is extracted behind `gateway/transport/*`; UDS remains the default transport.
- **R2 complete for loopback/plain WS:** existing control envelopes are sent directly over WS; no `{kind: 'envelope'}` wrapper was introduced.
- **R3 complete:** `~/.config/athena/gateway.json`, `athena gateway link <url> --token <token>`, `gateway unlink`, and remote `SessionBridge` endpoint selection are wired.
- **R4 partially complete:** `SessionRegistry` now separates runtime registration from connection binding; daemon supports a reconnect grace window for TCP listeners and keeps local UDS immediate-disconnect semantics.
- **R5 partially complete:** daemon accepts `--bind`, `--insecure`, and `--grace-period-ms`; non-loopback plain WS requires an explicit token plus `--insecure`. Full TLS/mTLS remains future work.
- **Debug instrumentation added:** `ATHENA_GATEWAY_TRACE=1` and optional `ATHENA_GATEWAY_TRACE_FILE=/path` trace transport frames, bridge lifecycle, runtime registration, and permission relay attempts with tokens redacted.
- **Permission relay wiring added but not proven by manual TUI smoke:** `RuntimeProvider -> useFeed -> runtimeController -> SessionBridge.relayPermission` is now wired for `permission.request` events that reach the user-prompt branch.

Known unresolved smoke-test gap:

- Direct WS control smoke succeeds against `node dist/athena-gateway.js --bind 127.0.0.1:18789 --silent`; ping returns `{pong:true}`.
- Manual TUI prompt traffic is **not expected** to traverse the gateway. Only `session.register`, `session.dispatch.turn`, `session.turn.complete`, and relay RPCs should show gateway traffic.
- The user's attempted TUI permission smoke still did not show trace lines. The most likely remaining explanations are: the running TUI was not this worktree's `dist/cli.js`, the event being triggered is `tool.pre` rather than `permission.request`, an allow rule short-circuits before relay, or the permission path is emitted by a harness path not passing through `useFeed` as expected.
- Resume by running both processes with a shared trace file:

```bash
rm -f /tmp/athena-gateway.trace.log
ATHENA_GATEWAY_TRACE=1 ATHENA_GATEWAY_TRACE_FILE=/tmp/athena-gateway.trace.log node dist/athena-gateway.js --bind 127.0.0.1:18789 --silent

ATHENA_GATEWAY_TRACE=1 ATHENA_GATEWAY_TRACE_FILE=/tmp/athena-gateway.trace.log node dist/cli.js

tail -f /tmp/athena-gateway.trace.log
```

Expected startup proof:

```text
RuntimeProvider starting SessionBridge runtimeId=...
sessionBridge start runtimeId=... endpoint=remote url=ws://127.0.0.1:18789
ws-client out ... {"kind":"connect","token":"<redacted>"}
ws in ws:127.0.0.1 ... {"kind":"connect","token":"<redacted>"}
sessionBridge registered runtimeId=...
daemon registered runtime runtimeId=...
RuntimeProvider SessionBridge ready runtimeId=...
```

Follow-up priorities after this merge:

1. Add a deterministic runtime-provider integration test proving `SessionBridge` startup and `relayPermission` wiring through the rendered TUI provider path.
   - Done in `test(gateway): cover provider permission relay wiring`.
2. Add a diagnostic command or `gateway status --json` runtime binding field so manual smoke no longer depends on trace logs.
   - Done in `feat(gateway): show runtime status for remote links` and `feat(gateway): print runtime in status output`.
3. Decide whether `tool.pre` events should ever relay remotely; currently only `permission.request` is relayed.
4. Continue with the remaining R4/R5/R6/R7 items: reconnecting WS client loop, TLS/mTLS, token rotation, rate limits, and in-flight relay replay.
   - SessionBridge now reconnects and re-registers before the next bridge RPC after a WS disconnect (`feat(gateway): reconnect session bridge before RPCs`).
   - R4 background reconnect + native WS heartbeat + rebind status all landed (`feat(gateway): background WS reconnect, heartbeat, rebind status`, `fix(gateway): tighten reconnect/heartbeat lifecycles`).
   - R5 landed as `feat(gateway): r5 public-bind safety — tls, rate limit, exposure docs` plus the `--tls-cert`/`--tls-key`/`--insecure` flag plumbing in `docs(gateway): surface tls flags in gateway help and fix daemon shape`. Connect rate limit (10/min/IP) lives in `gateway/transport/tlsWs.ts`.
   - R6 token rotation landed as `feat(gateway): r6 token rotation command` (+ `docs(gateway): flag rotate-token stdout as sensitive`). **mTLS is explicitly deferred** out of v1: `--tls-client-ca` is documented as a future flag but not implemented in the current daemon.
   - R7 (relay replay on reconnect) is the next milestone — design notes are below.

Post-merge continuation:

- `gateway status` and `gateway status --json` now use `~/.config/athena/gateway.json`, so a linked remote client queries the remote gateway rather than the local UDS daemon.
- Status responses include a list-friendly `runtimes` field showing runtime id, pid, binding state, and pending dispatch count.
- Human status output includes `runtime=<id> binding=<state> pid=<pid>` for quick smoke verification.
- `RuntimeProvider` has a deterministic test proving permission relay wiring through `SessionBridge`, and bridge startup now retries every 2s after an initial gateway connection failure.
- `SessionBridge` now observes control-client close events, marks itself disconnected, and reconnects/re-registers before the next bridge RPC. A WS integration test covers completing a previously dispatched turn after disconnect/reconnect inside the daemon grace window.

## R7 design notes (added 2026-05-04)

R7 is "relay replay on reconnect": an in-flight `relay.permission.request` (or `relay.question.request`) must survive a brief WS blip without losing the verdict that the human is about to send back. Before any code lands, the control surface is classified.

### Control request classification

| Kind                                                | Class                                                      | Notes                                                                                                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`                                              | non-replayable (cheap to re-issue)                         | Read-only, side-effect free. Caller, if it cares, just sends a fresh ping.                                                                                                                                                          |
| `status`                                            | non-replayable                                             | Same as ping. Snapshots are not worth replaying.                                                                                                                                                                                    |
| `session.register`                                  | replayable, idempotent by `runtimeId`                      | Already replayed by `SessionBridge` on reconnect. The grace window in `SessionRegistry` rebinds the connection without re-dispatching anything. `already_registered` is the only terminal failure mode (different runtimeId taken). |
| `session.unregister`                                | non-replayable                                             | Issued only at `bridge.stop()`; if the connection is gone, the daemon will GC the registration after the grace window. No replay value.                                                                                             |
| `session.turn.complete`                             | replayable, deduped by `idempotencyKey`                    | Outbox already dedupes by idempotency key, so a replay after reconnect is safe. R7 does **not** need to add anything here — `SessionBridge` already retries via the user-driven `completeTurn` call after reconnect.                |
| `channel.send`                                      | replayable, deduped by `idempotencyKey`                    | Same as `turn.complete`; not currently invoked directly from runtime, but if it ever is, the outbox dedupe holds.                                                                                                                   |
| `relay.permission.request`                          | **replayable, deduped by `(runtimeId, channelRequestId)`** | The whole point of R7. Long-blocking. The caller must reuse the same `channelRequestId` on replay so the gateway can deliver the existing pending broadcast's verdict instead of starting a new one.                                |
| `relay.question.request`                            | same as permission                                         | Same shape, same semantics; R7 covers both via the coordinator.                                                                                                                                                                     |
| `relay.permission.cancel` / `relay.question.cancel` | idempotent, no replay needed                               | Cancels are cheap and naturally idempotent: re-cancelling a missing entry returns `cancelled: false`. Stale cancels are dropped on the server (see "Connection epochs" below).                                                      |

The classification is consumed by `SessionBridge`: only `relay.*.request` actually needs new replay machinery. Everything else either auto-resumes (`session.register`) or is the caller's job to re-issue (`turn.complete` already is, and is dedupe-safe by key).

### `relay.permission.request` replay keyed by `(runtimeId, request_id)`

Today: when the WS drops mid-request, `ControlClient` rejects every entry in `pending` with `"connection closed"`. `SessionBridge.relayPermission()` then surfaces that to the caller — the user-facing prompt fails even though the human's verdict may already be on its way from Telegram.

Target shape:

1. **Caller-supplied stable id.** `SessionBridge.relayPermission()` mints `channelRequestId` up-front (single short id, e.g. via `relay/ids.generateChannelRequestId`) and passes it to the gateway in the request payload. The bridge already accepts `channelRequestId`; today it is undefined, so the coordinator generates one server-side. R7 makes the bridge always set it, so the same id can be used on replay.
2. **Server-side replay table.** `RelayCoordinator` already maps `channelRequestId → PendingEntry`. On a fresh `relay.permission.request` whose `channelRequestId` is **already pending** for the **same runtime**, the handler does not throw (today it does, with `channelRequestId collision`) — instead it **attaches the new request envelope to the existing pending entry**, returning the existing broadcast's promise. The handler resolves once the original verdict (or cancel) arrives. No second adapter broadcast is started.
3. **Identity scope.** Replay attachment is keyed by `(runtimeId, channelRequestId)`. Cross-runtime replay is forbidden — if a different runtime sends the same id (impossible in v1, but cheap to enforce), the coordinator returns `error: 'channel_request_owner_mismatch'`. This keeps the door open for multi-tenant.
4. **Connection-bridge replay.** Inside `SessionBridge`, `relayPermission()` wraps the underlying `client.request(...)` in a small loop: on `GatewayProtocolError('connection closed')` (and only that), wait for the next reconnect (`requireConnectedClient()` already does this), then re-issue the same payload (same `channelRequestId`). The loop bounds itself by the user-provided `ttlMs` — once the TTL window has elapsed, it surfaces the error like today. A handful of retries is enough for a 5 s blip and bounded for a long outage.
5. **Cancel still works.** A user-initiated cancel during the blip simply queues against the same `channelRequestId` and is resolved on the next reconnect.

### Connection epochs and stale cancels / stale verdicts

The gateway already tracks `binding.lastRebindAt` per runtime. R7 adds an **epoch counter** on the registry binding, incremented on every `bindConnection` rebind (both initial and re-bind). The coordinator stamps each pending entry with the epoch at which it was opened.

- **Stale cancel:** `relay.*.cancel` carries an implicit epoch (the connection it arrives on). If the pending entry's epoch is **older** than the current binding epoch, the cancel is still honored — same runtime, same logical request, the runtime just had a connection blip. This is the common, expected case after replay.
- **Stale verdict:** A verdict landing from an adapter after the request has already settled (either via a peer adapter winning the race, or via cancel) is silently dropped — already today's behavior in `settlePermission` (`if (entry.settled) return`). Replay does not change this.
- **Cross-runtime cancel:** If a cancel arrives but the pending entry's `runtimeId` does not match the connection's bound runtime, the coordinator returns `cancelled: false`. Defends against the (currently impossible) cross-tenant case.
- **Pending entries on full unregister.** When the grace window expires and the runtime is fully unregistered, all pending relays for that runtime are cancelled with `reason: 'connection_lost'`. New adapters and new runtimes start fresh. `RelayCoordinator.disposeAll('connection_lost')` already exists; the daemon needs to call it from the unregister path. Today it does not — that wiring is part of R7.

### Integration test (added in R7)

`src/app/channels/sessionBridge.integration.test.ts` (or a new `relay-replay.integration.test.ts`) gets a case that:

1. Starts daemon + WS listener + a `FakeAdapter` that holds the permission promise open until told to resolve.
2. Starts `SessionBridge` over remote WS, calls `relayPermission(...)` and awaits adapter pickup.
3. Forcibly closes the underlying WS (`(bridge as any).client.close()`), parking the adapter promise.
4. Asserts the bridge reconnects (`getConnectionState() === 'connected'`, binding `lastRebindAt` set) without the adapter being re-prompted.
5. Resolves the adapter promise; the original `relayPermission()` await **completes successfully** (verdict propagates through the rebound connection) and the result carries the original `channelRequestId`.
6. Asserts the adapter received exactly one `requestPermissionVerdict` call across the whole scenario — proving "rebroadcast" means "deliver the existing pending verdict", not "broadcast twice".

### Out of scope for R7

- Persisting pending relays through a daemon restart. The grace window is process-lifetime only; a daemon crash drops pending relays. Documented under "Risks #7" in the original plan.
- Multi-runtime cross-talk on relays. v1 stays single-runtime; the runtime-scoping above is forward-compatible only.
- Replaying `relay.*.cancel` after a full unregister. Once the grace window expires, relays are gone and cancels return `cancelled: false`.

### R7 status (2026-05-04)

R7 is complete. Landed slices:

1. `feat(gateway): r7 relay replay across reconnect` — bridge mints a stable `channelRequestId`, retries on `connection_closed` bounded by `ttlMs`; coordinator attaches duplicate ids to the existing pending broadcast.
2. `refactor(gateway): simplify r7 relay replay` — typed `connection_closed` error code, microtask yield to avoid retry tight-loop, dropped the placeholder cast in the coordinator.
3. `fix(gateway): guard relay attach by request fingerprint` — duplicate attach checks kind + payload fingerprint to prevent collision-driven verdict cross-talk.
4. `feat(gateway): r7 binding epoch + connection_lost relay disposal` — bindings carry an epoch counter; full unregister disposes pending relays with `connection_lost`.
5. `feat(gateway): r7 runtime-scoped relay cancels` — relay pending entries carry their caller `runtimeId`; cancels reject when the caller's bound runtime differs. Same-runtime cancels succeed across reconnect epochs (which was the original "stale cancel" worry — solved by runtime identity, not epoch comparison).

Carryover for the future multi-tenancy plan:

- `daemon.ts` calls `relayCoordinator.disposeAll('connection_lost')` globally on full unregister. Under multi-runtime this must become runtime-scoped (e.g. `disposeAllForRuntime(runtimeId, reason)`); single-runtime today makes the global call equivalent.
- The binding `epoch` field is internal-only; if multi-runtime introduces cross-epoch verdict races that runtime identity alone cannot resolve, expose the epoch on the wire and stamp pending entries with it.

Next milestone: R8 — telemetry + status polishing.

## Status (original plan, 2026-05-02)

Working branch: TBD (suggest `remote-gateway`, branched from `gateway-integration`).
Predecessor: `docs/plans/gateway-channels-plan.md` (M1–N3 shipped). All deltas below assume the N3-era gateway as the starting point.

## Goal

Run the gateway on a cloud server (or any non-local host) and let an Athena CLI elsewhere connect to it. After this lands, the same gateway daemon supports two deployment modes:

- **Local mode** (today): UDS at `${runDir}/gateway.sock`. Default. Unchanged for users who don't opt in.
- **Remote mode** (new): TLS-terminated WebSocket on a public/tailnet address. Athena CLI dials it; messages from channels (Telegram/etc.) arrive at the remote gateway and are dispatched to the connected runtime over the same socket; turn completions, relay verdicts, and channel sends flow back the other way.

**Non-goals (v1)**:

- Multi-runtime per gateway. One registered runtime at a time, like local mode.
- Built-in TLS certificate management. We document Tailscale Funnel / Caddy / nginx in front; the daemon takes a cert path or `--insecure` flag for tunneled deployments.
- OpenAI-compatible HTTP surface. Control plane only.
- Webhook-mode channel adapters. Telegram long-poll + Slack Socket Mode only (matches existing roadmap).
- Auto-pairing UX beyond `gateway link <url> --token <t>`. QR / discovery flow is out.

## Why client-initiated

Connection direction is the load-bearing decision. Gateway-dials-client requires the user's laptop to expose a port → hostile to NAT, IP changes, mobile networks. Client-dials-gateway:

- Outbound only — works through every NAT and firewall.
- IP changes are a non-event — the next reconnect opens from the new IP.
- Auth surface is single-sided: gateway needs a public listener, client needs a token.
- The existing `ControlEnvelope` protocol is already bidirectional (request/response + server `push`), so the wire shape doesn't change — only the transport.

## Architecture

```
                         Cloud / VPS host                   User laptop / dev box
┌──────────────────────────────────────────────────┐      ┌───────────────────────────────┐
│  athena-gateway  (--bind 0.0.0.0:18789 --tls …)  │      │  athena (TUI)                 │
│                                                  │      │   └─ RuntimeProvider           │
│  ┌──────────────┐   ┌────────────────────────┐   │      │       └─ SessionBridge        │
│  │ TG / Slack   │──▶│ ChannelManager         │   │      │           (transport: wss://) │
│  │ adapters     │   │  + InboundQueue (N1)   │   │      │                                │
│  └──────────────┘   │  + OutboundDispatcher  │   │      │                                │
│                     │    + Outbox (N2)       │   │      │                                │
│                     │  + RelayCoordinator    │   │      │                                │
│                     └────────────────────────┘   │      │                                │
│                                │                  │      │                                │
│                                ▼                  │      │                                │
│                     ┌────────────────────────┐   │      │                                │
│                     │  ControlServer         │◀──┼──────┼── WSS  (client-initiated)     │
│                     │   transport: tls-ws    │   │ TLS  │   ControlEnvelope NDJSON      │
│                     │   transport: uds       │◀──┘      │   (push frames carry           │
│                     └────────────────────────┘          │    session.dispatch.turn)     │
└──────────────────────────────────────────────────┘      └───────────────────────────────┘
```

Same envelope, same handlers, same registry. **The only structural change is a transport abstraction with two implementations.**

## Critical changes vs current code

| Subsystem                              | Today                                                                        | After this plan                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gateway/control/server.ts`            | Hardcoded `net.createServer` (UDS), filesystem ACL                           | `Transport` interface; `UdsTransport` (existing logic) + `TlsWsTransport` (new). `startControlServer` takes a `Transport` factory.                                             |
| `gateway/control/client.ts`            | Hardcoded `net.connect` (UDS), per-request timeout map                       | Same `Transport` interface; UDS impl + WSS impl. Adds reconnect loop + outbound request queue while disconnected.                                                              |
| `gateway/auth.ts`                      | 32-byte token, `timingSafeTokenEqual`. UDS path is the real boundary.        | Token stays. Adds **bind guard**: server refuses to start with a non-loopback listener if no token is configured. Optional `--tls-client-ca` for mTLS.                         |
| `gateway/paths.ts`                     | UDS path resolution + sun_path validation                                    | New `resolveListenSpec(env, flags)` returns `{kind: 'uds', path} \| {kind: 'tcp', host, port, tls}`. UDS branch unchanged.                                                     |
| `gateway/lock.ts`                      | One daemon per host (UDS path uniqueness)                                    | Lock now also covers `host:port` collisions with a clearer diagnostic. Lock file unchanged.                                                                                    |
| `app/channels/sessionBridge.ts`        | `connect()` opens a UDS socket; dies on close                                | Constructor takes `endpoint: LocalEndpoint \| RemoteEndpoint`. Adds reconnect + register-on-reconnect + in-flight request replay.                                              |
| `sessionRegistry.ts`                   | Single current runtime; map keyed by `runtimeId`; cleared on connection drop | **Decouple runtime registration from connection.** Keep registration alive across reconnects (TTL). On reconnect with same `runtimeId`, rebind the connection; no re-dispatch. |
| `daemon.ts` `runtimeConnections`       | Cleared on socket disconnect immediately                                     | Don't unregister on disconnect — instead, mark connection stale and start a grace timer (default 60 s). Reconnection within window is transparent.                             |
| `InboundQueue` (N1)                    | Drains when runtime registers                                                | Already correct for reconnect — messages that arrive during the disconnect window are parked and drained on reattach. **No change needed.**                                    |
| Relay coordinator                      | `relay.permission.request` is a long-blocking RPC                            | On connection drop mid-relay, the in-flight RPC is cancelled with `reason: 'connection_lost'`; gateway re-broadcasts on reconnect (server-side replay table keyed by request). |
| Heartbeats                             | None — UDS gives instant FIN/RST                                             | App-level ping/pong every 15 s on remote transport; missed-pong → close → client reconnects with backoff (1s/2s/4s/8s/16s/30s, jitter).                                        |
| CLI                                    | `athena gateway start` (foreground UDS only)                                 | Adds `--bind`, `--tls-cert`, `--tls-key`, `--tls-client-ca`, `--insecure` (loopback / unix socket only). New `athena gateway link <url> --token` writes client-side endpoint.  |
| Athena CLI runtime startup             | Always opens UDS to local gateway, best-effort                               | Reads `~/.config/athena/gateway.json`: `{mode: 'local'}` (default) or `{mode: 'remote', url, token, tlsCaPath?}`. Local mode is byte-for-byte the same as today.               |
| `--skipChannelLoad` invariant in tests | Boots daemon without sidecars                                                | Untouched. New transport tests use a tmp self-signed cert + 127.0.0.1; remote-mode tests still pass `skipChannelLoad: true` (per memory note).                                 |

## New files

```
src/gateway/transport/
  types.ts            Transport interface (Listener, Connection, framed message stream)
  uds.ts              Existing logic factored out of control/server.ts + control/client.ts
  tlsWs.ts            Server side: ws + node:tls; honors --bind, --tls-*, optional mTLS
  wsClient.ts         Client side: ws + tls; auto-reconnect with backoff; replay queue

src/shared/gateway-protocol/
  endpoint.ts         RuntimeEndpoint = {mode:'local'} | {mode:'remote', url, token, tlsCaPath?}
                      Plus zod-style guards (lightweight, hand-rolled — match infra/config style)

src/infra/config/
  gatewayClient.ts    Reads ~/.config/athena/gateway.json (0600); falls back to {mode:'local'}

src/app/entry/
  gatewayLinkCommand.ts   `athena gateway link <url> --token <t>` — writes the file above
```

## Modified files (high-confidence list)

- `src/gateway/control/server.ts` — extract framing, accept any `Listener`.
- `src/gateway/control/client.ts` — extract framing, accept any `Connection`; add reconnect.
- `src/gateway/control/handlers.ts` — no change to handler signatures; one-line addition: `runtimeConnections` keyed lookup tolerates stale entries.
- `src/gateway/daemon.ts` — replace `socketPath` arg with `listenSpec`; add `disconnectGracePeriodMs`; surface bind diagnostic; keep startup log line shape but include effective listener.
- `src/gateway/sessionRegistry.ts` — split "registration" from "connection binding". `register({runtimeId, connectionId})` → `bindConnection(runtimeId, connectionId)` becomes its own call, idempotent.
- `src/gateway/paths.ts` — add `resolveListenSpec`. Keep UDS resolution path-compatible.
- `src/gateway/auth.ts` — add `requireTokenForBind(spec, token)` guard.
- `src/app/channels/sessionBridge.ts` — endpoint param, reconnect, replay.
- `src/app/providers/RuntimeProvider.tsx` — read `gatewayClient.ts`; pass endpoint through.
- `src/app/entry/cli.tsx` — register `gateway link` subcommand; surface remote-mode errors clearly.
- `tsup.config.ts` — no change (gateway entry is unchanged).
- `eslint.config.js` — no rule changes; `gateway/transport/` lives inside the existing `gateway/` block.

## Wire protocol additions

Backward compatible. Existing `ControlEnvelope` / `ControlResponseEnvelope` / `ControlPushEnvelope` are unchanged. New optional frames:

```ts
// transport-level, not control-level — handled before envelope dispatch
type TransportFrame =
	| {kind: 'ping'; ts: number}
	| {kind: 'pong'; ts: number}
	| {
			kind: 'envelope';
			envelope: ControlEnvelope | ControlResponseEnvelope | ControlPushEnvelope;
	  };
```

UDS transport bypasses ping/pong (TCP keepalive on the kernel side is enough; UDS gives instant FIN). WSS transport always emits ping every 15 s; missed pong > 30 s closes the connection.

## Auth & bind safety

1. **Loopback or UDS without token** — allowed (existing behavior).
2. **Non-loopback bind without token** — daemon **refuses to start** with a clear error: `gateway: refusing to bind 0.0.0.0:18789 without --token configured`. Mirrors OpenClaw's posture.
3. **TLS** — `--tls-cert` + `--tls-key` enable TLS on the WSS listener. Without them, non-loopback bind also refuses unless `--insecure` is set (intended for "behind Tailscale / nginx" deployments). `--insecure` is logged loudly on every startup.
4. **mTLS (optional)** — `--tls-client-ca` requires the client to present a cert chained to that CA. Token still required. Useful for org deployments.
5. **Token rotation** — `athena gateway rotate-token` regenerates `~/.config/athena/gateway/token` and triggers a graceful drop of all WSS connections; clients reconnect with the new token (after a `gateway link --token` re-run).
6. **Rate limiting on connect** — 10 connect attempts / IP / minute, simple in-memory bucket. Defends against token brute force.

## Reconnect semantics

Athena CLI side:

1. On socket close (clean or unclean), enter `reconnecting` state.
2. Backoff: 1 s, 2 s, 4 s, 8 s, 16 s, 30 s, capped at 30 s with full jitter. Indefinite — no give-up.
3. On reconnect: replay `session.register` with the same `runtimeId`. Drain any inbound pushes the gateway parked during the gap (handled by N1 inbound queue — already works).
4. In-flight RPCs (turn-complete, channel-send, relay): replay if `idempotencyKey` allows; otherwise surface a `disconnected` error to the caller.

Gateway side:

1. On client disconnect, mark `runtimeConnections[runtimeId].state = 'stale'`, start grace timer (60 s).
2. New connect for same `runtimeId` within window: replace `connectionId`, clear stale state. **Do not** re-emit any pushes — that's the inbound queue's job.
3. After grace expires: full unregister. Newly arriving channel messages park in `InboundQueue`. When _any_ runtime registers later, they drain in FIFO order.

This makes IP changes invisible: the laptop reopens TCP from a new source IP, the WSS handshake authenticates the same token, the registry rebinds.

## Telemetry additions

- `gateway.transport.connect` — `{transport, peer, tls}` on accept.
- `gateway.transport.disconnect` — `{transport, reason, durationMs}` on close.
- `gateway.transport.reconnect` — client-side, `{attempt, backoffMs}`.
- `gateway.runtime.rebind` — server, `{runtimeId, gapMs}` when grace-window reconnect succeeds.
- `gateway.runtime.expired` — server, `{runtimeId}` when grace expires.

Reuse `capture()` from `src/infra/telemetry/events.ts`.

## CLI surface changes

```
athena gateway start
  [--bind <addr:port>]              # default: UDS
  [--tls-cert <path>]
  [--tls-key <path>]
  [--tls-client-ca <path>]          # mTLS, optional
  [--insecure]                      # allow non-loopback bind without TLS (Tailscale-only)
  [--grace-period-ms <n>]           # default 60000

athena gateway link <url>            # writes ~/.config/athena/gateway.json
  --token <t>                        # required
  [--tls-ca <path>]                  # custom CA bundle for self-signed deployments

athena gateway unlink                # rewrite the file with {mode:'local'}

athena gateway rotate-token          # server-side; prints the new token once

athena gateway status [--json]       # extends existing status with effective listener + connected runtime
```

`athena --gateway <url>` one-shot override remains a stretch; `gateway link` is the primary UX.

## Phased milestones

| M       | Deliverable                                                                                                                                                            | Verification                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **R1**  | Transport abstraction. Extract framing from `control/server.ts` + `control/client.ts` into `gateway/transport/types.ts` + `uds.ts`. Existing tests pass byte-for-byte. | `pnpm typecheck && pnpm lint && pnpm test` — 2856 still pass. No behavior change.                                     |
| **R2**  | `TlsWsTransport` server + `wsClient` client. Loopback bind only, plain WS (no TLS) — minimum viable wire. Passes the existing `sessionFlow.test.ts` over WS.           | New integration test: same scenario as `sessionFlow.test.ts` but with `transport: 'ws'` on `127.0.0.1:0`.             |
| **R3**  | Endpoint config + `gateway link` + `gateway unlink`. SessionBridge accepts `RuntimeEndpoint`. Local mode is the byte-for-byte default.                                 | Manual: `athena gateway link ws://127.0.0.1:18789 --token …`; restart Athena; verify register lands on remote daemon. |
| **R4**  | Reconnect + grace window + `bindConnection` split in `SessionRegistry`. Inbound queue drain across disconnect. Heartbeats.                                             | Integration test: kill TCP mid-session, assert `register` rebinds and parked inbound messages dispatch in order.      |
| **R5**  | TLS + bind guard + `--insecure`. Refuse to bind public without token. Log `--insecure` loudly.                                                                         | Test: `--bind 0.0.0.0:N` without token → daemon exits with clear stderr. With `--token` + `--insecure` → starts.      |
| **R6**  | mTLS optional path; `rotate-token` command; rate limiting on connect.                                                                                                  | Test: rotate-token forces reconnect; clients with old token are rejected.                                             |
| **R7**  | Relay-replay on reconnect (server-side). In-flight `relay.permission.request` survives a 5 s blip.                                                                     | Integration: drop client mid-relay, reconnect, assert relay completes against the rebroadcast.                        |
| **R8**  | Telemetry events + `gateway status --json` showing effective listener + connected runtime + last reconnect.                                                            | Manual + a status snapshot test.                                                                                      |
| **R9**  | Docs: `docs/guides/remote-gateway.md`. Tailscale, Caddy reverse-proxy, and direct-bind recipes. Threat model section.                                                  | Doc only; no code.                                                                                                    |
| **R10** | Operational hardening: connect rate-limit metric, structured connection log, `gateway doctor` checks endpoint reachability + TLS validity.                             | `athena gateway doctor` against a misconfigured remote shows actionable error.                                        |

R1–R3 is the MVP (loopback WS, no TLS, no reconnect). R4 makes it actually usable across networks. R5–R6 makes it safe to expose. R7 closes the relay gap. R8–R10 is polish and docs.

Each milestone is independently mergeable. R1 is pure refactor — should land first and stand alone.

## Risks & decisions to flag during execution

1. **Single-runtime invariant on a remote gateway is awkward.** Two laptops on the same gateway → second-to-register kicks first off. We keep this for v1 but document loudly. If demand emerges, the registry already keys by `runtimeId`; adding a "session.claim" frame with a per-message `targetRuntimeId` selector is straightforward but not on this plan.

2. **Token leakage**. The token in `~/.config/athena/gateway.json` is now a network-credential, not just a defense-in-depth check. File mode 0600 + key derivation + rotation command are mandatory. Telemetry must never emit the token.

3. **Clock skew**. Heartbeat timestamps and any future signed payloads need monotonic-clock framing; don't rely on wall clocks for liveness.

4. **TLS termination in front of the gateway**. Tailscale Funnel and Caddy are common; the daemon must trust `X-Forwarded-For` only when configured. For v1 we don't parse forwarded headers — trusted-proxy auth is on the OpenClaw roadmap and not required here.

5. **Channel adapter sidecars live on the gateway host**. Implication: bot tokens, Slack app credentials, etc. live next to the gateway, not the laptop. Document this clearly — a stolen laptop should not give an attacker the Telegram bot token.

6. **DB locality**. Per-session DBs live on the laptop (where the runtime runs). Gateway-state DB lives on the cloud host. The deviation-#6 decision (per-session vs gateway-global for `channel_messages`) is no longer deferrable — **gateway-global wins** because the channel messages are produced and consumed entirely on the gateway side now. Lift that work into R2 if not already done in N1/N2.

7. **What happens during a long disconnect.** With the inbound queue cap of 1000, a multi-hour outage on a chatty channel can drop messages. Document the cap; surface a `gateway.inbound.dropped` telemetry event when the queue truncates.

8. **Reconnect during a turn-in-flight.** The runtime is mid-turn locally, the gateway connection drops, channel reply can't be sent. Outbound is already covered by N2 (Outbox). On reconnect the outbox drain resumes. Verify in R4.

9. **Codex / Claude harness session state is local to the runtime.** Migrating runtime to a different machine mid-session is **not supported** and not on the roadmap. The cloud gateway is a router, not a runtime host. Document.

10. **`relay.*.cancel` over a flapping connection.** If a client reconnects between sending a relay request and its cancel, the gateway might broadcast a relay that no one is waiting on. Server-side: tag pending relays with the client's connection epoch; ignore stale cancels. Implement in R7.

## Verification (end-to-end after R5)

```bash
# Cloud host
athena gateway start --bind 0.0.0.0:18789 --tls-cert /etc/ssl/gw.crt --tls-key /etc/ssl/gw.key
# (sidecar Telegram channel already configured on the cloud host)

# Laptop
athena gateway link wss://gw.example.com:18789 --token "$ATHENA_GATEWAY_TOKEN"
athena                      # opens TUI; connects WSS to cloud gateway

# From Telegram, send a DM:
#   gateway receives inbound (cloud)
#   pushes session.dispatch.turn over WSS to laptop
#   Claude turn runs locally; permission prompt appears in TUI;
#   user chooses 'allow', verdict goes back over WSS to gateway,
#   relay completes; final agent message sent over WSS as turn.complete;
#   gateway dispatches outbound; reply lands in Telegram.

# Pull the laptop off wifi; reconnect 30s later. Send another Telegram message during the gap.
# Expect: parked in InboundQueue; drained automatically on reconnect; no user action.

sqlite3 ~/.config/athena/gateway/state.db \
  "select count(*) from inbound_queue where drained_at is not null"
# ↑ on the cloud host
```

Run gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm lint:dead && pnpm build`.

## Out of scope (v1)

- Multi-runtime fan-out per gateway.
- HTTP / OpenAI-compatible APIs on the gateway listener.
- Cross-machine session migration (runtime stays where it started).
- Webhook channel adapters.
- Auto-pairing / QR code flows.
- Gateway federation (gateway-to-gateway routing).
- Per-channel ACLs binding channels to specific remote runtimes.
- Web dashboard adapter (planned in `gateway-channels-plan.md` N5; orthogonal to this plan).
