# Yank-to-Clipboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users press `y` to copy the focused feed item's content to the system clipboard, in both the feed view and full-screen pager.

**Architecture:** A `copyToClipboard` utility writes text via OSC 52 escape sequence. A `extractYankContent` function extracts markdown/source from a `TimelineEntry`. The `y` keybinding is added to `useFeedKeyboard` and `usePager`. A "Copied!" toast is shown as a brief repaint in the pager footer, or emitted as a transient state in the feed view.

**Tech Stack:** OSC 52 (terminal protocol), Node.js Buffer for base64, strip-ansi for pager content.

---

### Task 1: Create `copyToClipboard` utility

**Files:**

- Create: `src/shared/utils/clipboard.ts`
- Create: `src/shared/utils/__tests__/clipboard.test.ts`

**Step 1: Write the failing test**

```typescript
// src/shared/utils/__tests__/clipboard.test.ts
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {copyToClipboard} from '../clipboard';

describe('copyToClipboard', () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
	});
	afterEach(() => {
		writeSpy.mockRestore();
	});

	it('writes OSC 52 sequence with base64-encoded content', () => {
		copyToClipboard('hello world');
		const expected = Buffer.from('hello world').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});

	it('handles empty string', () => {
		copyToClipboard('');
		const expected = Buffer.from('').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});

	it('handles multi-line content', () => {
		copyToClipboard('line1\nline2\nline3');
		const expected = Buffer.from('line1\nline2\nline3').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});

	it('handles unicode content', () => {
		copyToClipboard('hello 🌍');
		const expected = Buffer.from('hello 🌍').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/utils/__tests__/clipboard.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/shared/utils/clipboard.ts

/**
 * Copy text to system clipboard via OSC 52 terminal escape sequence.
 * Works in modern terminals including iTerm2, kitty, Alacritty, WezTerm,
 * Windows Terminal, and ghostty. Also works over SSH.
 */
export function copyToClipboard(text: string): void {
	const encoded = Buffer.from(text).toString('base64');
	process.stdout.write(`\x1B]52;c;${encoded}\x07`);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/utils/__tests__/clipboard.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/shared/utils/clipboard.ts src/shared/utils/__tests__/clipboard.test.ts
git commit -m "feat: add copyToClipboard utility using OSC 52"
```

---

### Task 2: Create `extractYankContent` function

**Files:**

- Create: `src/ui/utils/yankContent.ts`
- Create: `src/ui/utils/__tests__/yankContent.test.ts`

**Step 1: Write the failing test**

