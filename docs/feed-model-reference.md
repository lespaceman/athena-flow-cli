# Feed Model Reference

The feed model (`src/core/feed/types.ts`) is a **single shared schema** that both the
Claude and Codex harnesses feed into. Each harness's translator is responsible for
conforming to this contract. Harness-specific fields coexist on the same type as
optional fields; consumers (the UI) read defensively.

```
Claude UDS payload ─┐
                    ├─→ core/runtime RuntimeEvent ─→ core/feed/mapper ─→ FeedEvent ─→ UI
Codex SSE/JSON-RPC ─┘
```

Legend: **C** = Claude, **X** = Codex, **S** = synthesized by `core/feed/mapper`
(not emitted directly by a translator). Fields marked `(C)` or `(X)` are populated
only by that harness.

## Session / Run lifecycle

| Kind            | C   | X   | Required data                      | Optional / harness-specific                                                                       |
| --------------- | --- | --- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `session.start` | ✓   | ✓   | `source: string`                   | `agent_type?` (C), `model?` (C) — C values: `startup\|resume\|clear\|compact`; X value: `'codex'` |
| `session.end`   | ✓   | ✓   | `reason: string`                   | —                                                                                                 |
| `run.start`     | S   | S   | `trigger: {type, prompt_preview?}` | Synthesized on SessionStart / UserPromptSubmit                                                    |
| `run.end`       | S   | S   | `status, counters`                 | Synthesized when run closes                                                                       |

## User / Agent messaging

| Kind                | C   | X   | Required data                   | Optional                                                                                                                                                  |
| ------------------- | --- | --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.prompt`       | ✓   | S   | `prompt: string`, `cwd: string` | `permission_mode?` — C: direct from `UserPromptSubmit` hook. X: synthesized by mapper from Codex `turn.start` when a prompt is present (`mapper.ts:647`). |
| `agent.message`     | S   | S   | `message, source, scope`        | `model?` — C source: transcript / `last_assistant_message`; X source: `message.complete`                                                                  |
| `plan.update`       | —   | ✓   | —                               | `explanation?, delta?, plan?, item_id?, thread_id?, turn_id?` (from Codex `plan.delta`)                                                                   |
| `reasoning.summary` | —   | ✓   | `message: string`               | `item_id?, content_index?, summary_index?, thread_id?, turn_id?`                                                                                          |
| `usage.update`      | —   | ✓   | —                               | `usage?, delta?, thread_id?, turn_id?`                                                                                                                    |

## Tool lifecycle

| Kind           | C   | X   | Required data                          | Optional                                                                                                                                                          |
| -------------- | --- | --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool.delta`   | ✓   | ✓   | `tool_name, tool_input, delta`         | `tool_use_id?` — C: emitted by the Claude runtime server via stream-json parsing (`harnesses/claude/runtime/server.ts:107`). X: direct from the Codex translator. |
| `tool.pre`     | ✓   | ✓   | `tool_name, tool_input`                | `tool_use_id?`                                                                                                                                                    |
| `tool.post`    | ✓   | ✓   | `tool_name, tool_input, tool_response` | `tool_use_id?`                                                                                                                                                    |
| `tool.failure` | ✓   | ✓   | `tool_name, tool_input, error`         | `is_interrupt?, tool_use_id?`                                                                                                                                     |

## Permissions

| Kind                  | C   | X   | Required data                                                        | Optional                                                                                                                                                                |
| --------------------- | --- | --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission.request`  | ✓   | ✓   | `tool_name, tool_input`                                              | `tool_use_id?`, `permission_suggestions?: PermissionSuggestion[]` (C — shape in `src/shared/types/permissionSuggestion.ts`), `network_context?: {host?, protocol?}` (X) |
| `permission.decision` | S   | S   | `decision_type: allow\|deny\|no_opinion\|ask` + kind-specific fields | Synthesized from `mapDecision`                                                                                                                                          |
| `permission.denied`   | ✓   | —   | `tool_name`                                                          | `tool_input?, tool_use_id?, reason?`                                                                                                                                    |

## Stop

| Kind            | C   | X   | Required data                                      | Optional                                                                                                                                                       |
| --------------- | --- | --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stop.request`  | ✓   | S   | `stop_hook_active: boolean`                        | `last_assistant_message?` — C: direct from `Stop` hook. X: synthesized by mapper from Codex `turn.complete` (`mapper.ts:682`), with `stop_hook_active: false`. |
| `stop.decision` | S   | —   | `decision_type: block\|allow\|no_opinion` + fields | Synthesized from `mapDecision`                                                                                                                                 |
| `stop.failure`  | ✓   | —   | `error_type`                                       | `error_message?`                                                                                                                                               |

