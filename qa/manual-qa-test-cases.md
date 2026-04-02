# Athena CLI - Manual QA Test Cases (Headless Mode)

All tests use `athena-flow` CLI in non-interactive/headless mode.
Verification steps inspect the filesystem and config to confirm operations took effect.

**Prerequisites:**

- `athena-flow` built and available (`npm run start` or `node dist/cli.js`)
- Network access for remote marketplace tests
- Local marketplace at `/Users/nadeem/athena/workflow-marketplace` (or adjust paths)
- Remote marketplace: `lespaceman/athena-workflow-marketplace`
- Both `claude-code` and `openai-codex` harnesses installed and authenticated

---

## Section 1: Workflow Install

### TC-1.1 Install workflow from remote marketplace (bare name)

**Precondition:** Marketplace configured via `athena-flow marketplace add lespaceman/athena-workflow-marketplace`. Workflow `e2e-test-builder` is NOT installed (remove first if present).

**Steps:**

1. Run `athena-flow workflow install e2e-test-builder`
2. Run `athena-flow workflow list`

**Verification:**

- Step 1 prints `Installed workflow: e2e-test-builder (x.x.x)` with exit code 0
- Step 2 output includes `e2e-test-builder`
- Directory `~/.config/athena/workflows/e2e-test-builder/` exists and contains `workflow.json` and `source.json`
- `source.json` records the marketplace origin (kind: `"local"` pointing to cached repo, or kind referencing the marketplace)

---

### TC-1.2 Install workflow from remote marketplace (explicit ref)

**Precondition:** Workflow `web-bench` is NOT installed.

**Steps:**

1. Run `athena-flow workflow install web-bench@lespaceman/athena-workflow-marketplace`
2. Run `athena-flow workflow list`

**Verification:**

- Step 1 prints `Installed workflow: web-bench` with exit code 0
- Step 2 lists `web-bench`
- `~/.config/athena/workflows/web-bench/workflow.json` exists and is valid JSON
- `~/.config/athena/workflows/web-bench/source.json` references the explicit marketplace ref

---

### TC-1.3 Install workflow from local filesystem path

**Precondition:** A valid workflow JSON exists at a local path (e.g., `/Users/nadeem/athena/workflow-marketplace/workflows/e2e-test-builder/workflow.json`). Workflow is NOT already installed.

**Steps:**

1. Run `athena-flow workflow install /Users/nadeem/athena/workflow-marketplace/workflows/e2e-test-builder/workflow.json`
2. Run `athena-flow workflow list`

**Verification:**

- Step 1 prints `Installed workflow: e2e-test-builder` with exit code 0
- `~/.config/athena/workflows/e2e-test-builder/source.json` has `kind: "local"` with the filesystem path
- All referenced assets (e.g., `system_prompt.md`) are copied into the workflow directory

---

### TC-1.4 Install workflow that is already installed (idempotency)

**Precondition:** `e2e-test-builder` is already installed.

**Steps:**

1. Note the modification timestamp of `~/.config/athena/workflows/e2e-test-builder/workflow.json`
2. Run `athena-flow workflow install e2e-test-builder`
3. Note the new modification timestamp

**Verification:**

- Step 2 succeeds with exit code 0
- The workflow files are refreshed (timestamp updated)
- `workflow.json` content remains valid

---

### TC-1.5 Install workflow with invalid source

**Steps:**

1. Run `athena-flow workflow install nonexistent-workflow-xyz`

**Verification:**

- Command exits with code 1
- stderr contains an `Error:` message indicating the workflow was not found
- No directory created under `~/.config/athena/workflows/nonexistent-workflow-xyz/`

---

### TC-1.6 Install with no source argument

**Steps:**

1. Run `athena-flow workflow install`

**Verification:**

- Exit code 1
- stderr prints usage: `Usage: athena-flow workflow install <source>`

---

## Section 2: Workflow Upgrade

### TC-2.1 Upgrade a named workflow from its recorded source

