# AppShell.tsx Cleanup Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Clean up `AppShell.tsx` for readability and maintainability — reduce cognitive load per section, eliminate inline derivations, and apply consistent patterns already used elsewhere in the codebase.

**Architecture:** Extract remaining inline logic into focused hooks and pure functions. Colocate related state. Push derived values closer to where they're consumed. Follow the project's established hook-extraction pattern (see `usePager`, `useFrameChrome`, `useShellInput`). No behavior changes — pure refactoring.

**Tech Stack:** React 19, Ink, TypeScript, vitest

---

## Analysis: Issues Found

1. **Massive `useHookContextSelector` wall** (lines 180–216) — 15 consecutive context selector calls with no grouping or abstraction. Each selector creates a subscription, and the flat wall makes it hard to see which values are used for what purpose.

2. **Inline `sessionScope` derivation** (lines 219–232) — `useMemo` calling `getSessionMeta()` (an infra function) directly inside a UI component. This I/O-adjacent computation doesn't belong in `AppContent`.

3. **Inline `timelineCurrentRun` reshaping** (lines 236–246) — A `useMemo` that just picks 3 fields off `currentRun` and wraps them in a new shape. This is a pure transformation better expressed as a helper function.

4. **Giant `submitPromptOrSlashCommand` callback** (lines 391–460) — 70-line callback mixing prompt submission, command execution context building, and session management. The `executeCommand` context object construction alone is ~30 lines.

5. **Inline `useInput` global handler** (lines 589–642) — A catch-all keyboard handler for escape-interrupt, ctrl-t, ctrl-/, and input-mode keys. This is the last un-extracted keyboard hook.

6. **Inline input layout derivation** (lines 820–850) — Badge text, input prefix width, placeholder text — all computed inline in the render body with `let` mutations. Should be a `useMemo` or extracted.

7. **Duplicated type aliases** — `FocusMode` and `InputMode` are defined in this file (lines 104–105) AND in `useShellInput.ts` (lines 7–8). These shared types should live in one place.

8. **Stale constants masquerading as state** — `runFilter` (line 173) and `errorsOnly` (line 174) are hardcoded constants (`'all'` and `false`) threaded through as if they were dynamic state. They add noise.

9. **`theme` prop drilling** — `AppContent` calls `useTheme()` (line 179) then passes `theme` down to `buildBodyLines`, `FeedGrid`, `formatFeedRowLine`. The child components could call `useTheme()` themselves (as `PermissionDialog` and `QuestionDialog` already do).

10. **Unstable callback references in keyboard hook props** — `setInputValue: (v: string) => setInputValueRef.current(v)` is recreated every render (lines 656, 673). Should be a stable `useCallback`.

11. **`withProfiler` is a function, not a component** — The `withProfiler` helper (line 1043) in the outer `App` recreates JSX inline. It works but reads oddly; a `<MaybeProfiler>` wrapper component would be clearer.

12. **Outer `App` setup-completion handler is 20+ lines inline** — The `onComplete` callback inside the setup phase JSX (lines 1094–1119) does config refresh and state updates inline in JSX.

---

## Implementation Tasks

### Task 1: Deduplicate `FocusMode` and `InputMode` types

**Files:**

- Create: `src/app/shell/types.ts`
- Modify: `src/app/shell/AppShell.tsx:104-105`
- Modify: `src/app/shell/useShellInput.ts:7-8`

**Step 1: Create the shared types file**

```typescript
// src/app/shell/types.ts
export type FocusMode = 'feed' | 'input' | 'todo';
export type InputMode = 'normal' | 'search';
```

**Step 2: Update imports in both files**

In `AppShell.tsx`, remove lines 104–105 and add:

```typescript
import {type FocusMode, type InputMode} from './types';
```

In `useShellInput.ts`, remove lines 7–8 and add:

