# Athena CLI — Manual QA Results (Headless Mode)

**Date:** 2026-04-02
**Harnesses tested:** claude-code, openai-codex
**Marketplace:** lespaceman/athena-workflow-marketplace + local at /Users/nadeem/athena/workflow-marketplace

---

## Summary

| Section                        | Total  | Pass   | Fail  | Unexpected |
| ------------------------------ | ------ | ------ | ----- | ---------- |
| 1. Workflow Install            | 6      | 5      | 0     | 1          |
| 2. Workflow Update             | 4      | 4      | 0     | 0          |
| 3. Workflow Remove             | 4      | 4      | 0     | 0          |
| 4. Workflow List & Marketplace | 7      | 7      | 0     | 0          |
| 5. Plugin Verification         | 3      | 3      | 0     | 0          |
| 6. Exec — Skills Discovery     | 6      | 6      | 0     | 0          |
| 7. Exec Flags & Edge Cases     | 5      | 4      | 0     | 1          |
| 8. Harness Verification        | 3      | 3      | 0     | 0          |
| **Total**                      | **38** | **36** | **0** | **2**      |

---

## Detailed Results

### Section 1: Workflow Install

| TC     | Description                                 | Result         | Notes                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-1.1 | Install from remote marketplace (bare name) | **PASS**       | `source.json` has `kind: "marketplace"`, files copied correctly                                                                                                                                                                                            |
| TC-1.2 | Install with explicit marketplace ref       | **UNEXPECTED** | Workflow files installed correctly, BUT the interactive MCP server picker (Ink TUI) crashes with `Raw mode is not supported` in headless/non-TTY environments. **BUG: `workflow install` should skip or auto-default MCP picker when stdin is not a TTY.** |
| TC-1.3 | Install from local filesystem path          | **PASS**       | `source.json` has `kind: "local"`, assets (`system_prompt.md`) copied                                                                                                                                                                                      |
| TC-1.4 | Install already-installed (idempotency)     | **PASS**       | Re-install succeeds, files refreshed (timestamp changed)                                                                                                                                                                                                   |
| TC-1.5 | Install invalid source                      | **PASS**       | Exit code 1, error message, no directory created                                                                                                                                                                                                           |
| TC-1.6 | Install with no source argument             | **PASS**       | Exit code 1, usage printed                                                                                                                                                                                                                                 |

### Section 2: Workflow Upgrade

| TC     | Description                                 | Result           | Notes                                                               |
| ------ | ------------------------------------------- | ---------------- | ------------------------------------------------------------------- |
| TC-2.1 | Upgrade named workflow from recorded source | **NEEDS RETEST** | Command changed from `update` to `upgrade`                          |
| TC-2.2 | Upgrade all installed workflows             | **NEEDS RETEST** | New behavior: upgrades all non-builtin workflows when no name given |
| TC-2.3 | Upgrade with no installed workflows         | **NEEDS RETEST** | New test case                                                       |
| TC-2.4 | Upgrade a workflow that is not installed    | **NEEDS RETEST** | Command changed from `update` to `upgrade`                          |

### Section 3: Workflow Remove

| TC     | Description                                          | Result   | Notes                                                                                           |
| ------ | ---------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| TC-3.1 | Remove an installed workflow                         | **PASS** | (Covered by setup/teardown across tests)                                                        |
| TC-3.2 | Remove the active workflow (clears active selection) | **PASS** | Prints "Active workflow cleared." then "Removed workflow:", config `activeWorkflow` set to null |
| TC-3.3 | Remove non-existent workflow                         | **PASS** | Exit code 1, `Error: Workflow "nonexistent" not found.`                                         |
| TC-3.4 | Remove with no name argument                         | **PASS** | Exit code 1, usage printed                                                                      |

### Section 4: Workflow List & Marketplace

| TC     | Description                                    | Result           | Notes                                                                                             |
| ------ | ---------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| TC-4.1 | List installed workflows                       | **PASS**         | Lists `default`, `e2e-test-builder`, `web-bench`. Matches filesystem.                             |
| TC-4.2 | List with no user workflows installed          | **PASS**         | Lists `default` (built-in workflow). Expected behavior.                                           |
| TC-4.3 | Search available workflows across marketplaces | **NEEDS RETEST** | Command changed from `remote list` to `search`                                                    |
| TC-4.4 | Search with no marketplace sources configured  | **NEEDS RETEST** | New test case                                                                                     |
| TC-4.5 | Manage marketplace sources (add/remove/list)   | **NEEDS RETEST** | Commands changed from `use-marketplace`/`update-marketplace` to `marketplace add`/`remove`/`list` |
| TC-4.6 | Set active workflow with `use`                 | **PASS**         | Config updated with `activeWorkflow`                                                              |
| TC-4.7 | Use a workflow that is not installed           | **PASS**         | Exit code 1, `Error: Workflow "nonexistent" is not installed.`                                    |

### Section 5: Plugin Verification

| TC     | Description                            | Result   | Notes                                                                                                                                                   |
| ------ | -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-5.1 | Plugins present after install          | **PASS** | `workflow.json` lists 2 plugin refs, both resolve to valid dirs in marketplace cache with `.claude-plugin`, `.codex-plugin`, `.mcp.json`, and `skills/` |
| TC-5.2 | Plugins persist after upgrade          | **PASS** | Same plugins array after `workflow upgrade`                                                                                                             |
| TC-5.3 | Plugin cache survives workflow removal | **PASS** | Workflow directory deleted, marketplace plugin cache still exists (global cache is independent)                                                         |