```typescript
// src/ui/utils/__tests__/yankContent.test.ts
import {describe, it, expect} from 'vitest';
import {extractYankContent} from '../yankContent';
import type {TimelineEntry} from '../../../core/feed/timeline';
import type {FeedEvent} from '../../../core/feed/types';

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
	return {
		id: 'e1',
		ts: 0,
		op: 'Tool Call',
		opTag: 'tool.call',
		actor: 'Claude',
		actorId: 'c1',
		toolColumn: 'Read',
		summary: 'test summary',
		summarySegments: [],
		searchText: 'test',
		error: false,
		expandable: true,
		details: 'fallback details',
		duplicateActor: false,
		...overrides,
	};
}

describe('extractYankContent', () => {
	it('extracts agent.message as raw markdown', () => {
		const event = {
			kind: 'agent.message' as const,
			data: {
				message: '# Hello\n\nWorld',
				source: 'hook' as const,
				scope: 'root' as const,
			},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		expect(extractYankContent(entry)).toBe('# Hello\n\nWorld');
	});

	it('extracts user.prompt as raw text', () => {
		const event = {
			kind: 'user.prompt' as const,
			data: {prompt: 'fix the bug', cwd: '/home'},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		expect(extractYankContent(entry)).toBe('fix the bug');
	});

	it('extracts tool.pre as JSON of tool_input', () => {
		const event = {
			kind: 'tool.pre' as const,
			data: {tool_name: 'Read', tool_input: {file_path: '/foo.ts'}},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		const result = extractYankContent(entry);
		expect(JSON.parse(result)).toEqual({file_path: '/foo.ts'});
	});

	it('extracts tool.post with paired response', () => {
		const preEvent = {
			kind: 'tool.pre' as const,
			data: {tool_name: 'Read', tool_input: {file_path: '/foo.ts'}},
		} as FeedEvent;
		const postEvent = {
			kind: 'tool.post' as const,
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/foo.ts'},
				tool_response: 'file content here',
			},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: preEvent, pairedPostEvent: postEvent});
		const result = extractYankContent(entry);
		expect(result).toContain('"file_path": "/foo.ts"');
		expect(result).toContain('file content here');
	});

	it('extracts tool.failure error message', () => {
		const event = {
			kind: 'tool.failure' as const,
			data: {
				tool_name: 'Read',
				tool_input: {file_path: '/missing'},
				error: 'File not found',
			},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		const result = extractYankContent(entry);
		expect(result).toContain('File not found');
	});

	it('extracts notification message', () => {
		const event = {
			kind: 'notification' as const,
			data: {message: 'Build succeeded'},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		expect(extractYankContent(entry)).toBe('Build succeeded');
	});

	it('falls back to entry.details when no feedEvent', () => {
		const entry = makeEntry({feedEvent: undefined, details: 'fallback text'});
		expect(extractYankContent(entry)).toBe('fallback text');
	});

	it('falls back to JSON.stringify for unknown event kinds', () => {
		const event = {
			kind: 'run.end' as const,
			data: {
				status: 'completed',
				counters: {
					tool_uses: 5,
					tool_failures: 0,
					permission_requests: 0,
					blocks: 0,
				},
			},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		const result = extractYankContent(entry);
		expect(JSON.parse(result)).toEqual(event.data);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/utils/__tests__/yankContent.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/ui/utils/yankContent.ts
import type {TimelineEntry} from '../../core/feed/timeline';
import type {FeedEvent} from '../../core/feed/types';

/**
 * Extract copyable markdown/source content from a timeline entry.
 * Returns raw markdown for text content, JSON for structured data.
 */
export function extractYankContent(entry: TimelineEntry): string {
	const event = entry.feedEvent;
	if (!event) return entry.details || entry.summary;

	switch (event.kind) {
		case 'agent.message':
			return event.data.message;

		case 'user.prompt':
			return event.data.prompt;

		case 'notification':
			return event.data.message;

		case 'tool.pre':
		case 'permission.request':
			return formatToolRequest(event);

		case 'tool.post':
			return formatToolResponse(event);

		case 'tool.failure':
			return formatToolFailure(event);

		default:
			return formatWithPairedPost(entry, event);
	}
}

function formatToolRequest(
	event: Extract<FeedEvent, {kind: 'tool.pre'} | {kind: 'permission.request'}>,
): string {
	return JSON.stringify(event.data.tool_input, null, 2);
}

function formatToolResponse(
	event: Extract<FeedEvent, {kind: 'tool.post'}>,
): string {
	const response = event.data.tool_response;
	const responseStr =
		typeof response === 'string' ? response : JSON.stringify(response, null, 2);
	return `${JSON.stringify(event.data.tool_input, null, 2)}\n\n---\n\n${responseStr}`;
}

function formatToolFailure(
	event: Extract<FeedEvent, {kind: 'tool.failure'}>,
): string {
	return `${JSON.stringify(event.data.tool_input, null, 2)}\n\n---\n\nERROR: ${event.data.error}`;
}

function formatWithPairedPost(entry: TimelineEntry, event: FeedEvent): string {
	// For tool.pre with a paired post event, include both request and response
	if (
		(event.kind === 'tool.pre' || event.kind === 'permission.request') &&
		entry.pairedPostEvent
	) {
		const post = entry.pairedPostEvent;
		if (post.kind === 'tool.post') {
			return formatToolResponse(post);
		}
		if (post.kind === 'tool.failure') {
			return formatToolFailure(post);
		}
	}

	// Subagent stop: extract last assistant message if available
	if (event.kind === 'subagent.stop' && event.data.last_assistant_message) {
		return event.data.last_assistant_message;
	}

	return JSON.stringify(event.data, null, 2);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/utils/__tests__/yankContent.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ui/utils/yankContent.ts src/ui/utils/__tests__/yankContent.test.ts
git commit -m "feat: add extractYankContent for yank-to-clipboard"
```

