import {useEffect} from 'react';
import {type RunSummary} from '../../core/feed/timeline';
import {type UseTodoPanelResult} from './useTodoPanel';

const HEADER_ROWS = 1;
const FRAME_BORDER_ROWS = 4;
const TODO_PANEL_MAX_ROWS = 8;
const RUN_OVERLAY_MAX_ROWS = 6;

export type UseLayoutOptions = {
	terminalRows: number;
	terminalWidth: number;
	showRunOverlay: boolean;
	runSummaries: RunSummary[];
	todoPanel: UseTodoPanelResult;
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
	footerRows,
	inputRows = 1,
}: UseLayoutOptions): UseLayoutResult {
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

	const todoRowsTarget = todoPanel.todoVisible
		? Math.min(TODO_PANEL_MAX_ROWS, 2 + todoPanel.visibleTodoItems.length)
		: 0;
	const runOverlayRowsTarget = showRunOverlay
		? Math.min(RUN_OVERLAY_MAX_ROWS, 1 + Math.max(1, runSummaries.length))
		: 0;

	let remainingRows = bodyHeight;
	const todoRows = Math.min(todoRowsTarget, Math.max(0, remainingRows - 1));
	remainingRows -= todoRows;
	const runOverlayRows = Math.min(
		runOverlayRowsTarget,
		Math.max(0, remainingRows - 1),
	);
	remainingRows -= runOverlayRows;
	const baseFeedRows = Math.max(1, remainingRows);
	const feedHeaderRows = baseFeedRows > 1 ? 1 : 0;
	const baseFeedContentRows = Math.max(0, baseFeedRows - feedHeaderRows);
	const feedContentRows = baseFeedContentRows;
	const pageStep = Math.max(1, Math.floor(Math.max(1, feedContentRows) / 2));

	const setTodoScroll = todoPanel.setTodoScroll;
	const todoCursor = todoPanel.todoCursor;
	const visibleTodoItemsLength = todoPanel.visibleTodoItems.length;

	// Todo scroll adjustment
	const itemSlots = Math.max(0, todoRows - 2);
	const todoListHeight =
		todoPanel.visibleTodoItems.length > itemSlots
			? Math.max(0, itemSlots - 2)
			: itemSlots;
	useEffect(() => {
		if (todoListHeight <= 0) {
			setTodoScroll(0);
			return;
		}
		setTodoScroll(prev => {
			if (todoCursor < prev) return todoCursor;
			if (todoCursor >= prev + todoListHeight) {
				return todoCursor - todoListHeight + 1;
			}
			const maxScroll = Math.max(0, visibleTodoItemsLength - todoListHeight);
			return Math.min(prev, maxScroll);
		});
	}, [todoCursor, todoListHeight, visibleTodoItemsLength, setTodoScroll]);

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