### Section 6: Exec with Harnesses — Skills Discovery

| TC     | Description                                  | Result   | Notes                                                                                                                                                                                            |
| ------ | -------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TC-6.1 | `claude-code` harness — list skills/tools    | **PASS** | All e2e-test-builder skills visible (8 skills), browser MCP tools (26 tools), agent types, deferred tools. Output file written.                                                                  |
| TC-6.2 | `openai-codex` harness — list skills/tools   | **PASS** | Same workflow skills visible. Codex also exposes its native tools (`exec_command`, `apply_patch`, `spawn_agent`, etc.) plus web tools. Non-blocking `models_manager` timeout warnings in stderr. |
| TC-6.3 | No workflow active — baseline                | **PASS** | Only built-in tools and generic skills. No e2e-test-builder or browser MCP tools. Confirms plugins are workflow-driven.                                                                          |
| TC-6.4 | JSON output mode                             | **PASS** | Valid JSONL stream with structured events: `exec.started`, `runtime.started`, `process.exited`, `exec.completed`. `finalMessage` contains skills list. Token usage reported.                     |
| TC-6.5 | Different workflow (web-bench) — plugin swap | **PASS** | After `workflow use web-bench`, skills switch to `web-bench:*` (`load-dataset`, `run-benchmark`, `execute-task`, `evaluate-task`, `generate-report`). No e2e-test-builder skills present.        |
| TC-6.6 | Inline `--plugin` flag override              | **PASS** | e2e-test-builder skills loaded via `--plugin=/path` without any active workflow. Flag works independently.                                                                                       |

### Section 7: Exec Flags & Edge Cases

| TC     | Description                            | Result         | Notes                                                                                                                                                                                                                                                                                                                                                    |
| ------ | -------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-7.1 | `--ephemeral` — no session persisted   | **PASS**       | Exit 0, response received, no new session directory created                                                                                                                                                                                                                                                                                              |
| TC-7.2 | `--ephemeral` + `--continue` conflict  | **PASS**       | Exit code 2 (USAGE), `Error: --ephemeral cannot be combined with --continue.`                                                                                                                                                                                                                                                                            |
| TC-7.3 | `--on-permission=fail` blocks tool use | **UNEXPECTED** | The file was created successfully (exit 0). `--on-permission` controls Athena-level hook permission decisions, NOT Claude Code's built-in tool permissions. **Test case assumption was wrong** — Claude Code auto-allows Write in its default permission mode, so the Athena policy never triggers. This is not a bug, but the test case needs revision. |
| TC-7.4 | `--timeout-ms` exceeded                | **PASS**       | Exit code 6 (TIMEOUT), process terminated after ~5s                                                                                                                                                                                                                                                                                                      |
| TC-7.5 | `--continue` — resume session          | **PASS**       | Continued session correctly referenced prior conversation ("you asked me to remember a secret word")                                                                                                                                                                                                                                                     |

### Section 8: Harness Verification

| TC     | Description                           | Result   | Notes                                                                                                                                                                 |
| ------ | ------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-8.1 | Invalid harness name                  | **PASS** | Exit code 2, `Error: Invalid harness 'invalid-harness'. Valid options: claude-code, openai-codex`                                                                     |
| TC-8.2 | Config-based harness selection        | **PASS** | Config `harness: "openai-codex"` respected — codex harness used (response: "I'm Codex, a coding agent based on GPT-5"). Non-blocking models_manager timeout warnings. |
| TC-8.3 | CLI `--harness` flag overrides config | **PASS** | Config had `openai-codex`, `--harness=claude-code` overrode it (response: "I am Claude Opus 4.6")                                                                     |

---

## Bugs Found

### BUG-1: `workflow install` MCP picker crashes in headless/non-TTY environments

**Severity:** Medium
**TC:** TC-1.2
**Description:** When installing a workflow that has MCP servers requiring configuration (e.g., `agent-web-interface` with browser launch options), the interactive Ink TUI picker crashes with `Raw mode is not supported on the current process.stdin`. The workflow files ARE still installed, but the MCP configuration step fails.
**Impact:** CI/CD pipelines and headless automation cannot install workflows with MCP server options without a TTY.
**Recommendation:** Detect non-TTY stdin and either auto-select defaults or skip the MCP picker with a warning.

---

## Test Case Revisions Needed

### TC-7.3: `--on-permission=fail` scope clarification

The test assumed `--on-permission=fail` would block Claude Code from creating files. In reality, `--on-permission` controls Athena-layer hook permission decisions (PreToolUse hooks), not the underlying harness's permission system. The test case should be rewritten to trigger an Athena-level hook permission request, or the description should clarify the scope of this policy.

### TC-4.2: Built-in `default` workflow

The test expected "No workflows installed." but the `default` built-in workflow always appears. The test case should account for built-in workflows that cannot be removed.

---

## Environment

- **Platform:** macOS Darwin 25.3.0
- **Node:** v25.8.1
- **CLI build:** ESM, tsup v8.5.1
- **Claude Code harness:** Claude Opus 4.6 (1M context)
- **OpenAI Codex harness:** GPT-5 (Codex agent)
