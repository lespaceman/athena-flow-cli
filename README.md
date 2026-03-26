# Athenaflow CLI

[![npm version](https://img.shields.io/npm/v/@athenaflow/cli)](https://www.npmjs.com/package/@athenaflow/cli)
[![license](https://img.shields.io/npm/l/@athenaflow/cli)](https://github.com/lespaceman/athena-flow-cli/blob/main/LICENSE)
[![CI](https://github.com/lespaceman/athena-flow-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/lespaceman/athena-flow-cli/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@athenaflow/cli)](https://nodejs.org)

**Deterministic orchestration for non-deterministic agents.**

AI coding agents are getting better at reasoning -- but long-horizon tasks still break. Prompts drift, results vary between runs, and there's no good way to package what worked into something your whole team can reuse. The agent isn't the bottleneck anymore. The harness is.

Athenaflow is a **workflow runtime** for coding agent harnesses. It sits between you and [Claude Code](https://claude.com/product/claude-code) or [OpenAI Codex](https://chatgpt.com/codex), adding structured workflows, real-time observability, session persistence, and a plugin system -- so agent-driven tasks produce consistent, reliable results you can reproduce across runs, across teams, and across models.

```
npm install -g @athenaflow/cli && athena
```

> **[Documentation](https://athenaflow.in/docs)** -- full guides, workflow authoring, plugin API, and more.

<p align="center">
  <img src="assets/demo.gif" alt="Athenaflow terminal UI" width="960" />
</p>

---

## The Problem

Coding agents are powerful in a single session. But the moment you need repeatable, multi-step execution -- e2e test generation, migration plans, release workflows -- things fall apart:

- **Results vary between runs.** Same prompt, same model, different output. No reproducibility.
- **Long tasks drift off course.** Without structured checkpoints, agents compound small mistakes into big ones.
- **Prompts aren't portable.** What works for one developer doesn't transfer to the team.
- **No visibility into agent decisions.** You see the final output, not the 40 tool calls that got there.
- **CI integration is an afterthought.** Most harnesses are designed for interactive use, not pipelines.

## How Athenaflow Solves It

Athenaflow introduces a **workflow layer** between you and the underlying harness. Workflows are declarative, versioned, and shareable -- they define prompt templates, multi-session loops with completion tracking, plugin bundles, isolation policies, and model preferences. The runtime handles the rest.

- **Workflows encode what works.** A workflow captures the full orchestration strategy -- not just a prompt, but the loop logic, progress tracking, and tool configuration that make it reliable. Define once, run anywhere.
- **A marketplace for agent workflows.** Browse, install, and update community-built workflows like packages. `athena workflow install e2e-test-builder` -- done.
- **Real-time observability.** A live terminal feed showing every tool call, permission request, approval decision, and result as it happens. Know exactly what your agent is doing, not just what it outputs.
- **Sessions that persist and resume.** Every session is stored in SQLite. Pick up any past run right where it left off -- full state, full context.
- **Harness-agnostic by design.** Same workflows, same UI, same session model -- whether you're running Claude Code or Codex. Switch harnesses without rewriting your automation.
- **Built for CI from day one.** `athena exec` runs headlessly with safe defaults, JSONL output, and structured exit codes.

---

## Get Started

### 1. Install

```bash
npm install -g @athenaflow/cli
```

Requires **Node.js 20+** and at least one harness on your PATH:

- **Claude Code** -- `claude`
- **[OpenAI Codex](https://chatgpt.com/codex)** -- `codex`

### 2. Run

```bash
athena
```

The setup wizard walks you through theme, harness verification, and your first workflow from the marketplace.

### 3. Explore

```bash
athena resume                              # Pick up where you left off
athena sessions                            # Browse past sessions
athena workflow install e2e-test-builder   # Add a workflow from the marketplace
```

> See the **[Getting Started guide](https://athenaflow.in/docs)** for a full walkthrough.

---

## Harness Support

| Harness                                   | Status    | Integration                                    |
| ----------------------------------------- | --------- | ---------------------------------------------- |
| Claude Code                               | Supported | Hook events forwarded over a local Unix socket |
| [OpenAI Codex](https://chatgpt.com/codex) | Supported | Integrated via `codex app-server` protocol     |
| opencode                                  | Planned   | Adapter placeholder; not yet enabled           |

---

## Workflows

Workflows are the core of Athenaflow. They package prompt templates, loop strategies, plugin dependencies, isolation policies, and model config into a single portable unit. Anyone can author and publish a workflow.

```bash
athena workflow list                        # See what's installed
athena workflow install e2e-test-builder    # Install from the marketplace
athena workflow update                      # Re-sync from source
athena workflow use-marketplace owner/repo  # Point to a different marketplace
```

Install from a local file or a specific marketplace ref:

```bash
athena workflow install ./path/to/workflow.json
athena workflow install e2e-test-builder@lespaceman/athena-workflow-marketplace
```

> Learn how to **[author your own workflows](https://athenaflow.in/docs)**.

---

## CI / Automation

`athena exec` is built for pipelines. Safe by default -- permission and question hooks fail unless you opt in.

```bash
# Plain-text summary
athena exec "summarize risk in this PR"

# Machine-readable JSONL
athena exec "run checks" --json --on-permission=deny --on-question=empty

# Save the final message as a build artifact
athena exec "write release notes" --output-last-message release-notes.md
```

<details>
<summary>GitHub Actions example</summary>

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
      - run: npx athena-flow exec "summarize risk in this PR" \
          --json --on-permission=deny --on-question=empty \
          --output-last-message athena-summary.md
      - uses: actions/upload-artifact@v4
        with:
          name: athena-summary
          path: athena-summary.md
```

</details>

<details>
<summary>GitLab CI example</summary>

```yaml
athena_exec:
  image: node:20
  script:
    - npm ci
    - npx athena-flow exec "summarize pipeline status" \
      --json --on-permission=deny --on-question=empty \
      --output-last-message athena-summary.md
  artifacts:
    paths:
      - athena-summary.md
```

</details>

<details>
<summary>Exit codes</summary>

| Code | Meaning                           |
| ---- | --------------------------------- |
| `0`  | Success                           |
| `2`  | Usage / validation error          |
| `3`  | Bootstrap / configuration failure |
| `4`  | Runtime / process failure         |
| `5`  | Non-interactive policy failure    |
| `6`  | Timeout exceeded                  |
| `7`  | Output write failure              |

</details>

---

## Configuration

Config files merge in order: **global -> project -> CLI flags**.

```
~/.config/athena/config.json          # Global
{projectDir}/.athena/config.json      # Project
```

```json
{
	"harness": "claude-code",
	"model": "sonnet",
	"plugins": ["/path/to/plugin"],
	"activeWorkflow": "e2e-test-builder"
}
```

<details>
<summary>All CLI flags</summary>

| Flag            | Description                                    |
| --------------- | ---------------------------------------------- |
| `--project-dir` | Project directory (default: cwd)               |
| `--plugin`      | Path to a plugin directory (repeatable)        |
| `--isolation`   | `strict` (default), `minimal`, or `permissive` |
| `--theme`       | `dark` (default), `light`, or `high-contrast`  |
| `--ascii`       | ASCII-only UI glyphs for compatibility         |
| `--verbose`     | Show additional rendering detail               |

**`exec`-only flags:**

| Flag                    | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `--continue`            | Resume most recent exec session (or `--continue=<id>`) |
| `--json`                | Emit JSONL lifecycle events to stdout                  |
| `--output-last-message` | Write final assistant message to a file                |
| `--ephemeral`           | Disable session persistence for this run               |
| `--on-permission`       | `allow`, `deny`, or `fail` (default)                   |
| `--on-question`         | `empty` or `fail` (default)                            |
| `--timeout-ms`          | Hard timeout for the full exec run                     |

</details>

<details>
<summary>All CLI commands</summary>

| Command           | Description                                                                           |
| ----------------- | ------------------------------------------------------------------------------------- |
| _(none)_          | Start interactive session in cwd                                                      |
| `setup`           | Re-run setup wizard                                                                   |
| `sessions`        | Interactive session picker                                                            |
| `resume [id]`     | Resume most recent (or specific) session                                              |
| `exec "<prompt>"` | Run headlessly for CI / scripting                                                     |
| `workflow <sub>`  | `install`, `list`, `update`, `remove`, `use`, `use-marketplace`, `update-marketplace` |

</details>

---

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
npm run dev            # Watch mode
```

<details>
<summary>Codex protocol bindings</summary>

Files in `src/harnesses/codex/protocol/generated` are auto-generated from the `codex app-server` schema. Do not edit them by hand. To refresh, run:

```bash
scripts/update-codex-protocol-snapshot.mjs
```

Commit the regenerated directory so others can build without the generator.

</details>

---

## License

[MIT](LICENSE)
