# Claude Harness Gap Analysis

> Cross-reference of official Claude Code docs (hooks reference + headless/SDK) against what athena-cli actually implements in its harness layer. Each section independently verified by sub-agent code exploration.

Date: 2026-03-10
Status: **VERIFIED**

---

## 1. Hook Events: Typed but Never Translated (Dead Code)

**Verdict: VERIFIED**

Three hook events have TypeScript types in `src/harnesses/claude/protocol/events.ts`, are included in the `ClaudeHookEvent` union, and pass envelope validation in tests — but have **no case** in the `translateClaudeEnvelope()` switch in `eventTranslator.ts`. They fall through to `default: → kind: 'unknown'`:

| Hook Event               | Type                                 | Case in `eventTranslator.ts` | RuntimeEventKind   |
| ------------------------ | ------------------------------------ | ---------------------------- | ------------------ |
| **`InstructionsLoaded`** | `InstructionsLoadedEvent` (line 200) | **MISSING**                  | Falls to `unknown` |
| **`WorktreeCreate`**     | `WorktreeCreateEvent` (line 211)     | **MISSING**                  | Falls to `unknown` |
| **`WorktreeRemove`**     | `WorktreeRemoveEvent` (line 217)     | **MISSING**                  | Falls to `unknown` |

### Exact fields lost per event

All three inherit `BaseHookEvent` (`session_id`, `transcript_path`, `cwd`, `permission_mode?`).

**`InstructionsLoadedEvent`** (richest payload of the three):

| Field               | Type                                                                      | Required | Description                                    |
| ------------------- | ------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| `file_path`         | `string`                                                                  | yes      | Absolute path to the loaded instruction file   |
| `memory_type`       | `'User' \| 'Project' \| 'Local' \| 'Managed'`                             | yes      | Scope of the file                              |
| `load_reason`       | `'session_start' \| 'nested_traversal' \| 'path_glob_match' \| 'include'` | yes      | Why the file was loaded                        |
| `globs`             | `string[]`                                                                | no       | Path glob patterns from `paths:` frontmatter   |
| `trigger_file_path` | `string`                                                                  | no       | File whose access triggered this lazy load     |
| `parent_file_path`  | `string`                                                                  | no       | Parent instruction file that included this one |

**`WorktreeCreateEvent`**: `name: string` (slug identifier, e.g., `bold-oak-a3f2`)

**`WorktreeRemoveEvent`**: `worktree_path: string` (absolute path being removed)

### How `unknown` events surface in the UI

1. **Feed mapper** (`core/feed/mapper.ts:806-826`): maps to `kind: 'unknown.hook'`, `level: 'debug'`, `ui.collapsed_default: true`
2. **Title generation** (`core/feed/titleGen.ts:81`): renders as `? InstructionsLoaded` (question mark prefix)
3. **Timeline filtering** (`core/feed/timeline.ts:618`): `unknown.hook` is a member of `VERBOSE_ONLY_KINDS` — **hidden in normal mode**
4. **Detail rendering** (`ui/layout/renderDetailLines.ts:277`): shows raw hook name, no structured field rendering

**Net effect**: structured payload fields (`file_path`, `memory_type`, `load_reason`, `name`, `worktree_path`) are dumped into a raw `payload: unknown` field, invisible unless the user enables verbose mode and manually expands the event.

### Where these types are referenced

| File                                    | Usage                                             |
| --------------------------------------- | ------------------------------------------------- |
| `protocol/events.ts`                    | Type definitions + `ClaudeHookEvent` union member |
| `protocol/index.ts:32-34`               | Pure type re-exports via barrel                   |
| `protocol/hooks.test.ts:21-23, 324-355` | Shape conformance tests + envelope validation     |
| **Nowhere else**                        | No runtime code imports or consumes these types   |

### Test coverage gap

`hooks.test.ts` verifies that typed fixtures satisfy the TypeScript shapes and that the envelope validator accepts these event names. **No test verifies these events survive translation** — the test coverage stops at the protocol layer.

The sentinel test at `__sentinels__/unknown-hook-survival.sentinel.test.ts` confirms `unknown` events survive the full pipeline (mapper → store → persist → restore), making the gap invisible to CI.

### Fix required

