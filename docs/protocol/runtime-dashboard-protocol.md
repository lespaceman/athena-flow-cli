# Runtime-Dashboard Protocol

Status: intended contract derived from current implementation  
Last reviewed: 2026-05-17

## 1. Scope

This document defines the intended protocol between the Drisp dashboard and a paired Drisp CLI runtime. It covers the complete integration surface:

- HTTP APIs
- socket messages
- pairing and authentication
- instance, runner, dispatch, session, and run lifecycles
- workflow execution
- event streaming
- human decision delivery
- reconnect behavior
- errors, versioning, and compatibility

It intentionally separates the desired contract from the current-state documents:

- `cli-current-state.md`
- `dashboard-current-state.md`
- `protocol-gap-analysis.md`

## 2. Roles and Ownership

| Role                    | Owns                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard               | Pairing tokens, instance registry, runner attachments, dispatch queue, org/runner concurrency policy, dashboard run records, dashboard session read models, decision issuance |
| CLI runtime             | Local persistence, token rotation storage, local process health, workflow execution, feed publication retry, decision consumption                                             |
| Instance socket service | Control-plane delivery, pending offline assignments, pending offline decisions, heartbeat mediation                                                                           |
| Per-run stream service  | Compatibility event transport for older/remote-run flows until retired                                                                                                        |

## 3. Identifier Glossary

| Identifier               | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `instanceId`             | Dashboard-issued paired CLI identity                                            |
| `runnerId`               | Dashboard runner/deployment identity                                            |
| `runId`                  | Dashboard run identity                                                          |
| `athenaSessionId`        | Cross-event runtime session identity currently used by CLI feed/session systems |
| `adapterResumeSessionId` | Harness-level resume id for continuing an adapter session                       |
| `eventId`                | Stable feed-event identity within an Athena session                             |
| `feedSeq`                | Canonical event order within a session feed                                     |
| `deliverySeq`            | Local CLI outbox order used only for feed delivery retry                        |
| `requestId`              | Human-decision request identity within a session                                |

## 4. HTTP Contract

### Public CLI-facing endpoints

| Endpoint                                      | Method          | Purpose                                           |
| --------------------------------------------- | --------------- | ------------------------------------------------- |
| `/api/instances/pair`                         | `POST`          | Consume one-time pairing token                    |
| `/api/instances/refresh`                      | `POST`          | Rotate refresh token and mint access token        |
| `/api/instances/:id/socket`                   | `GET` WebSocket | Open long-lived instance socket                   |
| `/api/instances/:id/attachments`              | `GET`           | Refresh full attachment mirror                    |
| `/api/instances/:id/active-runs`              | `GET`           | Reconcile active dashboard runs for this instance |
| `/api/instances/:id/revoke`                   | `POST`          | Revoke active refresh chains for unpair           |
| `/api/runners/:id` or equivalent status route | `GET`           | Validate runner-to-instance binding               |

### Internal dashboard endpoints

| Endpoint                              | Method | Purpose                                    |
| ------------------------------------- | ------ | ------------------------------------------ |
| `/internal/instances/:id/dispatch`    | `POST` | Deliver or queue assignment                |
| `/internal/instances/:id/cancel`      | `POST` | Deliver cancel or purge pending assignment |
| `/internal/instances/:id/decisions`   | `POST` | Queue and deliver dashboard decision       |
| `/internal/instances/:id/attachments` | `POST` | Push full attachment mirror                |

### Authentication rules

1. Pairing token is one-time and short-lived.
2. Refresh tokens are:
   - long-lived;
   - single-use;
   - bound to fingerprint;
   - rotated on every successful refresh.
3. Access tokens are short-lived and must identify exactly one `instanceId`.
4. Socket upgrade must reject path/token instance mismatch.
5. Internal dashboard calls require a service token distinct from CLI access tokens.

## 5. Pairing Lifecycle

### Required states

| State      | Meaning                                        |
| ---------- | ---------------------------------------------- |
| `pending`  | Pairing token exists and may still be consumed |
| `consumed` | Pairing created an instance                    |
| `expired`  | Pairing token TTL elapsed                      |

### Required behavior

1. Pairing creates an instance identity and initial refresh-token chain.
2. The dashboard may attach zero or more runners as part of pairing.
3. The response must advertise:
   - minimum supported CLI version when applicable;
   - acknowledged capability set.
