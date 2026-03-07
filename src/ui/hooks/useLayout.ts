import {useRef} from 'react';
import {type RunSummary} from '../../core/feed/timeline';

type TodoLayoutInput = {
	todoVisible: boolean;
	visibleTodoItems: {length: number};
};

const HEADER_ROWS = 1;
const FRAME_BORDER_ROWS = 4;
const RUN_OVERLAY_MAX_ROWS = 6;

export type UseLayoutOptions = {
	terminalRows: number;
	terminalWidth: number;
	showRunOverlay: boolean;
	runSummaries: RunSummary[];
	todoPanel: TodoLayoutInput;
	feedEntryCount?: number;
	footerRows: number;
	/** Number of visual rows the input field occupies (default: 1) */
	inputRows?: number;
};

export type UseLayoutResult = {
	frameWidth: number;
	innerWidth: number;
	bodyHeight: number;
	feedHeaderRows: number;
	feedContentRows: number;
	actualTodoRows: number;
	actualRunOverlayRows: number;
	pageStep: number;
	todoListHeight: number;
	baseFeedContentRows: number;
};

export function useLayout({
	terminalRows,
	terminalWidth,
	showRunOverlay,
	runSummaries,
	todoPanel,
	feedEntryCount = 0,
	footerRows,
	inputRows = 1,
}: UseLayoutOptions): UseLayoutResult {
	const stickyTodoRowsRef = useRef(0);
	const frameWidth = Math.max(4, terminalWidth);
	const innerWidth = frameWidth - 2;

	const bodyHeight = Math.max(
		1,
		terminalRows -
			HEADER_ROWS -
			footerRows -
			FRAME_BORDER_ROWS -
			(inputRows - 1),
	);

	const runOverlayRowsTarget =
		showRunOverlay && runSummaries.length > 0
			? Math.min(RUN_OVERLAY_MAX_ROWS, 1 + runSummaries.length)
			: 0;
	const maxRunOverlayRows = Math.max(0, bodyHeight - 1);
	const runOverlayRows = Math.min(runOverlayRowsTarget, maxRunOverlayRows);
	const rowsForTodoAndFeed = Math.max(1, bodyHeight - runOverlayRows);
	const todoRowsTarget = todoPanel.todoVisible
		? 2 + todoPanel.visibleTodoItems.length
		: 0;
	const halfSplitTodoRows = Math.floor(rowsForTodoAndFeed / 2);
	const baseTodoRows = Math.min(todoRowsTarget, halfSplitTodoRows);
	const baseFeedRowsAtHalfSplit = Math.max(
		1,
		rowsForTodoAndFeed - baseTodoRows,
	);
	const minFeedRowsNeeded =
		feedEntryCount <= 0 ? 1 : Math.min(rowsForTodoAndFeed, feedEntryCount + 2);
	const feedSlack = Math.max(0, baseFeedRowsAtHalfSplit - minFeedRowsNeeded);
	const desiredTodoRows = Math.min(todoRowsTarget, baseTodoRows + feedSlack);
	const maxTodoRowsAvailable = Math.max(0, rowsForTodoAndFeed - 1);
	const retainedTodoRows =
		todoRowsTarget > 0
			? Math.min(
					stickyTodoRowsRef.current,
					maxTodoRowsAvailable,
					todoRowsTarget,
				)
			: 0;
	const todoRows = Math.max(desiredTodoRows, retainedTodoRows);
	stickyTodoRowsRef.current = todoRowsTarget > 0 ? todoRows : 0;
	const baseFeedRows = Math.max(1, rowsForTodoAndFeed - todoRows);
	const feedHeaderRows = baseFeedRows > 1 ? 1 : 0;
	const baseFeedContentRows = Math.max(0, baseFeedRows - feedHeaderRows);
	const feedContentRows = baseFeedContentRows;
	const pageStep = Math.max(1, Math.floor(Math.max(1, feedContentRows) / 2));

	const itemSlots = Math.max(0, todoRows - 2);
	const todoListHeight =
		todoPanel.visibleTodoItems.length > itemSlots
			? Math.max(0, itemSlots - 2)
			: itemSlots;

	return {
		frameWidth,
		innerWidth,
		bodyHeight,
		feedHeaderRows,
		feedContentRows,
		actualTodoRows: todoRows,
		actualRunOverlayRows: runOverlayRows,
		pageStep,
		todoListHeight,
		baseFeedContentRows,
	};
}