```typescript
import {type FocusMode, type InputMode} from './types';
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — types are identical, just relocated.

**Step 4: Commit**

```bash
git add src/app/shell/types.ts src/app/shell/AppShell.tsx src/app/shell/useShellInput.ts
git commit -m "refactor: deduplicate FocusMode/InputMode types into shell/types.ts"
```

---

### Task 2: Remove hardcoded constant noise (`runFilter`, `errorsOnly`)

**Files:**

- Modify: `src/app/shell/AppShell.tsx` — lines 173–174, and all references

**Step 1: Inline the constants at their usage sites**

Remove lines 173–174:

```typescript
const runFilter = 'all';
const errorsOnly = false;
```

Replace usages:

- `useTimeline` call: remove `runFilter` and `errorsOnly` params (or pass literals if required by the hook signature)
- `buildBodyLines` call: replace `runFilter` with `'all'`
- Check `useTimeline` and `buildBodyLines` signatures — if they have defaults, omit the params entirely.

**Step 2: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/app/shell/AppShell.tsx
git commit -m "refactor: remove hardcoded runFilter/errorsOnly pseudo-state"
```

---

### Task 3: Extract `useRuntimeSelectors` hook to group context selectors

**Files:**

- Create: `src/app/shell/useRuntimeSelectors.ts`
- Modify: `src/app/shell/AppShell.tsx` — lines 180–216

**Step 1: Create `useRuntimeSelectors.ts`**

Group the 15 `useHookContextSelector` calls into a single hook that returns a structured object with named groups:

```typescript
// src/app/shell/useRuntimeSelectors.ts
import {useHookContextSelector} from '../providers/RuntimeProvider';

export function useRuntimeSelectors() {
	// Feed data
	const feedEvents = useHookContextSelector(v => v.feedEvents);
	const feedItems = useHookContextSelector(v => v.items);
	const tasks = useHookContextSelector(v => v.tasks);
	const postByToolUseId = useHookContextSelector(v => v.postByToolUseId);

	// Session
	const session = useHookContextSelector(v => v.session);
	const currentRun = useHookContextSelector(v => v.currentRun);

	// Permission/question queues
	const currentPermissionRequest = useHookContextSelector(
		v => v.currentPermissionRequest,
	);
	const permissionQueueCount = useHookContextSelector(
		v => v.permissionQueueCount,
	);
	const resolvePermission = useHookContextSelector(v => v.resolvePermission);
	const currentQuestionRequest = useHookContextSelector(
		v => v.currentQuestionRequest,
	);
	const questionQueueCount = useHookContextSelector(v => v.questionQueueCount);
	const resolveQuestion = useHookContextSelector(v => v.resolveQuestion);

	// Actions
	const allocateSeq = useHookContextSelector(v => v.allocateSeq);
	const clearEvents = useHookContextSelector(v => v.clearEvents);
	const printTaskSnapshot = useHookContextSelector(v => v.printTaskSnapshot);
	const recordTokens = useHookContextSelector(v => v.recordTokens);
	const restoredTokens = useHookContextSelector(v => v.restoredTokens);

	return {
		feedEvents,
		feedItems,
		tasks,
		postByToolUseId,
		session,
		currentRun,
		currentPermissionRequest,
		permissionQueueCount,
		resolvePermission,
		currentQuestionRequest,
		questionQueueCount,
		resolveQuestion,
		allocateSeq,
		clearEvents,
		printTaskSnapshot,
		recordTokens,
		restoredTokens,
	};
}
```

**Step 2: Replace the selector wall in `AppContent`**

Replace lines 180–216 with:

```typescript
const rt = useRuntimeSelectors();
```

Update all references: `feedEvents` → `rt.feedEvents`, `session` → `rt.session`, etc.

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/shell/useRuntimeSelectors.ts src/app/shell/AppShell.tsx
git commit -m "refactor: extract useRuntimeSelectors to group context selectors"
```

---

### Task 4: Extract `useSessionScope` and `timelineCurrentRun` derivation

**Files:**

- Create: `src/app/shell/useSessionScope.ts`
- Modify: `src/app/shell/AppShell.tsx` — lines 218–246

**Step 1: Write the test**

```typescript
// src/app/shell/useSessionScope.test.ts
import {describe, it, expect} from 'vitest';
import {buildTimelineCurrentRun} from './useSessionScope';

