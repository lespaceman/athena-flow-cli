# Channels Code Review — Issue Tracker

Status legend: ⬜ open · 🔄 in progress · ✅ done · ⏭️ skipped (with reason)

Triage order: C1→C9 (security/DoS) → H1 (dead code) → H2/H3/H6/H7/H11 (lifecycle) → H10/H13/M9/M11/M13/M18 (Telegram robustness) → M16/M17 (tests).

## Critical

| ID  | File                                                    | Issue                                                         | Status | Notes                                                                                                                                             |
| --- | ------------------------------------------------------- | ------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `src/channels/daemon.ts:336–340`                        | UDS socket file inherits umask perms; chmod 0600 after listen | ✅     |                                                                                                                                                   |
| C2  | `src/channels/daemon.ts:158–193`                        | No peer auth; any local proc can fabricate verdicts           | ✅     | shared-secret token via `~/.athena/run/channel-<name>.token` (0600); auth handshake required before any method                                    |
| C3  | `src/channels/daemon.ts:250–253`                        | `writeToChild` lacks try/catch — EPIPE crashes daemon         | ✅     |                                                                                                                                                   |
| C4  | `src/channels/daemon.ts:220–228`                        | Child stderr broadcast may leak bot token                     | ✅     | redact `/bot<token>/`                                                                                                                             |
| C5  | `src/channels/daemon.ts:248`, `daemonClient.ts:133–141` | Bot token transits UDS in init                                | ✅     | secret keys (`bot_token`) stripped from init params; passed to daemon via `ATHENA_CHANNEL_SECRETS` env and re-injected before forwarding to child |
| C6  | `src/channels/daemonPaths.ts:4`                         | `safeChannelName` allows empty/dot                            | ✅     |                                                                                                                                                   |
| C7  | `src/channels/telegram/index.ts:127–142`                | Forum-mode state file world-readable                          | ✅     | mode 0700/0600                                                                                                                                    |
| C8  | `src/channels/telegram/verdict.ts:79–98`                | `JSON.parse` no size cap                                      | ✅     | 8 KB cap                                                                                                                                          |
| C9  | `src/channels/protocol.ts` (LineReader)                 | Unbounded NDJSON line buffer                                  | ✅     | 1 MB cap, pre-concat check                                                                                                                        |

## High

| ID  | File                                              | Issue                                                | Status | Notes                                                                     |
| --- | ------------------------------------------------- | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| H1  | `src/channels/host.ts`                            | Dead code (unused)                                   | ✅     | deleted                                                                   |
| H2  | `src/channels/daemon.ts:308–321`                  | Idle-exit race vs new connect                        | ✅     | server.close first                                                        |
| H3  | `src/channels/daemon.ts:122–167`                  | Multi-line first chunk + shutdown desyncs state      | ✅     | per-socket `LineReader` via WeakMap; cleared on shutdown                  |
| H4  | `src/channels/daemon.ts`                          | Broadcasts during detached window lost silently      | ✅     | doc comment on detached-window contract                                   |
| H5  | `src/channels/registry.ts:326`                    | Mismatched session_id events silently dropped        | ✅     | logError on drop                                                          |
| H6  | `src/channels/daemonClient.ts:127–131`            | Start failure invisible — req hangs to TTL           | ✅     | onChannelUnavailable callback                                             |
| H7  | `src/channels/daemonClient.ts`                    | `dispose()` race with in-flight `start()`            | ✅     | recheck after connect()                                                   |
| H8  | `permissionRelay.ts:71–79`, `registry.ts:168–170` | `setOnClaimed`/`setOnChatMessage` overwrite silently | ✅     | throws in non-prod, added `clearOnClaimed()`                              |
| H9  | `src/channels/registry.ts`                        | `setOnClaimed` not detached on dispose               | ✅     | dispose clears relay handlers                                             |
| H10 | `src/channels/telegram/index.ts:80–83`            | `cancelDuringSend`/`inFlightSends` leak on crash     | ✅     | `sendAndTrack` try/finally always cleans `inFlightSends`                  |
| H11 | `src/channels/daemon.ts:229–239`                  | Subprocess crash → all sessions silent forever       | ✅     | `child.on('exit')` → `process.exit(1)` so client sees ENOENT and resparks |
| H12 | `src/channels/daemon.ts`                          | `fanoutEventToSessions` iterates live Map            | ✅     | snapshot keys + sockets                                                   |
| H13 | `src/channels/registry.ts`                        | `permission.request` body not length-clamped         | ✅     | rebuilds with truncated preview if total > 4096-margin                    |
| H14 | `src/channels/telegram/index.ts:179–192`          | `/cancel <args>` silently ignored                    | ✅     | regex now accepts trailing args                                           |
| H15 | `src/channels/telegram/markdown.ts`               | Markdown escaping not fuzzed                         | ✅     | 8 fuzz tests added (lone markers, control chars, empty, …)                |
| H16 | `src/channels/telegram/verdict.ts:62`             | ID regex `i` flag accepts uppercase out-of-alphabet  | ⏭️     | False positive on review — `[a-km-z]/i` correctly excludes L. Reverted.   |

