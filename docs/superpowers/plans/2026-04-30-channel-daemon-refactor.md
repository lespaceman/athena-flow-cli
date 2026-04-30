# Channel Daemon Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-session channel subprocesses with one per-machine channel daemon that routes Telegram verdicts, answers, and notifications by `session_id`.

**Architecture:** `ChannelRegistry` remains session-local for relay ownership, but attaches to a process-global daemon client instead of spawning Telegram directly. A new daemon process listens on `~/.athena/run/channel-<name>.sock`, owns the Telegram poller, tracks connected sessions, and forwards every method/event through the existing channel protocol with `session_id` added to all messages.

**Tech Stack:** TypeScript, Node `net` Unix sockets, Vitest, existing NDJSON channel protocol.

---

### Task 1: Session-Scoped Protocol

**Files:**

- Modify: `src/channels/types.ts`
- Modify: `src/channels/protocol.ts`
- Modify: `src/channels/protocol.test.ts`

- [ ] Add `session_id: string` to every `ChannelMethodMessage` and every `ChannelEventMessage`.
- [ ] Update protocol validators to require a non-empty `session_id` for all messages.
- [ ] Update protocol tests so old messages without `session_id` fail and valid messages with `session_id` pass.

### Task 2: Daemon Socket Client

**Files:**

- Create: `src/channels/daemonPaths.ts`
- Create: `src/channels/daemonClient.ts`
- Create: `src/channels/daemonClient.test.ts`
- Modify: `src/channels/index.ts`

- [ ] Add a socket path helper returning `~/.athena/run/channel-<name>.sock`.
- [ ] Add a `ChannelDaemonClient` that connects to the socket, frames NDJSON, parses channel events, and sends session-scoped method messages.
- [ ] If attach fails, spawn the daemon process once, then retry attach.
- [ ] Track active clients in a module-level registry keyed by channel name, so one session creates one socket connection per channel while the daemon remains process-independent.

### Task 3: Daemon Server Entry

**Files:**

- Create: `src/channels/daemon.ts`
- Modify: `tsup.config.ts`
- Modify: `package.json`

- [ ] Add a `channel-daemon` build entry and package file.
- [ ] Implement a Unix socket server that removes stale socket files only after a failed connection probe.
- [ ] Support `session.attach`, `session.detach`, channel method forwarding, and session-scoped event fanout.
- [ ] Keep the daemon alive after last detach, then shut down after an idle timeout.

### Task 4: Telegram Multi-Session Routing

**Files:**

- Modify: `src/channels/telegram/index.ts`
- Modify: `src/channels/telegram/verdict.ts`
- Modify: `src/channels/telegram/verdict.test.ts`

- [ ] Store pending Telegram prompts by `session_id` and `channel_request_id`.
- [ ] Include `session_id` on every Telegram event emitted to the daemon.
- [ ] Preserve button and reply parsing by request id, resolving to the right session before emitting the event.
- [ ] Show enough session context in `/status` for duplicate request ids across sessions.

### Task 5: Registry Migration

**Files:**

- Modify: `src/channels/registry.ts`
- Modify: `src/channels/registry.test.ts`
- Modify: `src/app/providers/RuntimeProvider.tsx`
- Modify: `src/app/providers/useFeed.ts`

- [ ] Pass `athenaSessionId` into `ChannelRegistry`.
- [ ] Replace `ChannelHost` usage with daemon clients.
- [ ] Add `session_id` to every method sent by the registry.
- [ ] Ignore inbound daemon events whose `session_id` does not match the registry session.
- [ ] Detach sessions on registry dispose without shutting down the daemon immediately.

### Task 6: Verification

**Files:**

- Run tests only.

- [ ] Run `npm test -- --run src/channels/protocol.test.ts`.
- [ ] Run `npm test -- --run src/channels/registry.test.ts src/channels/daemonClient.test.ts`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
