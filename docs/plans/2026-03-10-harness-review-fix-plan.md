# Harness Review Fix Plan

## Decision

Admit that Claude and Codex have different turn and session semantics.

Do not keep extending the current shared contract as if `sessionId`, `spawn()`,
and `kill()` mean the same thing across both harnesses.

Instead:

- keep a shared turn-execution contract
- make continuation/session behavior explicit
- expose harness capabilities where semantics differ

This is the lowest-risk direction because the current bugs are caused by false
neutrality, not by lack of abstraction.

## Target Contract Changes

Replace the current ambiguous interactive contract with an outcome-oriented one.

```ts
type TurnContinuation =
	| {mode: 'fresh'}
	| {mode: 'resume'; handle: string}
	| {mode: 'reuse-current'};

type SessionControllerTurnResult = {
	exitCode: number | null;
	error: Error | null;
	tokens: TokenUsage;
	streamMessage: string | null;
	continuation?: TurnContinuation;
};

type SessionController = {
	startTurn(input: {
		prompt: string;
		continuation?: TurnContinuation;
		configOverride?: HarnessProcessOverride;
		onStderrLine?: (message: string) => void;
	}): Promise<SessionControllerTurnResult>;
	interrupt(): void;
	kill(): Promise<void>;
};
```

Add harness capabilities for app/workflow code:

```ts
type HarnessCapabilities = {
	conversationModel: 'fresh_per_turn' | 'persistent_thread';
	killWaitsForTurnSettlement: boolean;
	supportsEphemeralSessions: boolean;
	supportsConfigurableIsolation: boolean;
};
```

## Fix Order

### P0: Correctness bugs in shared session lifecycle

These are the highest-risk issues because they can cause wrong workflow
behavior, hangs, or contract violations.

#### 1. Make interactive workflow looping depend on turn outcome

Problem:

- interactive `useWorkflowSessionController()` keeps looping based only on the
  tracker state
- Claude failures do not stop the loop

Files:

- [src/core/workflows/useWorkflowSessionController.ts](/home/nadeemm/athena/cli/src/core/workflows/useWorkflowSessionController.ts)
- [src/harnesses/contracts/session.ts](/home/nadeemm/athena/cli/src/harnesses/contracts/session.ts)
- [src/harnesses/claude/process/useProcess.ts](/home/nadeemm/athena/cli/src/harnesses/claude/process/useProcess.ts)

Fix:

- change interactive `spawn()` to return a `SessionControllerTurnResult`
- stop workflow continuation when `error` is present or `exitCode !== 0`

Blast radius:

- medium
- touches shared interactive workflow wrapper and both harness session hooks

#### 2. Remove `sessionId` as the shared continuation contract

Problem:

- Claude treats missing session id as fresh
- Codex treats missing session id as reuse-current-thread

Files:

- [src/harnesses/contracts/session.ts](/home/nadeemm/athena/cli/src/harnesses/contracts/session.ts)
- [src/core/workflows/useWorkflowSessionController.ts](/home/nadeemm/athena/cli/src/core/workflows/useWorkflowSessionController.ts)
- [src/harnesses/codex/session/controller.ts](/home/nadeemm/athena/cli/src/harnesses/codex/session/controller.ts)
- [src/harnesses/codex/runtime/server.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/server.ts)

Fix:

- replace `sessionId?: string` with explicit `TurnContinuation`
- for Claude workflow loops, choose `fresh` after the first turn unless a true
  resume is intended
- for Codex workflow loops, choose either `reuse-current` or `fresh` explicitly
  based on Athena workflow policy

Blast radius:

- high
- this is the core semantic cleanup and should happen before more workflow work

#### 3. Make `kill()` semantics true or weaken the contract

Problem:

- shared callers await `kill()`
- Claude kill resolves before the child turn is fully settled
- Codex kill is only interrupt and may wait forever for completion

Files:

- [src/harnesses/claude/session/controller.ts](/home/nadeemm/athena/cli/src/harnesses/claude/session/controller.ts)
- [src/harnesses/codex/session/controller.ts](/home/nadeemm/athena/cli/src/harnesses/codex/session/controller.ts)
- [src/harnesses/codex/session/useSessionController.ts](/home/nadeemm/athena/cli/src/harnesses/codex/session/useSessionController.ts)
- [src/harnesses/codex/runtime/server.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/server.ts)

Fix:

- choose one of:
  - strengthen implementations so `kill()` means turn settled
  - or rename/split into `interrupt()` and `dispose()` and stop awaiting fake
    teardown
- recommended: make `kill()` wait for turn settlement in both harnesses

Blast radius:

- medium
- concentrated in session controllers and workflow wrapper behavior

### P1: Codex parity and protocol correctness

These are high value but more localized than the shared contract changes.

#### 4. Respect configured isolation on Codex

Problem:

- Codex hardcodes `approvalPolicy: 'on-request'` and
  `sandbox: 'workspace-write'`

