# Plan: Athena Gateway Daemon + Two-Way Channels + Cloud Function Invoker

## Status (as of 2026-05-02)

Working branch: **`gateway-integration`** (pushed to `origin`).
Test suite: **2850 passing**, full gates clean (`pnpm typecheck && pnpm lint && pnpm test && pnpm lint:dead && pnpm build`).

### What is done

| Milestone                                                                         | State      | Commit    | Notes                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** Skeleton + types + ESLint block + tsup target                              | ✅ shipped | `8614765` | `src/shared/gateway-protocol/`, `src/gateway/{entry,daemon,paths,lock,auth}.ts`, `dist/athena-gateway.js` build target                                                                                                                                                                         |
| **M2** Schema v6 (channel_messages, gateway_function_invocations, channel_outbox) | ✅ shipped | `8614765` | Migration from v5 to v6 in `src/infra/sessions/schema.ts`; partial unique indexes on idempotency keys                                                                                                                                                                                          |
| **M3** UDS NDJSON control plane (ping/status)                                     | ✅ shipped | `8614765` | Full UDS server + client + connect-frame handshake + bearer token + filesystem ACL (0700/0600)                                                                                                                                                                                                 |
| **M4** ChannelAdapter contract + Telegram chat-path port + ChannelManager         | ✅ shipped | `697113e` | Inbound long-poll, outbound `send`, in-memory dedup window, health sample sink. Permission/question relays explicitly _not_ in this milestone                                                                                                                                                  |
| **M5a** SessionRegistry + SessionKey router + Dispatcher                          | ✅ shipped | `1b7e6f9` | One-runtime invariant; deterministic SessionKey ladder; dispatch-id correlation for turn-complete                                                                                                                                                                                              |
| **M5b** UDS push channel + session/turn/send handlers + multiplexed client        | ✅ shipped | `8330d41` | `ConnectionContext.push()`, `onConnect`/`onDisconnect`; client refactored from FIFO line-matching to `Map<requestId, resolver>` so push frames can interleave; full inbound→`session.dispatch.turn`→`session.turn.complete`→adapter.send round-trip integration test against a real tmpdir UDS |
| **M6 phase A** Legacy `src/channels/` demolition                                  | ✅ shipped | `7428ae9` | **Big swing**: −5911 LOC. Entire `src/channels/` deleted. Per-session subprocess channel model gone. `RuntimeProvider`/`useFeed`/`AppShell`/`cli.tsx` de-wired. Reusable leaf utilities relocated (see deviations below)                                                                       |

### Deviations from the original plan (and why)

1. **`ChannelAdapter` lives in `src/shared/gateway-protocol/adapter.ts`, not `src/channels/adapter.ts`.** The plan's named path puts the interface in `channels/`, but layer rules forbid `gateway/**` from importing `channels/**`. Putting the contract at the shared boundary lets both gateway adapters and any future test fixtures speak it without crossing layers. (Moot now that `src/channels/` is deleted entirely.)

2. **`TelegramBot` HTTP client lives in `src/shared/telegram/bot.ts`, not duplicated.** Originally meant to live alongside the legacy channel and be copied into the gateway adapter. Relocating to `shared/` removed the duplication; the only other consumer (legacy `channels/telegram/index.ts`) was deleted in phase A so this is now the single source.

3. **`--foreground` flag dropped from `athena gateway start`.** M1 originally took `--foreground` as an explicit opt-in. M3 review surfaced that the only mode currently shipped _is_ foreground (service install is M8); the flag was just ceremony. Removed; foreground is the default and only mode until M8 lands.

4. **`ATHENA_GATEWAY=1` feature flag DROPPED.** The original M6 spec said "preserve the legacy subsystem behind a flag for one release." User explicitly approved deleting it outright (the legacy code was unmaintainable and not in user-facing use yet). Phase A demolition is the new M6 baseline.

5. **Single-instance lock uses `O_CREAT|O_EXCL` + pid-alive probe instead of `flock(2)`.** Node's `fs` module doesn't expose `flock` publicly. Atomic `'wx'` open + writing the pid + `process.kill(pid, 0)` to detect a dead owner gives the same semantics; stale locks from crashed daemons are reclaimed automatically.

