# Combined Harness Gap Analysis: Claude vs Codex

> **Date:** 2026-03-10
> **Purpose:** Side-by-side comparison of both harness implementations — what's implemented, what's missing, and where capabilities overlap or diverge.
>
> **Legend:**
>
> - **Implemented** = fully wired and working
> - **Partial** = some support but incomplete
> - **Stub** = code exists but auto-fails/drops data
> - **Missing** = not implemented at all
> - **N/A** = not applicable to this harness's protocol

---

## 1. Session / Thread Lifecycle

| Feature                           | Claude Harness                        | Codex Harness                                  | Notes                                                                                          |
| --------------------------------- | ------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Start new session**             | Implemented (`spawnClaude` with `-p`) | Implemented (`thread/start`)                   | Both fully working                                                                             |
| **Resume session by ID**          | Implemented (`--resume <id>`)         | Implemented (`thread/resume`)                  | Both fully working                                                                             |
| **Continue last session**         | Implemented (`--continue`)            | N/A                                            | Claude-only flag                                                                               |
| **Fork / branch conversation**    | N/A                                   | Missing (`thread/fork`)                        | Codex protocol supports it; would enable exploring two approaches from one branch point        |
| **Rollback / undo turns**         | N/A                                   | Missing (`thread/rollback`)                    | Codex protocol supports dropping last N turns from history; athena would pair with git revert  |
| **List past sessions**            | N/A                                   | Missing (`thread/list`)                        | Codex protocol supports paginated, filterable thread listing                                   |
| **Read session without resuming** | N/A                                   | Missing (`thread/read`)                        | Codex protocol supports inspecting past session history without consuming credits              |
| **List loaded sessions**          | N/A                                   | Missing (`thread/loaded/list`)                 | Check which threads are hot in server memory                                                   |
| **Archive / unarchive**           | N/A                                   | Missing (`thread/archive`, `thread/unarchive`) | Soft-delete and restore threads                                                                |
| **Unsubscribe from thread**       | N/A                                   | Missing (`thread/unsubscribe`)                 | Detach from notifications without killing the server                                           |
| **Manual context compaction**     | N/A                                   | Missing (`thread/compact/start`)               | Compress context window manually when hitting limits                                           |
| **Session end notification**      | Implemented (`SessionEnd`)            | Missing (`thread/closed` falls to `unknown`)   | Claude fires `SessionEnd` hook; Codex `thread/closed` is unhandled                             |
| **Worktree session isolation**    | Partial (types exist, not translated) | N/A                                            | `WorktreeCreate`/`WorktreeRemove` events typed but fall to `unknown`; `--worktree` flag unused |
| **Teleport (web-to-local)**       | Missing (`--teleport` flag unused)    | N/A                                            | Claude-only feature, not wired                                                                 |

---

## 2. Turn / Prompt Management

| Feature                      | Claude Harness                                                             | Codex Harness                                  | Notes                                                                        |
| ---------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| **Start a turn**             | Implemented (via `-p` prompt)                                              | Implemented (`turn/start`)                     | Both fully working                                                           |
| **Interrupt a turn**         | Implemented (process signal)                                               | Implemented (`turn/interrupt`)                 | Both fully working                                                           |
| **Mid-turn steering**        | N/A                                                                        | Missing (`turn/steer`)                         | Inject correction while agent is mid-response without restarting             |
| **Turn started event**       | Missing (dead code — `TurnStart` case exists but Claude never fires it)    | Implemented (`turn/started`)                   | Codex-only; Claude has dead code for it                                      |
| **Turn completed event**     | Missing (dead code — `TurnComplete` case exists but Claude never fires it) | Implemented (`turn/completed`)                 | Codex-only; Claude has dead code for it                                      |
| **System prompt override**   | Implemented (`--system-prompt` flag wired)                                 | N/A (uses `developerInstructions`)             | Different mechanisms                                                         |
| **Append system prompt**     | Implemented (`--append-system-prompt` flag wired)                          | N/A                                            | Claude-only                                                                  |
| **Output schema constraint** | Missing (`--json-schema` wired but may be ignored in stream-json mode)     | Missing (`outputSchema` param not passed)      | Both harnesses have the concept but neither uses it effectively              |
| **Max turns limit**          | Implemented (`--max-turns`)                                                | N/A                                            | Claude-only                                                                  |
| **Max budget limit**         | Implemented (`--max-budget-usd`)                                           | N/A                                            | Claude-only                                                                  |
| **Reasoning effort level**   | N/A                                                                        | Missing (`effort` param not passed)            | 6 levels: `none` to `xhigh`. Would enable `--effort high` for complex tasks  |
| **Reasoning summary style**  | N/A                                                                        | Missing (`summary` param not passed)           | 4 levels: `auto`/`concise`/`detailed`/`none`                                 |
| **Collaboration mode**       | N/A                                                                        | Missing (`collaborationMode` not configurable) | `plan` mode for deliberate plan-then-execute; `default` for current behavior |
| **Personality preset**       | N/A                                                                        | Missing (not passed)                           | `none`/`friendly`/`pragmatic` response style                                 |
| **Service tier**             | N/A                                                                        | Missing (not passed)                           | `fast`/`flex` — controls cost/speed tradeoff                                 |

