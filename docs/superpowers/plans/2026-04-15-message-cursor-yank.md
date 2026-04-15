# Message Panel Cursor & Yank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-message cursor to the messages panel so users can navigate between messages with arrow keys and yank (copy) the focused message with `y`. Mouse wheel scroll must also update the cursor.

**Architecture:** Add `messageCursorIndex` (entry-level, not line-level) to `SessionUiState` with new actions for cursor movement. The cursor is rendered as a brighter accent-colored left indicator (`┃`) on the focused message's lines. `MessagePanel` receives the cursor index and applies the highlight. `useMessageKeyboard` gains cursor movement (up/down = prev/next message) and yank. Mouse wheel in `usePanelMouseWheel` dispatches `move_message_cursor` instead of `scroll_message_viewport`, and the viewport follows the cursor.

**Tech Stack:** TypeScript, React/Ink, Vitest

---

### Task 1: Add `messageCursorIndex` to SessionUiState

**Files:**

- Modify: `src/app/shell/sessionUiState.ts`
- Test: `src/app/shell/__tests__/sessionUiState.test.ts`

- [ ] **Step 1: Write failing tests for the new message cursor actions**

Add a new `describe('message cursor model')` block in `sessionUiState.test.ts`:

```typescript
describe('message cursor model', () => {
	it('move_message_cursor moves cursor by delta', () => {
		const ctx = makeContext({messageEntryCount: 50, messageContentRows: 10});
		const state: SessionUiState = {
			...initialSessionUiState,
			focusMode: 'messages',
			messageCursorIndex: 2,
			messageTailFollow: false,
		};
		const result = reduceSessionUiState(
			state,
			{type: 'move_message_cursor', delta: 1},
			ctx,
		);
		expect(result.messageCursorIndex).toBe(3);
		expect(result.messageTailFollow).toBe(false);
	});

	it('move_message_cursor clamps at 0', () => {
		const ctx = makeContext({messageEntryCount: 50, messageContentRows: 10});
		const state: SessionUiState = {
			...initialSessionUiState,
			focusMode: 'messages',
			messageCursorIndex: 1,
			messageTailFollow: false,
		};
		const result = reduceSessionUiState(
			state,
			{type: 'move_message_cursor', delta: -5},
			ctx,
		);
		expect(result.messageCursorIndex).toBe(0);
	});

	it('move_message_cursor clamps at max (messageEntryCount - 1)', () => {
		const ctx = makeContext({messageEntryCount: 5, messageContentRows: 10});
		const state: SessionUiState = {
			...initialSessionUiState,
			focusMode: 'messages',
			messageCursorIndex: 3,
			messageTailFollow: false,
		};
		const result = reduceSessionUiState(
			state,
			{type: 'move_message_cursor', delta: 5},
			ctx,
		);
		expect(result.messageCursorIndex).toBe(4);
	});

	it('move_message_cursor disables tailFollow', () => {
		const ctx = makeContext({messageEntryCount: 10, messageContentRows: 5});
		const state: SessionUiState = {
			...initialSessionUiState,
			focusMode: 'messages',
			messageCursorIndex: 9,
			messageTailFollow: true,
		};
		const result = reduceSessionUiState(
			state,
			{type: 'move_message_cursor', delta: -1},
			ctx,
		);
		expect(result.messageTailFollow).toBe(false);
		expect(result.messageCursorIndex).toBe(8);
	});

	it('jump_message_tail sets cursor to last entry and enables tailFollow', () => {
		const ctx = makeContext({messageEntryCount: 10, messageContentRows: 5});
		const state: SessionUiState = {
			...initialSessionUiState,
			focusMode: 'messages',
			messageCursorIndex: 3,
			messageTailFollow: false,
		};
		const result = reduceSessionUiState(
			state,
			{type: 'jump_message_tail'},
			ctx,
		);
		expect(result.messageCursorIndex).toBe(9);
		expect(result.messageTailFollow).toBe(true);
	});

	it('jump_message_top sets cursor to 0 and disables tailFollow', () => {
		const ctx = makeContext({messageEntryCount: 10, messageContentRows: 5});
		const state: SessionUiState = {
			...initialSessionUiState,
			focusMode: 'messages',
			messageCursorIndex: 7,
			messageTailFollow: true,
		};
		const result = reduceSessionUiState(state, {type: 'jump_message_top'}, ctx);
		expect(result.messageCursorIndex).toBe(0);
		expect(result.messageTailFollow).toBe(false);
	});

	it('resolve clamps messageCursorIndex when entries shrink', () => {
		const ctx = makeContext({messageEntryCount: 3, messageContentRows: 10});
		const state: SessionUiState = {
			...initialSessionUiState,
			focusMode: 'messages',
			messageCursorIndex: 7,
			messageTailFollow: false,
		};
		const resolved = resolveSessionUiState(state, ctx);
		expect(resolved.messageCursorIndex).toBe(2);
	});

	it('resolve pins cursor to last entry when tailFollow is true', () => {
		const ctx = makeContext({messageEntryCount: 5, messageContentRows: 10});
		const state: SessionUiState = {
			...initialSessionUiState,
			focusMode: 'messages',
			messageCursorIndex: 0,
			messageTailFollow: true,
		};
		const resolved = resolveSessionUiState(state, ctx);
		expect(resolved.messageCursorIndex).toBe(4);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/shell/__tests__/sessionUiState.test.ts`
