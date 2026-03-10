# Athenaflow CLI

[![npm version](https://img.shields.io/npm/v/@athenaflow/cli)](https://www.npmjs.com/package/@athenaflow/cli)
[![license](https://img.shields.io/npm/l/@athenaflow/cli)](https://github.com/lespaceman/athena-flow-cli/blob/main/LICENSE)
[![CI](https://github.com/lespaceman/athena-flow-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/lespaceman/athena-flow-cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@athenaflow/cli)](https://nodejs.org)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025e8c?logo=dependabot)](https://github.com/lespaceman/athena-flow-cli/security/dependabot)
[![Vulnerabilities](https://snyk.io/test/github/lespaceman/athena-flow-cli/badge.svg)](https://snyk.io/test/github/lespaceman/athena-flow-cli)

Athenaflow CLI is a workflow runtime for AI coding harnesses.
It currently supports both [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and OpenAI Codex, orchestrates workflows and plugins, and provides an interactive terminal runtime for observability and control.
The runtime normalizes harness-specific events into a shared feed so the same Athena session UX works across supported backends.

## Install

```bash
npm install -g @athenaflow/cli
```

Requires Node.js >= 20.

Install at least one supported harness:

- `claude-code`: install Claude Code and make sure `claude` is on `PATH`
- `openai-codex`: install the Codex CLI and make sure `codex` is on `PATH`

## Quick Start

```bash
# Launch in your project directory
athena

# Or use the full command name
athena-flow
```

On first run, a setup wizard guides theme selection, harness verification, and workflow activation. The workflow step discovers published workflows from the Athena marketplace dynamically.

## Usage

```bash
athena-flow                             # Start in current project directory
athena-flow --project-dir=/my/project   # Specify project directory
athena-flow setup                       # Re-run setup wizard
athena-flow sessions                    # Pick a session interactively
athena-flow resume                      # Resume most recent session
athena-flow resume <sessionId>          # Resume specific session
athena-flow exec "summarize repo state" # Non-interactive run (CI/script)
athena-flow workflow list               # List installed workflows
athena-flow workflow install <source>   # Install workflow from configured marketplace name, marketplace ref, or local workflow.json
athena-flow workflow use-marketplace <source>  # Set workflow marketplace source (owner/repo or local path)
athena-flow workflow update [name]      # Re-sync a workflow from its recorded source
athena-flow workflow update-marketplace # Refresh the current workflow marketplace source
athena-flow --help                      # Show full command/flag manual
athena-flow --version                   # Print CLI version
```

## What Athena Does

Athena runs as a workflow runtime around supported coding harnesses:

1. Connects to the selected harness event stream.
2. Normalizes runtime events into a shared Athena feed model.
3. Applies workflow, plugin, and isolation policy.
4. Persists session state and renders live runtime state in the terminal.

```
Claude Code hooks / Codex app-server -> athena-flow runtime -> terminal UI + session store
```

## Harness Support

| Harness        | Status    | Integration                                                 |
| -------------- | --------- | ----------------------------------------------------------- |
| `claude-code`  | Supported | Claude Code hooks forwarded into Athena over a local socket |
| `openai-codex` | Supported | OpenAI Codex runtime integrated through `codex app-server`  |
| `opencode`     | Planned   | Adapter placeholder only; not yet enabled                   |

## CLI Options

| Flag            | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `--project-dir` | Project directory for hook socket (default: cwd)              |
| `--plugin`      | Path to a plugin directory (repeatable)                       |
| `--isolation`   | Isolation preset: `strict` (default), `minimal`, `permissive` |
| `--theme`       | Color theme: `dark` (default), `light`, `high-contrast`       |
| `--ascii`       | Use ASCII-only UI glyphs for compatibility                    |
| `--verbose`     | Show additional rendering detail                              |

`exec`-only flags:

| Flag                    | Description                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `--continue`            | Resume most recent exec session (or `--continue=<id>`)                              |
| `--json`                | Emit JSONL lifecycle events to stdout                                               |
| `--output-last-message` | Write the final assistant message to a file                                         |
| `--ephemeral`           | Disable durable session persistence for the current exec run (`--continue` invalid) |
| `--on-permission`       | `allow`, `deny`, or `fail` (default) for permission hooks                           |
| `--on-question`         | `empty` or `fail` (default) for `AskUserQuestion`                                   |
| `--timeout-ms`          | Hard timeout for the full exec run                                                  |

## CLI Commands

| Command              | Description                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `setup`              | Re-run setup wizard                                                                                      |
| `sessions`           | Launch interactive session picker                                                                        |
| `resume [sessionId]` | Resume most recent session, or a specific one                                                            |
| `exec "<prompt>"`    | Run Athena without Ink/TUI (automation mode)                                                             |
| `workflow <sub>`     | Manage workflows (`install`, `list`, `update`, `use-marketplace`, `update-marketplace`, `remove`, `use`) |

## Workflow Commands

```bash
# Install by workflow name using the configured marketplace source
athena-flow workflow install e2e-test-builder

# Install from marketplace
athena-flow workflow install e2e-test-builder@lespaceman/athena-workflow-marketplace

# Install from a local workflow file
athena-flow workflow install /path/to/workflow-marketplace/workflows/e2e-test-builder/workflow.json

# Use a local workflow marketplace for setup and discovery
athena-flow workflow use-marketplace /path/to/workflow-marketplace

# Switch back to the default git-backed marketplace
athena-flow workflow use-marketplace lespaceman/athena-workflow-marketplace

# Update the active workflow from its recorded source
athena-flow workflow update

# Update a specific installed workflow
athena-flow workflow update e2e-test-builder

# Refresh the current workflow marketplace source
athena-flow workflow update-marketplace

# Refresh a specific marketplace cache
athena-flow workflow update-marketplace owner/custom-marketplace
```

Source behavior:

- Marketplace installs store the original marketplace ref and re-sync from the cached git marketplace on update.
- Local installs store the original workflow file path and, when installed from a local workflow marketplace checkout, resolve plugin refs from that same local repo.
- `workflow install` uses the interactive install path, including MCP option selection when the workflow exposes configurable MCP servers. `<source>` can be a bare workflow name resolved from the current marketplace, a marketplace ref, or a local `workflow.json` path.
- `workflow use-marketplace <source>` changes which marketplace the setup wizard uses for workflow discovery. `source` can be an `owner/repo` slug or a local marketplace path.
- `workflow update-marketplace` refreshes the configured marketplace source by default. For local marketplaces, it validates the local checkout instead of running `git pull`.
- `--ephemeral` disables Athena session persistence for exec runs and is also passed through to Codex thread start, so Codex exec runs request upstream ephemeral sessions as well.

## Non-Interactive Exec Mode

`athena-flow exec` is designed for CI and automation.

```bash
# Human mode: final message to stdout, diagnostics to stderr
athena-flow exec "summarize latest test failures"

# Machine mode: JSONL events on stdout
athena-flow exec "run checks" --json --on-permission=deny --on-question=empty

# Persist final message as an artifact
athena-flow exec "write release notes" \
  --output-last-message .artifacts/release-notes.md
```

Output behavior:

- Default mode: stdout contains only the final assistant message.
- `--json` mode: stdout contains only JSONL events.
- stderr contains warnings/errors/progress diagnostics.

Safety defaults:

- `--on-permission=fail`
- `--on-question=fail`

Use explicit policies in unattended environments:

```bash
athena-flow exec "validate change" \
  --on-permission=deny \
  --on-question=empty
```

Parse JSONL with `jq`:

```bash
athena-flow exec "summarize diff" --json | jq -c 'select(.type == "exec.completed")'
```

Show the built-in terminal manual:

```bash
athena-flow --help
```

## Exec Exit Codes

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| `0`  | Success                                                            |
| `2`  | Usage/validation error (for example invalid flags, missing prompt) |
| `3`  | Bootstrap/configuration failure                                    |
| `4`  | Runtime/process failure                                            |
| `5`  | Non-interactive policy failure (`--on-permission=fail`, etc.)      |
| `6`  | Timeout exceeded                                                   |
| `7`  | Output failure (for example `--output-last-message` write error)   |

## CI Examples

GitHub Actions:

```yaml
name: athena-exec
on: [pull_request]
jobs:
  athena:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx athena-flow exec "summarize risk in this PR" --json --on-permission=deny --on-question=empty --output-last-message athena-summary.md
      - uses: actions/upload-artifact@v4
        with:
          name: athena-summary
          path: athena-summary.md
```

GitLab CI:

```yaml
athena_exec:
  image: node:20
  script:
    - npm ci
    - npx athena-flow exec "summarize pipeline status" --json --on-permission=deny --on-question=empty --output-last-message athena-summary.md
  artifacts:
    paths:
      - athena-summary.md
```

## Features

- Multi-harness runtime for Claude Code and OpenAI Codex
- Live event feed for tools, permissions, results, and errors
- Session persistence in SQLite with resume support
- Plugin system for commands, hooks, MCP servers, and agents
- Workflow orchestration with prompt templates, loops, and plugin bundles
- Isolation presets (`strict`, `minimal`, `permissive`)
- Keyboard-driven terminal runtime with theme support

## Configuration

Config files are merged in order: global -> project -> CLI flags.

```text
~/.config/athena/config.json          # Global config
{projectDir}/.athena/config.json      # Project config
```

```json
{
	"harness": "openai-codex",
	"model": "gpt-5.3-codex",
	"plugins": ["/path/to/plugin"],
	"additionalDirectories": ["/path/to/allow"],
	"activeWorkflow": "e2e-test-builder",
	"workflowSelections": {
		"e2e-test-builder": {
			"mcpServerOptions": {
				"agent-web-interface": ["--headless"]
			}
		}
	}
}
```

Notes:

- `harness` can be `claude-code` or `openai-codex`. If unset, Athena defaults to `claude-code`.
- `model` is harness-specific. For example, Claude aliases such as `sonnet` or Codex model IDs such as `gpt-5.3-codex`.

## Workflow Marketplace Resolution

- Workflow refs (`name@owner/repo`) are resolved from `.athena-workflow/marketplace.json` (preferred).
- Legacy workflow manifests at `.claude-plugin/marketplace.json` are still supported as fallback.
- Workflow `plugins[]` should use marketplace refs.
- Workflows installed from a local marketplace checkout keep resolving their plugin refs from that same local repo for testing.

## Development

```bash
npm install
npm run build
npm run typecheck
npm run dev
npm test
npm run lint
```

Performance profiling artifacts are written to `.profiles/` via:

```bash
npm run perf:tui -- -- sessions
```

See `docs/performance-profiling.md` for profiling modes and artifact analysis.

## Codex Protocol Bindings

- The source for `src/harnesses/codex/protocol/generated` is the `codex app-server` schema (`generate-ts`/`generate-json-schema`). Do not hand-edit those files—they are generated.
- To refresh them, run `scripts/update-codex-protocol-snapshot.mjs` with the version of `codex app-server` that matches your local runtime. Commit the regenerated directory so others can build without re-running the generator.

## License

MIT
