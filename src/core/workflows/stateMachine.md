# Stateless Session Protocol

You run in a stateless loop. Each session is a fresh process with no memory of prior sessions. **The tracker file is your only continuity** — read it, work, write it. Assume interruption: the runner may kill a long session, your context may collapse under tool output, you may hit token limits mid-task. Anything not in the tracker is gone.

## First action, every session

1. Read the tracker at the configured path (default: `.athena/<session_id>/tracker.md`). The runner provides the session ID — do not invent one.
2. If the tracker contains `<!-- TRACKER_SKELETON -->` → this is session 1, run [**Orient**](#orient-session-1).
3. Otherwise → this is a continuation, run [**Execute**](#execute-session-2) from where the tracker says, not from the start of the flow.

Reading first prevents two failure modes that waste whole sessions: redoing work already done, or contradicting decisions a prior session made.

## Tracker contract

The tracker must always answer four questions:

1. What are we trying to accomplish?
2. What has been done?
3. What's left?
4. What should the next session do first?

A future session has no other context. If something isn't here, it doesn't exist. Section headings may vary by workflow, but these four answers must be explicit and easy to find.

### Terminal markers

Default markers (workflows may override — use the markers configured for the active workflow):

- `<!-- WORKFLOW_COMPLETE -->` — all work done and verified
- `<!-- WORKFLOW_BLOCKED -->` or `<!-- WORKFLOW_BLOCKED: reason -->` — cannot proceed without external intervention

Rules:

- Only the last non-empty line of the tracker is authoritative. Marker-like text in notes, examples, or quoted instructions earlier in the file is ignored.
- The runner trusts markers unconditionally. A premature marker ends the loop with no automatic recovery — write one only when its criteria are fully met.
- Include a concrete reason after `WORKFLOW_BLOCKED:` whenever possible; the bare form is still valid.

## Phases

### Orient (session 1)

1. **Replace the skeleton immediately**, before any domain work. Even a three-line tracker (goal + "orienting") protects you if the session dies during setup.
2. Run the workflow's orientation steps. These vary by domain — a test-writing workflow explores the product in a browser; a migration workflow audits the schema. The workflow defines what orientation means.
3. Refine the tracker into a granular plan. Each task a concrete, verifiable unit of work, including verification steps (running checks, reviewing output) — not just implementation. Vague tasks ("write tests") cannot be meaningfully resumed by a future session that has no idea what they mean here.
4. Record concrete observations — what you actually saw, not what you assumed. Wrong assumptions burn entire future sessions on rework.
5. **Single-turn requests still go through this phase.** If the entire request is satisfied in one turn, write a minimal tracker (what was asked, what was done, the outcome) and append `<!-- WORKFLOW_COMPLETE -->`. Leaving the skeleton in place causes the runner to classify the session as a failure.

### Execute (session 2+)

- Work from where the tracker says, in the workflow's prescribed sequence. Not every session covers every step.
- If the workflow defines a skill table, **load the relevant skill before each activity**. Skills carry the implementation detail (scaffolding steps, locator rules, anti-patterns, code templates) that this protocol intentionally doesn't repeat.
- Delegate heavy exploration or generation to subagents via the Task tool. Pass file paths, conventions, and concrete output expectations; tell them which skill to load. Respect the workflow's **delegation constraints** — some operations must run in the main agent because their output is proof, or because the main agent needs to interpret results in context.
- Run quality gates in order. Do not skip — they exist because skipping cascades into rework. On a failing verdict, address the issues and re-run before proceeding. Respect the workflow's **retry limits**: repeated failure usually signals a deeper issue another retry won't fix.

### End

1. Tracker reflects all progress, discoveries, and blockers.
2. Tracker says clearly what the next session should do first.
3. If all work is verified: append the completion marker.
4. If an unrecoverable blocker prevents progress: append the blocked marker, with a reason if you have one.

## When to write the tracker

Write on **concrete triggers**, not on a vague sense of "meaningful progress." The right cadence sits between every-tool-call (noisy log, wastes tokens) and end-of-session (everything lost if you die mid-task).

- **Discrete unit done** — file written, fix applied, test run, gate passed. Reflect the new reality before starting the next unit.
- **Insight learned** — API quirk, config field that turned out to matter, dead end ruled out, decision between two approaches. Insights are tracker-worthy even when no code changed; rediscovering them costs the next session a full re-exploration. The tracker is a knowledge ledger, not just a task log.
- **About to do something risky or long-running** — subagent dispatch, long build, flaky external call, large refactor. Write _first_, then act. If the operation kills your session, only what's on disk survives.
- **Plan changed** — task resequenced, new task surfaced, planned task no longer needed. Stale plans poison continuation sessions.
- **You haven't written in a while** — if you can't remember the last update, you've gone too long. A short defensive update ("doing X, last completed Y, next is Z") beats nothing.

Each update covers: what changed (work or knowledge), what's now next, and any caveat the next session needs. Don't transcribe tool calls — the tracker is a contract with your future self, not a replay log.

The cost of one extra tracker update is a few tokens. The cost of dying without one is a whole wasted session. Bias toward writing.

## Task UI projection

The tracker is the durable source of truth. Your harness's task tools are a session-scoped UI projection of the same plan, shown to the user in their CLI widget. They do not survive process exit.

{{TASK_TOOL_INSTRUCTIONS}}

- **Session 1, after orientation:** project the tracker's task plan into the task tools.
- **Session 2+, after reading the tracker:** recreate the projection from the tracker; do not assume task IDs from prior sessions still exist.
- **During work:** update both — the task tools for immediate UI feedback, the tracker for persistence — in the same working phase.

## Session bounding

Each fresh session starts with a clean context window and a compact tracker — effectively self-compaction. As you work, context fills with tool outputs and intermediate state. The longer you run, the more attention is spread across tokens that are no longer relevant, degrading precision on the work that matters now.

Work a bounded chunk per session. Ending early and letting the next session pick up from a clean tracker is almost always better than pushing through with a heavy context. Natural checkpoints:

- After a quality gate
- After crossing multiple phases (explored → planned → wrote specs) — stop before pushing into the next
- When your context is visibly heavy with tool output from earlier work

## Quick reference

- [ ] Read the tracker before doing anything else
- [ ] Replace the skeleton immediately, even for single-turn requests
- [ ] Update on concrete triggers — unit done, insight learned, risky op pending, plan changed
- [ ] Project the tracker plan into task tools at session start; keep both in sync as work lands
- [ ] Load the workflow's skill before each activity
- [ ] Run quality gates in order; respect delegation constraints and retry limits
- [ ] Write the completion marker only when all work is verified
- [ ] Checkpoint and end before context goes stale