Add `RuntimeEventKind` entries (`instructions.loaded`, `worktree.create`, `worktree.remove`) in `events.ts`, corresponding `RuntimeEventDataMap` entries, cases in `eventTranslator.ts`, `mapLegacyHookNameToRuntimeKind()`, and `FeedEventKind` entries in `feed/types.ts`.

---

## 2. RuntimeEventKind Has No Mapping for These 3 Events

**Verdict: VERIFIED**

The drop happens at **two independent layers**, confirming these events are completely invisible:

**Layer 1 — Harness (`eventTranslator.ts`)**: `translateClaudeEnvelope()` switch has no case for `InstructionsLoaded`, `WorktreeCreate`, or `WorktreeRemove`. All fall to `default` → `kind: 'unknown'`.

**Layer 2 — Core runtime (`events.ts`)**: `mapLegacyHookNameToRuntimeKind()` also has no case for these three. Falls to `default` → `'unknown'`.

### Complete RuntimeEventKind ↔ Claude Hook mapping table

| RuntimeEventKind     | Claude Hook Name      | Status                       |
| -------------------- | --------------------- | ---------------------------- |
| `session.start`      | `SessionStart`        | Mapped                       |
| `session.end`        | `SessionEnd`          | Mapped                       |
| `user.prompt`        | `UserPromptSubmit`    | Mapped                       |
| `tool.pre`           | `PreToolUse`          | Mapped                       |
| `tool.post`          | `PostToolUse`         | Mapped                       |
| `tool.failure`       | `PostToolUseFailure`  | Mapped                       |
| `permission.request` | `PermissionRequest`   | Mapped                       |
| `stop.request`       | `Stop`                | Mapped                       |
| `subagent.start`     | `SubagentStart`       | Mapped                       |
| `subagent.stop`      | `SubagentStop`        | Mapped                       |
| `notification`       | `Notification`        | Mapped                       |
| `compact.pre`        | `PreCompact`          | Mapped                       |
| `setup`              | `Setup`               | Mapped                       |
| `teammate.idle`      | `TeammateIdle`        | Mapped                       |
| `task.completed`     | `TaskCompleted`       | Mapped                       |
| `config.change`      | `ConfigChange`        | Mapped                       |
| `turn.start`         | _(none — Codex only)_ | Dead code for Claude path    |
| `turn.complete`      | _(none — Codex only)_ | Dead code for Claude path    |
| `message.delta`      | _(none — Codex only)_ | Internal streaming           |
| `plan.delta`         | _(none — Codex only)_ | Internal streaming           |
| `reasoning.delta`    | _(none — Codex only)_ | Internal streaming           |
| `usage.update`       | _(none — Codex only)_ | Internal metrics             |
| `unknown`            | _(fallback)_          | Catch-all                    |
| **MISSING**          | `InstructionsLoaded`  | **Gap — drops to `unknown`** |
| **MISSING**          | `WorktreeCreate`      | **Gap — drops to `unknown`** |
| **MISSING**          | `WorktreeRemove`      | **Gap — drops to `unknown`** |

### Bonus finding: Dead code in legacy mapper

`mapLegacyHookNameToRuntimeKind()` has cases for `TurnStart` → `turn.start` and `TurnComplete` → `turn.complete`, but Claude Code does not fire these hook events. These are dead code on the Claude path — only the Codex harness produces `turn.start`/`turn.complete` events.

---

## 3. Decision Mapper: Missing Output Fields

**Verdict: 8 of 9 sub-claims VERIFIED, 1 REFUTED**

The `decisionMapper.ts` constructs hook result JSON from `RuntimeIntent`, but is missing several decision fields Claude Code officially supports. The root cause: the `RuntimeIntent` union in `core/runtime/types.ts:79-85` is the single choke point — it defines only minimal fields for current use cases.

### Current intent-to-JSON mapping (complete)

| `RuntimeIntent.kind` | JSON stdout produced                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `permission_allow`   | `{hookSpecificOutput: {hookEventName: 'PermissionRequest', decision: {behavior: 'allow'}}}`                                           |
| `permission_deny`    | `{hookSpecificOutput: {hookEventName: 'PermissionRequest', decision: {behavior: 'deny', reason}}}`                                    |
| `question_answer`    | `{hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: {answers}, additionalContext: '...'}}` |
| `pre_tool_allow`     | `{hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'allow'}}`                                                    |
| `pre_tool_deny`      | `{hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason}}`                           |
| `stop_block`         | `{decision: 'block', reason}`                                                                                                         |