Files:

- [src/harnesses/codex/session/promptOptions.ts](/home/nadeemm/athena/cli/src/harnesses/codex/session/promptOptions.ts)
- [src/harnesses/codex/runtime/server.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/server.ts)

Fix:

- add an explicit Codex config mapper from Athena isolation config to:
  - `approvalPolicy`
  - `sandbox` or `sandboxPolicy`
- document unsupported mappings explicitly instead of silently dropping them

Blast radius:

- medium
- Codex-only

#### 5. Pass full plugin MCP config into Codex, not only workflow MCP config

Problem:

- Codex only sees MCP config derived from `workflowPlan`
- global/project/CLI plugin MCP config is dropped

Files:

- [src/harnesses/codex/session/promptOptions.ts](/home/nadeemm/athena/cli/src/harnesses/codex/session/promptOptions.ts)
- [src/harnesses/codex/session/workflowArtifacts.ts](/home/nadeemm/athena/cli/src/harnesses/codex/session/workflowArtifacts.ts)
- [src/app/process/useHarnessProcess.ts](/home/nadeemm/athena/cli/src/app/process/useHarnessProcess.ts)
- [src/app/exec/runner.ts](/home/nadeemm/athena/cli/src/app/exec/runner.ts)

Fix:

- make Codex prompt/runtime config merge:
  - `pluginMcpConfig`
  - workflow-derived MCP config
- rename `workflowArtifacts` if it now contains general session assets

Blast radius:

- low to medium
- Codex-only

#### 6. Fix legacy approval response enums

Problem:

- legacy `applyPatchApproval` and `execCommandApproval` are answered with
  generic decision values

Files:

- [src/harnesses/codex/runtime/eventTranslator.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/eventTranslator.ts)
- [src/harnesses/codex/runtime/decisionMapper.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/decisionMapper.ts)

Fix:

- branch in `mapDecisionToCodexResult()` by request method
- emit protocol-correct legacy values for legacy requests

Blast radius:

- low
- protocol-localized

#### 7. Add Codex subagent lifecycle normalization

Problem:

- Codex collaboration items do not become `subagent.start` / `subagent.stop`

Files:

- [src/harnesses/codex/runtime/eventTranslator.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/eventTranslator.ts)
- [src/core/feed/mapper.ts](/home/nadeemm/athena/cli/src/core/feed/mapper.ts)

Fix:

- map `collabAgentToolCall` lifecycle into shared subagent events
- keep renderer unchanged

Blast radius:

- low
- mostly translator and tests

#### 8. Preserve Codex failure details

Problem:

- tool failure mapping throws away structured error/output details

Files:

- [src/harnesses/codex/runtime/eventTranslator.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/eventTranslator.ts)

Fix:

- normalize command, file, and MCP failures with real error payloads
- prefer structured messages over `item.error as string`

Blast radius:

- low

### P2: Cleanup after semantics are fixed

These are worthwhile, but should follow the contract corrections above.

#### 9. Expand adapter metadata with explicit capabilities

Files:

- [src/harnesses/adapter.ts](/home/nadeemm/athena/cli/src/harnesses/adapter.ts)
- [src/harnesses/claude/adapter.ts](/home/nadeemm/athena/cli/src/harnesses/claude/adapter.ts)
- [src/harnesses/codex/adapter.ts](/home/nadeemm/athena/cli/src/harnesses/codex/adapter.ts)

Purpose:

- let app/workflow code branch on declared capability, not harness id or hidden
  behavior

#### 10. Rename workflow/session APIs to match semantics

Examples:

- `sessionId` -> `continuation` or `resumeHandle`
- `spawn()` -> `startTurn()`

Purpose:

- remove Claude-biased naming from shared code

#### 11. Split “workflow artifacts” from “session assets”

Problem:

- Codex session assets now include both workflow-derived and session-global
  assets

Purpose:

- avoid repeating the same mistake with workflow-only naming around general
  plugin/MCP/session data

## Recommended Implementation Sequence

1. shared turn-result contract for interactive shell
2. explicit continuation model replacing `sessionId`
3. true `kill()` semantics or contract split
4. Codex isolation mapping
5. Codex MCP config merge
6. Codex legacy approval fix
7. Codex subagent lifecycle translation
8. Codex failure-detail preservation
9. adapter capabilities cleanup
10. naming cleanup

## Merge Gates Per Phase

### After P0

- workflow loops stop on failed Claude turns
- no shared logic depends on ambiguous `sessionId`
- interrupt/restart cannot hang on stale turn promises

### After P1

- Codex respects configured isolation policy
- Codex receives all active MCP config
- Codex approvals are protocol-correct
- Codex feed shows Spawn / Return with shared subagent events

### After P2

- shared contracts describe behavior honestly
- adapter metadata expresses semantic differences explicitly
- no hidden harness-specific behavior remains in app/workflow wrappers
