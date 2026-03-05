/** @vitest-environment jsdom */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {renderHook, act} from '@testing-library/react';

// Capture useInput handlers registered by the hook
type InputHandler = (input: string, key: Record<string, boolean>) => void;
const inputHandlers: Array<{handler: InputHandler; opts: {isActive: boolean}}> =
	[];

vi.mock('ink', () => ({
	useInput: (handler: InputHandler, opts: {isActive: boolean}) => {
		inputHandlers.push({handler, opts});
	},
}));

vi.mock('../../layout/renderDetailLines', () => ({
	renderDetailLines: () => ({
		lines: ['line1', 'line2', 'line3'],
		showLineNumbers: false,
	}),
	renderMarkdownToLines: () => ['md-line1', 'md-line2'],
}));

vi.mock('chalk', () => ({
	default: {dim: (s: string) => s, bold: {green: (s: string) => s}},
}));

vi.mock('strip-ansi', () => ({
	// eslint-disable-next-line no-control-regex
	default: (s: string) => s.replace(/\x1B\[[^m]*m/g, ''),
}));

vi.mock('../../../shared/utils/clipboard', () => ({
	copyToClipboard: vi.fn(),
}));

import {usePager} from '../usePager';
import type {TimelineEntry} from '../../../core/feed/timeline';

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
	return {
		id: 'e1',
		ts: 0,
		op: 'Tool Call',
		opTag: 'tool.call',
		actor: 'Claude',
		actorId: 'c1',
		toolColumn: 'Read',
		summary: 'test',
		summarySegments: [],
		searchText: 'test',
		error: false,
		expandable: true,
		details: 'details',
		duplicateActor: false,
		...overrides,
	};
}

describe('usePager', () => {
	let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
	let stdinOnSpy: ReturnType<typeof vi.spyOn>;
	let stdinRemoveSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		inputHandlers.length = 0;
		stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
		stdinOnSpy = vi.spyOn(process.stdin, 'on').mockReturnThis();
		stdinRemoveSpy = vi.spyOn(process.stdin, 'removeListener').mockReturnThis();
		Object.defineProperty(process.stdout, 'rows', {
			value: 24,
			configurable: true,
		});
		Object.defineProperty(process.stdout, 'columns', {
			value: 80,
			configurable: true,
		});
	});

	afterEach(() => {
		stdoutWriteSpy.mockRestore();
		stdinOnSpy.mockRestore();
		stdinRemoveSpy.mockRestore();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('starts with pagerActive=false', () => {
		const entries = [makeEntry()];
		const ref = {current: entries};
		const {result} = renderHook(() =>
			usePager({filteredEntriesRef: ref, feedCursor: 0}),
		);
		expect(result.current.pagerActive).toBe(false);
	});

	it('expand on non-expandable entry is a no-op', () => {
		const entries = [makeEntry({expandable: false})];
		const ref = {current: entries};
		const {result} = renderHook(() =>
			usePager({filteredEntriesRef: ref, feedCursor: 0}),
		);
		act(() => {
			result.current.handleExpandForPager();
		});
		expect(result.current.pagerActive).toBe(false);
	});

	it('expand on expandable entry sets pagerActive=true', () => {
		const entries = [makeEntry({expandable: true})];
		const ref = {current: entries};
		const {result} = renderHook(() =>
			usePager({filteredEntriesRef: ref, feedCursor: 0}),
		);
		act(() => {
			result.current.handleExpandForPager();
		});
		expect(result.current.pagerActive).toBe(true);
	});

	it('expand writes to alternate screen buffer', () => {
		const entries = [
			makeEntry({expandable: true, feedEvent: {type: 'tool_use'} as never}),
		];
		const ref = {current: entries};
		renderHook(() => usePager({filteredEntriesRef: ref, feedCursor: 0}));
		// After expand, the effect should write to alternate screen
		const {result} = renderHook(() =>
			usePager({filteredEntriesRef: ref, feedCursor: 0}),
		);
		act(() => {
			result.current.handleExpandForPager();
		});

		// Should have written alternate screen escape sequences
		const allWrites = stdoutWriteSpy.mock.calls
			.map(c => c[0])
			.filter(w => typeof w === 'string');
		const hasAltScreen = allWrites.some((w: string) =>
			w.includes('\x1B[?1049h'),
		);
		expect(hasAltScreen).toBe(true);
	});

	it('pressing q exits pager and restores main screen', () => {
		const entries = [makeEntry({expandable: true})];
		const ref = {current: entries};
		const {result} = renderHook(() =>
			usePager({filteredEntriesRef: ref, feedCursor: 0}),
		);

		// Activate pager
		act(() => {
			result.current.handleExpandForPager();
		});
		expect(result.current.pagerActive).toBe(true);

		// Find the pager keyboard handler (the one active when pagerActive=true)
		// Re-render to get fresh handlers
		inputHandlers.length = 0;
		const {result: result2} = renderHook(() =>
			usePager({filteredEntriesRef: ref, feedCursor: 0}),
		);
		act(() => {
			result2.current.handleExpandForPager();
		});

		// Find active handler
		const activeHandler = inputHandlers.find(h => h.opts.isActive);
		if (activeHandler) {
			stdoutWriteSpy.mockClear();
			act(() => {
				activeHandler.handler('q', {escape: false});
			});

			// Should have written leave-alternate-screen sequence
			const allWrites = stdoutWriteSpy.mock.calls
				.map(c => c[0])
				.filter(w => typeof w === 'string');
			const hasLeaveAlt = allWrites.some((w: string) =>
				w.includes('\x1B[?1049l'),
			);
			expect(hasLeaveAlt).toBe(true);
		}

		expect(result2.current.pagerActive).toBe(false);
	});

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
			expect(copyToClipboard).toHaveBeenCalledWith(
				'   line1\n   line2\n   line3',
			);
		}
	});

	it('cancels pending pager repaint timer on exit', () => {
		vi.useFakeTimers();
		const entries = [makeEntry({expandable: true})];
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
				activeHandler.handler('q', {escape: false});
			});
			stdoutWriteSpy.mockClear();
			act(() => {
				vi.advanceTimersByTime(1600);
			});
			expect(stdoutWriteSpy).not.toHaveBeenCalled();
		}
	});

	it('expand with cursor beyond entries is a no-op', () => {
		const entries = [makeEntry()];
		const ref = {current: entries};
		const {result} = renderHook(() =>
			usePager({filteredEntriesRef: ref, feedCursor: 5}),
		);
		act(() => {
			result.current.handleExpandForPager();
		});
		expect(result.current.pagerActive).toBe(false);
	});

	it('repaints pager on rerender while active', () => {
		const entries = [
			makeEntry({expandable: true, feedEvent: {type: 'tool_use'} as never}),
		];
		const ref = {current: entries};
		const {result, rerender} = renderHook(
			({cursor}: {cursor: number}) =>
				usePager({filteredEntriesRef: ref, feedCursor: cursor}),
			{initialProps: {cursor: 0}},
		);

		act(() => {
			result.current.handleExpandForPager();
		});
		expect(result.current.pagerActive).toBe(true);

		stdoutWriteSpy.mockClear();
		rerender({cursor: 1});

		const writes = stdoutWriteSpy.mock.calls
			.map(call => call[0])
			.filter((value): value is string => typeof value === 'string');
		expect(writes.some(write => write.includes('\x1B[2J\x1B[H'))).toBe(true);
	});
});