### Gap verification

| Decision Feature                          | Official Support                                             | Status                  | Detail                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `permission_allow` + `updatedInput`       | PermissionRequest `{behavior: 'allow', updatedInput: {...}}` | **VERIFIED MISSING**    | `RuntimeIntent` for `permission_allow` carries no `updatedInput` field. The protocol helper `createPermissionRequestAllowResult` in `result.ts:94-108` supports it, but `decisionMapper.ts` bypasses helpers and builds JSON inline — making it unreachable through the intent path. |
| `permission_allow` + `updatedPermissions` | Applies permanent permission rules                           | **VERIFIED MISSING**    | String `updatedPermissions` does not appear anywhere in `src/`. Completely unimplemented.                                                                                                                                                                                            |
| `permission_deny` + `interrupt: true`     | Stops Claude entirely on denial                              | **VERIFIED MISSING**    | `RuntimeIntent` for `permission_deny` is `{kind; reason: string}` — no `interrupt` field.                                                                                                                                                                                            |
| `pre_tool_allow` + `updatedInput`         | Modifies tool input before execution                         | **VERIFIED MISSING**    | `pre_tool_allow` intent has zero fields. Only `question_answer` (a separate intent) emits `updatedInput`.                                                                                                                                                                            |
| `pre_tool_allow` + `additionalContext`    | Injects context before tool runs                             | **VERIFIED MISSING**    | `additionalContext` only emitted in `question_answer` branch, not `pre_tool_allow`.                                                                                                                                                                                                  |
| `SubagentStop` blocking                   | Same top-level `{decision: 'block'}` format as Stop          | **REFUTED** — not a gap | The existing `stop_block` intent correctly handles both `Stop` and `SubagentStop` — both use the same `{decision: 'block', reason}` wire format. `interactionRules.ts` confirms `subagent.stop` has `canBlock: true`. No separate intent needed.                                     |
| `continue: false` + `stopReason`          | Universal halt across all events                             | **VERIFIED MISSING**    | Neither `continue`, `stopReason`, nor any equivalent exists in `src/`. No way to express "halt Claude entirely" independent of event type.                                                                                                                                           |
| `systemMessage`                           | Universal warning shown to user                              | **VERIFIED MISSING**    | Absent from entire `src/` tree.                                                                                                                                                                                                                                                      |
| `suppressOutput`                          | Hides stdout from verbose mode                               | **VERIFIED MISSING**    | Absent from entire `src/` tree.                                                                                                                                                                                                                                                      |

### Architectural root cause

`decisionMapper.ts` reads exclusively from `RuntimeIntent` fields to build JSON. The `RuntimeIntent` union defines only 6 variants with minimal fields. Any Claude wire-protocol field not modeled in the corresponding intent variant is structurally unreachable — even when the protocol helpers in `result.ts` already support it.

---

## 4. Unused/Underutilized Protocol Types

**Verdict: ALL VERIFIED + 2 additional types discovered**

Every type below is defined and exported from `protocol/events.ts` via the `protocol/index.ts` barrel, but no non-test file in `src/` imports them. The event translator reads all payload fields via bracket notation with `as string | undefined` casts, discarding the typed unions entirely.

| Type                           | Defined at      | Non-test imports | Runtime narrowing                                           | Verdict |
| ------------------------------ | --------------- | ---------------- | ----------------------------------------------------------- | ------- |
| `InstructionsLoadedEvent`      | `events.ts:200` | None             | Event falls to `default` in switch                          | Gap     |
| `WorktreeCreateEvent`          | `events.ts:211` | None             | Event falls to `default` in switch                          | Gap     |
| `WorktreeRemoveEvent`          | `events.ts:217` | None             | Event falls to `default` in switch                          | Gap     |
| `InstructionsMemoryType`       | `events.ts:61`  | None             | Field `memory_type` never read at runtime                   | Gap     |
| `InstructionsLoadReason`       | `events.ts:63`  | None             | Field `load_reason` never read at runtime                   | Gap     |
| `ConfigChangeSource`           | `events.ts:54`  | None             | Cast to `string` at `eventTranslator.ts:222`                | Gap     |
| `SessionEndReason`             | `events.ts:47`  | None             | Cast to `string` at `eventTranslator.ts:67`                 | Gap     |
| **`PermissionMode`** _(new)_   | `events.ts:29`  | None             | Cast to `string` at `eventTranslator.ts:75`, `mapper.ts:31` | Gap     |
| **`NotificationType`** _(new)_ | `events.ts:41`  | None             | Cast to `string` at `eventTranslator.ts:179`                | Gap     |

