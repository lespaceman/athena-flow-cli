# Codex High-Value Checklist

Use this checklist to prioritize the Codex harness work that will create the
largest immediate improvement in user experience and protocol correctness.

Sources:

- [2026-03-10-codex-app-server-gap-analysis.md](/home/nadeemm/athena/cli/docs/plans/2026-03-10-codex-app-server-gap-analysis.md)
- [2026-03-10-combined-harness-gap-analysis.md](/home/nadeemm/athena/cli/docs/plans/2026-03-10-combined-harness-gap-analysis.md)

## Prioritization Rule

Take items in this order:

1. Fix gaps that make the live feed misleading or silent during normal use.
2. Fix protocol behaviors that currently auto-fail or hide actionable state.
3. Add control surfaces that materially improve day-to-day Codex usage.
4. Leave broad platform-surface expansion until the above are stable.

## P0: Feed Truthfulness

These are the highest-value changes because users cannot trust the Codex feed
today when important work is in progress or failing.

- [ ] Stream command output from `item/commandExecution/outputDelta`.
      Success looks like long-running commands showing live stdout/stderr in the feed
      instead of appearing idle.
- [ ] Surface `error` notifications as first-class error events.
      Success looks like turn-level failures rendering as visible error entries, not
      collapsed `unknown` noise.
- [ ] Surface `turn/diff/updated` as a live diff view or diff event.
      Success looks like users being able to see aggregate file changes while Codex
      is editing.
- [ ] Surface skill lifecycle in the feed.
      Success looks like:
  - [ ] thread-start skill fetch produces a visible "skills loaded" summary
  - [ ] `skills/changed` invalidation produces a visible refresh/stale signal
  - [ ] users can tell when Codex is operating with skill context
- [ ] Surface `model/rerouted` clearly.
      Success looks like the feed showing when Codex switches models and why.
- [ ] Surface `thread/closed` clearly.
      Success looks like users getting a clean session-ended event instead of a
      cryptic next-turn failure.

## P0: Broken Interactive Flows

These are protocol paths that currently fail in ways the user cannot recover
from cleanly.

- [ ] Implement `mcpServer/elicitation/request` instead of auto-declining it.
      Success looks like OAuth URLs and form prompts being shown to the user and the
      turn resuming after input.
- [ ] Replace dynamic tool auto-failure with either real execution or an
      explicit unsupported-tool event.
      Success looks like plugin-backed tools no longer failing silently with
      `success: false`.
- [ ] Surface stub-failure details to the UI.
      Success looks like users seeing why an MCP or dynamic-tool path failed,
      instead of only the model seeing the error.

## P1: Missing High-Signal Item Types

These are not always blockers, but they carry high information density and make
Codex feel incomplete compared with the rest of the app.

- [ ] Render `enteredReviewMode` / `exitedReviewMode` as structured review
      output.
      Success looks like findings with file, line, priority, and confidence showing
      in the feed.
- [ ] Render `webSearch` actions as explicit search/open/find events.
      Success looks like users being able to see what Codex searched and opened.
- [ ] Render `imageView` actions as explicit image-consumption events.
      Success looks like users seeing which local image or screenshot Codex read.
- [ ] Render `contextCompaction` as a system event.
      Success looks like users understanding why earlier context may have been
      summarized.
- [ ] Preserve multi-agent collaboration metadata in `collabToolCall`.
      Success looks like all receiver agents, prompt text, and per-agent status being
      visible instead of only the first agent ID.

## P1: Control Surfaces With Immediate User Value

These are worth doing once the feed is trustworthy.

- [ ] Implement `turn/steer`.
      Success looks like users being able to redirect a running turn without fully
      interrupting and restarting it.
- [ ] Expose `outputSchema` on `turn/start`.
      Success looks like workflow and exec-mode users being able to request valid
      schema-constrained JSON.
- [ ] Expose `effort` and `summary`.
      Success looks like users being able to choose faster/cheaper turns or more
      deliberate turns without patching internals.
- [ ] Expose `collaborationMode`.
      Success looks like plan-style Codex turns being selectable intentionally.
- [ ] Unblock `acceptWithExecpolicyAmendment`.
      Success looks like users being able to approve a command and persist a safe
      allowlist rule in the same action.

## P2: Operational Visibility

These are useful, but lower value than the items above unless the team is
actively working on auth, MCP, or enterprise rollout.

- [ ] Surface `account/rateLimits/updated`.
- [ ] Surface `account/login/completed`.
- [ ] Surface `mcpServer/oauthLogin/completed`.
- [ ] Surface `item/mcpToolCall/progress`.
- [ ] Surface `item/commandExecution/terminalInteraction`.
- [ ] Surface `configWarning`.
- [ ] Preserve richer tool failure details:
  - [ ] stack traces
  - [ ] non-command exit codes
  - [ ] MCP server/tool identity
  - [ ] patch apply status

## P2: Broader Codex Surface Area

These are real capabilities, but they are not the first place to spend effort if
the goal is immediate product value.

- [ ] Add thread management features:
  - [ ] `thread/fork`
  - [ ] `thread/rollback`
  - [ ] `thread/list`
  - [ ] `thread/read`
  - [ ] `thread/archive` / `thread/unarchive`
  - [ ] `thread/compact/start`
- [ ] Add config/account surfaces:
  - [ ] `config/read`
  - [ ] `config/value/write` / `config/batchWrite`
  - [ ] `model/list`
  - [ ] `experimentalFeature/list`
  - [ ] `account/read`
  - [ ] `account/login/*` / `logout`
  - [ ] `account/rateLimits/read`
  - [ ] `mcpServerStatus/list`
- [ ] Add `review/start` command entrypoint.
- [ ] Add `command/exec` entrypoint for isolated non-turn commands.

## Recommended First Milestone

The first milestone should be considered complete only when all of the
following are true:

- [ ] Codex command execution visibly streams in the feed.
- [ ] Codex turn failures render as visible errors.
- [ ] Codex live file diff is no longer hard-dropped.
- [ ] Skill loading and skill invalidation are visible to the user.
- [ ] MCP elicitation no longer silently declines.
- [ ] Dynamic tool failures are no longer silent.