---

### Task 3: Add `y` keybinding to feed view

**Files:**

- Modify: `src/ui/hooks/useFeedKeyboard.ts` — add `yankAtCursor` callback and `y` handler
- Modify: `src/app/shell/AppShell.tsx` — wire yankAtCursor callback

**Step 1: Add yankAtCursor to FeedKeyboardCallbacks type**

In `src/ui/hooks/useFeedKeyboard.ts`, add to `FeedKeyboardCallbacks`:

```typescript
yankAtCursor: () => void;
```

**Step 2: Add `y` handler in useInput**

In `src/ui/hooks/useFeedKeyboard.ts`, add before the `Ctrl+L` handler:

```typescript
if (input === 'y' || input === 'Y') {
	callbacks.yankAtCursor();
	return;
}
```

**Step 3: Wire callback in AppShell**

In `src/app/shell/AppShell.tsx`:

1. Add imports at top:

```typescript
import {copyToClipboard} from '../../shared/utils/clipboard';
import {extractYankContent} from '../../ui/utils/yankContent';
```

2. Create the callback before the `useFeedKeyboard` call:

```typescript
const yankAtCursor = useCallback(() => {
	const entry = filteredEntriesRef.current[feedNav.feedCursor];
	if (!entry) return;
	const content = extractYankContent(entry);
	copyToClipboard(content);
}, [feedNav.feedCursor]);
```

3. Add `yankAtCursor` to the callbacks object in the `useFeedKeyboard` call:

```typescript
yankAtCursor,
```