### Root cause

The translation layer uses `asRecord(envelope.payload)` followed by `payload['field'] as string | undefined` — deliberately discarding TypeScript's discriminated union types. The downstream `RuntimeEventDataMap` types everything as `string`, defining its own field semantics independently. The protocol types function as **wire documentation** but provide no compile-time safety downstream.

---

## 5. Headless `-p` Mode: Stream-JSON Features

**Verdict: PARTIALLY VERIFIED — 3 of 5 original claims were wrong**

### Correctly identified gaps

| Feature                      | Status               | Detail                                                                                                                                                                                                            |
| ---------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text_delta` streaming       | **VERIFIED MISSING** | `tokenAccumulator.ts` and `assistantMessageAccumulator.ts` only handle `type: "assistant"`, `type: "message"`, and `type: "result"`. Streaming `text_delta` events are received in stdout but silently discarded. |
| `input_json_delta` streaming | **VERIFIED MISSING** | Same — no file in `src/` references `input_json_delta`.                                                                                                                                                           |

### Incorrectly claimed as missing (actually wired)

| Feature                  | Status                      | Detail                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json-schema`          | **REFUTED** — flag is wired | Registered in `flagRegistry.ts:128` as `{field: 'jsonSchema', flag: '--json-schema', kind: 'jsonOrString'}`. Declared in `IsolationConfig` at `isolation.ts:123`. Will be passed to Claude when set. **Nuance**: `spawn.ts` hardcodes `--output-format stream-json`, but `--json-schema` requires `--output-format json` — so the flag is wired but may be ignored by Claude at runtime. |
| `--append-system-prompt` | **REFUTED** — flag is wired | Registered at `flagRegistry.ts:82`. `appendSystemPrompt?: string` on `IsolationConfig` at `isolation.ts:85`. The workflow system actively uses `--append-system-prompt-file` via `sessionPlan.ts`.                                                                                                                                                                                       |
| `--system-prompt`        | **REFUTED** — flag is wired | Registered at `flagRegistry.ts:80`. `systemPrompt?: string` on `IsolationConfig` at `isolation.ts:81`. Available to callers, just not used by the default `strict` preset.                                                                                                                                                                                                               |

### `--include-partial-messages` flag exists but is inert

The flag is registered at `flagRegistry.ts:130-133` and declared in `IsolationConfig`. When enabled, Claude CLI emits `text_delta` and `input_json_delta` events. However, **none of the three isolation presets** (`strict`, `minimal`, `permissive`) enable it, and even if a caller did, both accumulators would silently discard the events — confirming the parsing gap is real even though the flag passthrough exists.

### Complete CLI flags spawned by `spawnClaude()`

Base args (always): `claude -p <prompt> --output-format stream-json --settings <tmpfile> --setting-sources ""`

Conditional flags via `IsolationConfig` → `buildIsolationArgs()`:

