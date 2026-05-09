---
name: drisp-cli-context
description: Domain language for the drisp/cli workflow runtime — feed pipeline, harnesses, runs, and sessions.
type: project
---

# drisp/cli

Workflow runtime for AI coding harnesses (Claude Code, Codex). Intercepts harness hook events, normalizes them, persists them, and renders them in a terminal UI.

## Language

### Pipeline

**RuntimeEvent**:
A normalized harness event (one of ~30 kinds: `tool.pre`, `session.start`, `permission.request`, etc.) emitted by a harness adapter.
_Avoid_: hook event, raw event, protocol event.

**RuntimeDecision**:
A delayed answer from the user/controller that resolves a prior `RuntimeEvent` (e.g. permission grant). Correlated by `request_id`.

**FeedEvent**:
A timeline-ready event derived from one or more `RuntimeEvent`s. Carries `event_id`, `seq`, `run_id`, `session_id`, `actor_id`, `kind`, `data`.
_Avoid_: feed item (that's a UI projection of multiple `FeedEvent`s).

**FeedMapper**:
The module that converts `RuntimeEvent` → `FeedEvent[]` and `RuntimeDecision` → `FeedEvent`. Stateful: maintains run/session/actor/correlation state across the event stream. Bootstraps from stored events on resume.

### State inside the FeedMapper

The mapper is internally composed of four named seams; each owns one slice of the mapper's state and has its own test surface.

**RunLifecycle**:
Owns `currentSession`, `currentRun`, run/session sequence numbers, and per-run counters (tool uses, failures, permission requests, blocks). Decides when a run starts, ends, or rolls over.
_Avoid_: run state, session manager.

**ToolCorrelation**:
Owns the `tool_use_id → feed event_id` index, streamed-output accumulators, and truncation state. Knows how a `tool.pre` enables a later `tool.post`/`tool.failure`/`tool.delta`, and how to handle a missing pre.

**DecisionCorrelation**:
Owns the `request_id → event_id` indexes that let `mapDecision` find the originating event. Has explicit invariants about restore behavior (fresh runs clear indexes; old request*ids never recur).
\_Avoid*: request index, decision router.

**AgentMessageStream**:
Owns pending message buffers, dedup state per actor scope, and reasoning summary accumulation. Decides when an in-flight message is emittable.

### Identity

**Run**:
One agent invocation within a **Session**. Triggered by `session.start` or `user.prompt`. Has a status (`running` | `completed`), counters, and an actor tree.

**Session**:
A drisp instance lifecycle. Spans many **Runs**. Identified by an adapter session id from the harness.

**Actor**:
A participant in a **Run** — the root agent or a subagent. Subagents form a stack (LIFO).

## Relationships

- A **Session** contains many **Runs**.
- A **Run** is owned by one root **Actor**, which may spawn subagent **Actors**.
- A **RuntimeEvent** is mapped to zero or more **FeedEvent**s by the **FeedMapper**.
- A **RuntimeDecision** is mapped to one **FeedEvent** by the **FeedMapper**, correlated through **DecisionCorrelation**.
- The **FeedMapper** is composed of **RunLifecycle**, **ToolCorrelation**, **DecisionCorrelation**, and **AgentMessageStream** as internal seams. Their combined interface is the seven-method `FeedMapper` type.

## Example dialogue

> **Dev:** "When a `tool.post` arrives but `ToolCorrelation` has no matching pre, what does the **FeedMapper** emit?"
> **Domain expert:** "It emits a `tool.post` **FeedEvent** with a `cause` of `orphan`, because the missing-pre case is handled inside **ToolCorrelation** — the **FeedMapper** itself doesn't know what 'orphan' means."

## Flagged ambiguities

- "event" alone is ambiguous between **RuntimeEvent** and **FeedEvent** — always qualify.
- "session" alone is ambiguous between drisp **Session** and harness adapter session — say "adapter session" for the latter.
