# Codex App-Server Gap Analysis — Verified & Enriched

> **Date:** 2026-03-10
> **Scope:** Cross-reference of Codex app-server protocol capabilities vs athena-cli harness implementation
> **Sources:** 486 generated protocol types, runtime message handling code, official Codex app-server documentation

## Corrections from Verification

- `skills/list` IS actually used (in `skillInstructions.ts`) — the original count was 6 methods, it's actually **7**
- `config/mcpServer/reloaded` does NOT exist as a notification — it's a client-to-server request. Removed from Section 2.
- `experimentalApi` IS already enabled (`true` in `buildInitializeParams`). The barrier isn't the flag — it's the missing call-site code.
- V2 protocol is NOT unused — it IS the active protocol. 37 v2 types are re-exported through `protocol/index.ts`.
- Plan structure data DOES survive through `TURN_PLAN_UPDATED` path, but is typed as `unknown[]` in the event map, weakening downstream usage.

---

## 1. Client-to-Server Methods NOT Implemented (28 of 35+)

Only **7** methods are called: `initialize`, `initialized`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `skills/list`.

| Method                                                  | What It Does                                        | What It Would Enable in athena-cli                                                                                                                                                                                       | Complexity |
| ------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| **`thread/fork`**                                       | Copies thread history into a new branch ID          | User types `/fork` mid-conversation — two independent threads diverge from the same point. Explore two refactor approaches without losing either. The fork carries full config overrides (model, sandbox, instructions). | Medium     |
| **`thread/read`**                                       | Fetches full thread data without resuming it        | `athena history view <id>` — inspect any past session's commands, messages, and file changes without consuming API credits or making the thread active. Prerequisite for a session replay feature.                       | Low        |
| **`thread/list`**                                       | Paginated, filterable thread listing                | `athena sessions` — browse all past sessions, filter by current working directory, search by name. Interactive session picker to resume any past conversation.                                                           | Medium     |
| **`thread/loaded/list`**                                | Returns thread IDs currently in server memory       | Enables smart session reuse — check if a thread is already hot before issuing `thread/resume`, avoiding cold-start latency. Useful for multi-session workflows.                                                          | Low        |
| **`thread/archive`** / **`unarchive`**                  | Soft-delete / restore threads                       | `athena sessions archive <id>` — keep the session list clean by archiving completed work. Unarchive when you need to return to old explorations.                                                                         | Low        |
| **`thread/unsubscribe`**                                | Stop receiving notifications for a thread           | Selective detach from one thread while keeping the app-server alive for others. Currently the only way to stop events is killing the entire `AppServerManager`.                                                          | Low        |
| **`thread/compact/start`**                              | Trigger context window compaction                   | `/compact` slash command — when hitting context limits mid-session, manually compress history and continue working in the same thread instead of starting fresh.                                                         | Low        |
| **`thread/rollback`**                                   | Drop last N turns from history                      | `/undo 2` — rewind the conversation, removing bad turns. Agent's context no longer contains them. Athena would pair this with `git checkout` to revert file changes (protocol explicitly doesn't revert files).          | Medium     |
| **`turn/steer`**                                        | Inject text into an in-flight turn                  | While the agent streams a long response going the wrong direction, type "focus on the API layer instead" — the agent pivots mid-response without a full restart. Uses `expectedTurnId` guard for safety.                 | Medium     |
| **`review/start`**                                      | Run Codex's code review agent                       | `athena review` after edits — structured findings with file+line locations, confidence scores, and priority. Output renders like a linter report in the terminal.                                                        | Medium     |
| **`command/exec`**                                      | Run a sandbox-isolated command outside turn context | Lightweight environment probing (run tests, check lint) without spinning up a full agent turn. Enables harness hooks and workflow plugins to do pre-turn validation.                                                     | Medium     |
| **`model/list`**                                        | List available models for the account               | `athena models` — see available models before starting a session. Validate model name at startup instead of failing on first turn. Includes `includeHidden` for experimental models.                                     | Low        |
| **`experimentalFeature/list`**                          | List active feature flags                           | `athena features` — show which beta capabilities are active. Workflow authors can write conditional logic based on feature availability.                                                                                 | Low        |
| **`collaborationMode/list`**                            | List collab presets                                 | Discovery step for multi-agent modes. Shows available orchestration patterns (e.g., plan-then-execute) before starting a session with `--collab-mode`.                                                                   | High       |
| **`skills/config/write`**                               | Enable/disable a Codex skill by path                | `athena skills disable <path>` — toggle individual skills on/off from the terminal. Paired with existing `skills/list` integration for an interactive skill management TUI.                                              | Low        |
| **`app/list`**                                          | Fetch available Codex apps/connectors               | Discover and select named app configurations (pre-packaged personas/tool sets) via `--app` option at session start.                                                                                                      | Medium     |
| **`config/read`**                                       | Read effective Codex config for a directory         | `athena config show` — dump resolved config with layer sources (user/project/repo) for troubleshooting why certain settings take effect.                                                                                 | Low        |
| **`config/value/write`** / **`config/batchWrite`**      | Write config values                                 | `athena config set model o4-mini` — set config from terminal without editing files. `batchWrite` enables atomic multi-option setup before first turn.                                                                    | Low        |
| **`config/mcpServer/reload`**                           | Reload MCP server config without restart            | After `registerPlugins` writes `.mcp.json`, call this instead of restarting the entire Codex process. Critical for live plugin installation.                                                                             | Low        |
| **`configRequirements/read`**                           | Fetch admin-enforced policy                         | Check policy at startup — clear error messages when config violates enterprise constraints (e.g., disallowed model) instead of failing mid-session.                                                                      | Low        |
| **`externalAgentConfig/detect`** / **`import`**         | Discover and import configs from other AI tools     | `athena migrate` — detect existing Claude/Cursor configurations and import them into Codex. Guided migration wizard for users switching tools.                                                                           | Medium     |
| **`mcpServer/oauth/login`**                             | Start OAuth flow for an MCP server                  | Authenticate with OAuth-secured MCP servers (GitHub, Google Drive) from the terminal. Print auth URL, wait for completion notification, resume.                                                                          | High       |
| **`mcpServerStatus/list`**                              | List MCP server health/status                       | `athena mcp status` — show which MCP servers are connected, failed, and why. Fast diagnostic for broken tool integrations.                                                                                               | Low        |
| **`account/read`**                                      | Fetch current account info                          | Display "Logged in as user@example.com (Pro)" at session start. Validate auth before first turn instead of failing mid-session.                                                                                          | Low        |
| **`account/login/start`** / **`cancel`** / **`logout`** | Full auth lifecycle                                 | `athena login` / `athena logout` — manage authentication in-process instead of requiring separate `codex` CLI auth. Switch accounts without restarting.                                                                  | High       |
| **`account/rateLimits/read`**                           | Fetch rate limit state                              | Show quota warning before starting a turn: "Rate limit: 87% used, resets in 4m." Prevent users from starting work that will fail mid-execution.                                                                          | Low        |
| **`feedback/upload`**                                   | Submit user feedback with thread context            | `/feedback` command — rate the session and submit a report with auto-attached thread history and logs.                                                                                                                   | Low        |