6. **Schema v6 tables landed in the per-session DB (as the plan specified), but this is wrong long-term.** `channel_messages`, `gateway_function_invocations`, and `channel_outbox` are gateway-global concerns; their FKs to `adapter_sessions` only make sense per-session. M6 phase B will need to revisit: either create a separate gateway-level DB at `${configDir}/gateway.db` (no FK to `adapter_sessions`), or scope these writes to the registered runtime's session. **Decision deferred to phase B**; flag for review during implementation.

7. **The `--channel` CLI flag and `athena channel telegram configure` command are still present but inert.** Removing them touches the meow flag schema and ripples into exec-mode validation; phase B will prune them as part of replacing the config-spawn pipeline with config-write-only (gateway reads on startup). The configure command's _behavior_ (writing `~/.config/athena/channels/<name>.json`) is still useful — the gateway will load these files on start in phase B.

8. **Channel feed-event types in `core/feed/types.ts` still exist but have no producers.** Render paths (`timeline`, `toolDisplay`, `titleGen`, `defaultRender`, `renderDetailLines`) were never broken — exhaustive switches handle the no-producer case naturally. Producers come back online when phase B's session bridge wires gateway client events to `feedStore.pushEvents`.

### Layout snapshot — where things actually live now

```
src/shared/gateway-protocol/
  envelope.ts          ControlEnvelope, ControlResponseEnvelope, ControlPushEnvelope
  control.ts           ControlRequestKind union; payload types for all kinds
  channel-events.ts    ChannelLocation, NormalizedInbound, OutboundMessage, SendResult, ProbeResult, HealthSample
  adapter.ts           ChannelAdapter interface, AdapterContext, StopReason, ChannelCapabilities
  index.ts             barrel

src/shared/telegram/
  bot.ts               TelegramBot HTTP client (single source of truth)
  markdown.ts          MarkdownV2 escape helpers + agent-markdown-to-MarkdownV2 conversion
  markdown.test.ts

src/gateway/
  entry.ts             tsup target → dist/athena-gateway.js
  daemon.ts            startDaemon(opts) → DaemonHandle; wires registry/dispatcher/channelManager
  paths.ts             resolveGatewayPaths(env): XDG_RUNTIME_DIR fallback, sun_path validation
  lock.ts              acquireLock(): O_CREAT|O_EXCL + pid + alive-probe
  auth.ts              loadOrCreateToken, timingSafeTokenEqual
  sessionRegistry.ts   one-runtime invariant + dispatch-id correlation
  dispatcher.ts        inbound → push session.dispatch.turn; turn-complete → channel.send
  channelManager.ts    owns ChannelAdapter set; dedup window; health sink
  router/sessionKey.ts deriveSessionKey(loc): peer:thread > peer > room:thread > room > default
  control/server.ts    UDS server with ConnectionContext.push(), onConnect/onDisconnect
  control/client.ts    multiplexed client (Map<requestId, resolver> + onPush(kind, cb))
  control/handlers.ts  request dispatcher: ping, status, session.{register,unregister,turn.complete}, channel.send
  control/lineReader.ts NDJSON splitter (duplicated from deleted channels/protocol.ts to avoid layer crossing)
  control/sessionFlow.test.ts end-to-end M5 integration test
  adapters/telegram/
    adapter.ts         TelegramAdapter implementing ChannelAdapter (chat path only)
    verdict.ts         callback-data parsing for permission/question (relay path lands phase B)
    ids.ts             5-letter channel-request-id generator (sole consumer = verdict.ts)
    index.ts           barrel
```

### What is NOT done (phase B onward)

The roadmap below replaces the original M6–M9 with the post-demolition reality.

#### Phase B (formerly M6, now bigger): two-way relays + app↔gateway integration

The legacy permission/question relay machinery is gone. Two-way Telegram chat lands when this phase ships.