## Medium

| ID  | File                                            | Issue                                                                | Status | Notes                                                                    |
| --- | ----------------------------------------------- | -------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| M1  | `src/channels/feedEvents.ts`                    | Drift risk against core/feed types                                   | ✅     | new `feedEvents.test.ts` constructs every variant                        |
| M2  | `src/channels/registry.ts`                      | God object (~480 LOC)                                                | ⬜     | split                                                                    |
| M3  | `src/channels/registry.ts:424–477`              | Accepts `multi_select` and `multiSelect`                             | ✅     | dropped legacy alias; harness emits `multiSelect`                        |
| M4  | `host.ts:142`, `daemonClient.ts:91`             | `truncate` duplicated                                                | ✅     | host.ts deleted; only `daemonClient.ts` retains it                       |
| M5  | `src/channels/registry.ts:184–193`              | Question relay optional, permission required (asymmetric)            | ⬜     |                                                                          |
| M6  | relays                                          | `PENDING_TTL_MS` / `SWEEP_INTERVAL_MS` duplicated                    | ✅     | extracted to `relayConstants.ts`                                         |
| M7  | `src/channels/registry.ts:26`                   | `MAX_NOTIFICATION_LEN` is Telegram-specific                          | ✅     | dropped — wire caps now belong to channels                               |
| M8  | `src/channels/telegram/markdown.ts`             | Table separators ignore alignment colons                             | ✅     | doc comment on `TABLE_SEPARATOR_RE`                                      |
| M9  | `src/channels/telegram/index.ts`                | `sendAndTrack` race in cancel ordering                               | ✅     | folded into H10 fix; `pendingMessages.set` before `inFlightSends.delete` |
| M10 | `src/channels/telegram/bot.ts:97`               | Polling offset in-memory only                                        | ✅     | `persistedOffset` field; saved every 10 updates + on shutdown            |
| M11 | `src/channels/telegram/bot.ts:340–344`          | Ignores `retry_after`                                                | ✅     | parsed from response body, sleeps on 429                                 |
| M12 | `bot.ts`                                        | No exponential backoff on transient errors                           | ✅     | `consecutiveErrors`-driven 1.5s→30s cap                                  |
| M13 | `bot.ts` getUpdates                             | No AbortController on long-poll                                      | ✅     | AbortController with `(pollTimeoutSec+5)*2*1000` cap                     |
| M14 | `src/channels/daemon.ts`                        | `writeToChild` silent on dead child                                  | ✅     | reports back to origin or broadcast                                      |
| M15 | `src/channels/daemon.ts`                        | `fanoutEventToSessions` exported only for tests                      | ✅     | @internal JSDoc                                                          |
| M16 | tests                                           | Untested: `host.ts`, `config.ts`, `daemonPaths`, telegram/index, bot | ✅     | new `config.test.ts` + `daemonPaths.test.ts`                             |
| M17 | tests                                           | No test for `loadChannelConfig` perm rejection                       | ✅     | covered in `config.test.ts` (0644, 0640)                                 |
| M18 | `src/channels/registry.ts`                      | Truncation before MarkdownV2 escape may exceed 4096                  | ✅     | clampToTelegramLimit applied to notify; permission body rebuilt          |
| M19 | `src/app/providers/RuntimeProvider.tsx:102–116` | Memo deps may not be stable                                          | ✅     | verified: `[runtime, channelDefs, athenaSessionId]` correct              |
| M20 | `src/app/shell/AppShell.tsx:906–911`            | `channelLabelSentRef` lifetime assumption                            | ✅     | inline doc comment                                                       |
| M21 | `src/ui/feed/useFeed.ts:558–562`                | Notify-on-agent.message filter untested                              | ✅     | new `useFeedChannelNotify.test.ts` (3 tests)                             |
| M22 | `AppShell.tsx`                                  | Single-slot chat queue silently overwrites                           | ✅     | inline doc comment                                                       |

## Low / Nits

