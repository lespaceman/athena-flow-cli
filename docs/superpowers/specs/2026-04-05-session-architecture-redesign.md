# Session Architecture Redesign

## Problem

The session management system has seven structural issues that compound into reliability and maintainability problems:

1. **Session ID never reaches the agent** — the state machine protocol references `<session_id>` but the prompt pipelines had no mechanism to inject it. Session 1's prompt template only supports `{input}` substitution. The system prompt pipeline does its own ad-hoc `.replaceAll('<session_id>', sessionId)`.

2. **Tracker path is coupled to the session ID model** — the session store lives at `~/.config/athena/sessions/{id}/session.db` while the tracker lives at `<projectDir>/.athena/{id}/tracker.md`. Custom tracker paths without `{sessionId}` create silent cross-session collisions with no validation.

3. **No parallel execution** — the exec runner is a `while` loop with `await`. One harness process at a time per session, one workflow at a time per CLI process. No architectural foundation for concurrent turns.

4. **Session identity is process-scoped, not durable** — iteration count, loop manager state, and workflow run state live entirely in memory. A crash mid-loop at iteration 3 resumes counting from 0. `--continue` resumes the Athena session but not the loop.

5. **"Session" abstraction is overloaded** — means three things (Athena session, adapter session, workflow run) but only two are modeled. Workflow runs have no identity, no persistence, and no way to distinguish "session X was resumed and looped 5 times" from "session X was resumed twice, looping 3 then 2 times."

6. **Interactive and exec modes are divergent codepaths** — `runner.ts` and `useWorkflowSessionController.ts` independently implement the same loop logic. Fixes to one must be verified against both.

7. **Tracker ownership is ambiguous** — the protocol says "Claude owns the tracker" but Athena decides where it lives, checks its existence, and reads it for markers. If the agent fails to create the tracker, Athena has no fallback.

## Design

### Approach Chosen

**Unified Core Loop + First-Class WorkflowRun** — extract loop logic into a single `WorkflowRunner` that both exec and interactive modes delegate to. Introduce `WorkflowRun` as a persisted entity. Athena owns tracker creation.

Alternatives considered:

- **Fix-in-place with shared functions**: smaller diff but leaves two codepaths, doesn't create foundation for parallel execution.
- **Full orchestration layer with parallel runs**: architecturally cleanest but YAGNI — no current use case requires parallel runs within a single session. Layers cleanly on top of this design later.

### Entity Model

```
AthenaSession (unchanged)          WorkflowRun (NEW)              AdapterSession (modified)
├── id: UUID                       ├── id: UUID                   ├── sessionId: string
├── projectDir: string             ├── sessionId: FK → Session    ├── runId: FK → WorkflowRun (NEW)
├── createdAt: number              ├── workflowName?: string      ├── startedAt: number
├── updatedAt: number              ├── startedAt: number          ├── endedAt?: number
├── label?: string                 ├── endedAt?: number           ├── model?: string
└── adapterSessionIds: string[]    ├── iteration: number          ├── source?: string
                                   ├── maxIterations: number      └── tokens: TokenUsage
                                   ├── status: RunStatus
                                   ├── stopReason?: string
                                   └── trackerPath?: string
```

**Relationships**: AthenaSession 1:N WorkflowRun 1:N AdapterSession.

**RunStatus lifecycle**:

```
running → completed     (tracker has completion marker)
running → blocked       (tracker has blocked marker)
running → exhausted     (hit maxIterations)
running → failed        (process error, timeout, missing tracker)
running → cancelled     (user interrupt / Ctrl+C / kill)
```

**`--continue` semantics**: Creates a new `WorkflowRun` under the same `AthenaSession`. The old run stays in its terminal status (immutable once terminal). The new run reads the existing tracker for continuity. Fresh iteration counter. Tracker path is always derived from workflow config + session ID, not inherited from the prior run — since `{sessionId}` is the same across runs in the same Athena session, the path resolves identically.

**Non-workflow single turns** also get a `WorkflowRun` with `iteration: 0`, `maxIterations: 1` — unifies the model rather than special-casing.

### WorkflowRunner — Unified Core Loop

**Location**: `src/core/workflows/workflowRunner.ts`

A pure async function that returns a handle. No React, no CLI, no DB, no harness imports. All external behavior is injected.