1. **Extend the `ChannelAdapter` contract** — add either two methods (`requestPermissionVerdict`, `requestQuestionAnswer`) or a generic `relay(): Promise<RelayResult>` channel that returns when the user clicks an inline-keyboard button or sends a free-text answer. Decision pending; lean toward the generic channel since Slack will need the same surface.

2. **`RelayCoordinator` in `src/gateway/relay/`** — claim/cancel state machine, ported in _behavior_ from the deleted `src/channels/{permissionRelay,questionRelay,registry}.ts`. Lives gateway-side because relays span all registered channels (broadcast → first verdict wins → cancel on losers). Existing `verdict.ts` and `ids.ts` already in place under `gateway/adapters/telegram/`; promote `ids.ts` to `gateway/relay/ids.ts` once the coordinator owns it.

3. **New control plane kinds**:
   - request: `relay.permission.request`, `relay.permission.cancel`, `relay.question.request`, `relay.question.cancel`
   - response: verdict / answer / cancel-ack
   - push: `relay.permission.timeout`, `relay.question.timeout` (TTL elapsed)

4. **Telegram adapter relay impl** — port the inline-keyboard build + callback-query dispatch from the deleted `src/channels/telegram/index.ts`. Forum-mode topic routing was a feature of the legacy daemon; consciously deciding _not_ to port it in phase B (per-session topic mode adds complexity and the user has not asked for it). Reusable bits already in place: `bot.ts` HTTP client, `markdown.ts` for MarkdownV2 escaping, `verdict.ts` for callback-data parsing.

5. **App-side `sessionBridge.ts` (`src/app/channels/sessionBridge.ts`)** — opens a long-lived gateway client at runtime start, registers the session via `session.register`, subscribes to `session.dispatch.turn` pushes and translates them into `spawnHarness` calls in `AppShell`, and calls `relay.permission.request` / `relay.question.request` whenever the harness emits a permission/question event. Replaces the deleted `RuntimeProvider` channel-registry wiring.

6. **Channel registration from config** — gateway daemon loads `~/.config/athena/channels/*.json` (the same paths `athena channel telegram configure` writes) on startup and instantiates adapters before accepting client connections.

7. **Decide where channel_messages/gateway_function_invocations/channel_outbox actually live.** Per-session DB (current) vs gateway-global DB (`${configDir}/gateway.db`). My instinct: gateway-global, with the FK to `adapter_sessions` dropped. Worth a 30-min RFC sketch before implementing.

#### Phase C (formerly M7): CloudFunctionInvoker + 3 callers

Unchanged from original M7. Foundation now exists in M5b's request-handler dispatch, so this is mostly: zod-validated registry reader (`src/infra/config/cloudFunctions.ts`), HTTPS transport, idempotency cache keyed on `(name, idempotencyKey)`, audit row in `gateway_function_invocations`. Three callers: MCP tool (`mcp__athena__cloud_function_invoke`), channel `/run <name> <json>` parser, hook helper. Authorization: `allowedAgents` / `allowedSessions` enforced at the registry boundary. Don't ship without authz.

#### Phase D (formerly M8): service install + outbox + health monitor

Unchanged. launchd plist + systemd user unit. `channel_outbox` durable retry with backoff + transactional dequeue. Health monitor with stale-event threshold + restart cooldown + max-restarts-per-hour parking. New telemetry events: `gateway.startup`, `gateway.startup_failed`, `channel.parked`, `channel.outbound_failed`.

#### Phase E (formerly M9): Slack adapter + channels CLI polish

Unchanged. `@slack/bolt` Socket Mode (NOT webhook). Validates the `ChannelAdapter` contract works for non-Telegram. Then `athena channels {list, add, remove, status [--probe], capabilities, logs}` super-command with `--json` output. Contract test harness exercising the same `ChannelAdapter` surface against both adapters with mocked transports.

### Important context for picking up later