## Subagent

| Kind             | C   | X   | Required data                            | Optional                                                                                                                               |
| ---------------- | --- | --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent.start` | ✓   | ✓   | `agent_id, agent_type`                   | `description?, tool?` (C); `sender_thread_id?, receiver_thread_id?, new_thread_id?, agent_status?` (X)                                 |
| `subagent.stop`  | ✓   | ✓   | `agent_id, agent_type, stop_hook_active` | C: `agent_transcript_path?, last_assistant_message?`; X: `description?, tool?, status?, sender/receiver/new_thread_id?, agent_status?` |

## Notification → specialized feed events

| Kind                      | C   | X   | Required data    | Notes                                                                                        |
| ------------------------- | --- | --- | ---------------- | -------------------------------------------------------------------------------------------- |
| `notification`            | ✓   | ✓   | `message`        | Raw fallback. `title?, notification_type?`                                                   |
| `runtime.error`           | —   | ✓   | `message`        | Synthesized from Codex `notification_type='codex.error'`                                     |
| `thread.status`           | —   | ✓   | `message`        | from `thread.status_changed`                                                                 |
| `turn.diff`               | —   | ✓   | `message, diff`  | from `turn.diff_updated`                                                                     |
| `server.request.resolved` | —   | ✓   | `message`        | from `server_request.resolved`                                                               |
| `web.search`              | S   | S   | `message, phase` | Synthesized for both harnesses from `tool.pre`/`tool.post` when `tool_name === 'WebSearch'`. |
| `review.status`           | —   | ✓   | `message, phase` | from `item.enteredReviewMode.*` / `item.exitedReviewMode.*`                                  |
| `image.view`              | —   | ✓   | `message`        | from `item.imageView.*`                                                                      |
| `context.compaction`      | —   | ✓   | `message, phase` | from `item.contextCompaction.*`                                                              |
| `mcp.progress`            | —   | ✓   | `message`        | from `mcp_tool_call.progress`                                                                |
| `terminal.input`          | —   | ✓   | `message`        | from `command_execution.terminal_interaction`                                                |
| `skills.changed`          | —   | ✓   | `message`        | from `skills.changed`                                                                        |
| `skills.loaded`           | —   | ✓   | `message`        | from `skills.loaded`                                                                         |

## Compaction

| Kind           | C   | X   | Required data           | Optional                                                                               |
| -------------- | --- | --- | ----------------------- | -------------------------------------------------------------------------------------- |
| `compact.pre`  | ✓   | ✓   | `trigger: manual\|auto` | `custom_instructions?` (C); `thread_id?, turn_id?` (X — from Codex `THREAD_COMPACTED`) |
| `compact.post` | ✓   | —   | `trigger`               | —                                                                                      |

## Tasks / todos

| Kind             | C   | X   | Required data              | Optional                                        |
| ---------------- | --- | --- | -------------------------- | ----------------------------------------------- |
| `todo.add`       | S   | S   | `todo_id, text`            | Synthesized from `TodoWrite` `tool.pre`         |
| `todo.update`    | S   | S   | `todo_id, patch`           | Synthesized                                     |
| `todo.done`      | S   | S   | `todo_id`                  | Synthesized                                     |
| `task.created`   | ✓   | —   | `task_id, task_subject`    | `task_description?, teammate_name?, team_name?` |
| `task.completed` | ✓   | —   | `task_id, task_subject`    | Same optional set                               |
| `teammate.idle`  | ✓   | —   | `teammate_name, team_name` | —                                               |

## Config / filesystem / misc

| Kind            | C   | X   | Required data                | Optional     |
| --------------- | --- | --- | ---------------------------- | ------------ |
| `config.change` | ✓   | —   | `source`                     | `file_path?` |
| `cwd.changed`   | ✓   | —   | `cwd`                        | —            |
| `file.changed`  | ✓   | —   | `file_path`                  | —            |
| `setup`         | ✓   | —   | `trigger: init\|maintenance` | —            |

## MCP elicitation

| Kind                  | C   | X   | Required data        | Optional   |
| --------------------- | --- | --- | -------------------- | ---------- |
| `elicitation.request` | ✓   | —   | `mcp_server`         | `form?`    |
| `elicitation.result`  | ✓   | —   | `mcp_server, action` | `content?` |

## Fallback

| Kind           | C   | X   | Required data              | Notes                                          |
| -------------- | --- | --- | -------------------------- | ---------------------------------------------- |
| `unknown.hook` | S   | S   | `hook_event_name, payload` | Fallback when `RuntimeEventKind === 'unknown'` |

## Quick stats

- **Shared by both harnesses (non-synthesized):** 11 kinds — `session.start/end`,
  `notification`, `permission.request`, `subagent.start/stop`,
  `tool.pre/post/failure`, `tool.delta`, `compact.pre`.
- **Claude-only direct emission:** 14 kinds (including 8 newly added). Some —
  `user.prompt`, `stop.request` — are also reached via mapper synthesis on the
  Codex side.
- **Codex-only direct emission:** ~15 kinds (including 11 specialized from
  `notification_type`). `web.search` is no longer in this bucket — it is
  mapper-synthesized for both harnesses.
- **Mapper-synthesized (harness-agnostic):** `run.start/end`, `permission.decision`,
  `stop.decision`, `todo.add/update/done`, `agent.message`, `web.search`,
  `unknown.hook`. Additionally, `user.prompt` and `stop.request` are synthesized
  on the Codex path (from `turn.start` / `turn.complete`).

Added in the Claude hook-protocol completeness PR (8 total, all Claude-emitted
only): `permission.denied`, `stop.failure`, `compact.post`, `task.created`,
`cwd.changed`, `file.changed`, `elicitation.request`, `elicitation.result`.

## Design pattern

The shared feed type is a **superset of fields** across harnesses:

- Fields present in only one harness (e.g. `permission_suggestions` vs `network_context`
  on `PermissionRequestData`) live on the same type as optional fields.
- String enums from different harnesses (e.g. `session.start.source` literal union
  widened with `| string` to absorb `'codex'`) use loose widening.
- `notification_type` is the discriminator that routes `notification` into
  specialized feed kinds (`runtime.error`, `thread.status`, …) inside
  `core/feed/mapper.ts`. Routing lives in a `NOTIFICATION_ROUTES` dispatch table
  keyed by `notification_type` — adding a new route is one entry.
- Required fields on feed data types are the integration contract: any harness
  emitting a kind must supply those fields (synthesizing safe defaults at the
  mapper boundary where needed — see `readString(x) ?? '…'` patterns in the
  mapper).

## Type-layer invariants

- `RuntimeEventDataMap` (`src/core/runtime/events.ts`) is the authoritative
  per-kind shape for translator output. All fields are optional — raw adapter
  data is partial.
- `FeedEvent` per-kind `*Data` types (`src/core/feed/types.ts`) may tighten
  fields (mark some required) but must stay structurally assignable to the
  runtime shape for shared kinds. A compile-time `AssertFeedExtendsRuntime`
  check at the bottom of `types.ts` catches drift across all 26 shared kinds.
- Translator return types (`ClaudeTranslatedEvent`, `CodexTranslatedEvent`) are
  discriminated mapped-type unions over `RuntimeEventKind`, so each switch arm
  in the translators is type-checked against the runtime map — emitting a
  `kind` with the wrong `data` shape fails to compile.
- Low-signal kinds whose rendering is generic (`compact.post`, `task.created`,
  `cwd.changed`, `file.changed`, `stop.failure`, `permission.denied`,
  `elicitation.request`, `elicitation.result`) are listed once in
  `src/core/feed/defaultRender.ts` as `DefaultRenderKind`. Renderer switches
  use the `isDefaultRenderKind` predicate to short-circuit without enumerating
  these kinds — adding a new default-render kind is a one-line change.