---

## 2. Server-to-Client Notifications NOT Handled

Verified through three drop mechanisms: explicit ignore set, no case handler (falls to `kind: 'unknown'`), and legacy prefix opt-out.

| Notification                                    | Drop Mechanism                      | What the User Misses                                                                                                                                                                                             | Priority    |
| ----------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **`error`**                                     | No case handler, falls to `unknown` | **Turn-level server errors are invisible.** The app-server pushes `{error: TurnError, willRetry: boolean}` but it lands as a collapsed debug entry. A turn error should be a red error banner.                   | **High**    |
| **`model/rerouted`**                            | No case handler, falls to `unknown` | **Silent model switch due to high-risk content detection.** The server reroutes the request to a different model (reason: `'highRiskCyberActivity'`). The user has no idea their model changed.                  | **High**    |
| **`item/commandExecution/outputDelta`**         | No case handler, falls to `unknown` | **No streaming command output.** A 30-second `npm install` produces zero terminal output while running. With this: live scrolling output like watching a build in real time. The delta is a simple string chunk. | **High**    |
| **`account/rateLimits/updated`**                | No case handler, falls to `unknown` | **No rate limit visibility.** Carries `usedPercent`, `windowDurationMins`, `resetsAt`, and credit balance. Could power a header metric like "Rate limit: 73% used, resets in 4m."                                | **High**    |
| **`turn/diff/updated`**                         | Explicit ignore set                 | **No live diff preview.** Carries an aggregated unified diff of all file changes so far in the turn, updated incrementally. A scrollable diff panel updating as the agent writes code.                           | **Medium**  |
| **`thread/closed`**                             | No case handler, falls to `unknown` | **No signal that the active thread was terminated server-side.** Next `turn/start` fails with a cryptic error instead of a clean "session ended" message.                                                        | **Medium**  |
| **`account/login/completed`**                   | No case handler, falls to `unknown` | **Silent auth flow completion.** After OAuth login, no "Login successful" or "Login failed: [error]" appears in the terminal.                                                                                    | **Medium**  |
| **`mcpServer/oauthLogin/completed`**            | No case handler, falls to `unknown` | **Silent MCP OAuth completion.** No confirmation that an MCP server auth succeeded or failed.                                                                                                                    | **Medium**  |
| **`configWarning`**                             | No case handler, falls to `unknown` | **Config file parse errors invisible.** A malformed config entry produces no warning in the CLI.                                                                                                                 | **Medium**  |
| **`item/mcpToolCall/progress`**                 | No case handler, falls to `unknown` | **No real-time MCP tool progress.** Carries `{message: string}` — a status update from a running MCP tool.                                                                                                       | **Medium**  |
| **`item/commandExecution/terminalInteraction`** | No case handler, falls to `unknown` | **Interactive stdin invisible.** Shows what input the agent typed to a running process (e.g., answering a y/n prompt).                                                                                           | **Medium**  |
| **`skills/changed`**                            | No case handler, falls to `unknown` | **Skill file changes not re-fetched mid-session.** The invalidation signal is ignored; skills loaded at thread start become stale.                                                                               | **Medium**  |
| **`thread/status/changed`**                     | Explicit ignore set                 | `systemError` variant is the only novel signal — a thread in system-error state produces no visible indication. `waitingOnApproval`/`waitingOnUserInput` flags are redundant with existing request events.       | **Low**     |
| **`item/fileChange/outputDelta`**               | No case handler, falls to `unknown` | Streaming patch application output. Lower impact than command output since patches are typically fast.                                                                                                           | **Low-Med** |
| **`thread/archived`** / **`unarchived`**        | No case handler, falls to `unknown` | Informational lifecycle in single-session CLI. No actionable consequence.                                                                                                                                        | **Low**     |
| **`account/updated`**                           | No case handler, falls to `unknown` | Mid-session plan type changes. Rare in practice.                                                                                                                                                                 | **Low**     |
| **`app/list/updated`**                          | No case handler, falls to `unknown` | Experimental app marketplace. No CLI surface.                                                                                                                                                                    | **Low**     |
| **`serverRequest/resolved`**                    | No case handler, falls to `unknown` | Protocol hygiene. `pending` map already cleaned by `sendDecision()`.                                                                                                                                             | **Low**     |
| **`fuzzyFileSearch/*`**                         | No case handler, falls to `unknown` | No CLI file picker UI. Client never initiates these sessions.                                                                                                                                                    | **Low**     |
| **`windowsSandbox/setupCompleted`**             | No case handler, falls to `unknown` | Windows-specific. Athena runs on Linux.                                                                                                                                                                          | **Low**     |
| All **`codex/event/*`**                         | Opted out + prefix drop             | **Working as intended.** V2 counterparts are handled. Legacy events correctly suppressed.                                                                                                                        | **N/A**     |