**Precondition:** `e2e-test-builder` is installed from the local marketplace.

**Steps:**

1. Manually edit `~/.config/athena/workflows/e2e-test-builder/workflow.json` to add a dummy field (e.g., `"_test": true`)
2. Run `athena-flow workflow upgrade e2e-test-builder`
3. Read `~/.config/athena/workflows/e2e-test-builder/workflow.json`

**Verification:**

- Step 2 prints `Upgraded workflow: e2e-test-builder` with exit code 0
- The dummy `_test` field is gone — the file matches the source
- All referenced assets (e.g., `system_prompt.md`) are also refreshed

---

### TC-2.2 Upgrade all installed workflows

**Precondition:** Multiple non-builtin workflows are installed (e.g., `e2e-test-builder` and `web-bench`).

**Steps:**

1. Run `athena-flow workflow upgrade`

**Verification:**

- Exits with code 0
- Output says `Upgraded workflow: ...` for each non-builtin installed workflow
- Builtin workflows (e.g., `default`) are skipped

---

### TC-2.3 Upgrade with no installed workflows

**Precondition:** Remove all non-builtin workflows.

**Steps:**

1. Run `athena-flow workflow upgrade`

**Verification:**

- Exit code 0
- Output: `No installed workflows to upgrade.`

---

### TC-2.4 Upgrade a workflow that is not installed

**Steps:**

1. Run `athena-flow workflow upgrade fake-workflow`

**Verification:**

- Exit code 1
- stderr contains `Error:` indicating the workflow is not found

---

## Section 3: Workflow Remove

### TC-3.1 Remove an installed workflow

**Precondition:** `e2e-test-builder` is installed and is NOT the active workflow.

**Steps:**

1. Run `athena-flow workflow remove e2e-test-builder`
2. Run `athena-flow workflow list`

**Verification:**

- Step 1 prints `Removed workflow: e2e-test-builder` with exit code 0
- Step 2 does NOT list `e2e-test-builder`
- Directory `~/.config/athena/workflows/e2e-test-builder/` is deleted

---

### TC-3.2 Remove the active workflow (clears active selection)

**Precondition:** `e2e-test-builder` is installed AND is the active workflow (`activeWorkflow: "e2e-test-builder"` in config).

**Steps:**

1. Run `athena-flow workflow remove e2e-test-builder`
2. Read `~/.config/athena/config.json`

**Verification:**

- Step 1 prints `Active workflow cleared.` followed by `Removed workflow: e2e-test-builder`
- Config file no longer has `activeWorkflow` set (or it is `undefined`/absent)

---

### TC-3.3 Remove a workflow that is not installed

**Steps:**

1. Run `athena-flow workflow remove nonexistent`

**Verification:**

- Exit code 1
- stderr contains `Error:`

---

### TC-3.4 Remove with no name argument

**Steps:**

1. Run `athena-flow workflow remove`

**Verification:**

- Exit code 1
- stderr prints usage: `Usage: athena-flow workflow remove <name>`

---

## Section 4: Workflow List & Marketplace

### TC-4.1 List installed workflows

**Precondition:** At least one workflow is installed.

**Steps:**

1. Run `athena-flow workflow list`

**Verification:**

- Exit code 0
- Each installed workflow name (and version if present) is printed, one per line
- Output matches directories under `~/.config/athena/workflows/`

---

### TC-4.2 List with no workflows installed

**Precondition:** Remove all workflows.

**Steps:**

1. Run `athena-flow workflow list`

**Verification:**

- Exit code 0
- Output: `No workflows installed.`

---

### TC-4.3 Search available workflows across marketplaces

**Precondition:** At least one marketplace source configured via `athena-flow marketplace add`.

**Steps:**

1. Run `athena-flow workflow search`

**Verification:**

- Exit code 0
- Lists available workflows from all configured marketplaces with name, version, description

---

### TC-4.4 Search with no marketplace sources configured

