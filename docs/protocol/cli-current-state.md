# CLI Runtime-Dashboard Protocol: Current State

Status: current implementation snapshot  
Last reviewed: 2026-05-17

## Purpose

This document records what `drisplabs/cli` implements today for dashboard-paired execution. It is descriptive, not prescriptive. The local gateway control plane is included where it affects runtime behavior, but the canonical dashboard-paired path is the dashboard runtime daemon described in ADR 0001.

## Main Components

| Area                     | Current implementation                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| Pairing command          | `src/app/entry/dashboardCommand.ts`                                     |
| Pairing config           | `src/infra/config/dashboardClient.ts`                                   |
| Refresh-token rotation   | `src/infra/config/dashboardAuth.ts`                                     |
| Runtime daemon           | `src/app/dashboard/runtimeDaemon.ts`                                    |
| Instance socket          | `src/app/dashboard/instanceSocketClient.ts`                             |
| Assignment execution     | `src/app/dashboard/dashboardPairedExecution.ts`, `remoteRunExecutor.ts` |
| Feed publication         | `src/app/dashboard/pairedFeedPublisher.ts`                              |
| Feed outbox storage      | `src/app/dashboard/dashboardFeedPublisher.ts`                           |
| Dashboard decision inbox | `src/app/dashboard/dashboardDecisionInbox.ts`                           |
| Local gateway substrate  | `src/gateway/*`, `src/shared/gateway-protocol/*`                        |

## Pairing and Authentication

### Pairing flow

`drisp dashboard pair <token> --url <origin>`:

1. Computes a deterministic machine fingerprint from hostname, user, platform, and architecture.
2. POSTs `/api/instances/pair` with:
   - `token`
   - `fingerprint`
   - `hostInfo`
   - `capabilities.instanceSocket = true`
   - `capabilities.runtimeDaemon = true`
   - `capabilities.cliVersion`
   - legacy `capabilities.version`
3. Accepts a response containing at least:
   - `instanceId`
   - `refreshToken`
   - optional `runners`
   - optional `requiredCliVersion`
   - optional `capabilityAck`
4. Refuses to install/start the daemon when `requiredCliVersion` is newer than the local CLI version, even though the dashboard-side pairing already succeeded.
5. Persists `dashboardUrl`, `instanceId`, `refreshToken`, `fingerprint`, `pairedAt` in `~/.config/athena/dashboard.json`.
6. Writes a local attachment mirror from `runners[]`.
7. Starts the local dashboard daemon best-effort. Daemon startup failure is a warning, not a pairing failure.

### Token lifecycle

- The CLI treats refresh tokens as single-use.
- `refreshDashboardAccessToken()` serializes refreshes with a filesystem lock beside `dashboard.json`.
- POST `/api/instances/refresh` sends:
  - `refreshToken`
  - `fingerprint`
- On success the CLI atomically replaces the stored refresh token and returns a short-lived access token.
- The runtime daemon proactively refreshes before expiry and circuit-breaks after repeated failures:
  - default failure limit: 5
  - default window: 5 minutes
  - default cooldown: 5 minutes
- Consecutive refresh failures can leave the daemon alive but offline until cooldown or successful retry.

## Local Daemon and Identity

### Dashboard runtime daemon

The dashboard daemon is the active paired-execution owner:

- Starts only when paired config exists.
- Uses a PID lock and UDS control socket for `status`, `runs`, `reload`, `restart`, and `stop`.
- Exit codes:
  - `0`: graceful stop/restart/signal
  - `1`: startup failure, including not paired or lock contention
- Maintains in-memory run history with a bounded ring buffer, default 100 entries.

### Instance identity

- Local persistent identity is the dashboard-issued `instanceId`.
- Pairing additionally binds the instance to a deterministic local `fingerprint`.
- The CLI never creates attachment ownership locally; it mirrors dashboard-owned attachments.
- `attachments.changed` frames overwrite the local attachment mirror with full-list semantics.