---

## 3. Server Requests Stubbed / Auto-Failed

All three are confirmed. The `emit(event)` fires before the stub response, so a collapsed `unknown.hook` debug entry exists — but it's invisible to normal users and the response is already sent before anyone could act.

### 3.1 `mcpServer/elicitation/request` — Auto-declined

**Response:** `{action: 'decline', content: null}`

**When it fires:** An MCP tool server needs user interaction — two modes: `mode: 'url'` (visit an OAuth URL) or `mode: 'form'` (fill in a JSON Schema form). Example: a GitHub MCP server requesting OAuth scope confirmation.

**What the user experiences now:** The elicitation is silently declined. The MCP tool call fails. The agent says "I couldn't complete this action." The user has no idea they needed to visit a URL. They debug the MCP server config thinking it's broken.

**What should happen:** Terminal interrupts with: `MCP Server "github" requires authorization. Visit: https://... Press Enter when done.` The turn pauses until confirmation.

**Risk: Medium-High.** Any MCP server requiring OAuth or form input triggers this. Increasingly common as MCP adoption grows.

### 3.2 `item/tool/call` (Dynamic Tools) — Auto-failed

**Response:** `{contentItems: [], success: false}`

**When it fires:** The model invokes a client-registered dynamic tool (plugin tools, custom integrations). The app-server delegates execution back to the client.