Expected: FAIL — `messageCursorIndex` doesn't exist on `SessionUiState`, `move_message_cursor` action type doesn't exist.

- [ ] **Step 3: Add `messageCursorIndex` to state, new actions, and reducer logic**

In `sessionUiState.ts`:

1. Add `messageCursorIndex: number` to `SessionUiState` type (after `messageViewportStart`).
2. Add `messageCursorIndex: 0` to `initialSessionUiState`.
3. Add `messageCursorIndex` to `MessageState` Pick type.
4. Add `| {type: 'move_message_cursor'; delta: number}` to `SessionUiAction`.
5. Update `computeMessageState` to accept and compute `messageCursorIndex`:

```typescript
function computeMessageState(
	viewportStart: number,
	tailFollow: boolean,
	cursorIndex: number,
	ctx: SessionUiContext,
): MessageState {
	const maxCursor = Math.max(0, ctx.messageEntryCount - 1);
	if (tailFollow) {
		const maxStart =
			ctx.messageContentRows <= 0
				? 0
				: Math.max(0, ctx.messageEntryCount - ctx.messageContentRows);
		return {
			messageTailFollow: true,
			messageViewportStart: maxStart,
			messageCursorIndex: maxCursor,
		};
	}
	const nextCursor = clamp(cursorIndex, 0, maxCursor);
	const maxStart =
		ctx.messageContentRows <= 0
			? 0
			: Math.max(0, ctx.messageEntryCount - ctx.messageContentRows);
	const nextStart = clamp(viewportStart, 0, maxStart);
	return {
		messageTailFollow: false,
		messageViewportStart: nextStart,
		messageCursorIndex: nextCursor,
	};
}
```

6. Update `withMessageChange` to also check `messageCursorIndex`.
7. Update all callers of `computeMessageState` to pass `cursorIndex`.
8. Add the new `move_message_cursor` case to the reducer:

```typescript
case 'move_message_cursor':
	return withMessageChange(
		current,
		computeMessageState(
			current.messageViewportStart,
			false,
			current.messageCursorIndex + action.delta,
			ctx,
		),
	);
```

9. Update existing `scroll_message_viewport`, `jump_message_tail`, `jump_message_top` cases to pass cursor through.
10. Update `resolveSessionUiState` to clamp `messageCursorIndex` and include it in the return + equality check.

