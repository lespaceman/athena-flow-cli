# Runtime-Dashboard Protocol Gap Analysis

Status: comparison of current implementations  
Last reviewed: 2026-05-17

## Summary

The CLI and dashboard largely agree on the shipped path:

- the dashboard owns pairing, runner attachments, queue admission, and persisted run/session read models;
- the paired CLI owns local execution and durable feed publication;
- the long-lived instance socket is the control channel;
- `FeedEvent` is now the canonical paired-session publication model.
- `feed_event` is the paired-session transport for that model.

The largest remaining gaps are not missing endpoints. They are mixed generations of the protocol, duplicate notions of concurrency, and several lifecycle acknowledgements whose meaning is weaker than their names imply.

## Matching Assumptions

| Topic                     | Matching current assumption                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| Pairing                   | One-time token creates one remote instance and one refresh-token chain.     |
| Fingerprint               | Refresh is bound to a stable local fingerprint.                             |
| Attachment ownership      | Dashboard is source of truth; CLI mirrors attachments.                      |
| Dispatch owner            | Dashboard creates runs and sends assignments; CLI executes them.            |
| Canonical event stream    | `FeedEvent` is the paired-session source of truth; `feed_event` carries it. |
| Decision retry            | Dashboard retries until CLI delivery ACK; CLI persists after receipt.       |
| Offline instance behavior | Dashboard may queue assignments/decisions until reconnect.                  |
| Workflow refs             | Dashboard sends workflow identity; CLI resolves/installs locally.           |

## Mismatched Assumptions

| Area               | CLI view                                                                | Dashboard view                                                                                                    | Risk                                                                                          |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Concurrency        | Local daemon defaults to one active run per runner key.                 | Dashboard enforces runner/org leases, then expects remote dispatch to proceed.                                    | Dashboard can deliver work the CLI rejects after queue admission.                             |
| Assignment ACK     | CLI emits `assignment_accepted` immediately on receipt.                 | Dashboard currently treats it as informational only.                                                              | Name suggests acceptance/capacity confirmation but does not mean that.                        |
| Run streaming      | CLI keeps per-run stream and `run_event` behind compatibility adapters. | Dashboard now treats `feed_event` as canonical paired-session transport while still minting callback credentials. | Compatibility transports remain, but transport selection is no longer spread through callers. |
| Attachment refresh | CLI relies on push plus local mirror.                                   | Dashboard drops `attachments.changed` while offline and expects refetch on reconnect.                             | Reconnect refetch is an implied requirement, not a fully explicit handshake.                  |
| Re-pairing         | CLI persists one local pairing config.                                  | Dashboard always creates a new instance row on successful pair.                                                   | No documented replacement/recovery semantics for the same physical machine.                   |

## Implicit Contracts

1. `decision_ack` means "stored in the CLI inbox", not "runtime applied the decision".
2. `feed_ack` means Convex accepted or deduplicated the event, not that UI consumers rendered it.
3. `deliverySeq` is a local outbox cursor; `feedSeq` is the canonical feed sequence carried inside the envelope.
4. `runnerId` on `job_assignment` is routing metadata, not authority to execute when the run spec is invalid.
5. Access-token refresh must serialize because refresh tokens rotate on every use.
6. Local daemon liveness is not identical to dashboard instance liveness; the dashboard infers liveness from heartbeat age.
7. A dashboard run may be queued for either capacity reasons or instance unavailability, both currently represented under `queued`.

## Naming Inconsistencies

| Current names                                            | Issue                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `athenaSessionId`, `Athena`, `Athenaflow` leftovers      | Brand/product naming is mixed with Drisp-facing protocol terminology.                  |
| `assignment_accepted`                                    | Means "received", not "accepted for execution".                                        |
| `remoteInstances` vs "paired instance"                   | Storage name and product name differ.                                                  |
| `run_event` vs `feed_event`                              | Both sound canonical; only one currently is for paired sessions.                       |
| `sessionId`, `athenaSessionId`, `adapterResumeSessionId` | Three session identifiers travel in one remote run spec without a single naming guide. |

## Missing or Weak Lifecycle States

### Pairing / instance

- No explicit `replaced`, `superseded`, or `re-paired` state for machines that pair again.
- `online` and `idle` exist in storage, but the protocol does not define transitions as a contract.

### Dispatch

- No distinct wire-level state for:
  - received
  - capacity accepted
  - execution started
- `assignment_accepted` currently collapses those distinctions.

### Session/run

- Dashboard run lifecycle and CLI local assignment lifecycle overlap but are not formally linked.
- `queued` overloads:
  - concurrency waiting
  - awaiting offline instance

### Decisions

- Dashboard tracks `queued`/`delivered`/`failed`.
- CLI tracks `received`/`consumed` locally.
- There is no cross-system notion of "applied".

## Ambiguous Ownership Boundaries

| Boundary              | Current ambiguity                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Concurrency           | Dashboard admission and CLI local cap can both reject work. No authoritative precedence is documented.                              |
| Workflow installation | Dashboard selects workflow ref/version; CLI may install missing content at execution time.                                          |
| Terminal status       | Dashboard can finalize from feed semantics, per-run stream terminal frames, liveness reconciliation, or cancellation expiry.        |
| Retry responsibility  | Durable feed retry is CLI-owned; assignment retry is dashboard-owned; per-run stream retry is CLI-owned but through a dashboard DO. |

## Unsupported but Expected Flows

1. Negotiated concurrency where dashboard dispatch cap equals runtime capacity.
2. Explicit assignment rejection ACK understood by the dashboard before moving a run to `running`.
3. Formal reconnect sync for:
   - attachments;
   - active assignments;
   - pending decisions.
4. Re-pairing or replacing a paired machine without orphaning old instance rows.
5. Version negotiation beyond `requiredCliVersion` at pair time.
6. One documented terminal-status precedence rule when multiple failure paths race.

## Backward-Compatibility Concerns

1. Older dashboards may omit:
   - `runnerId`
   - `capabilityAck`
   - newer feed/decision frames
2. Older CLIs may only understand `run_event` and legacy instance-socket behavior.
3. Access-token transport accepts:
   - bearer header
   - query token
   - raw subprotocol
   - `token.<jwt>` subprotocol
4. `runSpec` is intentionally opaque, so field additions are tolerated but not strongly negotiated.
5. Removing callback stream credentials too early would break CLIs that still rely on per-run stream durability.

## Recommended Follow-Up Issues

1. Define assignment admission semantics and split `received` from `accepted_for_execution`.
2. Decide the single source of truth for runtime capacity and expose it in protocol negotiation.
3. Publish a retirement plan for compatibility event transports (`run_event` and the per-run stream).
4. Add explicit reconnect synchronization requirements for attachments, active runs, and pending decisions.
5. Specify re-pair/replacement behavior for the same physical machine.
6. Publish an identifier glossary covering dashboard run id, Athena session id, adapter resume id, feed event id, and delivery sequence.
7. Define terminal-status precedence and idempotency rules across feed finalization, run-stream finalization, cancellation, and reconciliation.