- **Branch**: `gateway-integration`, pushed to `origin`. PR not opened yet — open it after phase B lands.
- **Layer rules** (ESLint enforced in `eslint.config.js`): `gateway/**` cannot import from `app/`, `harnesses/`, `ui/`, or `channels/`. The `channels/` denylist remains even though the directory is deleted (harmless; remove during a future cleanup pass).
- **Daemon control-plane locations** (resolved at runtime):
  - socket: `${XDG_RUNTIME_DIR:-~/.config/athena/run}/gateway.sock`, mode `0600`, parent dir `0700`
  - lock: `${runDir}/gateway.lock` (atomic create + pid + alive-probe)
  - token: `~/.config/athena/gateway/token`, 32 random bytes, base64url, mode `0600`
  - resolution lives in `src/gateway/paths.ts` with sun_path-length validation (≤104 bytes for macOS safety)
- **Daemon binary**: `dist/athena-gateway.js`, started via `athena gateway start` (foreground only — service install is phase D).
- **Test fixtures pattern**: `tmpPaths()` in `src/gateway/control/sessionFlow.test.ts` shows how to spin up a real daemon over a tmpdir UDS for integration tests. Reuse this for phase B.
- **Knip & dead-code**: knip is already strict-mode (`--strict --exclude dependencies,unlisted,binaries`). When you add a new export, either use it from a same-layer consumer or expose it through a barrel that's used. Knip will fail the build otherwise.
- **Commit convention**: conventional-commits enforced by commitlint. Use `feat(gateway):`, `feat(channels):`, `feat(invoker):`, `refactor(channels):` etc. Subject must be lowercase. Pre-commit runs lint-staged (eslint + prettier) on staged files; never use `--no-verify`.

### Verification plan as of HEAD

```bash
git checkout gateway-integration
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm lint:dead && pnpm build
# 2850 tests pass; full gates clean
```

End-to-end smoke (M5 integration test surface):

```bash
pnpm vitest run src/gateway/control/sessionFlow.test.ts
# Boots a real daemon on a tmpdir UDS, registers a fake adapter, drives an
# inbound chat through the dispatcher, asserts the dispatch.turn push lands,
# completes the turn, asserts adapter.send was called.
```

Foreground daemon (manual):

```bash
node dist/athena-gateway.js
# → "athena-gateway: ok pid=N socket=/path/to/gateway.sock"
athena gateway probe
athena gateway status --json
```

---

## Context

Athena (`@athenaflow/cli`) today has the bones of a channels subsystem — `src/channels/` runs out-of-process daemons (`channel-telegram.js`, `channel-daemon.js`) that surface `PermissionRelay` and `QuestionRelay` events into a running interactive session via `ChannelRegistry` (`src/app/providers/RuntimeProvider.tsx:96-116`). The feed pipeline already understands `channel.permission.relayed/resolved`, `channel.question.relayed/resolved`, and `channel.chat.inbound` (`src/core/feed/types.ts:79-100`). What's missing:

1. **Two-way chat with full turn invocation.** A Telegram message can't yet drive a Claude/Codex turn end-to-end and route the reply back.
2. **A standalone, always-on gateway.** Channels today are tied to a foreground Athena session. The user wants OpenClaw-style separation: a long-running gateway daemon owns adapters and brokers traffic to whichever Athena interactive runtime is up.
3. **Cloud function invocation.** No registry, no invoker, no audit. The user wants three callers: agent tool, channel command (`/run …`), and hook/workflow event.

Goal: build a separate `athena-gateway` daemon that owns channel adapters, dispatches inbound chats to a registered Athena runtime as full agent turns, and brokers HTTPS cloud function invocations from agents/channels/hooks. Modeled on OpenClaw's Gateway+Channels split, scoped to Athena's existing layer rules and persistence model.

## Architecture

```
External chat (Telegram / Slack)
        │   long-poll / Socket Mode
        ▼
ChannelAdapter (in-daemon)        ← outbound: SendRequest
        │  NormalizedInbound        │
        ▼                            │
ChannelManager + health monitor ────┘
        │
        ▼
Router (peer→thread→room→channel→default → SessionKey, agentId)
        │
        ▼
GatewayDaemon (UDS NDJSON control plane, reuses Athena envelope pattern)
   ├─ session.register / session.dispatch.turn  ◄── Athena interactive runtime registers here
   ├─ relay.permission.* / relay.question.*     ◄── relays move into gateway
   ├─ function.invoke                            ◄── from MCP tool / hook / channel /run cmd
   └─ ping / probe / status

CloudFunctionInvoker — HTTPS POST + bearer/HMAC + idempotency cache + audit
```