**Important:** `messageEntryCount` in `SessionUiContext` currently stores the **total wrapped line count** (from `useFilteredPanels`), which is a line count, not an entry count. The message cursor operates on **entry indices** (0-based index into `messageEntries[]`). We need a separate context field. Add `messageEntryLength: number` to `SessionUiContext` to hold `messageEntries.length` — the actual number of message entries. The cursor clamps against this, while `messageEntryCount` continues to be used for viewport line-based scrolling.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/shell/__tests__/sessionUiState.test.ts`
Expected: All PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: Type errors in `AppShell.tsx` and `useFilteredPanels.ts` because `messageEntryLength` isn't wired up yet. That's expected — we fix these in Task 3.

- [ ] **Step 6: Commit**

```bash
git add src/app/shell/sessionUiState.ts src/app/shell/__tests__/sessionUiState.test.ts
git commit -m "feat(messages): add messageCursorIndex to SessionUiState with move/jump actions"
```

---

### Task 2: Update MessagePanel to render focused-message indicator

**Files:**

- Modify: `src/ui/components/MessagePanel.tsx`
- Modify: `src/ui/theme/types.ts`
- Modify: `src/ui/theme/themes.ts`

- [ ] **Step 1: Add `focusBorder` color to `userMessage` theme**

In `src/ui/theme/types.ts`, add `focusBorder: string` to the `userMessage` object.

In `src/ui/theme/themes.ts`, add the `focusBorder` color to each theme:

- Dark: `focusBorder: '#58a6ff'` (matches `accent` — bright blue)
- Light: `focusBorder: '#0969da'` (matches `accent`)
- High Contrast: `focusBorder: '#71b7ff'` (matches `accent`)

- [ ] **Step 2: Update MessagePanel to accept and render `messageCursorIndex`**

In `src/ui/components/MessagePanel.tsx`:

1. Add `messageCursorIndex?: number` to the `Props` type.
2. Create a `focusIndicator` using `chalk.hex(theme.userMessage.focusBorder)(glyphChar)`.
3. In `sliceViewport`, pass `messageCursorIndex` through. When rendering a non-separator line, compare `line.entryIndex === messageCursorIndex` — if true, use `focusIndicator` instead of the normal `userIndicator`/`agentIndicator`.

The change in `sliceViewport`:

```typescript
function sliceViewport(
	wrapped: WrappedLine[],
	contentRows: number,
	viewportStart: number,
	frameBorder: string,
	userIndicator: string,
	agentIndicator: string,
	focusIndicator: string,
	theme: Theme,
	width: number,
	messageCursorIndex?: number,
): string[] {
	// ... existing code ...
	for (let lineIdx = start; lineIdx < end; lineIdx++) {
		const line = wrapped[lineIdx]!;
		if (line.isSeparator) {
			outputLines.push(blankRow);
			continue;
		}

		const isFocused =
			messageCursorIndex !== undefined &&
			line.entryIndex === messageCursorIndex;
		const indicator = isFocused
			? focusIndicator
			: line.kind === 'agent'
				? agentIndicator
				: userIndicator;

		// ... rest of row building unchanged ...
	}
}
```

4. Create `focusIndicator` in `MessagePanelImpl` and pass it through to `sliceViewport`.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: Type errors remain in `AppShell.tsx` (not passing `messageCursorIndex` prop yet). The component itself should be clean.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/MessagePanel.tsx src/ui/theme/types.ts src/ui/theme/themes.ts
git commit -m "feat(messages): render focused-message indicator with accent-colored left border"
```

---

### Task 3: Wire up cursor in AppShell and update useMessageKeyboard

**Files:**

- Modify: `src/ui/hooks/useMessageKeyboard.ts`
- Modify: `src/app/shell/AppShell.tsx`

- [ ] **Step 1: Add `yankAtCursor` and cursor movement callbacks to `useMessageKeyboard`**

In `src/ui/hooks/useMessageKeyboard.ts`:

1. Add to `MessageKeyboardCallbacks`:
   - `moveCursor: (delta: number) => void`
   - `yankAtCursor: () => void`

2. Remap arrow keys from `scrollViewport` to `moveCursor`:
   - `↑` → `callbacks.moveCursor(-1)`
   - `↓` → `callbacks.moveCursor(1)`
   - `PageUp` → `callbacks.moveCursor(-pageStep)`
   - `PageDown` → `callbacks.moveCursor(pageStep)`

3. Add `y` / `Y` keybinding: `callbacks.yankAtCursor()`

Full updated `useInput` handler (only showing changed parts):