describe('buildTimelineCurrentRun', () => {
	it('returns null when run_id is missing', () => {
		expect(buildTimelineCurrentRun(null)).toBeNull();
	});

	it('returns shaped object when run exists', () => {
		const run = {
			run_id: 'r1',
			started_at: 100,
			trigger: {prompt_preview: 'hello'},
		};
		expect(buildTimelineCurrentRun(run)).toEqual({
			run_id: 'r1',
			started_at: 100,
			trigger: {prompt_preview: 'hello'},
		});
	});
});
```

**Step 2: Run test — verify it fails (function doesn't exist yet)**

Run: `npx vitest run src/app/shell/useSessionScope.test.ts`
Expected: FAIL

**Step 3: Create `useSessionScope.ts`**

Extract `sessionScope` useMemo and `timelineCurrentRun` derivation into a hook + pure helper:

```typescript
// src/app/shell/useSessionScope.ts
import {useMemo} from 'react';
import {getSessionMeta} from '../../infra/sessions/registry';

type CurrentRun = {
	run_id: string;
	started_at: number;
	trigger: {prompt_preview?: string};
} | null;

export function buildTimelineCurrentRun(
	currentRun: {
		run_id: string;
		started_at: number;
		trigger: {prompt_preview?: string};
	} | null,
) {
	if (!currentRun) return null;
	return {
		run_id: currentRun.run_id,
		trigger: {prompt_preview: currentRun.trigger.prompt_preview},
		started_at: currentRun.started_at,
	};
}

export function useSessionScope(
	athenaSessionId: string,
	currentSessionId: string | null,
) {
	return useMemo(() => {
		const persisted = getSessionMeta(athenaSessionId)?.adapterSessionIds ?? [];
		const ids = [...persisted];
		if (currentSessionId && !ids.includes(currentSessionId)) {
			ids.push(currentSessionId);
		}
		const total = ids.length;
		const index =
			currentSessionId !== null ? ids.indexOf(currentSessionId) + 1 : null;
		return {
			current: index !== null && index > 0 ? index : null,
			total,
		};
	}, [athenaSessionId, currentSessionId]);
}
```

**Step 4: Run test — verify it passes**

Run: `npx vitest run src/app/shell/useSessionScope.test.ts`
Expected: PASS

**Step 5: Wire into `AppContent`, remove old inline code**

Replace lines 218–246 in `AppShell.tsx` with:

```typescript
const currentSessionId = rt.session?.session_id ?? null;
const sessionScope = useSessionScope(athenaSessionId, currentSessionId);
const timelineCurrentRun = useMemo(
	() => buildTimelineCurrentRun(rt.currentRun),
	[rt.currentRun],
);
```

**Step 6: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/app/shell/useSessionScope.ts src/app/shell/useSessionScope.test.ts src/app/shell/AppShell.tsx
git commit -m "refactor: extract useSessionScope and buildTimelineCurrentRun"
```

---

### Task 5: Extract `useGlobalKeyboard` hook

**Files:**

- Create: `src/app/shell/useGlobalKeyboard.ts`
- Modify: `src/app/shell/AppShell.tsx` — lines 582–642

**Step 1: Create the hook**

Extract the inline `useInput` handler (lines 589–642) into a dedicated hook following the same `callbacks` object pattern used by `useFeedKeyboard` and `useTodoKeyboard`:

```typescript
// src/app/shell/useGlobalKeyboard.ts
import {useRef, useEffect, useCallback} from 'react';
import {useInput} from 'ink';
import {evaluateEscapeInterruptGate} from './escapeInterruptGate';
import {startInputMeasure} from '../../shared/utils/perf';
import type {FocusMode, InputMode} from './types';
import type {InputHistory} from '../../ui/hooks/useInputHistory';

export type UseGlobalKeyboardOptions = {
	isActive: boolean;
	isHarnessRunning: boolean;
	focusMode: FocusMode;
	callbacks: {
		interrupt: () => void;
		cycleFocus: () => void;
		setFocusMode: (mode: FocusMode) => void;
		setInputMode: (mode: InputMode) => void;
		setTodoVisible: (fn: (v: boolean) => boolean) => void;
		setHintsForced: (fn: (prev: boolean | null) => boolean | null) => void;
		historyBack: (currentValue: string) => string | undefined;
		historyForward: () => string | undefined;
		getInputValue: () => string;
		setInputValue: (value: string) => void;
	};
};

export function useGlobalKeyboard({
	isActive,
	isHarnessRunning,
	focusMode,
	callbacks,
}: UseGlobalKeyboardOptions) {
	const interruptEscapeAtRef = useRef<number | null>(null);

	useEffect(() => {
		if (!isHarnessRunning || focusMode !== 'feed') {
			interruptEscapeAtRef.current = null;
		}
	}, [isHarnessRunning, focusMode]);

	useInput(
		(input, key) => {
			const done = startInputMeasure('app.global', input, key);
			try {
				const interruptGate = evaluateEscapeInterruptGate({
					keyEscape: key.escape,
					isHarnessRunning,
					focusMode,
					lastEscapeAtMs: interruptEscapeAtRef.current,
					nowMs: Date.now(),
				});
				interruptEscapeAtRef.current = interruptGate.nextLastEscapeAtMs;
				if (interruptGate.shouldInterrupt) {
					callbacks.interrupt();
					return;
				}
				if (key.ctrl && input === 't') {
					callbacks.setTodoVisible(v => !v);
					if (focusMode === 'todo') callbacks.setFocusMode('feed');
					return;
				}
				if (key.ctrl && input === '/') {
					callbacks.setHintsForced(prev =>
						prev === null ? true : prev ? false : null,
					);
					return;
				}
				if (focusMode === 'input') {
					if (key.escape) {
						callbacks.setFocusMode('feed');
						callbacks.setInputMode('normal');
						return;
					}
					if (key.tab) {
						callbacks.cycleFocus();
						return;
					}
					if (key.ctrl && input === 'p') {
						const prev = callbacks.historyBack(callbacks.getInputValue());
						if (prev !== undefined) callbacks.setInputValue(prev);
						return;
					}
					if (key.ctrl && input === 'n') {
						const next = callbacks.historyForward();
						if (next !== undefined) callbacks.setInputValue(next);
						return;
					}
				}
			} finally {
				done();
			}
		},
		{isActive},
	);
}
```

**Step 2: Replace inline handler in `AppShell.tsx`**

Remove lines 582–642 and the `interruptEscapeAtRef` declaration. Replace with:

```typescript
useGlobalKeyboard({
	isActive: !dialogActive && !pagerActive,
	isHarnessRunning,
	focusMode,
	callbacks: {
		interrupt,
		cycleFocus,
		setFocusMode,
		setInputMode,
		setTodoVisible: todoPanel.setTodoVisible,
		setHintsForced,
		historyBack: inputHistory.back,
		historyForward: inputHistory.forward,
		getInputValue: () => inputValueRef.current,
		setInputValue: (v: string) => setInputValueRef.current(v),
	},
});
```

**Step 3: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/app/shell/useGlobalKeyboard.ts src/app/shell/AppShell.tsx
git commit -m "refactor: extract useGlobalKeyboard hook from AppContent"
```

---

### Task 6: Extract `useInputLayout` for input area derivations

**Files:**

- Create: `src/app/shell/useInputLayout.ts`
- Create: `src/app/shell/useInputLayout.test.ts`
- Modify: `src/app/shell/AppShell.tsx` — lines 820–850

**Step 1: Write the test**

```typescript
// src/app/shell/useInputLayout.test.ts
import {describe, it, expect} from 'vitest';
import {
	deriveInputPlaceholder,
	deriveTextInputPlaceholder,
} from './useInputLayout';

describe('deriveInputPlaceholder', () => {
	it('returns search placeholder in search mode', () => {
		expect(deriveInputPlaceholder('search', null)).toBe('/search');
	});

	it('returns follow-up message after completed run', () => {
		expect(deriveInputPlaceholder('normal', 'completed')).toBe(
			'Run complete - type a follow-up',
		);
	});

	it('returns default prompt for idle state', () => {
		expect(deriveInputPlaceholder('normal', null)).toBe(
			'Type a prompt or /command',
		);
	});
});

describe('deriveTextInputPlaceholder', () => {
	it('uses input placeholder when no dialog', () => {
		expect(deriveTextInputPlaceholder(false, 'idle', 'test')).toBe('test');
	});

	it('shows question prompt during question dialog', () => {
		expect(deriveTextInputPlaceholder(true, 'question', 'test')).toBe(
			'Answer question in dialog...',
		);
	});
});
```

**Step 2: Run test — verify it fails**

Run: `npx vitest run src/app/shell/useInputLayout.test.ts`
Expected: FAIL

**Step 3: Create `useInputLayout.ts`**

```typescript
// src/app/shell/useInputLayout.ts
import {useMemo} from 'react';
import type {InputMode} from './types';