**Precondition:** No marketplace sources configured (empty `workflowMarketplaceSources` in config).

**Steps:**

1. Run `athena-flow workflow search`

**Verification:**

- Exit code 0
- Falls back to the default marketplace (`lespaceman/athena-workflow-marketplace`)
- Lists workflows from the default marketplace

---

### TC-4.5 Manage marketplace sources

**Steps:**

1. Run `athena-flow marketplace add lespaceman/athena-workflow-marketplace`
2. Run `athena-flow marketplace list`
3. Run `athena-flow marketplace add /Users/nadeem/athena/workflow-marketplace`
4. Run `athena-flow marketplace list`
5. Run `athena-flow marketplace remove /Users/nadeem/athena/workflow-marketplace`
6. Run `athena-flow marketplace list`

**Verification:**

- Step 1 prints `Added marketplace: lespaceman/athena-workflow-marketplace`
- Step 2 lists `lespaceman/athena-workflow-marketplace`
- Step 3 prints `Added marketplace: /Users/nadeem/athena/workflow-marketplace`
- Step 4 lists both sources
- Step 5 prints `Removed marketplace: /Users/nadeem/athena/workflow-marketplace`
- Step 6 lists only `lespaceman/athena-workflow-marketplace`
- Config `workflowMarketplaceSources` array is updated after each step

---

### TC-4.6 Set active workflow with `use`

**Precondition:** `e2e-test-builder` is installed.

**Steps:**

1. Run `athena-flow workflow use e2e-test-builder`
2. Read `~/.config/athena/config.json`

**Verification:**

- Step 1 prints `Active workflow: e2e-test-builder`
- Config has `"activeWorkflow": "e2e-test-builder"`

---

### TC-4.7 Use a workflow that is not installed

**Steps:**

1. Run `athena-flow workflow use nonexistent`

**Verification:**

- Exit code 1
- stderr: `Error: Workflow "nonexistent" is not installed.`

---

## Section 5: Plugin Verification After Workflow Operations

### TC-5.1 Verify plugins are present after install

**Precondition:** Install `e2e-test-builder` workflow.

**Steps:**

1. Run `athena-flow workflow install e2e-test-builder`
2. Read `~/.config/athena/workflows/e2e-test-builder/workflow.json`
3. For each plugin listed in the `plugins` array, verify the plugin is resolvable by checking the marketplace cache

**Verification:**

- `workflow.json` `plugins` array is non-empty (expects `agent-web-interface@...` and `e2e-test-builder@...`)
- Each plugin ref points to a valid directory in the marketplace cache under `~/.config/athena/marketplaces/`
- Plugin directories contain expected files (e.g., `plugin.json`, skill files, agent definitions)

---

### TC-5.2 Verify plugins persist after workflow upgrade

**Steps:**

1. Run `athena-flow workflow upgrade e2e-test-builder`
2. Read `~/.config/athena/workflows/e2e-test-builder/workflow.json`

**Verification:**

- `plugins` array still lists the same plugins as before the update
- Marketplace-cached plugin directories still exist and are intact

---

### TC-5.3 Verify plugins are unreferenced after workflow remove

**Steps:**

1. Note the plugins in `e2e-test-builder` workflow before removal
2. Run `athena-flow workflow remove e2e-test-builder`
3. Check that no `~/.config/athena/workflows/e2e-test-builder/` directory remains

**Verification:**

- Workflow directory is gone
- Marketplace plugin cache MAY still exist (plugins are cached globally, not per-workflow)

---

## Section 6: Exec with Different Harnesses — Skills & Tools Discovery

These tests run `athena-flow exec` in headless mode and ask the agent to report what skills, tools, and plugins it can access. This validates that the workflow's plugins are correctly loaded into the harness runtime.

### TC-6.1 Exec with `claude-code` harness — list skills and tools

**Precondition:** `e2e-test-builder` workflow installed and set as active. Claude Code harness is authenticated.