```typescript
type WorkflowRunnerInput = {
	sessionId: string;
	projectDir: string;
	workflow?: WorkflowConfig;
	prompt: string;
	initialContinuation?: TurnContinuation;

	// Injected dependencies
	startTurn: (input: TurnInput) => Promise<TurnExecutionResult>;
	persistRunState: (snapshot: WorkflowRunSnapshot) => void;
	onIterationComplete?: (snapshot: WorkflowRunSnapshot) => void;
	abortCurrentTurn?: () => void;

	// Optional overrides (default to fs implementations)
	createTracker?: (path: string, content: string) => void;
};

type TurnInput = {
	prompt: string;
	continuation: TurnContinuation;
	configOverride?: HarnessProcessOverride;
};

type WorkflowRunSnapshot = {
	runId: string;
	sessionId: string;
	workflowName?: string;
	iteration: number;
	status: RunStatus;
	stopReason?: string;
	tokens: TokenUsage;
	trackerPath?: string;
};

type WorkflowRunnerHandle = {
	readonly runId: string; // Available immediately, before result resolves
	result: Promise<WorkflowRunResult>;
	cancel: () => void; // Cooperative — current turn finishes, loop exits with 'cancelled'
	kill: () => void; // Forceful — calls abortCurrentTurn + cancel
};

type WorkflowRunResult = {
	runId: string;
	status: RunStatus;
	iterations: number;
	stopReason?: string;
	tokens: TokenUsage;
};
```

**Behavior**:

1. Generate `WorkflowRun` ID via `crypto.randomUUID()`
2. Resolve tracker path with `{sessionId}` substitution
3. If workflow has loop enabled and tracker doesn't exist: create tracker skeleton (via injected `createTracker` or default fs implementation)
4. Call `persistRunState()` with initial `running` state
5. Enter loop:
   - Call `prepareWorkflowTurn()` (existing function, unchanged)
   - Call `startTurn()` (injected)
   - On turn completion: increment iteration, call `persistRunState()`
   - Check `shouldContinueWorkflowRun()` (existing function, unchanged)
   - If terminal: set status, call `persistRunState()`, exit loop
6. On `cancel()`: set flag, current turn finishes, status → `cancelled`, persist
7. On `kill()`: call `abortCurrentTurn()` + `cancel()`

**Design choice — tracker fs dependency**: `WorkflowRunner` uses `fs` directly for tracker skeleton creation by default. The tracker is a core workflow concept, not an external resource. An injectable `createTracker` callback is available for testing, but the pragmatic default is the real filesystem. Testing with `tmpdir` is trivial.

**Exec mode integration** (replaces `runner.ts` while loop at lines ~386-488):

```typescript
const handle = createWorkflowRunner({
  sessionId: athenaSessionId,
  projectDir: options.projectDir,
  workflow: options.workflow,
  prompt: options.prompt,
  initialContinuation: nextContinuation,
  startTurn: (input) => sessionController.startTurn({
    prompt: input.prompt,
    continuation: input.continuation,
    configOverride: input.configOverride,
    onStderrLine: message => output.log(message),
  }),
  persistRunState: (snapshot) => {
    safePersist(store, () => store.persistRun(snapshot), ...);
  },
  abortCurrentTurn: () => sessionController.kill(),
  onIterationComplete: (snapshot) => {
    output.emitJsonEvent('iteration.complete', snapshot);
  },
});
const result = await handle.result;
```

**Interactive mode integration** (replaces `useWorkflowSessionController.ts` while loop at lines ~67-117):

```typescript
const runnerRef = useRef<WorkflowRunnerHandle | null>(null);

const spawn = useCallback(
	async (prompt, continuation, configOverride) => {
		if (runnerRef.current) {
			runnerRef.current.cancel();
			await runnerRef.current.result.catch(() => {});
		}
		setIsRunning(true);
		const handle = createWorkflowRunner({
			sessionId: input.sessionId,
			projectDir: input.projectDir,
			workflow: input.workflow,
			prompt,
			initialContinuation: continuation,
			startTurn: turnInput =>
				base.startTurn(
					turnInput.prompt,
					turnInput.continuation,
					turnInput.configOverride,
				),
			persistRunState: snapshot => {
				sessionStore?.persistRun(snapshot);
			},
			abortCurrentTurn: () => base.kill(),
		});
		runnerRef.current = handle;
		const result = await handle.result;
		setIsRunning(false);
		return turnExecutionResultFrom(result);
	},
	[base, input, sessionStore],
);
```

### Template Variable Injection

**Location**: `src/core/workflows/templateVars.ts`

Single substitution implementation used by all pipelines:

```typescript
type TemplateContext = {
	input?: string;
	sessionId?: string;
	trackerPath?: string;
};

function substituteVariables(text: string, ctx: TemplateContext): string {
	let result = text;
	if (ctx.input !== undefined) {
		result = result.replaceAll('{input}', ctx.input);
	}
	if (ctx.sessionId !== undefined) {
		result = result.replaceAll('{sessionId}', ctx.sessionId);
		result = result.replaceAll('<session_id>', ctx.sessionId); // Compat with state machine doc
	}
	if (ctx.trackerPath !== undefined) {
		result = result.replaceAll('{trackerPath}', ctx.trackerPath);
	}
	return result;
}
```

