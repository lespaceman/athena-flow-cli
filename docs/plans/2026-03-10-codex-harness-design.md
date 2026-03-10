# Harness Architecture Proposal

## Sources

- Claude CLI reference: https://code.claude.com/docs/en/cli-reference.md
- Claude headless mode: https://code.claude.com/docs/en/headless.md
- Claude docs index: https://code.claude.com/docs/llms.txt
- Codex app-server protocol: generated locally from `codex-cli 0.112.0` via:
  - `codex app-server generate-ts --experimental`
  - `codex app-server generate-json-schema`
- Codex reference integration: `lespaceman/t3code` at commit `45744cc7893243b5ad17b153fb250d50ce87d80c`

## What The Docs Say

### Claude

- Athena's current Claude path is aligned with the official model: `claude -p` plus `--output-format stream-json`.
- Hooks are configured through Claude settings, which fits Athena's generated temporary settings file and hook-forwarder approach.
- Claude is still fundamentally "spawn a headless run, stream output, receive hook callbacks out-of-band".

### Codex

- Codex app-server is not a "spawn once per prompt" CLI surface. It is a long-lived protocol:
  - `initialize` -> `initialized`
  - `thread/start` or `thread/resume`
  - `turn/start`
  - notifications and server requests during the turn
  - optional `turn/interrupt`
- The official protocol surface is broader than Athena's current hand-written subset. The generated v2 schema includes:
  - richer notifications (`turn/plan/updated`, reasoning deltas, output deltas, token usage updates)
  - broader request types (`item/tool/requestUserInput`, `mcpServer/elicitation/request`, dynamic tool calls, `execCommandApproval`, `applyPatchApproval`)
  - explicit session/thread/turn configuration fields (`approvalPolicy`, `sandbox`, `sandboxPolicy`, `developerInstructions`, collaboration mode)

### Implication

Claude and Codex can share a harness architecture, but they should not share a "process" abstraction. Claude's unit of work is a spawned headless run. Codex's unit of work is a turn on a persistent session.

## Problems In Athena Today

### 1. Runtime and execution are conflated

Current code forces both harnesses through `Runtime` plus a Claude-shaped "process profile". That leaks in multiple places:

- [src/harnesses/processProfiles.ts](/home/nadeemm/athena/cli/src/harnesses/processProfiles.ts#L24)
- [src/harnesses/codex/process/useProcess.ts](/home/nadeemm/athena/cli/src/harnesses/codex/process/useProcess.ts#L17)
- [src/app/exec/runner.ts](/home/nadeemm/athena/cli/src/app/exec/runner.ts#L479)

Codex only works by casting `Runtime` to `CodexRuntime` and pretending the runtime is also the process.

### 2. The public contract is Claude-shaped

`HarnessProcessConfig` and `configProfiles` are still built around Claude isolation semantics. Codex can only partially map onto that.

- [src/harnesses/configProfiles.ts](/home/nadeemm/athena/cli/src/harnesses/configProfiles.ts)
- [src/harnesses/claude/config/isolation.ts](/home/nadeemm/athena/cli/src/harnesses/claude/config/isolation.ts)

### 3. Codex protocol fidelity is being lost

Current Codex mapping collapses provider-specific semantics into Claude-era event kinds:

- `turn/completed` is translated into `stop.request`
- agent message deltas are buffered and injected into that fake stop event
- token usage lives as an ad hoc `notification`

Relevant files:

- [src/harnesses/codex/runtime/server.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/server.ts#L110)
- [src/harnesses/codex/runtime/server.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/server.ts#L248)
- [src/harnesses/codex/runtime/eventTranslator.ts](/home/nadeemm/athena/cli/src/harnesses/codex/runtime/eventTranslator.ts#L80)

This makes the runtime layer look unified, but it hides important differences and makes future Codex support brittle.

### 4. Codex protocol definitions are manually copied and already stale

Athena's `src/harnesses/codex/protocol/*` is a hand-maintained snapshot. The official generated schema for `0.112.0` has more request and notification variants than Athena handles today.

### 5. App integration branches on harness identity

The application still contains `if (isCodex)` branches because the harness contract is not strong enough.

- [src/app/runtime/createRuntime.ts](/home/nadeemm/athena/cli/src/app/runtime/createRuntime.ts#L16)
- [src/app/exec/runner.ts](/home/nadeemm/athena/cli/src/app/exec/runner.ts#L479)

## Recommended Target Architecture

Split harnesses into four concerns:

1. `adapter`
2. `runtime`
3. `session`
4. `config`

### 1. Adapter

One registry entry per harness. This is the public integration surface for the app.

```ts
type HarnessAdapter = {
	id: AthenaHarness;
	label: string;
	verify: () => HarnessVerificationResult;
	createRuntime(input: RuntimeFactoryInput): Runtime;
	createSessionController(
		input: SessionControllerFactoryInput,
	): SessionController;
	resolveConfigProfile(): HarnessConfigProfile;
};
```

The app should depend on this registry, not on `switch (harness)` plus ad hoc casts.

### 2. Runtime

The runtime remains the event/decision transport boundary only.

Responsibilities:

- start/stop provider transport
- emit normalized runtime events
- accept decisions for pending provider requests
- expose startup errors

Non-responsibilities:

- starting turns
- deciding whether work is "a process" or "a persistent thread"
- token accumulation policy

Claude runtime = hook server.
Codex runtime = app-server transport client.

### 3. Session controller

This replaces the current Claude-biased "process" abstraction.

```ts
type SessionController = {
	startTurn(input: {
		prompt: string;
		resumeSessionId?: string;
		overrides?: TurnOverrides;
	}): Promise<TurnResult>;
	interrupt(): void;
	stop(): Promise<void>;
	subscribeUsage(handler: (usage: TokenUsage) => void): () => void;
	getState(): {
		running: boolean;
		providerSessionId?: string | null;
	};
};
```

Why this matters:

- Claude implementation starts a child process per turn.
- Codex implementation sends `turn/start` on an existing thread.

Both are "start a turn", but only one is a spawned process.

### 4. Config

Replace the current isolation-first config model with two layers:

```ts
type SessionOpenConfig = {
	cwd: string;
	model?: string;
	approvalMode?: 'interactive' | 'never';
	sandboxMode?: 'workspace-write' | 'danger-full-access';
	baseInstructions?: string;
	developerInstructions?: string;
};

type TurnOverrides = {
	model?: string;
	outputSchema?: unknown;
	cwd?: string;
	developerInstructions?: string;
};
```

Harnesses can map these differently:

- Claude maps to CLI flags plus generated settings.
- Codex maps to `thread/start|resume` and `turn/start` params.

Keep Claude-specific isolation helpers internally under `src/harnesses/claude/config/`.
Do not make them the cross-harness contract.

## Recommended Folder Shape

```text
src/harnesses/
  adapter.ts
  registry.ts
  contracts/
    runtime.ts
    session.ts
    config.ts
    verification.ts
  claude/
    adapter.ts
    runtime/
    session/
    config/
    protocol/
    system/
  codex/
    adapter.ts
    runtime/
    session/
    config/
    protocol/
      generated/
      index.ts
    system/
```

Notes:

- `claude/process` should become `claude/session`.
- `codex/process/useProcess.ts` should disappear; it is a compatibility shim, not a real domain concept.
- `processProfiles.ts` should be replaced with adapter-driven `createSessionController`.

## Runtime Event Model Changes

The current `RuntimeEventKind` union is Claude-centric. Codex support is being forced into fake Claude events.

Add a small set of provider-neutral execution events:

```ts
type RuntimeEventKind =
  | existing Claude kinds
  | "turn.start"
  | "turn.complete"
  | "message.delta"
  | "plan.delta"
  | "reasoning.delta"
  | "usage.update";
```

Rules:

- Do not encode `turn/completed` as `stop.request`.
- Do not encode token updates as generic notifications if the app needs them structurally.
- Keep raw provider payloads attached for diagnostics.

Claude can keep emitting the existing hook-derived kinds.
Codex should emit the richer set directly.

The feed mapper can continue collapsing these into today's UI events where needed, but the runtime boundary should stop lying about what happened.

## Protocol Strategy For Codex

Do not keep hand-maintaining method names and payload shapes.

Recommended approach:

1. Add a small script that snapshots generated app-server bindings from the installed Codex CLI.
2. Check the generated snapshot into `src/harnesses/codex/protocol/generated/`.
3. Write thin Athena-owned wrappers around those generated types.

This gives Athena:

- a pinned protocol snapshot
- fewer silent drifts
- explicit upgrade points when Codex CLI changes

## How Each Harness Fits The New Shape

### Claude

Runtime:

- `createClaudeHookRuntime()` stays as the hook transport.

Session controller:

- wraps current `spawnClaude`
- manages per-turn child lifecycle
- owns token parsing from `stream-json`
- publishes turn completion independently of runtime transport

Config:

- continues to use generated hook settings
- keeps all Claude-only flags isolated inside the Claude adapter

### Codex

Runtime:

- owns the app-server transport and server request/notification plumbing
- does not expose `sendPrompt()` on the generic runtime type

Session controller:

- owns `thread/start|resume`, `turn/start`, and `turn/interrupt`
- owns thread state and resume fallback
- subscribes to runtime events for token/message/turn state

Config:

- maps shared open/turn config into protocol params
- optionally supports collaboration mode and developer instructions later

## Migration Plan

### Phase 1: Introduce contracts without behavior changes

- Add `contracts/session.ts`
- Add `claude/adapter.ts` and `codex/adapter.ts`
- Add a central adapter registry
- Keep old `processProfiles.ts` temporarily as a compatibility layer

### Phase 2: Move app code to adapter APIs

- Refactor `createRuntime()` into adapter lookup
- Refactor `useHarnessProcess()` to use `createSessionController()`
- Refactor exec mode to call the session controller instead of branching on `isCodex`

Success condition:

- no app-level casts to `CodexRuntime`
- no `if (harness === 'openai-codex')` in execution flow

### Phase 3: Expand runtime event kinds

- add `turn.complete`, `usage.update`, `message.delta`, and any other minimal structural kinds
- update feed mapper to consume them
- remove Codex's synthetic `stop.request` behavior

### Phase 4: Replace hand-written Codex protocol surface

- snapshot generated protocol bindings
- rework `decisionMapper` and translators around the generated types
- add explicit unsupported-request handling for any protocol variants Athena chooses not to support yet

### Phase 5: Clean naming

- rename `processProfiles.ts` -> `sessionProfiles.ts` or remove it entirely
- rename `claude/process/*` -> `claude/session/*`
- keep "process" only where an actual OS child process exists

## What I Would Not Change Yet

- Do not rewrite Claude hook transport. It already matches Anthropic's model.
- Do not try to force Claude to look like app-server.
- Do not broaden the UI first. Fix the harness contract first, then decide which Codex-native events deserve first-class UI.

## Immediate Recommendation

The next code change should be a contract refactor, not another Codex runtime patch.

Specifically:

1. Introduce `HarnessAdapter` and `SessionController`.
2. Move Claude and Codex behind that adapter boundary.
3. Remove app-level Codex casts.
4. Then upgrade Codex protocol handling against a generated snapshot.

That keeps Claude stable and gives Codex a shape that matches the official app-server model instead of pretending it is a second Claude.