4. The CLI must persist the returned instance identity before treating itself as paired.
5. Re-pairing semantics for the same physical host must be explicit in future revisions:
   - either create a replacement instance;
   - or resume an existing one;
   - but never leave that behavior implicit.

## 6. Instance Lifecycle

### Logical states

| State            | Meaning                                          |
| ---------------- | ------------------------------------------------ |
| `paired_offline` | Instance exists, but no current heartbeat/socket |
| `online`         | Recent heartbeat/socket activity                 |
| `revoked`        | Refresh chain invalidated                        |

`idle` may remain a UI/read-model refinement, but the protocol should not require clients to infer execution semantics from it.

### Heartbeat

- CLI sends `ping`.
- Dashboard responds `pong`.
- Dashboard records liveness at a throttled cadence.
- Lack of heartbeat past the configured stale window makes the instance unavailable for new dispatch.

## 7. Runner and Attachment Lifecycle

1. A runner may be attached to at most one instance at a time.
2. An instance may host multiple runner attachments.
3. Dashboard is source of truth for attachments.
4. CLI stores only a mirror.
5. `attachments.changed` uses full-list replace semantics.
6. Reconnect reconciliation must include a full attachments fetch before the CLI claims its local mirror is current.

## 8. Dispatch Lifecycle

### Desired states

| State                    | Meaning                                           |
| ------------------------ | ------------------------------------------------- |
| `queued_capacity`        | Waiting for org/runner capacity                   |
| `queued_instance`        | Waiting for paired instance connectivity          |
| `sent`                   | Assignment delivered over control plane           |
| `received`               | CLI has received the assignment                   |
| `accepted_for_execution` | CLI has capacity and intends to execute           |
| `running`                | Execution started                                 |
| terminal                 | Completed, failed, cancelled, rejected, timed out |

### Required behavior

1. Dashboard performs queue admission and lease acquisition before dispatch.
2. CLI must explicitly communicate whether a delivered assignment is:
   - merely received;
   - accepted for execution;
   - rejected.
3. Dashboard must not mark a run `running` solely because a frame was delivered.
4. Assignment rejection must be represented as a first-class control outcome, not inferred from a later event stream.
5. If the instance is offline, dispatch remains queued for instance availability unless cancellation removes it first.

## 9. Workflow Execution Semantics

### Run spec

The dashboard owns the requested run shape; the CLI owns execution realization.

The run spec may include:

- prompt
- target project directory
- workflow reference/source/version
- harness
- environment overrides
- timeout
- session continuation identifiers
- compatibility callback credentials

### Workflow resolution

1. Dashboard identifies the intended workflow and version.
2. CLI resolves locally.
3. If absent and installation is allowed, CLI installs from the declared source/version.
4. If the workflow cannot be resolved or installed, the assignment terminates as execution failure.

### Variable precedence

The intended precedence should be explicit:

1. workflow defaults
2. runner vars
3. dispatch overrides
4. resolved secrets

Current remote dispatch does not yet apply secrets; that is a known implementation gap, not the desired protocol.

## 10. Concurrency Rules

1. Dashboard is authoritative for org and runner dispatch concurrency.
2. CLI must advertise or negotiate runtime capacity if it can reject work after dashboard queue admission.
3. Until negotiation exists, dashboard and CLI local caps must be treated as two different controls:
   - dashboard cap protects global policy;
   - CLI cap protects the machine.
4. A CLI-local capacity rejection must be visible as a protocol outcome that returns the run to a defined dashboard state.

## 11. Event Streaming

### Canonical channel

`FeedEvent` is the canonical paired-session publication model.

`feed_event` is the paired-session transport for that model. The CLI-side
`PairedFeedPublisher` owns durable persistence, transport framing, ACK
consumption, and retry timing behind a `FeedEvent`-level interface.

Required properties:

- stable `eventId`
- canonical `feedSeq`
- idempotent ingest
- durable retry from CLI until ACK
- dashboard ACK only after accept-or-dedupe

### Ordering and delivery guarantees

| Property      | Contract                                                  |
| ------------- | --------------------------------------------------------- |
| Delivery      | At least once from CLI to dashboard                       |
| Deduplication | By `(instanceId, eventId)`                                |
| Display order | By canonical session sequence, not delivery attempt order |
| ACK meaning   | Event is durably accepted or identified as duplicate      |

