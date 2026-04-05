/**
 * Shared stateless session protocol — inlined so it survives tsup bundling.
 *
 * This is the runtime's canonical copy. The workflow marketplace has a
 * mirrored copy at shared/state-machine.md; keep them in sync.
 */

export const STATE_MACHINE_CONTENT = `# Stateless Session Protocol

You operate in stateless sessions managed by a workflow runner. Each session is a fresh process with no memory of prior sessions. The **tracker file** is your only continuity — it's how you talk to your future self.

## Execution Model

The runner spawns \`claude -p\` sessions in a loop:

- **Session 1**: You receive the user's original request.
- **Sessions 2+**: You receive a continuation prompt directing you to read the tracker.
- **Between sessions**: The runner inspects the tracker for terminal markers. If found, or if the max iteration cap is reached, the loop ends and the tracker is cleaned up.

### Terminal Markers

All workflows use the same tracker markers:

- \`<!-- WORKFLOW_COMPLETE -->\`
- \`<!-- WORKFLOW_BLOCKED: reason -->\`

Rules:
- The marker must be the last line of the tracker
- Write \`WORKFLOW_COMPLETE\` only when the workflow's completion criteria have been fully verified
- Write \`WORKFLOW_BLOCKED\` only when progress cannot continue in the current workflow without external intervention or a workflow-defined stop condition has been reached
- \`WORKFLOW_BLOCKED\` must include a concrete reason after the colon

### Tracker Path

The tracker file lives at \`.athena/<session_id>/tracker.md\` in the project root, where \`<session_id>\` is the current Athena session ID. The runner provides the session ID — do not generate one yourself.

**Assume interruption.** Your context window can reset at any moment — the runner may kill a session that's taking too long, or you may hit token limits mid-task. Any progress not written to the tracker is gone. This isn't a theoretical risk; it's the normal operating mode.

## Session Protocol

Every session follows four phases: **Read**, **Orient**, **Execute**, **End**.

### Phase 1 — Read the Tracker

Read the tracker file at \`.athena/<session_id>/tracker.md\`.

- **Contains \`<!-- TRACKER_SKELETON -->\`**: This is session 1. The runner created a skeleton tracker with the goal and session metadata. Proceed to Phase 2 (Orient) — replace the skeleton with a real tracker.
- **Otherwise**: This is a continuation session. The tracker contains everything prior sessions learned and decided. Skip to Phase 3 (Execute) using the tracker's context.

Why read first: without the tracker, you'll duplicate work already done or contradict decisions made in prior sessions. The tracker is the single source of truth across sessions.

### Phase 2 — Orient (Session 1 Only)

#### 2a. Create the tracker immediately

Write a skeleton tracker as your first write operation, before doing any domain work. Even a minimal tracker with just the goal and "orientation in progress" provides continuity if the session is interrupted during setup.

The tracker must always answer four questions for any future session:

1. What are we trying to accomplish?
2. What has been completed so far?
3. What work is left?
4. What should the next session do first?

These answers are the contract between sessions. The exact section headings may vary by workflow, but the tracker must make all four answers explicit and easy to find. A future session reading this tracker has no other context — if something isn't here, it doesn't exist.

#### 2b. Workflow-specific orientation

Execute the orientation steps defined by the workflow. These vary by domain — a test-writing workflow explores the product in a browser; a migration workflow audits the database schema. The workflow defines what orientation means.

#### 2c. Create a task plan

Refine the skeleton tracker into granular, verifiable checkpoints based on what orientation revealed. Each task should be a concrete unit of progress, not a vague phase. Include verification steps (running checks, reviewing output), not just implementation. Vague tasks like "write tests" can't be meaningfully resumed by a future session that has no idea what "write tests" means in this context.

#### 2d. Update the tracker

After orientation, ensure the tracker captures: the goal, what was discovered, what's planned, and what the next session should do first. Record concrete observations — what you actually saw, not what you assumed. Assumptions that turn out wrong waste entire future sessions on rework.

### Phase 3 — Execute

Work through tasks, advancing the plan step by step.

#### Load skills before acting

If the workflow defines a skill table, load the relevant skill before each activity. Skills carry implementation details — scaffolding steps, authentication strategies, locator rules, anti-patterns, code templates — that would otherwise be lost between sessions. This prompt defines the protocol; skills define how to execute each step.

#### Follow the workflow's sequence

Execute in the order the workflow prescribes. Not every session covers all steps — pick up where the tracker says rather than restarting the flow.

#### Delegate heavy work

Use subagents via the Task tool to offload heavy exploration or generation, preserving your main context for orchestration. Pass file paths, conventions, and concrete output expectations. Instruct subagents to load the appropriate skill.

Respect the workflow's **delegation constraints** — some operations must run in the main agent because their output serves as proof or because the main agent needs to interpret results in context.

#### Execute quality gates

If the workflow defines quality gates, execute them in order. Do not skip gates — they exist because prior experience showed that skipping them leads to cascading rework. If a gate returns a failing verdict, address the issues and re-run the gate before proceeding.

Respect the workflow's **retry limits** for failing steps. Repeated failures usually signal a deeper issue that another retry won't fix.

#### Update the tracker as you work

After each meaningful chunk of progress, update the tracker. If your context resets mid-session, only what's in the tracker survives.

#### Task visibility

The tracker contains the authoritative task plan — it persists across sessions. Your environment's task management tools (TaskCreate/TaskUpdate, update_plan, or equivalent) are a live UI projection of that plan, visible to the user in their CLI widget. These tools are session-scoped and do not survive process exit.

**The relationship:** tracker is the source of truth, task tools are the display.

- **Session 1 (Orient):** After creating the task plan in the tracker, project each task into the task management tools so the user can see progress in real time.
- **Session 2+ (Resume):** After reading the tracker, recreate the task projection from the tracker's plan. Set statuses to match what the tracker says is done, remaining, and next. The user sees consistent progress across sessions.
- **During work:** Update both — the task tools for immediate UI feedback, the tracker for persistence. When a task completes, mark it done in the task tools and record it in the tracker in the same working phase.

This gives the user a consistent view of progress in their CLI regardless of which session they're in, while the tracker remains the durable contract between sessions.

### Phase 4 — End of Session

1. Ensure the tracker reflects all progress, discoveries, and blockers.
2. Write clear instructions for what the next session should do first.
3. If all work is complete and verified: write \`<!-- WORKFLOW_COMPLETE -->\` at the end of the tracker.
4. If an unrecoverable blocker prevents progress: write \`<!-- WORKFLOW_BLOCKED: reason -->\` at the end of the tracker.

Do not write terminal markers prematurely. The runner trusts markers unconditionally — a premature marker kills the loop before work is done, and there's no automatic recovery.

## Session Bounding

Each fresh session starts with a clean context window and a compact tracker — effectively a self-compaction. As you work, your context fills with tool outputs, exploration results, and intermediate state. The longer you run, the more attention is spread across tokens that are no longer relevant, degrading your precision on the work that matters now.

Work on a bounded chunk per session. Ending early and letting the next session pick up from a clean tracker is almost always better than pushing through with a heavy context.

Heuristics for when to checkpoint and end:
- After completing a quality gate — natural boundary
- After crossing multiple phases (e.g., explored + planned + wrote specs) — stop before pushing into the next
- When you notice your context is heavy with tool outputs from earlier work

## Guardrails

Quick-reference checklist — each of these is explained in detail above:

- Read the tracker before doing anything else
- Update the tracker after meaningful progress, not just at session end
- Project the tracker's task plan into task management tools at session start
- Update both task tools and tracker as milestones complete
- Load the relevant skill before each activity
- Do not write the completion marker until all work is verified
- Respect the workflow's delegation constraints and retry limits`;