| ID  | File                        | Issue                              | Status |
| --- | --------------------------- | ---------------------------------- | ------ | -------------------------------------------------------------------- |
| L1  | `host.ts`                   | `'legacy'` literal                 | ⏭️     | host.ts removed (no longer applicable)                               |
| L2  | `protocol.ts:43–48`         | `Object.entries` preferable        | ✅     | `Object.values(v).every(...)`                                        |
| L3  | `daemon.ts:82–93`           | `Number('30s')` silently default   | ✅     | warns when env value is invalid                                      |
| L4  | `daemon.ts:138–142,147–152` | `'unknown'` magic string           | ✅     |
| L5  | `daemonClient.ts:46–47`     | retry constants undocumented       | ✅     | doc comment on attach budget                                         |
| L6  | misc                        | `'…'` vs `'...'`                   | ✅     | unified to `…`                                                       |
| L7  | `bot.ts:128–130`            | `as unknown as {stopped}` cast     | ✅     | `isStopped()` getter                                                 |
| L8  | `bot.ts:140–152`            | "after 3 attempts" log imprecise   | ✅     | per-attempt log + final throw msg includes count                     |
| L9  | `markdown.ts:53–56`         | Sentinel collision risk            | ✅     | input control-char strip in `agentMarkdownToTelegramV2`              |
| L10 | `markdown.ts:223`           | Control chars bypass escape        | ✅     | same input strip                                                     |
| L11 | `verdict.ts:113–125`        | recomputes trim                    | ⏭️     | False positive — single-pass already                                 |
| L12 | `verdict.ts:153–156`        | ternary → table lookup             | ✅     | CB_VERDICT lookup table                                              |
| L13 | `registry.ts:412–422`       | `200` magic                        | ✅     | INPUT_PREVIEW_MAX_CHARS const                                        |
| L14 | `registry.ts:46–69`         | reason\* fns near-duplicates       | ✅     | merged via CANCEL_REASON_BY_SOURCE table                             |
| L15 | `ChannelReady.version`      | unused                             | ⬜     |
| L16 | `telegram/index.ts:516–522` | unrate-limited debug logs          | ✅     | per-sender 60s throttle on unallowlisted-drop logs                   |
| L17 | `telegram/index.ts:1056`    | `markResolved` ignores edit errors | ⏭️     | by design — `bot.editMessageText` already debug-logs internally      |
| L18 | `telegram/index.ts:778–791` | concurrent cancel race             | ⏭️     | by design — last-cancel-wins via `cancelDuringSend` map              |
| L19 | `channels/index.ts`         | re-exports internal types          | ✅     | dropped `PendingRelay`/`PendingQuestionRelay` exports                |
| L20 | `types.ts:191–195`          | ClaimSource JSDoc cross-ref        | ✅     | `QuestionClaimSource` JSDoc references `ClaimSource`                 |
| L21 | `feedEvents.ts`             | tiny module fold                   | ⏭️     | kept separate — adds noise to large `types.ts`; clearer as own file  |
| L22 | `daemon.ts`                 | inline `fanoutEventToSessions`     | ⏭️     | already inlined in Round 2; kept exported for tests with `@internal` |
| L23 | misc                        | mixed comment styles               | ⏭️     | too vague — addressed organically as touched files                   |
| L24 | `markdown.ts`               | `TABLE_SEPARATOR_RE` flag comment  | ✅     | comment added in M8 round                                            |

## Cross-cutting

| ID  | Issue                                                 | Status |
| --- | ----------------------------------------------------- | ------ |
| X1  | `ChannelReady.version` not validated — no negotiation | ⬜     |
| X2  | No CLI debug surface for pending relay entries        | ⬜     |
| X3  | No structured telemetry for channel lifecycle         | ⬜     |

---

## Changelog

### Round 1 (security/lifecycle hardening)

- C1: chmod UDS socket 0600 after listen.
- C3: try/catch around `child.stdin.write`; reports back via origin socket or broadcast.
- C4: redact `/bot<token>/` in stderr broadcasts.
- C6: `safeChannelName` rejects empty / dot-only names.
- C7: telegram state file written with 0600, dir 0700.
- C8: 8 KB cap on `JSON.parse` in question-answer parser.
- C9: `LineReader` rejects payloads exceeding 1 MB before concat (prevents giant-chunk OOM).
- H1: deleted dead `host.ts` (no importers).
- H2: idle-exit closes server first so racing connects fail fast.
- H6: added `onChannelUnavailable` registry callback so start/exit failures can surface in UI.
- H7: dispose-race in `daemonClient.start()` — if disposed mid-await, abandon socket cleanly.
- H12: snapshot `sessions.keys()` and per-session `sockets` before fanout (mutation-safe).
- M14: `writeToChild` reports "channel subprocess unavailable" / write-failure back to originating socket.

### Round 3 (remaining criticals)

- C2: new `src/channels/auth.ts` — per-channel hex token persisted at `~/.athena/run/channel-<name>.token` (O_CREAT|O_EXCL, 0600). Daemon loads it on startup and rejects any frame on a new socket until it receives `{type:'auth',token}` matching (constant-time compare). Client sends the auth frame as the first write before init.
- C5: secret option keys (currently `bot_token`) are partitioned out of `init.params.options` on the host. Host hands them to the spawned daemon via `ATHENA_CHANNEL_SECRETS` env JSON; daemon reads & deletes the env var, then merges secrets into the first init's `options` before forwarding to the channel subprocess. Bot token never traverses UDS.

