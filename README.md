# athena-flow

Athena is a workflow runtime for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
Today it runs on Claude Code hooks, orchestrates workflow and plugin execution, and provides an interactive terminal runtime for observability and control.
The harness architecture is expanding: Codex support will run through `codex-app-server`, with more harness integrations coming.

## Install

```bash
npm install -g athena-flow-cli
```

Requires Node.js >= 20.

## Quick Start

```bash
# Launch in your project directory
athena

# Or use the full command name
athena-flow
```

On first run, a setup wizard guides theme selection, harness configuration, and workflow activation.

## Usage

```bash
athena-flow                             # Start in current project directory
athena-flow --project-dir=/my/project   # Specify project directory
athena-flow setup                       # Re-run setup wizard
athena-flow sessions                    # Pick a session interactively
athena-flow resume                      # Resume most recent session
athena-flow resume <sessionId>          # Resume specific session
athena-flow exec "summarize repo state" # Non-interactive run (CI/script)
athena-flow workflow list               # List available workflows
athena-flow workflow install <source>   # Install workflow from marketplace/repo
athena-flow --help                      # Show full command/flag manual
athena-flow --version                   # Print CLI version
```

## What Athena Does

Athena runs as a workflow runtime around Claude Code execution:

1. Registers Claude Code [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) to forward runtime events.
2. Receives event streams over Unix Domain Sockets using NDJSON.
3. Applies workflow, plugin, and isolation policy.
4. Persists session state and renders live runtime state in the terminal.

```
Claude Code -> hook-forwarder (stdin) -> UDS -> athena-flow runtime
```

## Harness Support

- `claude-code` (current): integrated via Claude Code hooks and forwarded runtime events.
- `codex` (planned): integration path is `codex-app-server`.
- Additional harness support is in progress.

## CLI Options

| Flag            | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `--project-dir` | Project directory for hook socket (default: cwd)              |
| `--plugin`      | Path to a Claude Code plugin directory (repeatable)           |
| `--isolation`   | Isolation preset: `strict` (default), `minimal`, `permissive` |
| `--theme`       | Color theme: `dark` (default), `light`, `high-contrast`       |
| `--ascii`       | Use ASCII-only UI glyphs for compatibility                    |
| `--verbose`     | Show additional rendering detail                              |

`exec`-only flags:

| Flag                    | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `--continue`            | Resume most recent exec session (or `--continue=<id>`)     |
| `--json`                | Emit JSONL lifecycle events to stdout                      |
| `--output-last-message` | Write the final assistant message to a file                |
| `--ephemeral`           | Disable durable session persistence (`--continue` invalid) |
| `--on-permission`       | `allow`, `deny`, or `fail` (default) for permission hooks  |
| `--on-question`         | `empty` or `fail` (default) for `AskUserQuestion`          |
| `--timeout-ms`          | Hard timeout for the full exec run                         |

## CLI Commands

| Command              | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `setup`              | Re-run setup wizard                                   |
| `sessions`           | Launch interactive session picker                     |
| `resume [sessionId]` | Resume most recent session, or a specific one         |
| `exec "<prompt>"`    | Run Athena without Ink/TUI (automation mode)          |
| `workflow <sub>`     | Manage workflows (`install`, `list`, `remove`, `use`) |

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

## Workflow Marketplace Resolution

- Workflow refs (`name@owner/repo`) are resolved from `.athena-workflow/marketplace.json` (preferred).
- Legacy workflow manifests at `.claude-plugin/marketplace.json` are still supported as fallback.
- Workflow `plugins[]` should use marketplace refs.

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

## License

MIT