`--mcp-config`, `--strict-mcp-config`, `--disallowedTools`, `--tools`, `--permission-mode`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--add-dir`, `--model`, `--fallback-model`, `--agent`, `--agents`, `--system-prompt`, `--system-prompt-file`, `--append-system-prompt`, `--append-system-prompt-file`, `--fork-session`, `--no-session-persistence`, `--verbose`, `--debug`, `--max-turns`, `--max-budget-usd`, `--plugin-dir`, `--disable-slash-commands`, `--chrome`, `--no-chrome`, `--json-schema`, `--include-partial-messages`

Session flags: `--resume <sessionId>` or `--continue`

### Accumulators: exact message type coverage

**`tokenAccumulator.ts`** handles 3 types:

| `type`                          | Extraction             | Action                                     |
| ------------------------------- | ---------------------- | ------------------------------------------ |
| `"assistant"` + `message.usage` | `parsed.message.usage` | Per-turn token accumulation                |
| `"message"` + `usage`           | `parsed.usage`         | Per-turn token accumulation                |
| `"result"` + `usage`            | `parsed.usage`         | Cumulative replacement (overwrites totals) |

**`assistantMessageAccumulator.ts`** handles 2 types:

| `type`                               | Action                                                |
| ------------------------------------ | ----------------------------------------------------- |
| `"assistant"`                        | Reads `content[]` text blocks, joins as `lastMessage` |
| `"message"` + `role === "assistant"` | Same extraction path                                  |

All other NDJSON event types (including all `stream_event` / delta types) are silently dropped by both parsers.

---

## 6. Session Management Gaps

**Verdict: ALL 3 CLAIMS VERIFIED + additional unused flags found**

### Verified claims

| Feature                 | Status                                  | Detail                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--continue`            | **VERIFIED** — supported                | Used as fallback when `isolationConfig.continueSession === true` and no explicit `sessionId`. Emitted at `spawn.ts:169`. Not wired through the `TurnContinuation` contract — it's a separate code path.                           |
| `--resume <session_id>` | **VERIFIED** — supported (primary path) | Full call chain: CLI `--continue[=<id>]` → `resolveContinueFlag()` → `TurnContinuation{mode: 'resume', handle}` → `resolveClaudeSessionId()` → `spawnClaude({sessionId})` → `args.push('--resume', sessionId)` at `spawn.ts:167`. |
| `CLAUDE_ENV_FILE`       | **VERIFIED** — not utilized             | Zero references in `src/`. Only in docs. Architecturally consistent: athena-cli hooks are forwarded via UDS, not through Claude Code's env file mechanism.                                                                        |

### Continuation contract details

`TurnContinuation` (`core/runtime/process.ts:3-6`) defines 3 modes:

| Mode            | Behavior                                         | Claude flag         |
| --------------- | ------------------------------------------------ | ------------------- |
| `fresh`         | New session, no ID                               | No session flag     |
| `resume`        | Resume by session ID                             | `--resume <handle>` |
| `reuse-current` | **Unsupported** — throws error in Claude harness | N/A                 |

Workflow loop behavior: first turn uses caller's continuation, then `nextContinuation` resets to `{mode: 'fresh'}` — workflow iterations always start new sessions.

### Additional unused Claude CLI flags

| Flag                       | Purpose                                 | In athena-cli? |
| -------------------------- | --------------------------------------- | -------------- |
| `--session-id <uuid>`      | Assign a specific UUID to a new session | Not used       |
| `--teleport`               | Web-to-local session transfer           | Not used       |
| `--worktree`               | Git worktree session isolation          | Not used       |
| `--permission-prompt-tool` | MCP-based permission handler            | Not used       |

---

## 7. Hook Handler Types & Injection Mechanism

**Verdict: VERIFIED — with correction to handler type count**

### Handler types

Claude Code supports **4** hook handler types: `command`, `http`, `prompt`, `agent`. athena-cli exclusively registers `type: "command"` handlers — this is architecturally correct since `command` is the only type that invokes an external process.

| Handler Type      | Used by athena-cli | Notes                                                                                      |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `type: "command"` | **Yes**            | The hook forwarder (`hook-forwarder.ts`) is registered as the command for every hook event |
| `type: "http"`    | N/A                | Claude sends HTTP POST internally — no external process invoked                            |
| `type: "prompt"`  | N/A                | Claude makes an LLM API call internally                                                    |
| `type: "agent"`   | N/A                | Claude spawns an internal subagent                                                         |

### Hook injection mechanism (complete)

**Step 1 — Settings generation**: `generateHookSettings()` in `hooks/generateHookSettings.ts:153` creates a `ClaudeSettings` JSON with `type: "command"` handlers for every Claude hook event, pointing at the `hook-forwarder.js` binary. Written to `os.tmpdir()/athena-hooks-<pid>-<timestamp>.json`.

**Step 2 — Full settings isolation**: `spawnClaude()` passes `--settings <tmpfile> --setting-sources ""` — this tells Claude Code to load **no standard settings sources** (user, project, local, managed). Only athena's generated hooks are active. No user-configured `prompt` or `agent` hooks can bleed in.

**Step 3 — Forwarder receives events**: When Claude fires a hook, it invokes the forwarder as a subprocess with event JSON on stdin. The forwarder:

1. Parses as `ClaudeHookEvent`
2. Sets timeout: 5 min for `PreToolUse`/`PermissionRequest`, 5 sec for everything else
3. Resolves socket: `<cwd>/.claude/run/ink-<ATHENA_INSTANCE_ID>.sock`
4. Wraps in `HookEventEnvelope` with `request_id` and sends via UDS as NDJSON
5. Waits for `HookResultEnvelope` back
6. Maps to Claude protocol: exit 0 (passthrough), exit 2 + stderr (block), exit 0 + JSON stdout (json_output)
7. If socket not found → exits 0 (passthrough) to avoid blocking Claude