### Round 3 (next batch)

- H5: `handleEvent` now `logError`s on session_id mismatch instead of dropping silently.
- H8: relays + registry throw in non-prod when a handler is overwritten; added `clearOnClaimed()` so dispose paths can detach cleanly.
- H9: `ChannelRegistry.dispose()` clears relay handlers + chat handler before disposing clients.
- H13/M18: `buildPromptMarkdown` rebuilds with truncated preview when total exceeds Telegram's 4096-char cap (with safety margin for trailer); `notification` path runs `clampToTelegramLimit` on both rendered and fallback text.
- H14: `parseCommand` regex accepts and ignores trailing args, so `/cancel foo` cancels rather than falling through to chat.
- M11: `bot.call` parses `parameters.retry_after` from 429 bodies and surfaces as `err.retryAfterMs`; `poll` loop sleeps for the requested duration on 429.
- M13: `bot.call` runs every request under an `AbortController` with `(pollTimeoutSec + 5) * 2 * 1000` ms cap so a hung connection can't leak forever.
- L4: `UNKNOWN_SESSION_ID` constant (already added in Round 2).
- L6: `…` unified across `daemonClient.truncate`.
- L13: `INPUT_PREVIEW_MAX_CHARS = 200` extracted in `registry.ts`.

### Round 5 (cleanup batch)

- M3: dropped legacy `multi_select` alias in `extractQuestions`; harness emits `multiSelect` (camelCase) which is converted once to `multi_select` for the wire.
- M6: extracted `PENDING_TTL_MS` and `SWEEP_INTERVAL_MS` to `src/channels/relayConstants.ts`; both relays import from there.
- M7: removed `MAX_NOTIFICATION_LEN` from registry; `notify` now forwards verbatim. Wire-level caps belong to the channel (telegram already clamps via `clampToTelegramLimit`). Updated registry test accordingly.
- M15: `@internal` JSDoc on `fanoutEventToSessions` and `expandBroadcastEvent`.
- M20+M22: inline doc comments on `channelLabelSentRef` and `pendingChatRef` in `AppShell.tsx` explaining lifetime + single-slot semantics.
- M21: new `src/app/providers/__tests__/useFeedChannelNotify.test.ts` — pins root vs subagent scope filter, plus null-registry safety.
- L7: `TelegramBot.isStopped()` getter replaces the `as unknown as {stopped}` cast.
- L12: `CB_VERDICT` lookup table replaces the inline ternary in `buildPermissionCallbackData`.
- L14: collapsed `reasonForSource` and `reasonForQuestionSource` into a single `CANCEL_REASON_BY_SOURCE` lookup table with one helper accepting either union.
- L19: `channels/index.ts` no longer re-exports the internal `PendingRelay` / `PendingQuestionRelay` types.
- Skipped: L11 (false positive — `text.trim()` is single-pass), L22 (already inlined in Round 2).

### Round 4 (simplify pass)

- Added `src/shared/utils/env.ts` with `isDev()`; replaced 3 inline `process.env['NODE_ENV'] !== 'production'` checks across `permissionRelay.ts`, `questionRelay.ts`, `registry.ts`.
- Migrated `bot.ts` to `errorMessage()` — replaced 8 inline `err instanceof Error ? err.message : String(err)` patterns.
- Introduced `class TelegramApiError extends Error` (status + retryAfterMs); replaced ad-hoc `Error & {status?: number; retryAfterMs?: number}` cast with `instanceof` discriminator in the poll loop.
- Refactored `buildPromptMarkdown` with a single `render(preview)` closure — eliminated ~15 lines of duplicated line-assembly between optimistic and overflow paths.
- Skipped: BaseRelay abstraction (tracked in M2), shared truncate helper (semantics differ), shared AbortController timer (different deadlines).

### Round 2 (simplify pass)

- Added `src/shared/utils/errorMessage.ts`; replaced ~6 inline `instanceof Error` ternaries.
- Extracted `errorEvent(sid, msg, fatal?)` helper in `daemon.ts` — collapsed 12+ inline error envelopes.
- Extracted `UNKNOWN_SESSION_ID` constant; unified two phrasings of the "subprocess unavailable" message.
- Inlined `redactSecrets` (single call site).
- Simplified `daemon.start()`: removed defensive `process.exit(1)` around `chmodSync` (top-level main() catch handles it).
- Refactored `daemonClient.start()`: extracted `connect()` helper; flatter linear flow.
- Collapsed `routeEvent`/`broadcast` to share a `deliverToSession` helper.
- Inlined `writeToChild` error routing via local `report()` closure.
- Net diff after simplify: −27 lines vs. round 1 with same behaviour and 140/140 channel tests still passing.