**Steps:**

1. Run:
   ```
   athena-flow exec "List all the skills and tools you have access to. Include skill names, agent names, and any MCP tools. Format as a bulleted list." \
     --harness claude-code \
     --on-permission=allow \
     --on-question=empty \
     --timeout-ms=120000 \
     --output-last-message=/tmp/qa-claude-skills.txt
   ```
2. Read `/tmp/qa-claude-skills.txt`

**Verification:**

- Exit code 0
- Output contains skills from the `e2e-test-builder` plugin (e.g., `analyze-test-codebase`, `review-test-cases`, `add-e2e-tests`, `write-test-code`, `generate-test-cases`, `plan-test-coverage`, `review-test-code`, `fix-flaky-tests`)
- Output contains skills/tools from the `agent-web-interface` plugin (e.g., browser navigation tools like `navigate`, `click`, `screenshot`, `read_page`)
- Output lists available agents from the plugins
- The model confirms it can use these tools (not just see them)

---

### TC-6.2 Exec with `openai-codex` harness — list skills and tools

**Precondition:** Same as TC-6.1 but using codex. OpenAI Codex harness is authenticated.

**Steps:**

1. Run:
   ```
   athena-flow exec "List all the skills and tools you have access to. Include skill names, agent names, and any MCP tools. Format as a bulleted list." \
     --harness openai-codex \
     --on-permission=allow \
     --on-question=empty \
     --timeout-ms=120000 \
     --output-last-message=/tmp/qa-codex-skills.txt
   ```
2. Read `/tmp/qa-codex-skills.txt`

**Verification:**

- Exit code 0
- Output contains the same plugin-provided skills and tools as TC-6.1
- The codex harness surfaces the plugin capabilities equivalently to claude-code

---

### TC-6.3 Exec with no workflow active — baseline tool check

**Precondition:** No active workflow set. Clear `activeWorkflow` from config.

**Steps:**

1. Run:
   ```
   athena-flow exec "List all the skills and tools you have access to." \
     --harness claude-code \
     --on-permission=allow \
     --on-question=empty \
     --timeout-ms=60000 \
     --output-last-message=/tmp/qa-baseline-skills.txt
   ```
2. Read `/tmp/qa-baseline-skills.txt`

**Verification:**

- Exit code 0
- Output does NOT contain workflow-specific skills (no `e2e-test-builder` skills, no `agent-web-interface` tools)
- Only default/built-in tools are listed (Read, Write, Edit, Bash, Grep, Glob, Agent, etc.)

---

### TC-6.4 Exec with JSON output — verify structured skill reporting

**Precondition:** `e2e-test-builder` workflow is active.

**Steps:**

1. Run:
   ```
   athena-flow exec "List your available skills briefly." \
     --harness claude-code \
     --json \
     --on-permission=allow \
     --on-question=empty \
     --timeout-ms=60000
   ```
2. Capture stdout

**Verification:**

- Exit code 0
- stdout contains valid JSONL (one JSON object per line)
- The assistant's response within the JSON events mentions the workflow plugin skills

---

### TC-6.5 Exec with different workflow — verify plugin swap

**Precondition:** Two workflows installed (e.g., `e2e-test-builder` and `web-bench`). Switch active workflow to `web-bench`.

**Steps:**

1. Run `athena-flow workflow use web-bench`
2. Run:
   ```
   athena-flow exec "List all the skills and tools you have access to." \
     --harness claude-code \
     --on-permission=allow \
     --on-question=empty \
     --timeout-ms=120000 \
     --output-last-message=/tmp/qa-web-bench-skills.txt
   ```
3. Read `/tmp/qa-web-bench-skills.txt`

**Verification:**

- Output lists skills specific to the `web-bench` workflow, NOT `e2e-test-builder`-only skills
- Plugin set matches what is declared in `web-bench`'s `workflow.json` `plugins` array

---

### TC-6.6 Exec with inline `--plugin` flag override

