# ADR 0001 — Attachment supervisor and multi-runtime gateway

Status: Superseded by paired-instance dashboard feed sync
Date: 2026-05-10

## Superseding Decision — 2026-05-12

Dashboard pairing now means one local CLI instance broadcasts canonical
`FeedEvent` envelopes for every local, resumed, and dashboard-requested Session
to the paired dashboard through a durable local outbox. Runner scheduling remains
dashboard-side metadata and is not a CLI routing key for feed publishing or
execution.

The dashboard runtime daemon remains the local remote-sync process: it owns the
paired instance socket, drains the feed outbox, persists inbound dashboard
decisions to a local inbox, and launches dashboard assignments through the same
`runExec` path used by local exec. The multi-runtime gateway/runner-adapter model
described below is retained only as historical context for the previous proposal.

## Context

Drisp pairs one CLI instance with a dashboard. The dashboard binds N **runners**
to that instance and dispatches **runner-runs** plus a separate **console**
chat channel into the CLI. Today the CLI:

- Persists the dashboard's runner list locally (read-only mirror at
  `~/.config/athena/attachments.json`, populated by `dashboard pair`). See
  `src/infra/config/attachmentMirror.ts`.
- Loads N **console** channels in parallel via per-runner sidecars
  (`console-<runnerId>.json`, `kind: console`, `instance_id: console:<runnerId>`).
- Hosts at most **one** Registered runtime in the gateway
  (`RuntimeBindingStore` in `src/gateway/runtimeBindingStore.ts`).
- Treats the dashboard's instance-socket job-assignment stream as a separate
  transport (`src/app/dashboard/runtimeDaemon.ts` + `remoteRunExecutor.ts`),
  not as a gateway adapter.

The goal is to support N runners attached to one CLI, all running concurrently,
with N parallel console sessions. The user-facing behaviour:

- `dashboard pair <token>` mirrors all attached runners and starts the gateway
  with one console adapter per runner.
- Each runner gets its own harness **Session** that can run independently from
  the others.
- The CLI never edits the attachment list; it only mirrors what the dashboard
  reports.

## Decision

The CLI grows an **Attachment** as a first-class concept and a process-per-Attachment
**supervisor** model. The supervisor runs the gateway (multi-runtime), the
attachment mirror, and a consolidated Ink terminal. Each attachment has its own
single-tenant harness child process, registered with the gateway under its
`attachmentId`.

Today's `runtimeDaemon` collapses into a gateway adapter (`runner` kind) that
demuxes the dashboard's instance socket per attachment.

```
Dashboard
  │ instance socket (one connection, frames carry runnerId/attachmentId)
  ▼
Supervisor (one CLI process)
  ├─ AttachmentMirror (read-only sync of dashboard-owned list)
  ├─ Gateway DispatchPipeline (multi-runtime, keyed by attachmentId)
  │   ├─ runner adapter — one instance per attachment
  │   └─ console adapter — one instance per attachment (id = console:<runnerId>)
  ├─ Harness children — one process per Attachment, --attachment-id <id>
  └─ Ink terminal — tabbed/merged view across child feeds
```

## Why this shape, not the alternatives

**Alternative A — single-process, multi-Session FeedMapper.** Refactor the
FeedMapper, SessionStore, and harness internals to support N concurrent Sessions
keyed by `session_id`. Rejected: Claude Code (and the wider harness model) is a
single-conversation subprocess. Multi-Session-per-process means
multi-subprocess-per-process anyway, so the apparent simplification is illusory
and the FeedMapper refactor is pure cost.

**Alternative B — N supervisors, one per attachment.** Each `drisp pair` invocation
binds one runner. Rejected: defeats the user requirement "one CLI talking to N
runners" and forks the gateway, which is the natural multiplexing point.