---

## 3. Tool Handling / Item Types

| Tool / Item Type              | Claude Harness                                         | Codex Harness                                                                         | Notes                                                                              |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Command execution**         | Implemented (`PreToolUse`/`PostToolUse` for all tools) | Implemented (`commandExecution` as `tool.pre`/`tool.post`)                            | Both handle shell commands                                                         |
| **File changes**              | Implemented (via generic tool events)                  | Implemented (`fileChange` as `tool.pre`/`tool.post`)                                  | Both handle file edits                                                             |
| **MCP tool calls**            | Implemented (via generic tool events)                  | Implemented (`mcpToolCall` — reduced to `mcp:server/tool` string)                     | Codex loses `durationMs`, separate server/tool identity                            |
| **Web search**                | N/A (Claude handles internally)                        | Missing (`webSearch` falls to generic `notification`)                                 | Codex has search/open_page/find_in_page actions — all invisible                    |
| **Image viewing**             | N/A (Claude handles internally)                        | Missing (`imageView` falls to generic `notification`)                                 | Agent reads a screenshot — user doesn't know which file                            |
| **Image generation**          | N/A                                                    | Missing (generated types unused)                                                      | DALL-E/GPT-Image results not piped through                                         |
| **Dynamic tool calls**        | N/A                                                    | Stub (auto-fails with `success: false`)                                               | Plugin-registered client-side tools always silently fail                           |
| **Code review**               | N/A                                                    | Missing (`review/start` not called; `enteredReviewMode`/`exitedReviewMode` unhandled) | Structured review findings with file+line+confidence — completely invisible        |
| **Sandbox command exec**      | N/A                                                    | Missing (`command/exec` not called)                                                   | Run isolated commands outside turn context                                         |
| **Collab / sub-agents**       | Implemented (`SubagentStart`/`SubagentStop`)           | Partial (`collabToolCall` — only first agent ID captured)                             | Claude fully handles; Codex drops multi-agent data                                 |
| **Context compaction marker** | Implemented (`PreCompact` event)                       | Missing (`contextCompaction` item falls to generic)                                   | Claude shows compaction event; Codex doesn't                                       |
| **Tool failure handling**     | Implemented (`PostToolUseFailure`)                     | Partial (only `error.message` extracted; exit codes only for commands)                | Claude gets full failure data; Codex loses stack traces and non-command exit codes |

---

## 4. Streaming / Output