```typescript
if (key.upArrow) {
	callbacks.moveCursor(-1);
	return;
}
if (key.downArrow) {
	callbacks.moveCursor(1);
	return;
}
if (key.pageUp) {
	callbacks.moveCursor(-pageStep);
	return;
}
if (key.pageDown) {
	callbacks.moveCursor(pageStep);
	return;
}
if (input === 'y' || input === 'Y') {
	callbacks.yankAtCursor();
	return;
}
```

- [ ] **Step 2: Wire up in AppShell**

In `src/app/shell/AppShell.tsx`:

1. Add `messageEntryLength: messageEntries.length` to the `uiContext` memo (the `SessionUiContext` object around line 1027).

2. Create a `yankMessageAtCursor` callback:

```typescript
const yankMessageAtCursor = useCallback(() => {
	const entry = messageEntries[resolvedUiState.messageCursorIndex];
	if (!entry) return;
	const text = messageText(entry);
	copyToClipboard(text);
	showToast('Copied to clipboard!');
}, [messageEntries, resolvedUiState.messageCursorIndex, showToast]);
```

Import `messageText` from `../../core/feed/panelFilter`.

3. Update `useMessageKeyboard` callbacks:

```typescript
useMessageKeyboard({
	isActive: focusMode === 'messages' && !dialogActive && !pagerActive,
	pageStep: messagePageStep,
	callbacks: {
		moveCursor: (delta: number) =>
			dispatchUi({type: 'move_message_cursor', delta}),
		scrollViewport: (delta: number) =>
			dispatchUi({type: 'scroll_message_viewport', delta}),
		jumpToTail: () => dispatchUi({type: 'jump_message_tail'}),
		jumpToTop: () => dispatchUi({type: 'jump_message_top'}),
		yankAtCursor: yankMessageAtCursor,
		cycleFocus,
		openCommandInput: () => dispatchUi({type: 'open_command_input'}),
		openSearchInput: () => dispatchUi({type: 'open_search_input'}),
		setInputValue: stableSetInputValue,
		setMessageTab: tab => dispatchUi({type: 'set_message_tab', tab}),
	},
});
```

4. Pass `messageCursorIndex` to `<MessagePanel>`:

```tsx
<MessagePanel
	entries={messageEntries}
	width={messagePanelWidth}
	contentRows={feedHeaderRows + feedContentRows}
	viewportStart={resolvedUiState.messageViewportStart}
	messageCursorIndex={resolvedUiState.messageCursorIndex}
	theme={theme}
	borderColor={theme.border}
/>
```

5. Update `onMessageWheel` in `usePanelMouseWheel` to dispatch `move_message_cursor` instead of `scroll_message_viewport`:

```typescript
onMessageWheel: delta =>
	dispatchUi({type: 'move_message_cursor', delta}),
```