### Local gateway substrate

The separate local gateway daemon:

- Uses a local token file plus filesystem ACLs for UDS access.
- Allows one active runtime per `attachmentId` slot, with a legacy fallback slot when `attachmentId` is omitted.
- Supports runtime states `absent -> active -> stale -> active|absent`.
- Queues inbound channel messages when no runtime is active.

This gateway is not the canonical dashboard assignment scheduler in the current architecture.

## Instance Socket Protocol

### Connection

- WebSocket URL: `/api/instances/:instanceId/socket`
- Access token is sent as the first `Sec-WebSocket-Protocol` value.
- The client:
  - opens a socket with a 10 second default connect timeout;
  - sends `ping` every 30 seconds;
  - reconnects with backoff `[1s, 2s, 5s, 10s, 30s]`;
  - retains the last client object only so fallback `run_event` sends can still be attempted after disconnect.

### Server-to-CLI frames consumed

| Frame                 | Current CLI behavior                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `job_assignment`      | Immediately sends `assignment_accepted`, then schedules local execution. |
| `cancel`              | Aborts an active local assignment when `runId` matches.                  |
| `dashboard_decision`  | Enqueues into durable SQLite inbox, then sends `decision_ack`.           |
| `attachments.changed` | Rewrites local attachment mirror.                                        |
| `feed_ack`            | Marks durable feed outbox row acked by `deliverySeq` and/or `eventId`.   |
| `pong`                | No special logic beyond socket liveness.                                 |
| `error`               | Exposed to handlers/logging only.                                        |

### CLI-to-server frames emitted

| Frame                 | Current CLI behavior                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `ping`                | Heartbeat.                                                                              |
| `assignment_accepted` | Sent eagerly when an assignment frame arrives, before execution starts.                 |
| `decision_ack`        | Sent after local inbox enqueue, not after the runtime consumes the decision.            |
| `feed_event`          | Canonical paired-session event transport; durable and retried from local SQLite outbox. |
| `run_event`           | Legacy/fallback remote-run event transport when no per-run stream is available.         |

## Assignment and Execution Semantics

### Dispatch admission

`createDashboardPairedExecution()` enforces:

- no duplicate active `runId`;
- per-runner concurrency cap in the daemon process;
- default `maxConcurrentRuns = 1`;
- rejection on overflow via a `run_event` with:
  - `kind: "rejected"`
  - `seq: 0`
  - payload reason.

The cap is local and per runner key. It is separate from dashboard-side queue leases.

### Run spec handling

`remoteRunExecutor` accepts an opaque `runSpec` but currently expects:

- required `prompt`
- optional `athenaSessionId`
- optional `adapterResumeSessionId`
- optional `sessionId`
- optional `projectDir`
- optional `workflow { source, ref, version }`
- optional `harness`
- optional `env`
- optional `timeoutSec`
- optional `callbackWsUrl`
- optional `callbackToken`

Behavior:

- missing/empty prompt is a terminal error;
- remote env is merged over workflow env without mutating `process.env`;
- missing workflows can be installed from the requested marketplace/source;
- local execution uses the same `runExec` path as local CLI execution;
- dashboard decisions are injected through the durable dashboard decision inbox.

### Workflow selection

- If `workflow.ref` is present, the CLI resolves the workflow name from the ref.
- If missing locally, it installs from:
  - `workflow.source`, when non-`marketplace`;
  - otherwise configured marketplace sources;
  - otherwise default marketplace source.
- Version is appended to `workflow.ref` when `version` exists and the ref has no version suffix.

## Session, Run, Feed, and Decision Handling

### Session/run model visible to the CLI

- Dashboard assignments carry dashboard `runId`.
- `athenaSessionId` may be provided for dashboard-created runs or continued runs.
- The CLI emits canonical local `FeedEvent` payloads that contain runtime/session/run semantics from the core execution layer.
- Local paired sessions can exist without a dashboard runner.

### Feed publishing