type LastRunStatus = 'completed' | 'failed' | 'aborted' | null;

export function deriveInputPlaceholder(
	inputMode: InputMode,
	lastRunStatus: LastRunStatus,
): string {
	if (inputMode === 'search') return '/search';
	if (lastRunStatus === 'completed') return 'Run complete - type a follow-up';
	if (lastRunStatus === 'failed' || lastRunStatus === 'aborted')
		return 'Run failed - type a follow-up';
	return 'Type a prompt or /command';
}

export function deriveTextInputPlaceholder(
	dialogActive: boolean,
	appModeType: string,
	inputPlaceholder: string,
): string {
	if (!dialogActive) return inputPlaceholder;
	if (appModeType === 'question') return 'Answer question in dialog...';
	return 'Respond to permission dialog...';
}

export function useInputLayout({
	innerWidth,
	inputMode,
	lastRunStatus,
	dialogActive,
	appModeType,
	isHarnessRunning,
}: {
	innerWidth: number;
	inputMode: InputMode;
	lastRunStatus: LastRunStatus;
	dialogActive: boolean;
	appModeType: string;
	isHarnessRunning: boolean;
}) {
	return useMemo(() => {
		const inputPrefix = 'input> ';
		const runBadge = isHarnessRunning ? '[RUN]' : '[IDLE]';
		const modeBadges = [
			runBadge,
			...(inputMode === 'search' ? ['[SEARCH]'] : []),
		];
		const badgeText = modeBadges.join('');
		const inputContentWidth = Math.max(
			1,
			innerWidth - inputPrefix.length - badgeText.length,
		);

		const inputPlaceholder = deriveInputPlaceholder(inputMode, lastRunStatus);
		const textInputPlaceholder = deriveTextInputPlaceholder(
			dialogActive,
			appModeType,
			inputPlaceholder,
		);

		return {inputPrefix, badgeText, inputContentWidth, textInputPlaceholder};
	}, [
		innerWidth,
		inputMode,
		lastRunStatus,
		dialogActive,
		appModeType,
		isHarnessRunning,
	]);
}
```

**Step 4: Run test — verify it passes**

Run: `npx vitest run src/app/shell/useInputLayout.test.ts`
Expected: PASS

**Step 5: Wire into `AppContent`, remove inline code**

Replace lines 820–850 with:

```typescript
const {inputPrefix, badgeText, inputContentWidth, textInputPlaceholder} =
	useInputLayout({
		innerWidth,
		inputMode,
		lastRunStatus,
		dialogActive,
		appModeType: appMode.type,
		isHarnessRunning,
	});
inputContentWidthRef.current = inputContentWidth;
```

**Step 6: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/app/shell/useInputLayout.ts src/app/shell/useInputLayout.test.ts src/app/shell/AppShell.tsx
git commit -m "refactor: extract useInputLayout for input area derivations"
```

---

### Task 7: Stabilize recreated callback references

**Files:**

- Modify: `src/app/shell/AppShell.tsx` — lines 656, 673

**Step 1: Wrap unstable closures in `useCallback`**

The `setInputValue` closures are recreated every render. Add a stable callback before the keyboard hooks:

```typescript
const stableSetInputValue = useCallback(
	(v: string) => setInputValueRef.current(v),
	[],
);
```

Then replace `setInputValue: (v: string) => setInputValueRef.current(v)` in both `useFeedKeyboard` and `useTodoKeyboard` callbacks with `setInputValue: stableSetInputValue`.

**Step 2: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/app/shell/AppShell.tsx
git commit -m "refactor: stabilize setInputValue callback reference"
```

---

### Task 8: Extract `MaybeProfiler` wrapper component

**Files:**

- Modify: `src/app/shell/AppShell.tsx` — lines 1043–1050

**Step 1: Replace `withProfiler` function with a component**

Replace the `withProfiler` helper:

```typescript
// Before (inline function)
const withProfiler = (id: string, node: React.ReactElement) =>
  perfEnabled ? (
    <Profiler id={id} onRender={handleProfilerRender}>{node}</Profiler>
  ) : node;