**Alternative C (chosen) — one supervisor, N harness children.** Each child
remains single-tenant (today's harness model, mostly unchanged). The gateway
becomes the multi-runtime routing layer. Crash containment and isolation come
from process boundaries; consolidation comes from one supervisor and one
gateway.

## Phased work

The phasing reflects what's blocked by what.

### Phase 1 — Dashboard protocol contract (server-side, blocks everything else)

The dashboard must:

1. Include `runnerId` (and optionally a stable `attachmentId`) on every
   `job_assignment` frame on the instance socket. Without this the supervisor
   cannot route runs to the right harness child. See
   `src/app/dashboard/instanceSocketClient.ts`.
2. Emit an `attachments.changed` frame (or expose `GET /api/instances/<id>/attachments`)
   so the CLI's mirror stays in sync without re-pairing.
3. (Optional) Annotate each attachment with which transports are enabled —
   today the CLI assumes "all transports for every attached runner."

### Phase 2 — Local read-only attachment mirror (DONE)

`src/infra/config/attachmentMirror.ts`. `pair` populates it; `unpair` removes
it; `dashboard list` prints it.

### Phase 3 — Multi console adapter instances (DONE)

`ChannelSidecar` carries `kind` + `instance_id`. `ConsoleAdapter` and
`TelegramAdapter` accept an injected id. `console link <runnerId>` writes
`console-<runnerId>.json`. Multiple consoles coexist. Legacy `console.json`
continues to load via backward-compat defaults.

### Phase 4 — Multi-runtime binding store

Make `RuntimeBindingStore` a `Map<attachmentId, RegisteredRuntime>` with the
same per-key state machine as today (active/stale/absent + grace timer). The
`DispatchPipeline` routes inbound turns by `attachmentId` extracted from the
frame payload; falls back to the legacy single-runtime slot when absent (which
is what arrives until phase 1 ships).

Today's `RegisteredRuntime` carries an optional `attachmentId` field (added in
this ADR's accompanying scaffolding) so the type is forward-compatible. The
behaviour change waits on phase 1.

Surfaces touched:

- `src/gateway/runtimeBindingStore.ts` — store internals
- `src/gateway/dispatchPipeline.ts` — extract `attachmentId` from incoming
  turn payload, key all binding lookups
- `src/gateway/control/handlers.ts` — register/unregister handlers accept
  `attachmentId`
- All `runtimeBindingStore` and `dispatchPipeline` tests

### Phase 5 — Process-per-Attachment supervisor

A new entry point `src/app/entry/supervisor.tsx` (replaces today's
`runtimeDaemon` and consolidates with `gateway/daemon.ts`) owns:

- `AttachmentMirror` startup + subscription to `attachments.changed`
- One gateway daemon (in-process, not subprocess) with the multi-runtime store
- One `AttachmentRunner` per attachment — manages a child harness process,
  passes `--attachment-id <id>` and the right `runnerId`/transports config,
  restarts on crash, drains on detach
- One consolidated Ink terminal that demuxes child harness feeds (data plumbing
  already keys on `session_id`; UI gains a tabbed/merged projection)

Interface sketch for `AttachmentRunner`:

```typescript
type AttachmentRunner = {
	readonly attachmentId: string;
	readonly runnerId: string;
	start(): Promise<void>;
	stop(reason: 'detach' | 'shutdown' | 'crash'): Promise<void>;
	// Observed by supervisor for UI demux + telemetry
	onChildExit(
		handler: (e: {code: number; signal: string | null}) => void,
	): void;
};
```

### Phase 6 — Collapse `runtimeDaemon` into a gateway `runner` adapter

The dashboard's instance socket becomes a gateway channel adapter (kind:
`runner`). Inbound `job_assignment` frames flow into `DispatchPipeline` like any
other channel turn. `remoteRunExecutor`'s response handling becomes the
Registered runtime's reply path (already its role; just speaks the unified
`session.dispatch.turn` contract instead of its bespoke frames).

Single instance-socket connection is preserved — supervisor-level demux by
`runnerId`/`attachmentId` extracts the routing key inside the gateway, not by
opening N WebSockets.

Net deletions after this lands:

- `src/app/dashboard/runtimeDaemon.ts` (collapses into supervisor entry +
  gateway adapter)
- `src/app/dashboard/instanceSocketClient.ts`'s bespoke frame contract (replaced
  by the `runner` adapter speaking gateway-protocol frames)
- `dashboard console enable` / `dashboard console link` (the mirror does this
  automatically; manual link is dead code)

## Consequences

**Positive**

- One inbound contract (`session.dispatch.turn`), one binding store, one
  process supervisor.
- True parallelism across attachments without changing FeedMapper or harness
  internals.
- Crash containment per attachment.
- The dashboard remains the source of truth for the attachment set; the CLI is
  a passive mirror.

**Negative / costs**

- N times the harness memory/CPU per attachment. Mitigation: shared SQLite is
  not used (each child writes its own per-session DB at
  `sessionsDir()/<sessionId>/session.db` — already isolated, see
  `src/app/exec/runner.ts:129`).
- Ink consolidation needs UI work. Tabbed view first; merged view is a future
  refinement.
- Phase 1 is a dashboard-team dependency. Until it ships, runtime routing must
  fall back to single-runtime semantics — the multi-runtime store is dead code
  on the wire.

## Out of scope

The reviewer flagged **permission lifecycle** (scattered across
`runtimeController`, `useFeed`, `sessionBridge`) and **FeedMapper seam-depth**
(1477-LOC `mapEvent` switch with shallow internal state buckets) as
architectural opportunities elsewhere in the codebase. They are real, but they
are not the path to solving the runner/console pairing problem. Leave them as
future ADRs when the pairing work is settled.

## References

- Architecture review thread (May 2026)
- Domain glossary: `CONTEXT.md` — Attachment is added in this ADR; existing
  terms used: Session, Run, Dispatch turn, Registered runtime, DispatchPipeline
- `src/infra/config/attachmentMirror.ts` — phase 2 substrate
- `src/infra/config/channels.ts` — phase 3 sidecar schema
- `src/gateway/runtimeBindingStore.ts` — phase 4 scaffolding