**Dispatch model**: Gateway is a separate process; the Athena interactive runtime registers its `SessionController`s with the gateway over UDS on startup. Inbound chat → router resolves agent → `session.dispatch.turn` → Athena's session bridge calls `controller.startTurn`. No `exec` per turn (would shred Claude session state, MCP servers, hook-forwarder UDS, in-memory permission cache).

## Layer Rules

Add to `eslint.config.js` (after the existing `channels/` block at lines 179–199):

```
src/gateway/**  → may import: core, infra, shared
                  must NOT import: app, harnesses, ui, channels (use shared/gateway-protocol)
src/channels/** → unchanged; gains src/channels/adapter.ts contract
src/shared/gateway-protocol/** → leaf; envelope + control message types
```

Symmetrically deny `gateway/**` from `harnesses/**` and `ui/**`.

## Critical Files

**Reuse, do not reinvent:**

- `src/harnesses/claude/hook-forwarder.ts:63-128` — NDJSON socket framing, 5s default / 5min permission timeouts. Mirror this for the gateway control plane.
- `src/harnesses/claude/protocol/envelope.ts:13-28` — `HookEventEnvelope` / `HookResultEnvelope` shape. Generalize into `shared/gateway-protocol/envelope.ts`.
- `src/harnesses/adapter.ts:24-34` — `HarnessAdapter` contract. The session bridge calls `useSessionController().startTurn` — no harness changes needed.
- `src/core/runtime/types.ts:23-83` & `events.ts:4-37` — `RuntimeEvent` union; the session bridge subscribes here for `turn.complete` / final assistant message to drive outbound.
- `src/core/feed/types.ts:79-100` — extend with new kinds (see below); reuse `channel.*` event mapping in `src/core/feed/mapper.ts`.
- `src/infra/sessions/store.ts:35` — `recordEvent(runtimeEvent, feedEvents)`. Used by gateway-side feed bridging.
- `src/infra/sessions/schema.ts:3` — `SCHEMA_VERSION = 5`, linear migrations. Bump to v6.
- `src/infra/telemetry/events.ts` — `capture('event.name', props)`. Reuse for all gateway/channel/invoker telemetry.
- `src/app/entry/cli.tsx:76-86, 465-481` — meow dispatch + `KNOWN_COMMANDS` set; add `gateway` and `channels` here.
- `src/app/channels/setup.ts:24-26` — channel resolution by name. Becomes the gateway client wiring point in M6.
- `src/app/entry/channelCommand.ts:56-106` — existing `athena channel telegram configure`; remains and shares config readers with the new `channels` (plural) command.

**New files:**

- `src/shared/gateway-protocol/{envelope,control,channel-events}.ts`
- `src/gateway/entry.ts` (tsup target → `dist/athena-gateway.js`)
- `src/gateway/{daemon,lock,auth}.ts`
- `src/gateway/control/{server,handlers}.ts`
- `src/gateway/router/{sessionKey,binding}.ts`
- `src/gateway/adapters/{telegram,slack}.ts`
- `src/gateway/invoker/{types,httpsTransport,idempotency,registry}.ts`
- `src/gateway/outbox/{queue,drain}.ts`
- `src/gateway/health/{monitor,policy}.ts`
- `src/channels/adapter.ts` (in-daemon contract)
- `src/app/entry/{gatewayCommand,channelsCommand}.ts`
- `src/app/channels/sessionBridge.ts` (subscribes RuntimeEvents → gateway client)
- `src/app/mcp/cloudFunctionTool.ts` (MCP tool implementation)
- `src/infra/config/{channels,cloudFunctions}.ts` (zod-validated readers)

## Key Contracts