**What the user experiences now:** Tool silently returns `success: false` with empty content. The model sees failure. It tells the user "I couldn't use that tool." The user assumes the plugin is broken, when athena-cli never even tried to call it.

**What should happen:** Recognize the tool name, execute locally, return results. Or at minimum: `"Tool 'jira_search' is not supported by athena-cli"` visible in the feed.

**Risk: Low-Medium currently, growing.** Dynamic tools are the plugin ecosystem hook point.

### 3.3 `account/chatgptAuthTokens/refresh` — JSON-RPC error -32601

**Response:** `{error: {code: -32601, message: 'Athena does not implement...'}}`

**When it fires:** Token expiry during a `chatgptAuthTokens` auth mode session. The backend returns HTTP 401, app-server asks client to refresh.

**What the user experiences now:** Turn errors out mid-execution. The user sees a cryptic model error. They have no idea their session token expired. They may restart and lose thread context.

**What should happen:** Transparent token refresh, or "Your ChatGPT session has expired. Please re-authenticate."

**Risk: Low in practice** (athena likely uses `apikey` mode), but **catastrophic when triggered** — breaks entire session mid-turn, not just one tool call.

---

## 4. Item Types Missing or Partially Handled

| Item Type                                                       | Status                                                | What the User Gains With Full Implementation                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`dynamicToolCall`**                                           | Stub always fails                                     | Plugin-registered tools (browser automation, local APIs, custom scripts) could execute locally. Terminal shows tool name + arguments, execution, then results — same UX as `commandExecution`. Currently every dynamic tool silently returns empty failure.                                                                                                                                                |
| **`webSearch`**                                                 | Falls to generic `notification`                       | When Codex researches a topic, user currently sees nothing meaningful. With handling: `Searching: "react query v5 migration guide"` then `Opened: https://...` then `Found results for: ...`. The `WebSearchAction` union covers `search`, `open_page`, `find_in_page`, and `other` — full browsing visibility.                                                                                            |
| **`imageView`**                                                 | Falls to generic `notification`                       | When the agent reads a screenshot or diagram, user sees nothing. With handling: `Viewing image: /path/to/screenshot.png`. Terminal-capable image preview (sixel/kitty protocol) could render thumbnails inline. Even without that, knowing _which_ image the agent consumed is critical context.                                                                                                           |
| **`enteredReviewMode`** / **`exitedReviewMode`**                | Falls to generic `notification`                       | **Highest-information-density event in the protocol.** `ReviewOutputEvent` carries per-finding structured data: file path, line range, title, body, confidence score, priority, plus overall correctness/explanation. Currently invisible. Would render as: `Starting code review: uncommitted changes` then `Overall: mostly correct (0.87). 3 findings: [HIGH] src/auth.ts:42 — potential token leak...` |
| **`contextCompaction`**                                         | Falls to generic `notification`                       | When context gets compressed mid-session, user has no signal. Agent suddenly "forgets" earlier context and user doesn't know why. With handling: `[system] Context compacted — conversation history summarized`. A timestamped reference point explaining behavior changes.                                                                                                                                |
| **`collabToolCall`**                                            | Only first agent ID captured                          | `resolveCollabAgentId()` takes `Object.keys(agentsStates)[0]` — drops all other agents. In a 3-agent parallel task, user sees one sub-agent interaction where there were three. The `prompt`, `senderThreadId`, `receiverThreadIds`, and per-agent `message` fields are all lost. A line like `orchestrator -> agent-a, agent-b, agent-c: "write tests for auth module"` is impossible.                    |
| **Suppressed lifecycles** (`agentMessage`, `plan`, `reasoning`) | `ITEM_STARTED`/`COMPLETED` dropped before translation | The suppression avoids double-rendering of streamed content, which is valid. But `ITEM_COMPLETED` payloads carry final assembled state — the complete plan with step statuses, full reasoning summary, finalized message. These could serve as authoritative "completed" snapshots instead of requiring consumers to reconstruct from deltas.                                                              |

