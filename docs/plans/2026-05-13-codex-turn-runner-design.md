# CodexTurnRunner Design

Date: 2026-05-13

## Context

Codex runs as a persistent app-server runtime. Starting work means sending a
prompt into an existing Codex session, then interpreting the normalized
`RuntimeEvent` stream until the Codex turn settles.

Today that projection is duplicated:

- `src/harnesses/codex/session/controller.ts` implements the non-React
  `SessionController` path.
- `src/harnesses/codex/session/useSessionController.ts` implements the React
  hook path.

Both modules subscribe to `runtime.onEvent`, call `sendPrompt`, accumulate
`message.delta`, read per-turn token `delta`, observe `turn.complete`, extract
Codex error notifications, unsubscribe, and build a `TurnExecutionResult`.

This is a shallow split. The React and non-React adapters look different, but
their interface knowledge is almost identical: event ordering, error modes,
token policy, stream policy, and cleanup rules.

## Goal

Introduce **CodexTurnRunner** as the deep module behind the Codex session seam.
It should own a single Codex turn from prompt submission to
`TurnExecutionResult`.

The public Codex session adapters should stop knowing how Codex event streams
become turn results. They should only provide runtime/config inputs and own
their caller-specific state:

- React hook: `isRunning`, global token display, lifecycle callbacks.
- Non-React controller: `SessionController` shape and interrupt/kill methods.

## Non-Goals

- Do not change `RuntimeEvent` translation.
- Do not change `FeedMapper` behavior.
- Do not change `buildCodexPromptOptions`.
- Do not add new Codex protocol methods.
- Do not redesign the cross-harness `SessionController` interface.

## Proposed Module

Create:

```text
src/harnesses/codex/session/turnRunner.ts
src/harnesses/codex/session/turnRunner.test.ts
```

The module has one primary interface:

```ts
import type {RuntimeEvent} from '../../../core/runtime/types';
import type {TurnExecutionResult} from '../../../core/runtime/process';
import type {CodexPromptOptions, CodexRuntime} from '../runtime/server';

export type CodexTurnRunner = {
	run(input: CodexTurnInput): Promise<TurnExecutionResult>;
	isRunning(): boolean;
	interrupt(): void;
	kill(): Promise<void>;
};

export type CodexTurnInput = {
	prompt: string;
	options: CodexPromptOptions;
};

export function createCodexTurnRunner(
	runtime: CodexRuntime | null,
): CodexTurnRunner;
```

If `CodexPromptOptions` is not currently exported under that exact name, add the
smallest exported type needed from the runtime layer instead of widening the
interface to `unknown`.

## Interface Invariants

### Single Active Turn

`run()` rejects if another turn is already active for the runner.

Reason: Codex emits events through one runtime stream. If two prompts are in
flight, `message.delta`, `usage.update`, `unknown/error`, and `turn.complete`
cannot be attributed safely without stronger protocol correlation than the
current session layer uses.

Suggested error:

```ts
new Error('Codex turn already running');
```

### Subscription Ownership

`run()` owns the `runtime.onEvent` subscription for turn-result projection.
It must unsubscribe exactly once when the turn settles, whether the prompt
succeeds, the turn fails, `sendPrompt` throws, or `kill()` waits for completion.

### Result Policy

`message.delta` events append to the returned `streamMessage`.

`usage.update` events update the returned per-turn `tokens` from
`event.data.delta`, not cumulative `event.data.usage`.

`turn.complete` with `data.status === 'failed'` returns:

```ts
{
	exitCode: 1,
	error: new Error(lastCodexErrorMessage ?? 'Codex turn failed'),
	tokens,
	streamMessage,
}
```

Successful `sendPrompt` with no failed turn returns `exitCode: 0` and
`error: null`.

Thrown `sendPrompt` errors return `exitCode: null` and the thrown error.

### Error Extraction

For now, preserve current behavior:

- detect `event.kind === 'unknown' && event.hookName === 'error'`
- read `event.data.payload.error.message` when present

If later Codex translation creates a first-class runtime error event, this
module becomes the single locality point for that migration.

## Implementation Sketch