This ensures mouse wheel scrolling moves the cursor (and the viewport follows the cursor).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — all types should align now.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/ui/hooks/useMessageKeyboard.ts src/app/shell/AppShell.tsx
git commit -m "feat(messages): wire up message cursor navigation, yank, and mouse wheel"
```

---

### Task 4: Make viewport follow cursor

**Files:**

- Modify: `src/app/shell/sessionUiState.ts`
- Modify: `src/ui/hooks/useFilteredPanels.ts`
- Test: `src/app/shell/__tests__/sessionUiState.test.ts`

The viewport is line-based (`messageViewportStart` counts wrapped lines) but the cursor is entry-based (`messageCursorIndex`). When the cursor moves, we need to ensure the focused message is visible. This requires knowing the **line offset** of each entry.

- [ ] **Step 1: Add `messageEntryLineOffsets` to `SessionUiContext`**

In `sessionUiState.ts`, add to `SessionUiContext`:

```typescript
messageEntryLength: number;
messageEntryLineOffsets: ReadonlyArray<number>;
```

`messageEntryLineOffsets[i]` = the first wrapped line index of entry `i` (cumulative sum of line counts + separator lines). This is computed in `useFilteredPanels`.

- [ ] **Step 2: Compute line offsets in `useFilteredPanels`**

In `src/ui/hooks/useFilteredPanels.ts`:

1. Add `messageEntryLineOffsets: number[]` to the `FilteredPanels` type.
2. Build the offsets array during the existing line-counting loop:

```typescript
const offsets: number[] = [];
let lineCount = 0;
for (let i = 0; i < tabFiltered.length; i++) {
	offsets.push(lineCount);
	lineCount += cachedLineCount(tabFiltered[i]!, contentWidth);
	if (i < tabFiltered.length - 1) {
		lineCount += 1; // separator
	}
}
return {
	messageEntries: tabFiltered,
	feedEntries,
	messageLineCount: lineCount,
	messageEntryLineOffsets: offsets,
};
```

When `!splitMode`, return `messageEntryLineOffsets: []`.

- [ ] **Step 3: Wire offsets through AppShell into `uiContext`**

In `AppShell.tsx`, destructure `messageEntryLineOffsets` from `useFilteredPanels` and include both new fields in the `uiContext` memo:

```typescript
messageEntryLength: messageEntries.length,
messageEntryLineOffsets,
```

- [ ] **Step 4: Update `computeMessageState` to auto-scroll viewport to keep cursor visible**

In `sessionUiState.ts`, update `computeMessageState`:

```typescript
function computeMessageState(
	viewportStart: number,
	tailFollow: boolean,
	cursorIndex: number,
	ctx: SessionUiContext,
): MessageState {
	const maxCursor = Math.max(0, ctx.messageEntryLength - 1);
	const maxStart =
		ctx.messageContentRows <= 0
			? 0
			: Math.max(0, ctx.messageEntryCount - ctx.messageContentRows);

	if (tailFollow) {
		return {
			messageTailFollow: true,
			messageViewportStart: maxStart,
			messageCursorIndex: clamp(cursorIndex, 0, maxCursor),
		};
	}

	const nextCursor = clamp(cursorIndex, 0, maxCursor);
	let nextStart = clamp(viewportStart, 0, maxStart);

	// Auto-scroll viewport to keep cursor visible
	const offsets = ctx.messageEntryLineOffsets;
	if (offsets.length > 0 && nextCursor < offsets.length) {
		const cursorLineStart = offsets[nextCursor]!;
		// If cursor entry starts above viewport, scroll up
		if (cursorLineStart < nextStart) {
			nextStart = cursorLineStart;
		}
		// If cursor entry starts below viewport, scroll down so it's visible
		if (cursorLineStart >= nextStart + ctx.messageContentRows) {
			nextStart = cursorLineStart - ctx.messageContentRows + 1;
		}
		nextStart = clamp(nextStart, 0, maxStart);
	}

	return {
		messageTailFollow: false,
		messageViewportStart: nextStart,
		messageCursorIndex: nextCursor,
	};
}
```

- [ ] **Step 5: Write tests for viewport-follows-cursor behavior**

Add to the `message cursor model` describe block:

```typescript
it('move_message_cursor scrolls viewport so cursor entry is visible', () => {
	// 5 entries, offsets: [0, 3, 7, 12, 18], viewport shows 5 lines
	const ctx = makeContext({
		messageEntryCount: 22, // total lines
		messageEntryLength: 5,
		messageEntryLineOffsets: [0, 3, 7, 12, 18],
		messageContentRows: 5,
	});
	const state: SessionUiState = {
		...initialSessionUiState,
		focusMode: 'messages',
		messageCursorIndex: 1,
		messageViewportStart: 0,
		messageTailFollow: false,
	};
	// Move cursor to entry 3 (line offset 12), which is outside viewport [0..5)
	const result = reduceSessionUiState(
		state,
		{type: 'move_message_cursor', delta: 2},
		ctx,
	);
	expect(result.messageCursorIndex).toBe(3);
	// Viewport should have scrolled so line 12 is visible
	expect(result.messageViewportStart).toBe(8); // 12 - 5 + 1
});