**Three call sites, one implementation**:

| Pipeline                     | Call site              | Context passed                      |
| ---------------------------- | ---------------------- | ----------------------------------- |
| System prompt                | `readWorkflowOverride` | `{ sessionId, trackerPath }`        |
| User prompt (session 1)      | `applyPromptTemplate`  | `{ input, sessionId, trackerPath }` |
| Continue prompt (session 2+) | `buildContinuePrompt`  | `{ trackerPath }`                   |

`readWorkflowOverride` keeps its `sessionId` parameter but delegates to `substituteVariables` instead of doing its own `.replaceAll('<session_id>', sessionId)`.

### Tracker Ownership & Lifecycle

**Athena creates the tracker skeleton** before session 1. The agent extends it.

```markdown
<!-- TRACKER_SKELETON -->

# Workflow Tracker

**Session**: {sessionId}
**Tracker**: {trackerPath}
**Goal**: {input}

---

> This tracker was created by the runner. Update it as you work.
> See the Stateless Session Protocol for tracker conventions.

## Status

Orientation in progress.

## Plan

_To be created during orientation._

## Progress

_No progress yet._
```

The `<!-- TRACKER_SKELETON -->` marker follows the existing convention of `<!-- WORKFLOW_COMPLETE -->` and `<!-- WORKFLOW_BLOCKED -->`. The agent removes it during Phase 2 (Orient). The runner can detect "agent failed to orient" if the skeleton marker is still present after session 1 exits.

**Tracker path validation**: When the tracker path is resolved, if the raw path doesn't contain `{sessionId}`, emit a warning about collision risk. Not a hard error — custom workflows may legitimately want a fixed path.

**No automatic cleanup**: Terminal runs do not delete the tracker. The tracker is valuable for debugging and `--continue` semantics. Tracker cleanup is an explicit user action via `athena sessions delete <id>`.

**State machine doc update** — Phase 1 changes from existence check to content check:

> **Phase 1 — Read the Tracker**
>
> Read the tracker file at `.athena/<session_id>/tracker.md`.
>
> - **Contains `<!-- TRACKER_SKELETON -->`**: This is session 1. Proceed to Phase 2 (Orient).
> - **Otherwise**: This is a continuation. Skip to Phase 3 (Execute).

### Schema Migration

Schema version bumps from 4 to 5.