---

## 5. Generated Types Usage Statistics

**Total:** 486 generated types (223 v1 + 263 v2). **Actively used: ~18 (3.7%).**

| Category                  | V1 Types | V2 Types | Actively Used | Notes                                                                                                                                                         |
| ------------------------- | -------- | -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core session/turn/message | ~40      | ~40      | ~20           | All active runtime types                                                                                                                                      |
| Realtime/Audio            | 6        | 14       | 0             | Voice mode: mic capture, PCM streaming, audio output. Requires native audio addon for terminal.                                                               |
| Collaboration             | 12       | 8        | partial       | V2 `collabAgentToolCall` duck-typed; rich event stream (spawn/interaction/waiting boundaries) discarded. Full support enables live agent-tree display.        |
| Review                    | 7        | 2        | 1             | Only `ReviewDecision` used. `ReviewFinding` with file+line+confidence+priority is the structured code review output — entirely unused.                        |
| Image Generation          | 3        | 0        | 0             | DALL-E/GPT-Image results. `revised_prompt` and `result` (URL/base64) could render in terminal.                                                                |
| Web Search                | 5        | 1        | 0             | Search queries, page opens, find-in-page patterns. Full browsing visibility.                                                                                  |
| Skills                    | 6        | 12       | 0             | `skillInstructions.ts` duck-types via `asRecord()`. Typed versions would enable `SkillInterface.default_prompt` as suggested prompts, `SkillScope` filtering. |
| MCP lifecycle             | 5        | 6        | 0             | Startup progress, per-server health, failure reasons. `athena mcp status` diagnostic.                                                                         |
| Plan structure            | 5        | 4        | 2             | V2 notifications used, but `PlanItem`/`UpdatePlanArgs` (structured checklist with step statuses) unused.                                                      |
| Configuration             | 5        | 15+      | 0             | `Personality` (`none`/`friendly`/`pragmatic`), `Verbosity` (`low`/`medium`/`high`), `ServiceTier` (`fast`/`flex`), `ModeKind` (`plan`/`default`).             |
| Account/Auth              | 0        | 26       | 0             | Full auth lifecycle, rate limits, plan type.                                                                                                                  |
| App/Plugin system         | 0        | 12       | 0             | Codex app marketplace (experimental).                                                                                                                         |
| Thread management         | ~15      | 15       | 0             | Fork, rollback, archive, list, compact.                                                                                                                       |

### V2 Protocol Clarification

V2 is NOT a future protocol — it IS the active protocol. `protocol/index.ts` imports 37 v2 types with `Codex` prefix aliases. The remaining ~226 unused v2 types represent Codex capabilities not yet integrated.

---

## 6. Data Received But NOT Piped to the User