```

With a small component defined above `App`:

```typescript
function MaybeProfiler({
  enabled,
  id,
  onRender,
  children,
}: {
  enabled: boolean;
  id: string;
  onRender: React.ProfilerProps['onRender'];
  children: React.ReactElement;
}) {
  if (!enabled) return children;
  return <Profiler id={id} onRender={onRender}>{children}</Profiler>;
}
```

Update the three render sites in `App` to use `<MaybeProfiler>` instead.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/app/shell/AppShell.tsx
git commit -m "refactor: replace withProfiler function with MaybeProfiler component"
```

---

### Task 9: Extract setup completion handler

**Files:**

- Modify: `src/app/shell/AppShell.tsx` — lines 1086–1123

**Step 1: Extract the `onComplete` handler to a `useCallback`**

Move the inline setup completion handler to a named callback above the render:

```typescript
const handleSetupComplete = useCallback(
	(setupResult: {theme: string}) => {
		setActiveTheme(resolveTheme(setupResult.theme));
		try {
			const refreshed = bootstrapRuntimeConfig({
				projectDir,
				showSetup: false,
				workflowFlag,
				pluginFlags,
				isolationPreset,
				verbose,
			});
			for (const warning of refreshed.warnings) {
				console.error(warning);
			}
			setRuntimeState({
				harness: refreshed.harness,
				isolation: refreshed.isolationConfig,
				pluginMcpConfig: refreshed.pluginMcpConfig,
				modelName: refreshed.modelName,
				workflowRef: refreshed.workflowRef,
				workflow: refreshed.workflow,
			});
		} catch (error) {
			console.error(`Error: ${(error as Error).message}`);
		}
		setPhase({type: 'main'});
	},
	[projectDir, workflowFlag, pluginFlags, isolationPreset, verbose],
);
```

Then simplify the JSX: `onComplete={handleSetupComplete}`.

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/app/shell/AppShell.tsx
git commit -m "refactor: extract handleSetupComplete callback from inline JSX"
```

---

### Task 10: Final lint, typecheck, and full test pass

**Step 1: Run lint**

Run: `npm run lint`
Expected: PASS (fix any formatting issues with `npm run format` if needed)

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 4: Run dead code detection**

Run: `npm run lint:dead`
Expected: No new dead exports introduced

**Step 5: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint and format after AppShell cleanup"
```

---

## Summary of Changes

| Task | What                    | Lines removed from AppShell | New file                       |
| ---- | ----------------------- | --------------------------- | ------------------------------ |
| 1    | Deduplicate types       | 2                           | `shell/types.ts`               |
| 2    | Remove constant noise   | 2                           | —                              |
| 3    | Group context selectors | ~37                         | `shell/useRuntimeSelectors.ts` |
| 4    | Extract session scope   | ~28                         | `shell/useSessionScope.ts`     |
| 5    | Extract global keyboard | ~60                         | `shell/useGlobalKeyboard.ts`   |
| 6    | Extract input layout    | ~30                         | `shell/useInputLayout.ts`      |
| 7    | Stabilize callbacks     | ~4 (replaced)               | —                              |
| 8    | MaybeProfiler component | ~8 (replaced)               | —                              |
| 9    | Extract setup handler   | ~20 (moved up)              | —                              |

**Net effect:** ~150 lines removed from `AppContent`, ~20 from `App`. The file drops from ~1178 to ~1000 lines, with each remaining section having a clear single responsibility. Four new testable files are created following established project conventions.

## Out of Scope (intentionally deferred)

- **`theme` prop drilling** — Removing `theme` from `FeedGrid`/`formatFeedRowLine` props would change their component contracts. This is a broader refactor that should be its own task.
- **Extracting `submitPromptOrSlashCommand`** — This callback builds the `executeCommand` context object which depends on many local values. Extracting it cleanly requires rethinking the command execution API, which is beyond a cleanup scope.
- **`React.memo` on static entry renderer** — The `<Static>` render function is an optimization concern, not a readability concern.
