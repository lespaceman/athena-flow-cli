# Transient API Error Retry

## Problem

When a workflow turn fails because of a transient Anthropic API error (e.g. `API Error: 401 Invalid authentication credentials` that resolves on a subsequent run without any credential change, or 429/5xx), Athena currently marks the run as `failed` and stops. The user then has to manually restart. We want Athena to automatically retry the turn a bounded number of times with exponential backoff, so transient blips don't abort workflows. Hard bound prevents infinite loops when the failure is genuine (e.g. real auth breakage).

## Scope

In scope:

- Auto-retry the failing turn on a narrow allowlist of transient API/network errors.
- Bounded attempts with exponential backoff.
- Feed visibility so users see retries happen.
- Clear final `stopReason` that distinguishes "gave up after N attempts" from a single failure.

Out of scope:

- Retrying non-API errors (tool failures, agent-produced errors, schema validation, etc.).
- Per-workflow retry configuration.
- Jitter on backoff.
- Cross-run resumption (this is intra-turn retry only).
- Changes to the Codex harness — this lives at the workflow runner layer and is harness-agnostic, but the error-matching patterns are tuned to Claude/Anthropic errors today.

## Design

### Location

`src/core/workflows/workflowRunner.ts`, around lines 213–245. The current failure branch (`if (turnResult.error || exitCode !== 0)`) is replaced by a retry-aware wrapper around `input.startTurn(...)`.

### Error classification

New helper, colocated with the runner or in a small module it imports:

```ts
export function isTransientTurnError(result: TurnExecutionResult): boolean;
```

Returns `true` when `result.error` or `result.exitCode !== 0` AND the concatenated haystack of `result.error?.message` + `result.lastStderr` matches any of:

- `/API Error: 401\b/u` — transient auth (observed)
- `/API Error: 403\b/u`
- `/API Error: 429\b/u` — rate limit
- `/API Error: 5\d\d\b/u` — server errors
- `/\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/u`
- `/socket hang up/iu`
- `/fetch failed/iu`

Anything else that currently enters the failure branch continues to fail immediately, same as today.

### Retry loop

Replace the current single `startTurn` call with:

```
const MAX_ATTEMPTS = 3; // initial + 2 retries
const BACKOFF_MS = [5_000, 15_000]; // delay BEFORE attempt 2, then BEFORE attempt 3

let attempt = 0;
let turnResult: TurnExecutionResult;
while (true) {
  attempt++;
  turnResult = await input.startTurn({ prompt: prepared.prompt, continuation: nextContinuation, configOverride: prepared.configOverride });

  if (cancelled) break;
  if (!isTransientTurnError(turnResult)) break;            // success OR non-retryable error
  if (attempt >= MAX_ATTEMPTS) break;                       // budget exhausted

  const delay = BACKOFF_MS[attempt - 1];
  emitRetryFeedEvent({ attempt, nextAttempt: attempt + 1, maxAttempts: MAX_ATTEMPTS, delayMs: delay, cause: summarize(turnResult) });
  const cancelledDuringSleep = await sleepCancellable(delay, () => cancelled);
  if (cancelledDuringSleep || cancelled) break;
}
```

After the loop:

- If `turnResult` is a success or a non-transient error → existing logic handles it unchanged.
- If `turnResult` is still a transient error and `attempt === MAX_ATTEMPTS` → enter the failure branch with a `stopReason` that includes `" (gave up after 3 transient-error retries)"` appended to the existing message.

Cumulative token accounting should merge tokens from **every** attempt, not just the final one, so usage reflects real spend.

### Cancellation

`sleepCancellable(ms, isCancelled)` resolves early when `cancelled` flips. The existing `cancel()` path on `WorkflowRunnerHandle` sets `cancelled = true`; the retry loop checks it after each sleep and after each attempt. No timer leaks.

### Feed visibility

Emit a synthetic feed event before each backoff sleep via a new optional `onRetryScheduled` callback on `WorkflowRunnerInput`, wired up by the caller to the feed store. Event shape (new `FeedEvent` variant or reuse of an existing system/info event — TBD during implementation based on existing patterns in `src/core/feed/`):

- Kind: info / system message
- Text: `Transient API error — retrying in {delay}s (attempt {next}/{max}). Cause: {short cause}`

Keeping the emission as a callback avoids adding feed-layer imports to the runner.

### Continuation semantics

Retries pass the **same `nextContinuation`** that was used for the failed attempt. We do not switch to `continue`/`resume` mode — we want to re-execute the same turn, not tack onto a half-completed one. This is important because a 401 typically means the request never reached the model, so there is no partial session state to resume from.

### Final `stopReason` format

When all attempts fail:

```
{original error parts joined as today} (gave up after 3 transient-error retries)
```

This preserves current behavior for the common single-failure case while making retry exhaustion obvious in logs and UI.

## Testing

Unit tests in `src/core/workflows/workflowRunner.test.ts` (or a new sibling):

- `startTurn` returns transient 401 twice then success → runner completes, `iterations === 1`, `onRetryScheduled` called twice with correct attempt numbers and delays.
- `startTurn` returns transient 5xx three times → runner fails with `stopReason` containing "gave up after 3".
- `startTurn` returns non-transient error (e.g. tool failure message, or 400) → fails immediately, no retries, no feed emissions.
- Cancel during backoff sleep → runner transitions to `cancelled`, no further `startTurn` calls.
- Token accounting merges across all attempts (including failed ones).

Use fake timers (`vi.useFakeTimers()`) to verify exact backoff delays without real waits.

A unit test for `isTransientTurnError` covers each regex branch and confirms non-matching strings return `false`.

## Risks and mitigations

- **Risk:** Anthropic error message format changes, causing retries to stop firing silently. **Mitigation:** regex list is centralized in one function with its own tests; error-classification tests will flag format drift when exercised against real error corpora. We can also log the raw error when classification decides "not transient" to help catch drift in the field.
- **Risk:** A genuinely-broken credential causes two full backoff cycles (~20s) of user-visible delay before surfacing the error. **Mitigation:** feed events make retries visible, and the total budget (~20s) is bounded. If this proves annoying in practice, we can add a `--no-retry` flag or shorten the first backoff. YAGNI for now.
- **Risk:** Retry loop masks a real underlying problem that a human should see immediately. **Mitigation:** only narrowly-classified transient errors retry; everything else fails fast as today.