| Feature                          | Claude Harness                                                                                                 | Codex Harness                                                             | Notes                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Agent message streaming**      | Partial (`text_delta` not parsed — accumulators only handle complete messages)                                 | Implemented (`item/agentMessage/delta` as `message.delta`)                | Codex streams deltas; Claude waits for full messages                                  |
| **Reasoning streaming**          | N/A (Claude reasoning is opaque)                                                                               | Implemented (`reasoning.delta` from 3 event types)                        | Codex-only                                                                            |
| **Plan streaming**               | N/A                                                                                                            | Implemented (`plan.delta` from `TURN_PLAN_UPDATED` and `ITEM_PLAN_DELTA`) | Codex-only; plan step statuses survive but typed as `unknown[]`                       |
| **Command output streaming**     | N/A (Claude handles internally)                                                                                | Missing (`item/commandExecution/outputDelta` falls to `unknown`)          | 30-second builds produce zero output while running                                    |
| **File change output streaming** | N/A                                                                                                            | Missing (`item/fileChange/outputDelta` falls to `unknown`)                | No streaming patch application feedback                                               |
| **Live turn diff**               | N/A                                                                                                            | Missing (`turn/diff/updated` explicitly ignored)                          | Aggregated unified diff of all file changes — hard-dropped                            |
| **Partial message parsing**      | Missing (`--include-partial-messages` flag exists but inert; `text_delta`/`input_json_delta` silently dropped) | N/A                                                                       | Flag wired but all 3 isolation presets leave it off; parsers would drop events anyway |

---

## 5. Approval / Permission System

| Feature                    | Claude Harness                                                                            | Codex Harness                                                                     | Notes                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Permission request**     | Implemented (`PermissionRequest` with `behavior: allow/deny`)                             | Implemented (`commandExecution/requestApproval`, `fileChange/requestApproval`)    | Both handle basic approve/deny                                                |
| **Pre-tool use approval**  | Implemented (`PreToolUse` with `permissionDecision`)                                      | N/A (Codex uses per-type approval requests)                                       | Different architectures                                                       |
| **Tool user input**        | N/A                                                                                       | Implemented (`tool/requestUserInput`)                                             | Codex-only: tool prompts user with questions                                  |
| **Allow + modify input**   | Missing (`updatedInput` field exists in protocol but `RuntimeIntent` has no field for it) | N/A                                                                               | Claude supports modifying tool params on approval — not wired                 |
| **Allow + permanent rule** | Missing (`updatedPermissions` completely unimplemented)                                   | Missing (`acceptWithExecpolicyAmendment` type-stripped by `Extract<..., string>`) | Both protocols support persistent rules; neither harness implements them      |
| **Deny + interrupt**       | Missing (`interrupt: true` on deny not in `RuntimeIntent`)                                | N/A                                                                               | Claude supports stopping entirely on denial — not wired                       |
| **Accept for session**     | N/A                                                                                       | Implemented (`acceptForSession`)                                                  | Codex-only: approve all similar actions for this session                      |
| **MCP elicitation**        | N/A                                                                                       | Stub (auto-declined — `{action: 'decline'}`)                                      | MCP servers requesting user interaction (OAuth URLs, forms) silently rejected |
| **Universal halt**         | Missing (`continue: false` + `stopReason` absent from codebase)                           | N/A                                                                               | Claude supports halting from any event — completely unimplemented             |
| **Unknown decisions**      | N/A                                                                                       | Stub (default to `approved` silently)                                             | Unknown approval types auto-approve — potential security concern              |

---

## 6. Event Handling / Notifications

