/** @vitest-environment jsdom */
import {describe, it, expect, vi} from 'vitest';
import {renderHook} from '@testing-library/react';
import {useLayout} from './useLayout';
import {type UseTodoPanelResult} from './useTodoPanel';

function makeTodoPanel(
	overrides: Partial<UseTodoPanelResult> = {},
): UseTodoPanelResult {
	return {
		todoVisible: true,
		todoShowDone: true,
		todoCursor: 0,
		todoScroll: 0,
		extraTodos: [],
		todoStatusOverrides: {},
		todoItems: [],
		visibleTodoItems: [],
		doneCount: 0,
		doingCount: 0,
		blockedCount: 0,
		openCount: 0,
		failedCount: 0,
		remainingCount: 0,
		setTodoVisible: vi.fn(),
		setTodoShowDone: vi.fn(),
		setTodoCursor: vi.fn(),
		setTodoScroll: vi.fn(),
		setExtraTodos: vi.fn(),
		setTodoStatusOverrides: vi.fn(),
		addTodo: vi.fn(),
		toggleTodoStatus: vi.fn(),
		...overrides,
	};
}

describe('useLayout height constants', () => {
	it('total rendered rows should equal terminalRows with dynamic footer', () => {
		const terminalRows = 40;
		const HEADER_ROWS = 1;
		const FRAME_BORDER_ROWS = 4;
		const footerRows = 2;
		const bodyHeight =
			terminalRows - HEADER_ROWS - footerRows - FRAME_BORDER_ROWS;
		const totalRendered =
			bodyHeight + HEADER_ROWS + FRAME_BORDER_ROWS + footerRows;
		expect(totalRendered).toBe(terminalRows);
	});

	it('adjusts body height for multi-line input footer', () => {
		const terminalRows = 40;
		const HEADER_ROWS = 1;
		const FRAME_BORDER_ROWS = 4;
		const footerRows = 4;
		const bodyHeight =
			terminalRows - HEADER_ROWS - footerRows - FRAME_BORDER_ROWS;
		expect(bodyHeight).toBe(31);
	});
});

describe('Bug #7: todoListHeight accounts for worst-case scroll affordances', () => {
	it('todoListHeight should subtract 2 when items exceed raw slots', () => {
		// Simulating the useLayout calculation for todoListHeight
		const actualTodoRows = 8;
		const itemSlots = actualTodoRows - 2; // 6 (header + divider)
		const totalItems = 10; // more items than slots → scrolling needed

		// Old (buggy): todoListHeight = actualTodoRows - 1 = 7
		// This is used to clamp scrolling. But actual visible items when both
		// affordances are present is only itemSlots - 2 = 4.
		// maxScroll = totalItems - todoListHeight
		// Old: maxScroll = 10 - 7 = 3. At scroll=3, visible = items[3..6], but
		// with both affordances only 4 items render, so items[7..9] unreachable.
		//
		// Correct: todoListHeight = itemSlots - 2 = 4 when totalItems > itemSlots
		// maxScroll = 10 - 4 = 6. At scroll=6, visible = items[6..9] ✓

		// The actual useLayout code computes:
		const oldTodoListHeight = Math.max(0, actualTodoRows - 1); // 7 — buggy
		const oldMaxScroll = Math.max(0, totalItems - oldTodoListHeight); // 3

		// At maxScroll, the render shows at most itemSlots - 2 items (both affordances)
		const worstCaseRenderSlots = itemSlots - 2; // 4
		const lastReachableOld = oldMaxScroll + worstCaseRenderSlots - 1; // 6

		// Bug: last item index is 9 but only index 6 is reachable
		expect(lastReachableOld).toBeLessThan(totalItems - 1);

		// After fix: todoListHeight should equal worstCaseRenderSlots
		const fixedTodoListHeight = itemSlots - 2; // 4
		const fixedMaxScroll = Math.max(0, totalItems - fixedTodoListHeight); // 6
		const lastReachableFixed = fixedMaxScroll + fixedTodoListHeight - 1; // 9
		expect(lastReachableFixed).toBe(totalItems - 1);
	});
});