**Precondition:** No active workflow. A plugin directory exists on disk.

**Steps:**

1. Run:
   ```
   athena-flow exec "List all the skills and tools you have access to." \
     --plugin=/path/to/a/known/plugin \
     --harness claude-code \
     --on-permission=allow \
     --on-question=empty \
     --timeout-ms=60000 \
     --output-last-message=/tmp/qa-inline-plugin-skills.txt
   ```
2. Read `/tmp/qa-inline-plugin-skills.txt`

**Verification:**

- Exit code 0
- Output includes skills/tools from the explicitly specified plugin directory
- Demonstrates that `--plugin` flag works independently of workflows

---

## Section 7: Exec Mode Flags & Edge Cases

### TC-7.1 Exec with `--ephemeral` — no session persisted

**Steps:**

1. Run:
   ```
   athena-flow exec "Say hello" \
     --ephemeral \
     --on-permission=deny \
     --on-question=empty \
     --timeout-ms=30000
   ```
2. Check `~/.config/athena/sessions/` for new entries

**Verification:**

- Exit code 0
- No new session file created for this run

---

### TC-7.2 Exec with `--ephemeral` and `--continue` (conflict)

**Steps:**

1. Run:
   ```
   athena-flow exec "test" --ephemeral --continue
   ```

**Verification:**

- Exit code 2 (USAGE)
- stderr: `Error: --ephemeral cannot be combined with --continue.`

---

### TC-7.3 Exec with `--on-permission=fail` and tool requiring permission

**Steps:**

1. Run:
   ```
   athena-flow exec "Create a file called /tmp/qa-test-permission.txt with the text hello" \
     --on-permission=fail \
     --on-question=empty \
     --timeout-ms=30000
   ```

**Verification:**

- Exit code 5 (POLICY) — execution fails because a permission was needed but policy is `fail`
- File `/tmp/qa-test-permission.txt` is NOT created

---

### TC-7.4 Exec with `--timeout-ms` exceeded

**Steps:**

1. Run:
   ```
   athena-flow exec "Count to a million slowly" \
     --on-permission=deny \
     --on-question=empty \
     --timeout-ms=5000
   ```

**Verification:**

- Exit code 6 (TIMEOUT)
- Process terminates after ~5 seconds

---

### TC-7.5 Exec with `--continue` — resume session

**Precondition:** A previous exec session exists.

**Steps:**

1. Run:
   ```
   athena-flow exec "What was discussed in the previous message?" \
     --continue \
     --on-permission=deny \
     --on-question=empty \
     --timeout-ms=60000 \
     --output-last-message=/tmp/qa-continue.txt
   ```
2. Read `/tmp/qa-continue.txt`

**Verification:**

- Exit code 0
- The response references context from the prior session, confirming session continuity

---

## Section 8: Harness Verification

### TC-8.1 Exec with invalid harness name

**Steps:**

1. Run `athena-flow exec "hello" --harness=invalid-harness`

**Verification:**

- Non-zero exit code
- Error message about unrecognized harness

---

### TC-8.2 Verify harness selection from config

**Precondition:** `~/.config/athena/config.json` has `"harness": "openai-codex"`.

**Steps:**

1. Run `athena-flow exec "What model are you?" --on-permission=deny --on-question=empty --timeout-ms=30000 --output-last-message=/tmp/qa-config-harness.txt` (no `--harness` flag)
2. Read output

**Verification:**

- The exec runs using the codex harness (observable via `--verbose` output or model self-identification)
- CLI `--harness` flag was not needed; config was respected

---

### TC-8.3 CLI `--harness` flag overrides config

**Precondition:** Config has `"harness": "openai-codex"`.

**Steps:**

1. Run `athena-flow exec "What model are you?" --harness=claude-code --on-permission=deny --on-question=empty --timeout-ms=30000 --verbose`

**Verification:**

- Verbose output shows the `claude-code` harness was used, overriding the config setting