| Event                            | Claude Harness                                                              | Codex Harness                                                   | Notes                                                         |
| -------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| **Session start**                | Implemented (`SessionStart`)                                                | Implemented (`thread/started`)                                  | Both working                                                  |
| **Session end**                  | Implemented (`SessionEnd`)                                                  | Missing (`thread/closed` unhandled)                             | Claude has it; Codex doesn't signal thread termination        |
| **User prompt**                  | Implemented (`UserPromptSubmit`)                                            | N/A (input via `turn/start`)                                    | Different mechanisms                                          |
| **Tool pre-use**                 | Implemented (`PreToolUse`)                                                  | Implemented (via approval requests)                             | Both working                                                  |
| **Tool post-use**                | Implemented (`PostToolUse`)                                                 | Implemented (`item/completed`)                                  | Both working, Codex loses some fields                         |
| **Tool failure**                 | Implemented (`PostToolUseFailure`)                                          | Implemented (`item/completed` with failed status)               | Both working                                                  |
| **Stop request**                 | Implemented (`Stop` — blockable)                                            | N/A                                                             | Claude-only                                                   |
| **Notification**                 | Implemented (`Notification`)                                                | Implemented (various mapped to `notification`)                  | Both working                                                  |
| **Token usage**                  | Implemented (token accumulators for `assistant`/`message`/`result` types)   | Implemented (`thread/tokenUsage/updated` as `usage.update`)     | Both working; Codex loses `cacheWrite` and `contextSize`      |
| **Thread name updated**          | N/A                                                                         | Implemented (`thread/name/updated`)                             | Codex-only                                                    |
| **Instructions loaded**          | Typed but **not translated** (falls to `unknown`)                           | N/A                                                             | Claude has the type but no case in translator                 |
| **Config change**                | Implemented (`ConfigChange`)                                                | Missing (`configWarning` unhandled)                             | Claude handles config events; Codex config warnings invisible |
| **Setup**                        | Implemented (`Setup`)                                                       | N/A                                                             | Claude-only                                                   |
| **Teammate idle**                | Implemented (`TeammateIdle`)                                                | N/A                                                             | Claude-only                                                   |
| **Task completed**               | Implemented (`TaskCompleted`)                                               | N/A                                                             | Claude-only                                                   |
| **Pre-compact**                  | Implemented (`PreCompact`)                                                  | N/A                                                             | Claude-only                                                   |
| **Server error**                 | N/A                                                                         | Missing (`error` notification falls to `unknown`)               | Turn-level errors invisible — should be red error banner      |
| **Model rerouted**               | N/A                                                                         | Missing (`model/rerouted` falls to `unknown`)                   | Silent model switch due to content policy — user doesn't know |
| **Rate limits updated**          | N/A                                                                         | Missing (`account/rateLimits/updated` unhandled)                | No rate limit visibility in CLI                               |
| **Login completed**              | N/A                                                                         | Missing (`account/login/completed` unhandled)                   | Silent auth flow results                                      |
| **MCP OAuth completed**          | N/A                                                                         | Missing (`mcpServer/oauthLogin/completed` unhandled)            | Silent MCP auth results                                       |
| **MCP tool progress**            | N/A                                                                         | Missing (`item/mcpToolCall/progress` unhandled)                 | No real-time MCP tool status                                  |
| **Command terminal interaction** | N/A                                                                         | Missing (`item/commandExecution/terminalInteraction` unhandled) | Agent's interactive stdin to processes invisible              |
| **Skills changed**               | N/A                                                                         | Missing (`skills/changed` unhandled)                            | Mid-session skill invalidation ignored                        |
| **Worktree create**              | Typed but **not translated** (correctness bug: `canBlock` should be `true`) | N/A                                                             | Claude type exists with wrong blocking config                 |
| **Worktree remove**              | Typed but **not translated**                                                | N/A                                                             | Claude type exists but benign gap                             |

---

## 7. Configuration / Account Management

| Feature                      | Claude Harness                                | Codex Harness                                                | Notes                                                         |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| **Read config**              | N/A (settings injected via `--settings` flag) | Missing (`config/read` not called)                           | Claude uses flag injection; Codex has API but doesn't call it |
| **Write config**             | N/A                                           | Missing (`config/value/write`, `config/batchWrite`)          | Set config from terminal without editing files                |
| **Reload MCP servers**       | N/A                                           | Missing (`config/mcpServer/reload`)                          | Live MCP reload without restart                               |
| **Admin requirements**       | N/A                                           | Missing (`configRequirements/read`)                          | Enterprise policy checking                                    |
| **List models**              | N/A                                           | Missing (`model/list`)                                       | Discover available models                                     |
| **List feature flags**       | N/A                                           | Missing (`experimentalFeature/list`)                         | Show active beta capabilities                                 |
| **List skills**              | N/A                                           | Implemented (`skills/list` — used in `skillInstructions.ts`) | Codex queries skills at thread start                          |
| **Toggle skills**            | N/A                                           | Missing (`skills/config/write`)                              | Enable/disable individual skills                              |
| **List apps**                | N/A                                           | Missing (`app/list`)                                         | App/connector marketplace                                     |
| **Account info**             | N/A                                           | Missing (`account/read`)                                     | Display "Logged in as ..."                                    |
| **Login / logout**           | N/A                                           | Missing (`account/login/*`, `account/logout`)                | In-process auth management                                    |
| **Rate limits**              | N/A                                           | Missing (`account/rateLimits/read`)                          | Pre-turn quota checking                                       |
| **Feedback**                 | N/A                                           | Missing (`feedback/upload`)                                  | Submit feedback with session context                          |
| **External agent migration** | N/A                                           | Missing (`externalAgentConfig/detect`, `import`)             | Import Claude/Cursor configs                                  |
| **MCP OAuth login**          | N/A                                           | Missing (`mcpServer/oauth/login`)                            | Terminal-driven MCP OAuth flows                               |
| **MCP server status**        | N/A                                           | Missing (`mcpServerStatus/list`)                             | Health/diagnostic for MCP servers                             |
| **Experimental API**         | N/A                                           | Implemented (`experimentalApi: true` in init)                | Gate is open; call-site code is the barrier                   |