```ts
// src/shared/gateway-protocol/envelope.ts (generalize hook-forwarder envelope)
export interface ControlEnvelope<T = unknown> {
	request_id: string;
	ts: number;
	kind: ControlMessageKind; // 'session.register' | 'session.dispatch.turn' | …
	payload: T;
}

// src/channels/adapter.ts
export interface ChannelAdapter {
	readonly id: string; // 'telegram' | 'slack'
	readonly capabilities: ChannelCapabilities;
	start(ctx: AdapterContext): Promise<void>;
	stop(reason: StopReason): Promise<void>;
	send(msg: OutboundMessage): Promise<SendResult>; // idempotent on msg.idempotencyKey
	probe(): Promise<ProbeResult>;
	on(event: 'inbound', cb: (m: NormalizedInbound) => void): void;
	on(event: 'health', cb: (h: HealthSample) => void): void;
}

// src/gateway/invoker/types.ts
export interface CloudFunctionInvoker {
	invoke(req: InvokeRequest, signal: AbortSignal): Promise<InvokeResult>;
}
export interface InvokeRequest {
	name: string;
	args: unknown;
	idempotencyKey?: string;
	caller: {
		kind: 'agent' | 'channel' | 'hook';
		sessionId?: string;
		agentId?: string;
	};
}
```

Cloud function registry at `~/.config/athena/cloud-functions.json`, zod-validated:

```json
{
	"functions": [
		{
			"name": "summarize_pr",
			"url": "https://example.com/fn/summarize_pr",
			"auth": {"type": "bearer", "tokenEnv": "ATHENA_FN_TOKEN"},
			"timeoutMs": 30000,
			"idempotencyTtlSec": 300,
			"allowedAgents": ["main"]
		}
	]
}
```

## SessionKey Ladder

Deterministic, first match wins. Persisted as `(channel, account, peer, room, thread)` columns in `channel_messages`:

1. `peer:{channel}:{account}:{peerId}:{threadId}`
2. `peer:{channel}:{account}:{peerId}`
3. `room:{channel}:{account}:{roomId}:{threadId}`
4. `room:{channel}:{account}:{roomId}`
5. `default:{channel}:{account}`

Agent resolution: per-channel `defaultAgent` in config, overridable by `/agent <id>` channel command. Bindings stored in config; no per-message DB write for routing decisions.

## Schema v5 → v6

Add to `src/infra/sessions/schema.ts` under a new `if (existing.version < 6)` block:

```sql
CREATE TABLE channel_messages (
  id INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  peer_id TEXT,
  room_id TEXT,
  thread_id TEXT,
  provider_message_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  session_id TEXT REFERENCES adapter_sessions(session_id),
  agent_id TEXT,
  idempotency_key TEXT,
  feed_event_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ix_channel_messages_idem
  ON channel_messages(channel_id, account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_channel_messages_session_key
  ON channel_messages(channel_id, account_id, peer_id, room_id, thread_id, created_at);

CREATE TABLE gateway_function_invocations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  caller_kind TEXT NOT NULL CHECK(caller_kind IN ('agent','channel','hook')),
  session_id TEXT REFERENCES adapter_sessions(session_id),
  agent_id TEXT,
  idempotency_key TEXT,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','ok','error','timeout')),
  http_status INTEGER,
  duration_ms INTEGER,
  error TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX ix_fn_idem
  ON gateway_function_invocations(name, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE channel_outbox (
  id INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_outbox_due ON channel_outbox(next_attempt_at);
```

Add new feed event kinds to `src/core/feed/types.ts`: `channel.chat.outbound`, `gateway.function.invoked`, `gateway.function.completed`, `gateway.function.failed`. Map them in `src/core/feed/mapper.ts`.

## Daemon Process Details