| #   | Data Loss Point                      | Where Lost                       | What's Available                                                                 | What's Kept                                                       | What the User Would See                                                                      |
| --- | ------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **Tool failure stack traces**        | `eventTranslator.ts:398-411`     | Full error object with message, code, nested causes                              | Only `error.message` string                                       | A stack trace or diagnostic context on tool failures, not just "Exit 1"                      |
| 2   | **Exit codes for non-command tools** | `eventTranslator.ts:413-420`     | `exitCode`, `durationMs` on items                                                | Only for `commandExecution`; never for `mcpToolCall`/`fileChange` | "MCP tool failed with code PERMISSION_DENIED (2.4s)" instead of bare failure                 |
| 3   | **MCP tool call metadata**           | `eventTranslator.ts:54-55`       | Separate `server`, `tool`, `durationMs`, `status` fields                         | Collapsed to `mcp:server/tool` string                             | Per-server latency tracking, tool invocation counts, filterable server/tool identity         |
| 4   | **Multi-agent collab IDs**           | `eventTranslator.ts:343-346`     | `senderThreadId`, `receiverThreadIds[]`, per-agent `{status, message}`, `prompt` | First `agentsStates` key only                                     | `orchestrator -> agent-a, agent-b, agent-c: "write tests"` with per-agent status             |
| 5   | **Plan step structure**              | `events.ts:64`                   | `TurnPlanStep[]` with `{step, status: 'pending'\|'inProgress'\|'completed'}`     | Data passes but typed as `unknown[]`                              | Progress checklist: `[x] Write tests [o] Run lint [ ] Deploy`                                |
| 6   | **Token usage context**              | `tokenUsage.ts:33,37`            | Protocol provides `total`, `last`, implicit context occupancy                    | `cacheWrite` and `contextSize` always `null`                      | "47,000 / 128,000 tokens in context" header metric; cache write cost for API spend tracking  |
| 7   | **Turn diff content**                | `server.ts:82-85`                | Aggregated unified diff of all file changes in the turn, updated live            | **Nothing — hard-dropped**                                        | Live scrolling diff panel as the agent writes code. Most impactful silent discard.           |
| 8   | **Stub request error details**       | `server.ts:94-119, 325-335`      | Stub reason (`action: 'decline'`, `success: false`, error -32601)                | Sent to Codex only, not to UI                                     | "MCP elicitation declined — athena-cli does not support interactive MCP prompts" in the feed |
| 9   | **Unknown approval decisions**       | `decisionMapper.ts:28-32, 96-99` | `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment` object variants   | Silently coerced to `'approved'` / `'accept'`                     | Persistent allowlist rules: "approve this AND always allow `git push` without asking"        |
| 10  | **File change `PatchApplyStatus`**   | `eventTranslator.ts:286-291`     | `status: 'applied'\|'partially_applied'\|'skipped'` on `fileChange` items        | Only `changes[]` array via fallback chain                         | Warning on partial patch application: "3/5 hunks applied, 2 skipped"                         |

---

## 7. Missing Capabilities and Configuration

| Capability                          | Protocol Location                                | Harness Status                                                                              | What It Enables for athena-cli Users                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`thread/fork`**                   | `ClientRequest.ts:66`, `ThreadForkParams.ts`     | Not called                                                                                  | `/fork` — branch conversation at current point. Explore two refactor approaches independently. Fork carries full config overrides (model, sandbox, instructions).                                                                                        |
| **`thread/rollback`**               | `ClientRequest.ts:90`, `ThreadRollbackParams.ts` | Not called                                                                                  | `/undo 2` — rewind conversation. Agent forgets bad turns. Athena pairs with `git checkout` for file revert (protocol note: "does not revert local file changes").                                                                                        |
| **`turn/steer`**                    | `ClientRequest.ts:117`, `TurnSteerParams.ts`     | Not called                                                                                  | Type mid-stream to redirect the agent: "focus on API endpoints instead." `expectedTurnId` guard ensures safety — if the turn completed before steer arrives, request fails cleanly instead of corrupting the next turn.                                  |
| **`outputSchema`**                  | `TurnStartParams.ts:52`                          | Not passed                                                                                  | Constrain agent output to a JSON Schema — valid JSON for downstream workflow tools. No fragile regex extraction from prose. Critical for automated pipelines.                                                                                            |
| **`dynamicTools`**                  | `ThreadStartParams.ts:24`                        | Not passed; handling stubbed                                                                | Register client-side tools at thread start. Agent invokes them during turns. Currently: tools registered nowhere, invocations auto-fail with `success: false`.                                                                                           |
| **`collaborationMode`**             | `TurnStartParams.ts:60`, `ModeKind.ts`           | Not configurable                                                                            | `/mode plan` — agent presents numbered plan, waits for confirmation, then executes. `'default'` mode behaves as today. `Settings` bundles per-mode model and reasoning overrides.                                                                        |
| **`effort`**                        | `TurnStartParams.ts:40`, `ReasoningEffort.ts`    | Not exposed                                                                                 | `--effort high` for deep chain-of-thought on hard problems. `--effort low` for fast, cheap answers to simple questions. Six levels: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.                                                                 |
| **`summary`**                       | `TurnStartParams.ts:44`, `ReasoningSummary.ts`   | Not exposed                                                                                 | `--summary detailed` for full reasoning chain. `--summary none` for clean output without reasoning traces. Four levels: `auto`/`concise`/`detailed`/`none`.                                                                                              |
| **WebSocket transport**             | Protocol-level                                   | Stdio only                                                                                  | Multiple athena instances connect to one persistent server. Remote Codex servers. Sessions survive terminal close.                                                                                                                                       |
| **`experimentalApi`**               | `InitializeCapabilities.ts:12`                   | **Already enabled**                                                                         | `experimentalApi: true` is set in `buildInitializeParams`. The gate is open — the barrier is missing call-site code, not the capability handshake.                                                                                                       |
| **`acceptWithExecpolicyAmendment`** | `CommandExecutionApprovalDecision.ts:10`         | **Type-stripped** — `Extract<..., string>` in `items.ts` excludes all object union variants | "Approve this AND add a permanent rule allowing all `git push` commands without asking." Sends `["git", "push"]` prefix to the exec policy config. Persists across sessions. Currently impossible — the type construction silently removes this variant. |