---

## 8. Decision Mapping / Response Capabilities

| Decision Feature           | Claude Harness                                                           | Codex Harness                                                                   | Notes                                                  |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Allow / approve**        | Implemented (`permission_allow`, `pre_tool_allow`)                       | Implemented (`accept`)                                                          | Both working                                           |
| **Deny / decline**         | Implemented (`permission_deny`, `pre_tool_deny`)                         | Implemented (`decline`)                                                         | Both working                                           |
| **Block / cancel**         | Implemented (`stop_block`)                                               | Implemented (`cancel` maps to `abort`)                                          | Both working                                           |
| **Accept for session**     | N/A                                                                      | Implemented (`acceptForSession`)                                                | Codex-only                                             |
| **Allow + modify input**   | Missing (protocol supports `updatedInput`; `RuntimeIntent` has no field) | N/A                                                                             | Claude protocol supports it; athena can't express it   |
| **Allow + permanent rule** | Missing (`updatedPermissions` absent from codebase)                      | Missing (`acceptWithExecpolicyAmendment` type-stripped)                         | Both protocols support persistent rules; neither works |
| **Deny + interrupt**       | Missing (`interrupt: true` not in intent)                                | N/A                                                                             | Can't stop Claude entirely on denial                   |
| **Question answers**       | Implemented (`question_answer` intent with `updatedInput.answers`)       | Implemented (maps to `ToolRequestUserInputResponse`)                            | Both working                                           |
| **Universal halt**         | Missing (`continue: false` + `stopReason`)                               | N/A                                                                             | Can't halt from any event type                         |
| **System message**         | Missing (`systemMessage` absent)                                         | N/A                                                                             | Can't inject warning shown to user                     |
| **Suppress output**        | Missing (`suppressOutput` absent)                                        | N/A                                                                             | Can't hide stdout in verbose mode                      |
| **Legacy approval**        | N/A                                                                      | Implemented (`applyPatchApproval`, `execCommandApproval` with `ReviewDecision`) | Codex-only backward compat                             |

---

## 9. Transport / Infrastructure

| Feature                    | Claude Harness                                            | Codex Harness                                       | Notes                                                                        |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Process communication**  | Child process stdio + UDS hook forwarder                  | Child process stdio (JSON-RPC)                      | Both use stdio                                                               |
| **Hook injection**         | Full hook system via generated settings + forwarder       | N/A (Codex uses JSON-RPC requests instead of hooks) | Fundamentally different architectures                                        |
| **WebSocket transport**    | N/A                                                       | Missing (stdio only)                                | Codex protocol supports WebSocket; would enable multi-client, remote servers |
| **Settings isolation**     | Implemented (`--settings <tmpfile> --setting-sources ""`) | N/A                                                 | Claude-only: prevents user hooks from bleeding in                            |
| **Env file support**       | Missing (`CLAUDE_ENV_FILE` not utilized)                  | N/A                                                 | Architecturally N/A — athena uses UDS                                        |
| **Permission prompt tool** | Missing (`--permission-prompt-tool` unused)               | N/A                                                 | MCP-based permission handler                                                 |

---

## 10. Data Fidelity / Information Loss