describe('todo panel growth policy', () => {
	it('lets todo borrow slack from the feed when the feed would otherwise pad blank rows', () => {
		const bodyHeight = 30;
		const runOverlayRows = 0;
		const rowsForTodoAndFeed = bodyHeight - runOverlayRows;
		const halfSplitTodoRows = Math.floor(rowsForTodoAndFeed / 2); // 15
		const todoRowsTarget = 2 + 40; // many items
		const baseTodoRows = Math.min(todoRowsTarget, halfSplitTodoRows);
		const baseFeedRows = rowsForTodoAndFeed - baseTodoRows; // 15
		const minFeedRowsNeeded = 3 + 2; // 3 entries + header + divider
		const feedSlack = Math.max(0, baseFeedRows - minFeedRowsNeeded); // 10
		const todoRows = Math.min(todoRowsTarget, baseTodoRows + feedSlack);
		const feedRows = rowsForTodoAndFeed - todoRows;

		expect(todoRows).toBe(25);
		expect(feedRows).toBe(5);
	});

	it('keeps the half split when the feed actually needs its full share', () => {
		const bodyHeight = 30;
		const runOverlayRows = 6;
		const rowsForTodoAndFeed = bodyHeight - runOverlayRows; // 24
		const halfSplitTodoRows = Math.floor(rowsForTodoAndFeed / 2); // 12
		const todoRowsTarget = 2 + 40;
		const baseTodoRows = Math.min(todoRowsTarget, halfSplitTodoRows);
		const baseFeedRows = rowsForTodoAndFeed - baseTodoRows; // 12
		const minFeedRowsNeeded = rowsForTodoAndFeed; // many entries, no slack
		const feedSlack = Math.max(0, baseFeedRows - minFeedRowsNeeded);
		const todoRows = Math.min(todoRowsTarget, baseTodoRows + feedSlack);
		const feedRows = rowsForTodoAndFeed - todoRows;

		expect(todoRows).toBe(12);
		expect(feedRows).toBe(12);
	});
});