it('move_message_cursor scrolls viewport up when cursor goes above', () => {
	const ctx = makeContext({
		messageEntryCount: 22,
		messageEntryLength: 5,
		messageEntryLineOffsets: [0, 3, 7, 12, 18],
		messageContentRows: 5,
	});
	const state: SessionUiState = {
		...initialSessionUiState,
		focusMode: 'messages',
		messageCursorIndex: 3,
		messageViewportStart: 10,
		messageTailFollow: false,
	};
	// Move cursor to entry 1 (line offset 3), above viewport start 10
	const result = reduceSessionUiState(
		state,
		{type: 'move_message_cursor', delta: -2},
		ctx,
	);
	expect(result.messageCursorIndex).toBe(1);
	expect(result.messageViewportStart).toBe(3);
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/app/shell/__tests__/sessionUiState.test.ts`
Expected: All PASS.

- [ ] **Step 7: Run full test suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/shell/sessionUiState.ts src/app/shell/__tests__/sessionUiState.test.ts src/ui/hooks/useFilteredPanels.ts src/app/shell/AppShell.tsx
git commit -m "feat(messages): viewport auto-scrolls to keep cursor entry visible"
```

---

### Task 5: Add yank hint to footer for messages mode

**Files:**

- Modify: `src/ui/layout/buildFrameLines.ts`
- Modify: `src/ui/layout/buildFrameLines.test.ts`

- [ ] **Step 1: Write failing test**

In `src/ui/layout/buildFrameLines.test.ts`:

```typescript
it('shows yank hint in messages mode', () => {
	const {footerHelp} = buildFrameLines({
		...baseCtx,
		focusMode: 'messages',
	});
	expect(footerHelp).toContain('Yank');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/layout/buildFrameLines.test.ts`
Expected: FAIL — messages mode currently falls through to the feed hints, which may already include Yank, or it may not have a dedicated section. Verify whether this actually fails — if it passes, we still need to add a dedicated messages hint block with appropriate keys (arrows, y, u/a/b tabs, etc.).

- [ ] **Step 3: Add dedicated messages-mode hint block**

In `buildFrameLines.ts`, before the `// Feed mode (default)` comment (line ~74), add:

```typescript
if (ctx.focusMode === 'messages') {
	const messagePairs: Array<[string, string]> = [
		[h.arrowsUpDown, 'Navigate'],
		['y', 'Yank'],
		['u/a/b', 'Filter'],
		['/', 'Cmds'],
		[':', 'Search'],
		['End', 'Tail'],
	];
	if (ctx.isClaudeRunning) {
		messagePairs.push([`${h.escape} ${h.escape}`, 'Interrupt']);
	}
	return buildHintPairs(messagePairs);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ui/layout/buildFrameLines.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/layout/buildFrameLines.ts src/ui/layout/buildFrameLines.test.ts
git commit -m "feat(messages): add yank hint to footer in messages focus mode"
```

---

### Task 6: Update mouse wheel tests

**Files:**

- Modify: `src/ui/hooks/__tests__/usePanelMouseWheel.test.ts`

- [ ] **Step 1: Verify existing mouse wheel tests still pass**

Run: `npx vitest run src/ui/hooks/__tests__/usePanelMouseWheel.test.ts`
Expected: PASS — the `usePanelMouseWheel` hook API hasn't changed (it still takes `onMessageWheel`). The callback now dispatches `move_message_cursor` instead of `scroll_message_viewport`, but that's an AppShell wiring change, not a hook-level change. Existing tests should pass unchanged.

- [ ] **Step 2: Run full test suite + lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: All PASS.

- [ ] **Step 3: Commit (if any test adjustments were needed)**

```bash
git commit -m "test: update mouse wheel tests for message cursor integration"
```

---

### Task 7: Final integration verification

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: PASS — no build errors.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All PASS.

- [ ] **Step 3: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: All PASS.

- [ ] **Step 4: Manual smoke test**

Run: `npm run start` (or `node dist/cli.js`)

1. Start a session, send a message, wait for agent response
2. Press `Tab` to cycle to messages panel
3. Verify cursor indicator (bright blue `┃`) appears on the last message
4. Press `↑`/`↓` — cursor moves between messages, viewport follows
5. Press `y` — toast "Copied to clipboard!" appears, verify clipboard content
6. Mouse wheel scroll in messages panel — cursor moves, viewport follows
7. Press `g`/`G` — cursor jumps to first/last message
8. Verify no regressions in feed panel (`Tab` back to feed, `y` still works there)