- `FeedEvent` is the canonical publication model for paired sessions.
- `PairedFeedPublisher` accepts canonical `FeedEvent`s plus session identity, persists them durably, frames `feed_event`, owns retry timing, and consumes `feed_ack`.
- `feed_event` is the paired-session transport.
- `run_event` and the per-run stream are compatibility transports for remote-run flows, isolated behind `remoteRunEventPublisher.ts`.
- Feed outbox storage is persisted in SQLite.
- Each row has:
  - monotonic local `deliverySeq`
  - event identity `athenaSessionId:event_id`
  - attempt count
  - next attempt timestamp
- Runtime daemon drains up to 100 rows per poll, default every 1 second.
- Backoff is linear up to 30 seconds.
- ACK by `deliverySeq` and/or `eventId` marks delivery complete.
- Because insertion is `UNIQUE(instanceId, eventId)`, duplicate local enqueue is ignored.

### Decision handling

- Incoming dashboard decisions are stored durably in SQLite by `(athenaSessionId, requestId)` while unconsumed.
- New delivery replaces an existing unconsumed decision for the same key.
- The daemon ACKs dashboard delivery as soon as the inbox enqueue succeeds.
- The runtime later polls pending decisions for a session and marks rows consumed independently of socket acknowledgement.

## Reconnect and Failure Semantics

### Reconnect

- Instance socket reconnect is automatic.
- Initial socket failure can be retried instead of failing daemon startup.
- A reconnect refreshes access token before creating the new socket.
- Missed `attachments.changed` is tolerated because the dashboard owns attachment state and the mirror can be refreshed from HTTP.

### Event delivery guarantees

| Path                                  | Current guarantee                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `feed_event`                          | Durable local retry until ACK; dashboard ingestion is idempotent by `(instanceId, eventId)`.   |
| Per-run stream                        | At-least-once replay with strict sequence resume when `callbackWsUrl` + `callbackToken` exist. |
| Legacy `run_event` on instance socket | Best-effort; frames may be dropped while disconnected.                                         |
| `dashboard_decision`                  | Dashboard-side queue + reconnect replay; local inbox durable after receipt.                    |
| `attachments.changed`                 | Best-effort push only.                                                                         |

### Failure semantics

- Assignment execution failures are reflected through emitted runtime events and local run records.
- Duplicate or over-cap assignments are rejected locally, not queued locally.
- Socket sends while disconnected are dropped except for durable feed events and per-run stream queueing.
- Refresh failure can strand the daemon offline without exiting.
- Daemon process exit semantics are independent from run success/failure semantics.

## Current-State Lifecycle Tables

### Local daemon

| State          | Entered by               | Leaves by            |
| -------------- | ------------------------ | -------------------- |
| unpaired       | missing config           | `dashboard pair`     |
| paired-offline | config exists, no socket | successful reconnect |
| connected      | socket open              | close/error/stop     |
| stopping       | UDS stop or signal       | process exit         |

### Local assignment

| State     | Meaning                            |
| --------- | ---------------------------------- |
| received  | `job_assignment` arrived           |
| accepted  | `assignment_accepted` sent         |
| running   | executor promise active            |
| completed | executor resolved                  |
| failed    | executor rejected                  |
| cancelled | `cancel` aborted active controller |
| rejected  | duplicate or over local cap        |

## Implementation Boundaries

- Dashboard owns pair tokens, attachments, runner binding, dashboard run records, and queue leases.
- CLI owns local config, token rotation storage, runtime process lifecycle, local execution, feed retry, and local decision inbox persistence.
- The gateway owns channel routing, not paired dashboard scheduling.

## Notable Current-State Ambiguities

- `assignment_accepted` confirms frame receipt, not dispatch start or capacity acceptance.
- Local daemon concurrency and dashboard runner concurrency are separate limits with separate rejection behavior.
- `run_event` and `feed_event` coexist, but only `feed_event` is the canonical paired-session stream.
- Token names still use legacy Athena terminology in several files and data fields.