| Data Point                         | Claude Harness                                    | Codex Harness                                                | Notes                                                      |
| ---------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| **Protocol types used as typed**   | 0 of 9 union types (all cast to `string`)         | 18 of 486 generated types (3.7%)                             | Both harnesses discard most type information               |
| **Tool failure context**           | Full (via `PostToolUseFailure` payload)           | Partial (only `error.message`; exit codes only for commands) | Claude preserves more failure data                         |
| **MCP tool identity**              | Full (via generic tool event fields)              | Partial (collapsed to `mcp:server/tool` string)              | Claude preserves separate fields                           |
| **Multi-agent data**               | Full (`SubagentStart`/`SubagentStop`)             | Partial (only first agent of N captured)                     | Claude handles multi-agent correctly                       |
| **Plan structure**                 | N/A                                               | Partial (data passes but typed as `unknown[]`)               | Step statuses survive but are untyped downstream           |
| **Token usage completeness**       | Partial (3 message types parsed; deltas dropped)  | Partial (`cacheWrite` and `contextSize` always null)         | Both lose some usage data                                  |
| **Turn diff / aggregated changes** | N/A                                               | Missing (hard-dropped in ignore set)                         | Most impactful silent discard                              |
| **Stub request visibility**        | N/A                                               | Missing (errors sent to Codex, not UI)                       | User can't see why MCP elicitation or dynamic tools failed |
| **Approval decision variants**     | Missing (only string variants in `RuntimeIntent`) | Missing (`Extract<..., string>` strips object variants)      | Both structurally block advanced approval types            |
| **Patch apply status**             | N/A                                               | Missing (`PatchApplyStatus` not forwarded)                   | Can't warn on partial patch application                    |

---

## Summary: Feature Coverage at a Glance

| Capability Area   | Claude                                     | Codex                                                             | Winner                                          |
| ----------------- | ------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------- |
| Session lifecycle | Basic (start/resume/continue)              | Basic (start/resume) + rich protocol unused                       | **Claude** (more flags wired)                   |
| Turn management   | Basic (start/interrupt)                    | Basic (start/interrupt) + steer/rollback unused                   | **Tie** (both basic)                            |
| Tool handling     | Full (generic events for all tools)        | Partial (typed per-tool but some missing/stubbed)                 | **Claude** (no silent failures)                 |
| Streaming         | Weak (no deltas parsed)                    | Strong (message/reasoning/plan deltas) but missing command output | **Codex** (delta streaming works)               |
| Approvals         | Strong (3 blockable events)                | Strong (5 approval request types) but stubs for 3                 | **Tie** (different strengths)                   |
| Event coverage    | 16 of 19 events handled                    | ~12 of 30+ notifications handled                                  | **Claude** (higher coverage ratio)              |
| Configuration     | N/A (flag injection)                       | 1 of 17+ methods used                                             | **Claude** (simpler but complete for its model) |
| Data fidelity     | Weak (all types cast to string)            | Weak (3.7% type utilization, data loss at multiple points)        | **Tie** (both lose data)                        |
| Decision mapping  | 6 intent types, missing 7+ Claude features | Basic approve/deny/cancel, missing amendment types                | **Tie** (both incomplete)                       |

### Top Gaps Shared by Both Harnesses

1. **Persistent approval rules** — both protocols support "approve + add permanent rule" but neither harness implements it
2. **Protocol type utilization** — both cast typed payloads to strings/unknown, losing compile-time safety
3. **Advanced decision variants** — both structurally block rich decision types (`updatedInput`, `updatedPermissions`, `acceptWithExecpolicyAmendment`)

### Top Gaps Unique to Codex

1. **`item/commandExecution/outputDelta`** — no streaming command output (HIGH)
2. **`turn/diff/updated`** — live diff hard-dropped (HIGH)
3. **`error` notification** — turn errors invisible (HIGH)
4. **`turn/steer`** — no mid-turn correction (MEDIUM)
5. **28 unused client-to-server methods** — vast protocol surface untapped

### Top Gaps Unique to Claude

1. **`InstructionsLoaded` / `WorktreeCreate` / `WorktreeRemove`** — typed but never translated (HIGH)
2. **`text_delta` / `input_json_delta` streaming** — accumulators drop partial messages (MEDIUM)
3. **`continue: false` + `stopReason` universal halt** — completely absent (HIGH)
4. **`updatedInput` on permission allow** — protocol helper exists but decision mapper bypasses it (MEDIUM)
5. **5 events with latent `canBlock: true` but `expectsDecision: false`** — blocking advertised but never engaged (MEDIUM)