**Step 4 — UDS server dispatches**: `server.ts` receives NDJSON, maps to `RuntimeEvent` via `mapEnvelopeToRuntimeEvent()`, emits to UI handlers, manages timeout auto-passthrough, receives decisions back via `sendDecision()`.

### Hook events registered by athena-cli

Tool events (`matcher: "*"`): `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PostToolUseFailure`

Non-tool events (no matcher — always fire): `Notification`, `Stop`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `PreCompact`, `Setup`

**Not registered**: `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `InstructionsLoaded`, `WorktreeCreate`, `WorktreeRemove` — these events are handled by the harness if they arrive, but athena-cli's generated settings don't register command hooks for them. They would only fire if the user had additional settings sources enabled.

---

## 8. Interaction Rules: `canBlock` and `expectsDecision`

**Verdict: ALL CLAIMS VERIFIED + critical findings about latent blocking**

### Complete interaction rules table (Claude harness)

Source: `src/harnesses/claude/runtime/interactionRules.ts`
Constants: `DEFAULT_TIMEOUT_MS = 4000`, `PERMISSION_TIMEOUT_MS = 300_000`

| Athena Kind          | Claude Hook          | `expectsDecision` | `defaultTimeoutMs` | `canBlock` | Official `canBlock` | Match?              |
| -------------------- | -------------------- | ----------------- | ------------------ | ---------- | ------------------- | ------------------- |
| `permission.request` | `PermissionRequest`  | **true**          | 300,000            | true       | Yes                 | CORRECT             |
| `tool.pre`           | `PreToolUse`         | **true**          | 300,000            | true       | Yes                 | CORRECT             |
| `stop.request`       | `Stop`               | **true**          | 4,000              | true       | Yes                 | CORRECT             |
| `tool.post`          | `PostToolUse`        | false             | 4,000              | false      | No                  | CORRECT             |
| `tool.failure`       | `PostToolUseFailure` | false             | 4,000              | false      | No                  | CORRECT             |
| `subagent.stop`      | `SubagentStop`       | false             | 4,000              | true       | Yes                 | CORRECT             |
| `subagent.start`     | `SubagentStart`      | false             | 4,000              | false      | No                  | CORRECT             |
| `notification`       | `Notification`       | false             | 4,000              | false      | No                  | CORRECT             |
| `session.start`      | `SessionStart`       | false             | 4,000              | false      | No                  | CORRECT             |
| `session.end`        | `SessionEnd`         | false             | 4,000              | false      | No                  | CORRECT             |
| `compact.pre`        | `PreCompact`         | false             | 4,000              | false      | No                  | CORRECT             |
| `user.prompt`        | `UserPromptSubmit`   | false             | 4,000              | true       | Yes                 | CORRECT             |
| `setup`              | `Setup`              | false             | 4,000              | false      | No                  | CORRECT             |
| `teammate.idle`      | `TeammateIdle`       | false             | 4,000              | true       | Yes                 | CORRECT             |
| `task.completed`     | `TaskCompleted`      | false             | 4,000              | true       | Yes                 | CORRECT             |
| `config.change`      | `ConfigChange`       | false             | 4,000              | true       | Yes                 | CORRECT             |
| `turn.start`         | _(Codex only)_       | false             | 4,000              | false      | N/A                 | N/A                 |
| `turn.complete`      | _(Codex only)_       | false             | 4,000              | false      | N/A                 | N/A                 |
| `message.delta`      | _(internal)_         | false             | 4,000              | false      | N/A                 | N/A                 |
| `plan.delta`         | _(internal)_         | false             | 4,000              | false      | N/A                 | N/A                 |
| `reasoning.delta`    | _(internal)_         | false             | 4,000              | false      | N/A                 | N/A                 |
| `usage.update`       | _(internal)_         | false             | 4,000              | false      | N/A                 | N/A                 |
| `unknown`            | _(fallback)_         | false             | 4,000              | false      | N/A                 | N/A                 |
| **MISSING**          | `InstructionsLoaded` | N/A               | N/A                | N/A        | No                  | **Benign gap**      |
| **MISSING**          | `WorktreeCreate`     | N/A               | N/A                | N/A        | **Yes**             | **Correctness bug** |
| **MISSING**          | `WorktreeRemove`     | N/A               | N/A                | N/A        | No                  | **Benign gap**      |

### Critical finding: `WorktreeCreate` correctness bug

`WorktreeCreate` CAN block per official docs (non-zero exit fails creation), but since it falls through to `unknown`, it receives `DEFAULT_HINTS` with `canBlock: false`. If this event were ever handled, the blocking capability would be incorrectly suppressed. `WorktreeRemove` and `InstructionsLoaded` cannot block per docs, so their `unknown` fallback (`canBlock: false`) happens to be accidentally correct.

### Critical finding: Latent blocking — `canBlock: true` but `expectsDecision: false`

Five events advertise `canBlock: true` but have `expectsDecision: false`:

| Event            | `canBlock` | `expectsDecision` | Implication                                             |
| ---------------- | ---------- | ----------------- | ------------------------------------------------------- |
| `user.prompt`    | true       | false             | Runtime won't wait for UI decision — blocking is latent |
| `subagent.stop`  | true       | false             | Same                                                    |
| `teammate.idle`  | true       | false             | Same                                                    |
| `task.completed` | true       | false             | Same                                                    |
| `config.change`  | true       | false             | Same                                                    |

Only `permission.request`, `tool.pre`, and `stop.request` have **both** `canBlock: true` AND `expectsDecision: true` — making them the only events where the UI can actively block execution. The other 5 events document blocking as metadata but the runtime auto-passthroughs them on timeout rather than waiting for a user decision.

### Codex comparison

The Codex harness uses a simpler binary function: `getCodexInteractionHints(expectsDecision: boolean)` — `canBlock` always equals `expectsDecision`. No asymmetry is possible. The Claude harness's per-event granularity enables future expansion but currently creates the latent-blocking pattern above.

---

## Summary: Priority Gaps (Post-Verification)

### High Priority (functional gaps)

1. **`InstructionsLoaded` / `WorktreeCreate` / `WorktreeRemove` — untranslated events** (§1, §2)
   - Rich payload data is lost; `WorktreeCreate` has a `canBlock` correctness bug
   - Fix: add `RuntimeEventKind` entries, translator cases, feed event kinds

2. **`permission_allow` missing `updatedInput` + `updatedPermissions`** (§3)
   - Can't modify tool params or set permanent permissions from the UI
   - The protocol helper already supports `updatedInput` but `decisionMapper.ts` bypasses it
   - Root cause: `RuntimeIntent` union is the choke point

3. **`continue: false` + `stopReason` universal halt** (§3)
   - No way to express "stop Claude entirely" from athena-cli regardless of event type
   - Completely absent from the codebase

4. **5 events with latent blocking** (`user.prompt`, `subagent.stop`, `teammate.idle`, `task.completed`, `config.change`) (§8)
   - `canBlock: true` but `expectsDecision: false` — blocking capability advertised but never engaged

### Medium Priority (partial coverage)

5. **`pre_tool_allow` missing `updatedInput` + `additionalContext`** (§3) — can't modify tool input on approval
6. **`permission_deny` missing `interrupt: true`** (§3) — can't stop Claude on denial
7. **Stream-json `text_delta` / `input_json_delta` parsing** (§5) — accumulators only handle complete messages, `--include-partial-messages` defaults off and parsers would drop events anyway
8. **6 hook events not registered in generated settings** (§7) — `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `InstructionsLoaded`, `WorktreeCreate`, `WorktreeRemove` have no command hook registration

### Low Priority (type safety / nice-to-have)

9. **9 protocol union types cast to `string`** at the translation boundary (§4) — `PermissionMode`, `NotificationType`, `ConfigChangeSource`, `SessionEndReason`, `InstructionsMemoryType`, `InstructionsLoadReason`, plus 3 event types with no handling
10. **`suppressOutput` / `systemMessage`** universal fields (§3) — never emitted
11. **`CLAUDE_ENV_FILE`** (§6) — architecturally N/A for athena-cli's UDS model
12. **Unused CLI flags**: `--session-id`, `--teleport`, `--worktree`, `--permission-prompt-tool` (§6)
13. **Dead code**: `TurnStart`/`TurnComplete` cases in `mapLegacyHookNameToRuntimeKind()` — unreachable on Claude path (§2)