**New table**:

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workflow_name TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  iteration INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',
  stop_reason TEXT,
  tracker_path TEXT,
  FOREIGN KEY (session_id) REFERENCES session(id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_session
  ON workflow_runs(session_id);
```

**Modified table**:

```sql
ALTER TABLE adapter_sessions ADD COLUMN run_id TEXT
  REFERENCES workflow_runs(id);
```

**Backward compatibility**: `run_id` is nullable. Existing adapter sessions get NULL. `workflow_runs` starts empty. No data loss.

### SessionStore Changes

New convenience method — upsert semantics:

```typescript
type SessionStore = {
	// ... existing methods unchanged ...

	/** Upsert a workflow run snapshot. Creates on first call, updates thereafter. */
	persistRun(snapshot: WorkflowRunSnapshot): void;

	/** Retrieve the most recent run for this session. */
	getLatestRun(): PersistedWorkflowRun | null;

	/** Associate an adapter session with a workflow run. */
	linkAdapterSession(adapterSessionId: string, runId: string): void;
};
```

`persistRun` uses SQLite upsert. The snapshot carries `sessionId` and `workflowName` for the INSERT side:

```sql
INSERT INTO workflow_runs (id, session_id, workflow_name, started_at, iteration,
  max_iterations, status, stop_reason, tracker_path)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  iteration=excluded.iteration, status=excluded.status,
  stop_reason=excluded.stop_reason, ended_at=excluded.ended_at
```

Callers wire `persistRunState` directly to `store.persistRun(snapshot)` — no conditional create-vs-update logic at the call site.

**Token aggregation**: `workflow_runs` has no token columns. Cumulative tokens for a run are queried via `SUM` over `adapter_sessions WHERE run_id = ?`, same pattern as the existing per-session token aggregation. The `tokens` field on `WorkflowRunSnapshot` is used by the runner for in-memory tracking and `onIterationComplete` callbacks, not persisted on the run row.

**`linkAdapterSession` timing**: Happens in the existing `recordEvent` flow (in runner.ts / RuntimeProvider), which sees both the `runId` (from `handle.runId`, a synchronous property) and the `adapterSessionId` (from the runtime event). The `WorkflowRunnerHandle.runId` is available immediately on construction, before `result` resolves.

### Removed Code

| What                                             | Where                                           | Replaced by                                           |
| ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------- |
| `while (!hasFailure()) { ... }` loop             | `runner.ts` ~lines 386-488                      | `createWorkflowRunner()` call                         |
| `while (!isCancelled()) { ... }` loop            | `useWorkflowSessionController.ts` ~lines 67-117 | `createWorkflowRunner()` call                         |
| `composed.replaceAll('<session_id>', sessionId)` | `sessionPlan.ts` `readWorkflowOverride`         | `substituteVariables()` call                          |
| `TurnContinuation` `'reuse-current'` variant     | `src/core/runtime/process.ts`                   | Removed entirely — unused, rejected by Claude adapter |

### File-Level Impact

**New files**:

| File                                        | Purpose                  |
| ------------------------------------------- | ------------------------ |
| `src/core/workflows/templateVars.ts`        | `substituteVariables()`  |
| `src/core/workflows/workflowRunner.ts`      | `createWorkflowRunner()` |
| `src/core/workflows/workflowRunner.test.ts` | Runner tests             |
| `src/core/workflows/templateVars.test.ts`   | Substitution tests       |

**Modified files**:

| File                                                 | Change                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/core/workflows/applyWorkflow.ts`                | `applyPromptTemplate` calls `substituteVariables`                                                             |
| `src/core/workflows/loopManager.ts`                  | `buildContinuePrompt` calls `substituteVariables`. Export `TRACKER_SKELETON_MARKER`                           |
| `src/core/workflows/sessionPlan.ts`                  | `readWorkflowOverride` delegates `<session_id>` substitution to `substituteVariables`                         |
| `src/core/workflows/stateMachine.ts`                 | Phase 1: skeleton marker detection replaces existence check                                                   |
| `src/core/workflows/types.ts`                        | Add `RunStatus` type                                                                                          |
| `src/core/workflows/useWorkflowSessionController.ts` | Replace while loop with `createWorkflowRunner()`                                                              |
| `src/core/workflows/index.ts`                        | Re-export new types and `createWorkflowRunner`                                                                |
| `src/core/runtime/process.ts`                        | Remove `'reuse-current'` from `TurnContinuation`                                                              |
| `src/infra/sessions/schema.ts`                       | Schema v5 migration                                                                                           |
| `src/infra/sessions/store.ts`                        | Add `persistRun()`, `getLatestRun()`, `linkAdapterSession()`                                                  |
| `src/infra/sessions/types.ts`                        | Add `PersistedWorkflowRun`, `WorkflowRunSnapshot`, `RunStatus`                                                |
| `src/app/exec/runner.ts`                             | Replace while loop with `createWorkflowRunner()`. Wire callbacks. Use `handle.runId` for `linkAdapterSession` |
| `src/app/providers/RuntimeProvider.tsx`              | Expose `runId` from active workflow runner handle                                                             |

**Unchanged files** (boundary confirmation):

| File                                         | Why unchanged                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/harnesses/claude/session/controller.ts` | Adapter layer untouched                                                                     |
| `src/harnesses/adapter.ts`                   | Adapter contract untouched                                                                  |
| `src/harnesses/contracts/session.ts`         | `SessionController` contract same                                                           |
| `src/app/entry/interactiveSession.ts`        | Session ID resolution unchanged                                                             |
| `src/app/entry/execCommand.ts`               | `--continue` resolution unchanged                                                           |
| `src/app/shell/AppShell.tsx`                 | Calls `useWorkflowSessionController` which changes internally                               |
| `src/app/shell/useSessionScope.ts`           | Reads from registry, unaffected                                                             |
| `src/app/process/useHarnessProcess.ts`       | Direct caller of `useWorkflowSessionController` — contract unchanged, only internals change |
| `src/core/feed/mapper.ts`                    | Feed mapping pipeline untouched                                                             |
| `src/infra/sessions/registry.ts`             | Read-only session listing untouched                                                         |

## Summary: Problems → Solutions

| #   | Problem                                  | Solution                                                                                     |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Session ID never reaches the agent       | `substituteVariables` in both prompt pipelines + tracker skeleton with session ID            |
| 2   | Tracker path coupled to session ID model | Resolved once in `WorkflowRunner`, stored on `WorkflowRun`, validated with warning           |
| 3   | No parallel execution                    | `WorkflowRunner` has clean async interface; parallel runners layer on top later              |
| 4   | Session identity is process-scoped       | `WorkflowRun` entity with persisted iteration, status, tracker path. Survives crash          |
| 5   | Session abstraction overloaded           | Three entities: `AthenaSession`, `WorkflowRun`, `AdapterSession`. Each with own ID/lifecycle |
| 6   | Interactive and exec modes diverge       | Single `WorkflowRunner`, two thin wrappers                                                   |
| 7   | Tracker ownership ambiguous              | Athena creates skeleton with `<!-- TRACKER_SKELETON -->`, agent extends it                   |