- **Entrypoint**: `src/gateway/entry.ts` → tsup target → `dist/athena-gateway.js` (shebang). Add to `tsup.config.ts` alongside the existing two entry points.
- **Control plane**: UDS + NDJSON. Path: `${XDG_RUNTIME_DIR:-~/.config/athena/run}/gateway.sock` (mode 0600). Falls back to `~/.config/athena/run/` on macOS where `XDG_RUNTIME_DIR` is unset; verify 108-byte `sun_path` limit isn't hit.
- **Auth**: peer-uid check on `accept(2)` + per-connection bearer token from `~/.config/athena/gateway/token` (0600). Loopback-only by construction (UDS).
- **Single-instance lock**: `gateway.lock` with `flock` + pid; mirror existing claude hook-forwarder lock convention.
- **Graceful shutdown**: SIGTERM → stop accepting → drain outbox (≤10s) → close adapters in reverse start order → release lock.
- **Service install**: deferred to M8. M1 ships foreground-only (`athena gateway start --foreground`).

## CLI Surface

Extend `src/app/entry/cli.tsx` `KNOWN_COMMANDS`:

- `athena gateway {start|stop|status|probe|install|uninstall}` → `src/app/entry/gatewayCommand.ts`
- `athena channels {list|add|remove|status [--probe]|capabilities|logs}` → `src/app/entry/channelsCommand.ts`
- Existing `athena channel telegram configure` (`channelCommand.ts:56-106`) stays untouched. Both commands share config readers in `src/infra/config/channels.ts`.

## Phased Milestones

| M      | Deliverable                                                                                                                                                                                                | Verification                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **M1** | Skeleton + types: `src/shared/gateway-protocol/*`, ESLint gateway block, `src/gateway/{entry,daemon}.ts` (no-op handlers), tsup target, `athena gateway start --foreground` prints "ok" + holds the socket | `pnpm build && node dist/athena-gateway.js --foreground`                                 |
| **M2** | Schema v6 migration block + types + `channel_messages`/`gateway_function_invocations`/`channel_outbox` tables; new `feed_events` kinds                                                                     | Migration test from v5 fixture; `pnpm typecheck`                                         |
| **M3** | Control plane: UDS NDJSON server + client, lock, token, peer-uid check, `ping` / `probe` / `status` RPCs reusing the envelope pattern                                                                      | `athena gateway probe` round-trips against running daemon                                |
| **M4** | `ChannelAdapter` contract; port existing Telegram daemon logic into `gateway/adapters/telegram.ts`. Relay paths still legacy (untouched)                                                                   | Manual: send DM → `channel.chat.inbound` row appears in DB                               |
| **M5** | Session bridge + inbound→turn: `app/channels/sessionBridge.ts`, `session.register` and `session.dispatch.turn`, outbound emitter on `turn.complete`                                                        | E2E: Telegram message → Claude turn → reply lands back in Telegram                       |
| **M6** | Relay migration over gateway control plane behind `ATHENA_GATEWAY=1` flag; legacy daemons preserved one release for fallback                                                                               | Existing permission/question flows unchanged with flag on or off                         |
| **M7** | `CloudFunctionInvoker` + 3 callers: HTTPS transport, zod-validated registry, MCP tool (`mcp__athena__cloud_function_invoke`), channel `/run` parser, hook helper. Audit table writes; idempotency cache    | Invoke same fn via all three paths; idempotency hit on retry; audit row per call         |
| **M8** | Service install (launchd plist + systemd user unit), `channel_outbox` durable retry drain, health monitor with stale-event threshold + restart cooldown + max-restarts/hour parking                        | Crash daemon mid-send → outbox restores on restart; channel parked after restart storm   |
| **M9** | Slack adapter (Socket Mode via `@slack/bolt`) validates the contract; `athena channels` super-command polish; full status/capabilities/logs JSON output                                                    | Slack DM and thread reply both round-trip; `athena channels status --probe --json` clean |

Each milestone is independently mergeable. M1–M3 is plumbing. M4–M5 is the MVP (one channel, full two-way). M6 is migration. M7 is the cloud function feature. M8–M9 are operational polish.

## Reuse Map