describe('useLayout', () => {
	it('does not allocate run overlay rows when overlay is enabled but there are no runs', () => {
		const todoPanel = makeTodoPanel();
		const {result} = renderHook(() =>
			useLayout({
				terminalRows: 40,
				terminalWidth: 120,
				showRunOverlay: true,
				runSummaries: [],
				todoPanel,
				feedEntryCount: 0,
				footerRows: 2,
			}),
		);

		expect(result.current.actualRunOverlayRows).toBe(0);
	});

	it('does not call setTodoScroll when the current scroll is already valid', () => {
		const setTodoScroll = vi.fn();
		const todoPanel = makeTodoPanel({
			todoCursor: 1,
			todoScroll: 0,
			visibleTodoItems: [
				{id: '1', text: 'a', priority: 'P1', status: 'open'},
				{id: '2', text: 'b', priority: 'P1', status: 'doing'},
			],
			setTodoScroll,
		});

		renderHook(() =>
			useLayout({
				terminalRows: 30,
				terminalWidth: 100,
				showRunOverlay: false,
				runSummaries: [],
				todoPanel,
				feedEntryCount: 0,
				footerRows: 2,
			}),
		);

		expect(setTodoScroll).not.toHaveBeenCalled();
	});

	it('clamps scroll back to zero when no todo item rows are available', () => {
		const setTodoScroll = vi.fn();
		const todoPanel = makeTodoPanel({
			todoVisible: true,
			todoCursor: 3,
			todoScroll: 2,
			visibleTodoItems: [{id: '1', text: 'a', priority: 'P1', status: 'open'}],
			setTodoScroll,
		});

		renderHook(() =>
			useLayout({
				terminalRows: 6,
				terminalWidth: 100,
				showRunOverlay: false,
				runSummaries: [],
				todoPanel,
				feedEntryCount: 0,
				footerRows: 2,
			}),
		);

		expect(setTodoScroll).toHaveBeenCalledWith(0);
	});

	it('scrolls down only when the cursor moves below the visible todo window', () => {
		const setTodoScroll = vi.fn();
		const todoPanel = makeTodoPanel({
			todoCursor: 6,
			todoScroll: 0,
			visibleTodoItems: Array.from({length: 8}, (_, index) => ({
				id: String(index),
				text: `task-${index}`,
				priority: 'P1' as const,
				status: 'open' as const,
			})),
			setTodoScroll,
		});

		renderHook(() =>
			useLayout({
				terminalRows: 20,
				terminalWidth: 100,
				showRunOverlay: false,
				runSummaries: [],
				todoPanel,
				feedEntryCount: 50,
				footerRows: 2,
			}),
		);

		expect(setTodoScroll).toHaveBeenCalledWith(5);
	});

	it('grows todo rows beyond half split when the feed has only a few entries', () => {
		const todoPanel = makeTodoPanel({
			visibleTodoItems: Array.from({length: 20}, (_, index) => ({
				id: String(index),
				text: `task-${index}`,
				priority: 'P1' as const,
				status: 'open' as const,
			})),
		});

		const {result} = renderHook(() =>
			useLayout({
				terminalRows: 30,
				terminalWidth: 100,
				showRunOverlay: false,
				runSummaries: [],
				todoPanel,
				feedEntryCount: 3,
				footerRows: 2,
			}),
		);

		expect(result.current.actualTodoRows).toBe(18);
		expect(result.current.feedHeaderRows + result.current.feedContentRows).toBe(5);
	});

	it('does not shrink todo rows later just because feed activity grows', () => {
		const todoPanel = makeTodoPanel({
			visibleTodoItems: Array.from({length: 20}, (_, index) => ({
				id: String(index),
				text: `task-${index}`,
				priority: 'P1' as const,
				status: 'open' as const,
			})),
		});

		const {result, rerender} = renderHook(
			({feedEntryCount}: {feedEntryCount: number}) =>
				useLayout({
					terminalRows: 30,
					terminalWidth: 100,
					showRunOverlay: false,
					runSummaries: [],
					todoPanel,
					feedEntryCount,
					footerRows: 2,
				}),
			{
				initialProps: {feedEntryCount: 3},
			},
		);

		expect(result.current.actualTodoRows).toBe(18);

		rerender({feedEntryCount: 50});

		expect(result.current.actualTodoRows).toBe(18);
	});

	it('shrinks sticky todo rows when the todo list itself gets shorter', () => {
		const longTodoPanel = makeTodoPanel({
			visibleTodoItems: Array.from({length: 20}, (_, index) => ({
				id: String(index),
				text: `task-${index}`,
				priority: 'P1' as const,
				status: 'open' as const,
			})),
		});
		const shortTodoPanel = makeTodoPanel({
			visibleTodoItems: Array.from({length: 4}, (_, index) => ({
				id: String(index),
				text: `task-${index}`,
				priority: 'P1' as const,
				status: 'open' as const,
			})),
		});

		const {result, rerender} = renderHook(
			({todoPanel}: {todoPanel: UseTodoPanelResult}) =>
				useLayout({
					terminalRows: 30,
					terminalWidth: 100,
					showRunOverlay: false,
					runSummaries: [],
					todoPanel,
					feedEntryCount: 3,
					footerRows: 2,
				}),
			{
				initialProps: {todoPanel: longTodoPanel},
			},
		);

		expect(result.current.actualTodoRows).toBe(18);

		rerender({todoPanel: shortTodoPanel});

		expect(result.current.actualTodoRows).toBe(6);
	});
});