**Step 4: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ui/hooks/useFeedKeyboard.ts src/app/shell/AppShell.tsx
git commit -m "feat: add y keybinding to yank cursor item in feed view"
```

---

### Task 4: Add `y` keybinding to pager view

**Files:**

- Modify: `src/ui/hooks/usePager.ts` — add `y` handler in pager's useInput

**Step 1: Add imports to usePager.ts**

```typescript
import stripAnsi from 'strip-ansi';
import {copyToClipboard} from '../../shared/utils/clipboard';
```

**Step 2: Add `y` handler in pager's useInput (after the scroll handlers, before the closing brace)**

In the `useInput` callback inside usePager (the one with `{isActive: pagerActive}`), add after the `G`/end handler:

```typescript
if (input === 'y' || input === 'Y') {
	const content = pagerLinesRef.current
		.map(line => stripAnsi(line).trimEnd())
		.join('\n');
	copyToClipboard(content);
	// Flash "Copied!" in pager footer
	const margin = ' '.repeat(PAGER_MARGIN);
	const rows = process.stdout.rows ?? 24;
	process.stdout.write(`\x1B[${rows};1H`);
	process.stdout.write(
		margin + chalk.bold.green('Copied to clipboard!') + '\x1B[K',
	);
	setTimeout(() => {
		paintPager();
	}, 1500);
	return;
}
```

**Step 3: Update pager footer hint to include `y`**

In `paintPager`, update the footer text from:

```
`${pos}  ↑/↓ j/k scroll  PgUp/PgDn page  q exit`
```

to:

```
`${pos}  ↑/↓ j/k scroll  PgUp/PgDn page  y copy  q exit`
```

**Step 4: Add test for pager yank**

Add to `src/ui/hooks/__tests__/usePager.test.ts`:

```typescript
vi.mock('strip-ansi', () => ({
	default: (s: string) => s.replace(/\x1B\[[^m]*m/g, ''),
}));

vi.mock('../../../shared/utils/clipboard', () => ({
	copyToClipboard: vi.fn(),
}));
```

Then add a test:

```typescript
it('pressing y copies pager content to clipboard', async () => {
	const {copyToClipboard} = await import('../../../shared/utils/clipboard');
	const entries = [
		makeEntry({expandable: true, feedEvent: {type: 'tool_use'} as never}),
	];
	const ref = {current: entries};

	inputHandlers.length = 0;
	const {result} = renderHook(() =>
		usePager({filteredEntriesRef: ref, feedCursor: 0}),
	);
	act(() => {
		result.current.handleExpandForPager();
	});

	const activeHandler = inputHandlers.find(h => h.opts.isActive);
	if (activeHandler) {
		act(() => {
			activeHandler.handler('y', {escape: false});
		});
		expect(copyToClipboard).toHaveBeenCalled();
	}
});
```

**Step 5: Run tests + typecheck + lint**

Run: `npx vitest run src/ui/hooks/__tests__/usePager.test.ts && npm run typecheck && npm run lint`
Expected: PASS

**Step 6: Commit**

```bash
git add src/ui/hooks/usePager.ts src/ui/hooks/__tests__/usePager.test.ts
git commit -m "feat: add y keybinding to yank content in pager view"
```

---

### Task 5: Add toast feedback in feed view

**Files:**

- Modify: `src/ui/hooks/usePager.ts` — return `toastMessage` state
- Modify: `src/app/shell/AppShell.tsx` — show toast in footer area

The pager already handles its own toast (Task 4). For the feed view, we need a transient message.

**Step 1: Add toast state to AppShell**

In `src/app/shell/AppShell.tsx`, add state:

```typescript
const [toastMessage, setToastMessage] = useState<string | null>(null);
const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

**Step 2: Create showToast helper**

```typescript
const showToast = useCallback((msg: string) => {
	if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
	setToastMessage(msg);
	toastTimerRef.current = setTimeout(() => setToastMessage(null), 1500);
}, []);
```

**Step 3: Update yankAtCursor to call showToast**

```typescript
const yankAtCursor = useCallback(() => {
	const entry = filteredEntriesRef.current[feedNav.feedCursor];
	if (!entry) return;
	const content = extractYankContent(entry);
	copyToClipboard(content);
	showToast('Copied to clipboard!');
}, [feedNav.feedCursor, showToast]);
```

**Step 4: Render toast in JSX**

In the JSX return, add just before `</Box>` (after the question dialog):

```tsx
{
	toastMessage && (
		<Box position="absolute" marginLeft={2}>
			<Text color="green" bold>
				{toastMessage}
			</Text>
		</Box>
	);
}
```

**Note:** If Ink doesn't support `position="absolute"` cleanly, an alternative is to replace the `footerHelp` line temporarily when toast is active:

In the `frame.footerHelp` section, change:

```tsx
{
	frame.footerHelp !== null && (
		<Text>
			{frameLine(
				toastMessage
					? chalk.bold.green(toastMessage)
					: fit(frame.footerHelp, innerWidth),
			)}
		</Text>
	);
}
```

**Step 5: Run typecheck + lint + tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/app/shell/AppShell.tsx
git commit -m "feat: add toast feedback for yank in feed view"
```

---

### Task 6: Update keyboard hints

**Files:**

- Find and modify the keyboard hint configuration to include `y` for yank

**Step 1: Find where keyboard hints are defined**

Search for the `Ctrl+/` hints toggle and the hint content. This is likely in `useFrameChrome.ts` or a similar layout hook.

**Step 2: Add `y yank` to the feed mode hints**

Add the yank hint alongside existing feed navigation hints.

**Step 3: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS

**Step 4: Commit**

```bash
git commit -am "feat: add yank hint to keyboard help"
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

**Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

**Step 4: Run dead code check**

Run: `npm run lint:dead`
Expected: No new dead code introduced

**Step 5: Manual smoke test**

Run: `npm run dev` and verify:

1. Navigate feed with arrows, press `y` → "Copied to clipboard!" toast appears
2. Open pager (Enter), press `y` → "Copied to clipboard!" appears in footer
3. Paste clipboard content to verify correctness
4. Footer hint in pager shows `y copy`