### Compatibility channel

`run_event` and the per-run stream may continue temporarily as compatibility
adapters, but:

- they are not the canonical session feed;
- their retention and replay rules must be documented separately;
- future implementations should not require consumers to merge two canonical streams.

## 12. Decision and Approval Handling

### Lifecycle

| State      | Meaning                                                      |
| ---------- | ------------------------------------------------------------ |
| `queued`   | Dashboard created decision, CLI not yet acknowledged receipt |
| `received` | CLI durably stored the decision                              |
| `consumed` | Runtime read/applied the decision locally                    |

### Required behavior

1. Dashboard sends `dashboard_decision` addressed by `(athenaSessionId, requestId)`.
2. CLI stores durably before sending `decision_ack`.
3. Dashboard retries until ACK.
4. Runtime consumption is a distinct local action and should not be conflated with delivery ACK.
5. Reconnect must replay unacknowledged decisions.

## 13. Reconnect and Recovery

On reconnect, the protocol should converge through:

1. token refresh;
2. socket establishment;
3. attachment mirror refresh;
4. replay of pending assignments;
5. replay of pending decisions;
6. paired feed reconnect drain;
7. active-run reconciliation.

Flows that intentionally remain best effort must be called out explicitly. `attachments.changed` may remain best-effort only because step 3 exists.

## 14. Failure Taxonomy

| Class                | Examples                                                  | Owner                |
| -------------------- | --------------------------------------------------------- | -------------------- |
| auth failure         | invalid pair token, expired refresh, fingerprint mismatch | dashboard            |
| protocol failure     | malformed frame, unknown frame, instance mismatch         | receiver             |
| admission failure    | org cap, runner cap, local capacity rejection             | dashboard and/or CLI |
| execution failure    | invalid run spec, missing workflow, harness failure       | CLI                  |
| transport failure    | socket drop, timeout, reconnect exhaustion                | both                 |
| liveness failure     | stale instance, start timeout                             | dashboard reconciler |
| cancellation failure | deadline exceeded                                         | dashboard reconciler |

Every failure should map to:

- a stable machine-readable code;
- a human-readable summary;
- a terminal or retryable classification.

## 15. Versioning and Compatibility

1. Pair response advertises minimum supported CLI version and acknowledged capabilities.
2. Frame additions must be backward compatible unless a negotiated capability says otherwise.
3. Unknown optional fields in `runSpec` must be ignored.
4. Unknown required frame types must fail explicitly, not silently.
5. Token carriage variants may remain accepted during migration, but one preferred form should be documented for new clients.
6. Compatibility transports such as legacy `run_event` should have:
   - support window;
   - retirement criteria;
   - test coverage until removal.

## 16. Intended State Tables

### Instance

| From            | Event              | To             |
| --------------- | ------------------ | -------------- |
| none            | pairing consumed   | paired_offline |
| paired_offline  | socket + heartbeat | online         |
| online          | stale timeout      | paired_offline |
| any non-revoked | revoke             | revoked        |

### Dispatch

| From                   | Event                           | To                      |
| ---------------------- | ------------------------------- | ----------------------- |
| queued_capacity        | lease acquired                  | queued_instance or sent |
| queued_instance        | socket available                | sent                    |
| sent                   | CLI receipt ACK                 | received                |
| received               | CLI capacity acceptance         | accepted_for_execution  |
| accepted_for_execution | executor starts                 | running                 |
| received               | CLI rejects                     | rejected                |
| running                | completion/error/cancel/timeout | terminal                |

### Decision

| From     | Event                   | To       |
| -------- | ----------------------- | -------- |
| queued   | CLI durable receipt ACK | received |
| received | runtime consumes        | consumed |

## 17. Current Compatibility Notes

The following are current-state realities, not the target shape:

1. Existing code uses `assignment_accepted` for receipt only.
2. Existing code uses a single `queued` dashboard state for both capacity and offline-instance waiting.
3. Existing code still carries per-run callback stream credentials.
4. Existing code uses Athena-named identifiers throughout the wire contract.

These should remain supported until migration work closes the gaps listed in `protocol-gap-analysis.md`.
