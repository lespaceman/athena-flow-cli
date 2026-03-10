# Codex-Native Workflow And Plugin Execution

## Goal

Make Athena workflows harness-neutral at bootstrap time, then let each harness
consume a compiled workflow plan instead of re-resolving marketplace/plugin
state during session start.

This is required because:

- Claude executes a prompt by spawning `claude -p`.
- Codex executes a prompt by opening or resuming a thread and starting turns on
  `codex app-server`.
- Workflow packaging today is shared, but workflow execution is still
  Claude-first.

## Packaging Model

Keep one shared workflow manifest:

- `workflow.json`

Allow optional harness-specific assets beside it:

- `.claude/`
- `.codex/`

Recommended marketplace shape:

```text
workflows/<name>/
  workflow.json
  system_prompt.md
  .claude/workflow.json
  .codex/workflow.json

plugins/<name>/
  .claude-plugin/plugin.json
  .mcp.json
  skills/                 # shared only if neutral
  .claude/skills/
  .claude/hooks/
  .codex/plugin.json
  .codex/skills/
```

## Execution Model

### Shared bootstrap product

Bootstrap should resolve a workflow once and emit a `WorkflowPlan`:

- `workflow`
- `pluginDirs`
- `pluginMcpConfig`

This phase is implemented.

### Harness consumption

- Claude consumes the plan indirectly through existing workflow/session and MCP
  wiring.
- Codex consumes the plan directly to derive:
  - skill roots
  - Codex MCP config
  - future Codex-native skill and mention inputs

## Phases

### Phase 1: Compiled plan

Implemented:

- add `WorkflowPlan`
- compile it during bootstrap
- thread it through exec and interactive session contracts
- stop Codex prompt setup from re-installing workflow plugins in the hot path

### Phase 2: Codex-native skill execution

Next:

- stop relying on injected prose skill inventory as the primary execution path
- compile workflow/plugin skill definitions into Codex-native turn inputs
  - `{"type":"skill","name","path"}`
  - `mention` items where appropriate
- add workflow entrypoint routing for Codex

### Phase 3: Marketplace split

Next:

- add `.codex/` assets to workflow marketplace packages
- migrate Claude-specific slash-command instructions out of shared `SKILL.md`
- replace `CLAUDE_PLUGIN_ROOT` assumptions with Athena-neutral plugin-root
  semantics

### Phase 4: Native plugin runtime parity

Next:

- map workflow/plugin MCP config into stable Codex thread config
- support disabled-skill filtering and skill invalidation cleanly
- decide whether Athena needs Codex `plugin://` mentions in addition to
  `skill` inputs

## Success Criteria

- workflow/plugin resolution happens once during bootstrap
- Codex no longer depends on Claude-style prompt prose for workflow execution
- shared workflow orchestration remains Athena-owned
- marketplace packages can ship both Claude and Codex assets without forking
  the shared workflow manifest