```ts
export function createCodexTurnRunner(
	runtime: (Runtime & CodexRuntime) | null,
): CodexTurnRunner {
	let activeTurnPromise: Promise<TurnExecutionResult> | null = null;

	async function run(input: CodexTurnInput): Promise<TurnExecutionResult> {
		if (!runtime || typeof runtime.sendPrompt !== 'function') {
			return unavailableResult();
		}
		if (activeTurnPromise) {
			return {
				exitCode: null,
				error: new Error('Codex turn already running'),
				tokens: {...NULL_TOKENS},
				streamMessage: null,
			};
		}

		const state = createTurnProjectionState();
		const unsubscribe = runtime.onEvent(event => state.observe(event));

		activeTurnPromise = (async () => {
			try {
				await runtime.sendPrompt(input.prompt, input.options);
				return state.toResult();
			} catch (error) {
				return state.toThrownResult(error);
			} finally {
				activeTurnPromise = null;
				unsubscribe();
			}
		})();

		return activeTurnPromise;
	}

	return {
		run,
		isRunning: () => activeTurnPromise !== null,
		interrupt: () => runtime?.sendInterrupt(),
		async kill() {
			runtime?.sendInterrupt();
			await activeTurnPromise?.catch(() => {});
		},
	};
}
```

The sketch is illustrative. The final implementation should keep
`createTurnProjectionState` private unless tests prove a smaller internal seam
would materially improve locality.

## Adapter Changes

### Non-React Controller

`createCodexSessionController` should create one `CodexTurnRunner` and delegate
`startTurn`, `interrupt`, and `kill`.

It remains responsible for:

- runtime availability cast
- `processConfig` capture
- `buildCodexPromptOptions`
- `SessionController` input/output shape

### React Hook

`useCodexSessionController` should keep React-owned state:

- `isRunning`
- global `tokenUsage` from cumulative `usage.update`
- `onLifecycleEvent`
- `onExitTokens`
- abort handling

It should delegate turn execution to `CodexTurnRunner.run()`.

The hook can still subscribe separately to `runtime.onEvent` for cumulative
header token display. That is not turn-result projection and should remain
React-local unless a later module deepens token display ownership.

## Testing Plan

Add focused `turnRunner.test.ts` coverage:

1. returns unavailable result when runtime is absent
2. sends prompt with provided options
3. accumulates `message.delta` into `streamMessage`
4. uses `usage.update.data.delta` for returned per-turn tokens
5. returns failed result on `turn.complete` status `failed`
6. uses the latest Codex error notification message for failed turns
7. returns thrown `sendPrompt` errors with accumulated stream/tokens
8. unsubscribes after success
9. unsubscribes after thrown error
10. rejects overlapping turns
11. `interrupt()` delegates to `runtime.sendInterrupt`
12. `kill()` interrupts and waits for the active turn to settle

Then reduce existing adapter tests to prove delegation and caller-owned state:

- `controller.test.ts`: options forwarded, failed turn behavior via runner if
  not already covered, interrupt/kill delegation.
- `useSessionController.test.ts`: React `isRunning`, cumulative header token
  policy, lifecycle error callback, options forwarded.

Avoid keeping duplicate tests for the full Codex event-to-result matrix in both
adapters after `turnRunner.test.ts` owns that interface.

## Migration Plan

1. Add `turnRunner.ts` and its tests without changing callers.
2. Move the non-React controller to the runner.
3. Move the React hook to the runner while preserving its global token
   subscription.
4. Remove duplicated projection code from both adapters.
5. Run:

```bash
npm test -- src/harnesses/codex/session
npm run typecheck
```

## Risks

### Overlap Rejection Changes Behavior

Current code tracks an active turn but does not prevent a second `startTurn`.
Rejecting overlap is an intentional tightening. It may surface a caller bug that
was previously hidden.

Mitigation: use a clear error and add tests at the runner seam. If a caller
legitimately needs concurrency, it must use separate Codex runtimes or add
protocol-level turn correlation before this invariant can be relaxed.

### React Hook Subscription Duplication

The React hook will still subscribe to runtime events for cumulative header
tokens while the runner subscribes for active turn projection.

Mitigation: these are different responsibilities. The hook's subscription is
display state; the runner's subscription is turn-result projection.

### Runtime Type Widening

If the runner interface accepts broad `Runtime` plus casts, it loses depth.

Mitigation: keep the runner Codex-specific and require a runtime shape that has
`sendPrompt`, `sendInterrupt`, and `onEvent`.

## Success Criteria

- Codex event-to-`TurnExecutionResult` behavior has one test surface.
- `controller.ts` and `useSessionController.ts` no longer duplicate
  `message.delta`, `usage.update`, `turn.complete`, or Codex error extraction.
- Overlapping turns are explicitly rejected.
- Public behavior for successful turns, failed turns, thrown prompt errors,
  stream messages, and per-turn token deltas is preserved except for the
  intentional overlap invariant.