- **NDJSON envelope + UDS framing**: copy structure from `src/harnesses/claude/hook-forwarder.ts:63-128` and `protocol/envelope.ts:13-28` into `shared/gateway-protocol/`.
- **Subprocess lifecycle, lock files, signal handling**: pattern from existing channel daemons in `src/channels/`.
- **Session writes**: `SessionStore.recordEvent` in `src/infra/sessions/store.ts:35` — gateway control handler calls this when bridging events into the registered runtime's DB.
- **Telemetry**: `capture()` from `src/infra/telemetry/events.ts` — new event names: `gateway.startup`, `gateway.startup_failed`, `gateway.invocation`, `channel.parked`, `channel.outbound_failed`.
- **CLI dispatch**: meow + `KNOWN_COMMANDS` pattern from `src/app/entry/cli.tsx:76-86, 465-481`.
- **Config readers**: existing `~/.config/athena/channels/<name>.json` shape from `channelCommand.ts:56-106`.

## Verification (end-to-end)

After M5 (MVP):

```bash
pnpm build
athena gateway start --foreground &        # in one terminal
athena                                      # interactive Athena registers with the gateway
# from Telegram: send a DM to the configured bot
# expect: Claude turn runs in the interactive session, reply returns to Telegram
sqlite3 ~/.athena/sessions/<id>/session.db \
  "select direction, peer_id, provider_message_id from channel_messages order by created_at"
# expect two rows: one 'in', one 'out'
```

After M7 (cloud functions):

```bash
echo '{"functions":[{"name":"echo","url":"https://httpbin.org/post","auth":{"type":"bearer","tokenEnv":"FAKE"},"timeoutMs":5000}]}' \
  > ~/.config/athena/cloud-functions.json
# 1. Channel command path
# Telegram: /run echo {"hello":"world"}        → expect 200 reply posted back
# 2. Agent tool path
# Inside Athena, ask Claude to "invoke echo with {hello: world}" → tool fires, result in transcript
# 3. Hook path
# Configure a workflow PreToolUse hook calling invokeCloudFunction('echo', ...)
sqlite3 ~/.athena/sessions/<id>/session.db \
  "select name, caller_kind, status, http_status, duration_ms from gateway_function_invocations"
# expect three rows, all status='ok'
```

Run unit/integration tests: `pnpm test src/gateway src/shared/gateway-protocol src/channels`.
Run lint + types: `pnpm typecheck && pnpm lint`.
Run dead-code check before each merge: `pnpm lint:dead`.

## Risks & Decisions to Flag During Execution

1. **One gateway, one Athena runtime invariant**: gateway routes by registered `agentId`. Reject duplicate registrations in M5; flag if multi-runtime fan-in becomes a real requirement (it isn't today).
2. **Relay backward compatibility (M6)**: keeps legacy per-channel daemons working behind a feature flag for one release. Confirm cutover release with the user before removing the flag.
3. **Idempotency key sourcing**: Telegram `update_id` is reliable; Slack needs `client_msg_id` fallback. Document per adapter; surface a clear error if absent.
4. **MCP cloud-function tool authorization**: any agent in any session can invoke any registered function unless gated. Implement `allowedAgents` / `allowedSessions` on the registry from M7 v1; do not ship without it.
5. **HMAC signing scheme**: confirm canonicalization (body + `X-Athena-Timestamp` + nonce) before M7 ships externally.
6. **UDS path 108-byte limit on macOS**: `XDG_RUNTIME_DIR` not set; fall back to `~/.config/athena/run/`. Validate the resolved path length at daemon start; bail with a clear error if too long.
7. **Codex `turn.complete` semantics**: differ from Claude. Verify outbound emitter handles both via `HarnessAdapter.capabilities` (`src/harnesses/adapter.ts:24-34`) rather than sniffing event kinds.
8. **Single-Gateway-per-host**: `flock`-based lock; clear "gateway already running" diagnostic before exiting.

## Out of Scope (v1)

- WhatsApp / Signal / iMessage / Matrix / Discord channels.
- Multi-agent routing across multiple Athena runtimes.
- Hosted gateway / multi-tenant.
- Webhook-mode adapters (long-poll / Socket Mode only).
- Lambda SDK / GCP Functions SDK transports (HTTPS only).
- Service auto-install on Windows (defer; M8 ships macOS launchd + Linux systemd user unit).