---

## Top 5 Highest-Impact Gaps

1. **`item/commandExecution/outputDelta`** — streaming command output is table-stakes terminal UX. A 30s build producing zero output is unacceptable.
2. **`turn/diff/updated`** — live diff preview while the agent writes code is the most impactful data currently hard-dropped.
3. **`error` notification** — turn-level server errors being invisible (collapsed debug entries) means users see mysterious hangs instead of actionable error messages.
4. **`turn/steer`** — mid-turn correction without interrupting is a fundamental interaction model improvement.
5. **`acceptWithExecpolicyAmendment`** — persistent approval rules would eliminate the most repetitive friction point (re-approving safe commands every session). The type is actively stripped by the harness's own type construction, making it architecturally blocked.

---

## Key Files Reference

| File                                                                            | Role                                                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/harnesses/codex/runtime/server.ts`                                         | Main runtime orchestration, ignore sets, stub responses, notification listener |
| `src/harnesses/codex/runtime/eventTranslator.ts`                                | Protocol-to-RuntimeEvent translation, all data shaping and loss points         |
| `src/harnesses/codex/runtime/appServerManager.ts`                               | Transport layer, `buildInitializeParams`, JSON-RPC wire I/O                    |
| `src/harnesses/codex/runtime/decisionMapper.ts`                                 | Approval decision mapping, silent defaults                                     |
| `src/harnesses/codex/runtime/mapper.ts`                                         | RuntimeEvent wrapping, `unknown` kind feed mapping                             |
| `src/harnesses/codex/runtime/tokenUsage.ts`                                     | Token usage calculation, hardcoded null fields                                 |
| `src/harnesses/codex/runtime/skillInstructions.ts`                              | Skills API integration (duck-typed)                                            |
| `src/harnesses/codex/session/useSessionController.ts`                           | Session-level event consumption                                                |
| `src/harnesses/codex/session/promptOptions.ts`                                  | Prompt configuration surface                                                   |
| `src/harnesses/codex/protocol/methods.ts`                                       | Method name constants                                                          |
| `src/harnesses/codex/protocol/index.ts`                                         | Curated type re-exports (41 types)                                             |
| `src/harnesses/codex/protocol/items.ts`                                         | Derived union types, type-stripping of approval variants                       |
| `src/harnesses/codex/protocol/generated/index.ts`                               | V1 barrel (223 types)                                                          |
| `src/harnesses/codex/protocol/generated/v2/index.ts`                            | V2 barrel (263 types)                                                          |
| `src/harnesses/codex/protocol/generated/ClientRequest.ts`                       | Full protocol method surface (40+ methods)                                     |
| `src/harnesses/codex/protocol/generated/v2/TurnStartParams.ts`                  | Per-turn params (`effort`, `summary`, `outputSchema`, `collaborationMode`)     |
| `src/harnesses/codex/protocol/generated/v2/ThreadStartParams.ts`                | Thread-level params including `dynamicTools`                                   |
| `src/harnesses/codex/protocol/generated/v2/CommandExecutionApprovalDecision.ts` | Full approval decision union including `acceptWithExecpolicyAmendment`         |
| `src/core/runtime/events.ts`                                                    | `RuntimeEventDataMap` type declarations                                        |
| `src/core/runtime/types.ts`                                                     | `RuntimeEvent` and `RuntimeDecision` contracts                                 |
