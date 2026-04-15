import type {MessageTab} from '../../core/feed/panelFilter';
import type {FocusMode, InputMode} from './types';

export type TodoCursorMode = 'auto' | 'manual';

export type SessionUiState = {
	focusMode: FocusMode;
	inputMode: InputMode;
	hintsForced: boolean | null;
	showRunOverlay: boolean;
	searchQuery: string;
	searchMatchPos: number;
	feedCursor: number;
	feedViewportStart: number;
	tailFollow: boolean;
	todoVisible: boolean;
	todoShowDone: boolean;
	todoCursor: number;
	todoScroll: number;
	todoCursorMode: TodoCursorMode;
	messagePanelTab: MessageTab;
	messageCursor: number;
	messageViewportStart: number;
	messageTailFollow: boolean;
};

export type SessionUiContext = {
	feedEntryCount: number;
	feedContentRows: number;
	searchMatchCount: number;
	todoVisibleCount: number;
	todoListHeight: number;
	todoFocusable: boolean;
	todoAnchorIndex: number;
	staticFloor?: number;
	messageEntryCount: number;
	messageContentRows: number;
};

export type SessionUiAction =
	| {type: 'cycle_focus'}
	| {type: 'set_focus_mode'; focusMode: FocusMode}
	| {type: 'open_command_input'}
	| {type: 'open_search_input'}
	| {type: 'open_normal_input'}
	| {type: 'cancel_input'}
	| {type: 'cycle_hints_forced'}
	| {type: 'set_input_mode'; inputMode: InputMode}
	| {type: 'set_show_run_overlay'; show: boolean}
	| {type: 'set_search_query'; query: string}
	| {type: 'submit_search_query'; query: string; firstMatchIndex: number | null}
	| {type: 'step_search_match'; direction: 1 | -1; matches: number[]}
	| {type: 'clear_search_and_jump_tail'}
	| {type: 'move_feed_cursor'; delta: number}
	| {type: 'jump_feed_tail'}
	| {type: 'jump_feed_top'}
	| {type: 'set_feed_cursor'; cursor: number}
	| {type: 'set_tail_follow'; tailFollow: boolean}
	| {type: 'toggle_todo_visible'}
	| {type: 'set_todo_visible'; visible: boolean}
	| {type: 'set_todo_show_done'; showDone: boolean}
	| {type: 'move_todo_cursor'; delta: number}
	| {type: 'set_todo_cursor'; cursor: number}
	| {type: 'reveal_feed_entry'; cursor: number}
	| {type: 'set_search_match_pos'; position: number}
	| {type: 'set_message_tab'; tab: MessageTab}
	| {type: 'move_message_cursor'; delta: number}
	| {type: 'jump_message_tail'}
	| {type: 'jump_message_top'};

type ScrollState = {cursor: number; viewportStart: number; tailFollow: boolean};

type FeedState = Pick<
	SessionUiState,
	'feedCursor' | 'feedViewportStart' | 'tailFollow'
>;

type MessageState = Pick<
	SessionUiState,
	'messageCursor' | 'messageViewportStart' | 'messageTailFollow'
>;

const DEFAULT_STATIC_FLOOR = 0;

export const initialSessionUiState: SessionUiState = {
	focusMode: 'input',
	inputMode: 'normal',
	hintsForced: null,
	showRunOverlay: false,
	searchQuery: '',
	searchMatchPos: 0,
	feedCursor: 0,
	feedViewportStart: 0,
	tailFollow: true,
	todoVisible: true,
	todoShowDone: true,
	todoCursor: 0,
	todoScroll: 0,
	todoCursorMode: 'auto',
	messagePanelTab: 'both',
	messageCursor: 0,
	messageViewportStart: 0,
	messageTailFollow: true,
};

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function computeScrollState(
	cursor: number,
	viewportStart: number,
	tailFollow: boolean,
	entryCount: number,
	contentRows: number,
	floor: number,
): ScrollState {
	const maxCursor = Math.max(floor, entryCount - 1);
	const maxStart = contentRows <= 0 ? 0 : Math.max(0, entryCount - contentRows);
	if (tailFollow) {
		return {cursor: maxCursor, tailFollow: true, viewportStart: maxStart};
	}
	const nextCursor = clamp(cursor, floor, maxCursor);
	let nextStart = clamp(viewportStart, floor, maxStart);
	if (nextCursor < nextStart) {
		nextStart = nextCursor;
	} else if (contentRows > 0) {
		const visibleEnd = nextStart + contentRows - 1;
		if (nextCursor > visibleEnd) {
			nextStart = nextCursor - contentRows + 1;
		}
	}
	return {
		cursor: nextCursor,
		tailFollow: false,
		viewportStart: clamp(nextStart, floor, maxStart),
	};
}

function maxFeedCursor(ctx: SessionUiContext): number {
	return Math.max(
		ctx.staticFloor ?? DEFAULT_STATIC_FLOOR,
		ctx.feedEntryCount - 1,
	);
}

function maxFeedViewportStart(ctx: SessionUiContext): number {
	return ctx.feedContentRows <= 0
		? 0
		: Math.max(0, ctx.feedEntryCount - ctx.feedContentRows);
}

function computeFeedState(
	cursor: number,
	viewportStart: number,
	tailFollow: boolean,
	ctx: SessionUiContext,
): FeedState {
	const floor = ctx.staticFloor ?? DEFAULT_STATIC_FLOOR;
	const s = computeScrollState(
		cursor,
		viewportStart,
		tailFollow,
		ctx.feedEntryCount,
		ctx.feedContentRows,
		floor,
	);
	return {
		feedCursor: s.cursor,
		tailFollow: s.tailFollow,
		feedViewportStart: s.viewportStart,
	};
}

function maxMessageCursor(ctx: SessionUiContext): number {
	return Math.max(0, ctx.messageEntryCount - 1);
}

function maxMessageViewportStart(ctx: SessionUiContext): number {
	return ctx.messageContentRows <= 0
		? 0
		: Math.max(0, ctx.messageEntryCount - ctx.messageContentRows);
}

function computeMessageState(
	cursor: number,
	viewportStart: number,
	tailFollow: boolean,
	ctx: SessionUiContext,
): MessageState {
	const s = computeScrollState(
		cursor,
		viewportStart,
		tailFollow,
		ctx.messageEntryCount,
		ctx.messageContentRows,
		0,
	);
	return {
		messageCursor: s.cursor,
		messageTailFollow: s.tailFollow,
		messageViewportStart: s.viewportStart,
	};
}

function withFeedChange(
	current: SessionUiState,
	feed: FeedState,
): SessionUiState {
	if (
		feed.feedCursor === current.feedCursor &&
		feed.feedViewportStart === current.feedViewportStart &&
		feed.tailFollow === current.tailFollow
	) {
		return current;
	}
	return {...current, ...feed};
}

function withMessageChange(
	current: SessionUiState,
	msg: MessageState,
): SessionUiState {
	if (
		msg.messageCursor === current.messageCursor &&
		msg.messageViewportStart === current.messageViewportStart &&
		msg.messageTailFollow === current.messageTailFollow
	) {
		return current;
	}
	return {...current, ...msg};
}

function resolveTodoCursor(
	state: SessionUiState,
	ctx: SessionUiContext,
): number {
	if (ctx.todoVisibleCount <= 0) return 0;
	const preferredCursor =
		state.todoCursorMode === 'auto' && ctx.todoAnchorIndex >= 0
			? ctx.todoAnchorIndex
			: state.todoCursor;
	return clamp(preferredCursor, 0, ctx.todoVisibleCount - 1);
}

function resolveTodoScroll(
	todoCursor: number,
	todoScroll: number,
	ctx: SessionUiContext,
): number {
	if (ctx.todoListHeight <= 0 || ctx.todoVisibleCount <= 0) {
		return 0;
	}
	let nextScroll = clamp(
		todoScroll,
		0,
		Math.max(0, ctx.todoVisibleCount - ctx.todoListHeight),
	);
	if (todoCursor < nextScroll) {
		nextScroll = todoCursor;
	} else if (todoCursor >= nextScroll + ctx.todoListHeight) {
		nextScroll = todoCursor - ctx.todoListHeight + 1;
	}
	return clamp(
		nextScroll,
		0,
		Math.max(0, ctx.todoVisibleCount - ctx.todoListHeight),
	);
}

export function resolveSessionUiState(
	state: SessionUiState,
	ctx: SessionUiContext,
): SessionUiState {
	const feedState = computeFeedState(
		state.feedCursor,
		state.feedViewportStart,
		state.tailFollow,
		ctx,
	);
	const msgState = computeMessageState(
		state.messageCursor,
		state.messageViewportStart,
		state.messageTailFollow,
		ctx,
	);
	const todoCursor = resolveTodoCursor(state, ctx);
	let focusMode = state.focusMode;
	if (focusMode === 'todo' && (!state.todoVisible || !ctx.todoFocusable)) {
		focusMode = 'feed';
	}
	if (focusMode === 'messages' && ctx.messageEntryCount <= 0) {
		focusMode = 'feed';
	}
	const searchMatchPos =
		ctx.searchMatchCount <= 0
			? 0
			: clamp(state.searchMatchPos, 0, ctx.searchMatchCount - 1);
	const todoScroll = resolveTodoScroll(todoCursor, state.todoScroll, ctx);

	if (
		focusMode === state.focusMode &&
		searchMatchPos === state.searchMatchPos &&
		feedState.feedCursor === state.feedCursor &&
		feedState.feedViewportStart === state.feedViewportStart &&
		feedState.tailFollow === state.tailFollow &&
		todoCursor === state.todoCursor &&
		todoScroll === state.todoScroll &&
		msgState.messageCursor === state.messageCursor &&
		msgState.messageViewportStart === state.messageViewportStart &&
		msgState.messageTailFollow === state.messageTailFollow
	) {
		return state;
	}

	return {
		...state,
		focusMode,
		searchMatchPos,
		feedCursor: feedState.feedCursor,
		feedViewportStart: feedState.feedViewportStart,
		tailFollow: feedState.tailFollow,
		todoCursor,
		todoScroll,
		messageCursor: msgState.messageCursor,
		messageViewportStart: msgState.messageViewportStart,
		messageTailFollow: msgState.messageTailFollow,
	};
}

function cycleHintsForced(value: boolean | null): boolean | null {
	if (value === null) return true;
	if (value) return false;
	return null;
}

export function reduceSessionUiState(
	state: SessionUiState,
	action: SessionUiAction,
	ctx: SessionUiContext,
): SessionUiState {
	const current = resolveSessionUiState(state, ctx);
	switch (action.type) {
		case 'cycle_focus': {
			if (current.focusMode === 'input') {
				if (current.todoVisible && ctx.todoFocusable) {
					return {...current, focusMode: 'todo', todoCursorMode: 'auto'};
				}
				if (ctx.messageEntryCount > 0) {
					return {...current, focusMode: 'messages'};
				}
				return {...current, focusMode: 'feed'};
			}
			if (current.focusMode === 'todo') {
				if (ctx.messageEntryCount > 0) {
					return {...current, focusMode: 'messages'};
				}
				return {...current, focusMode: 'feed'};
			}
			if (current.focusMode === 'messages') {
				return {...current, focusMode: 'feed'};
			}
			return {...current, focusMode: 'input'};
		}
		case 'set_focus_mode':
			return {
				...current,
				focusMode:
					action.focusMode === 'todo' &&
					(!current.todoVisible || !ctx.todoFocusable)
						? 'feed'
						: action.focusMode,
				todoCursorMode:
					action.focusMode === 'todo' ? 'auto' : current.todoCursorMode,
			};
		case 'open_command_input':
			return {...current, focusMode: 'input', inputMode: 'command'};
		case 'open_search_input':
			return {...current, focusMode: 'input', inputMode: 'search'};
		case 'open_normal_input':
			return {...current, focusMode: 'input', inputMode: 'normal'};
		case 'cancel_input':
			return {...current, focusMode: 'feed', inputMode: 'normal'};
		case 'cycle_hints_forced':
			return {...current, hintsForced: cycleHintsForced(current.hintsForced)};
		case 'set_input_mode':
			if (current.inputMode === action.inputMode) return current;
			return {...current, inputMode: action.inputMode};
		case 'set_show_run_overlay':
			if (current.showRunOverlay === action.show) return current;
			return {...current, showRunOverlay: action.show};
		case 'set_search_query':
			if (
				current.searchQuery === action.query &&
				(action.query.length !== 0 || current.searchMatchPos === 0)
			) {
				return current;
			}
			return {
				...current,
				searchQuery: action.query,
				searchMatchPos: action.query.length === 0 ? 0 : current.searchMatchPos,
			};
		case 'submit_search_query': {
			const nextState: SessionUiState = {
				...current,
				focusMode: 'feed',
				inputMode: 'normal',
				searchQuery: action.query,
				searchMatchPos: 0,
			};
			return action.firstMatchIndex === null
				? nextState
				: {
						...nextState,
						...computeFeedState(
							action.firstMatchIndex,
							current.feedViewportStart,
							false,
							ctx,
						),
					};
		}
		case 'step_search_match': {
			if (action.matches.length === 0) return current;
			const nextPos =
				(current.searchMatchPos + action.direction + action.matches.length) %
				action.matches.length;
			return {
				...current,
				searchMatchPos: nextPos,
				...computeFeedState(
					action.matches[nextPos]!,
					current.feedViewportStart,
					false,
					ctx,
				),
			};
		}
		case 'clear_search_and_jump_tail':
			return {
				...current,
				searchQuery: '',
				searchMatchPos: 0,
				showRunOverlay: false,
				feedCursor: maxFeedCursor(ctx),
				feedViewportStart: maxFeedViewportStart(ctx),
				tailFollow: true,
			};
		case 'move_feed_cursor':
			return withFeedChange(
				current,
				computeFeedState(
					current.feedCursor + action.delta,
					current.feedViewportStart,
					false,
					ctx,
				),
			);
		case 'jump_feed_tail':
			return withFeedChange(current, {
				feedCursor: maxFeedCursor(ctx),
				feedViewportStart: maxFeedViewportStart(ctx),
				tailFollow: true,
			});
		case 'jump_feed_top':
			return withFeedChange(current, {
				feedCursor: ctx.staticFloor ?? DEFAULT_STATIC_FLOOR,
				feedViewportStart: ctx.staticFloor ?? DEFAULT_STATIC_FLOOR,
				tailFollow: false,
			});
		case 'set_feed_cursor':
			return withFeedChange(
				current,
				computeFeedState(action.cursor, current.feedViewportStart, false, ctx),
			);
		case 'set_tail_follow':
			if (action.tailFollow) {
				return withFeedChange(current, {
					feedCursor: maxFeedCursor(ctx),
					feedViewportStart: maxFeedViewportStart(ctx),
					tailFollow: true,
				});
			}
			if (!current.tailFollow) return current;
			return {...current, tailFollow: false};
		case 'toggle_todo_visible': {
			const nextVisible = !current.todoVisible;
			return {
				...current,
				todoVisible: nextVisible,
				focusMode:
					current.focusMode === 'todo' && !nextVisible
						? 'feed'
						: current.focusMode,
				todoCursorMode: nextVisible ? 'auto' : current.todoCursorMode,
			};
		}
		case 'set_todo_visible':
			return {
				...current,
				todoVisible: action.visible,
				focusMode:
					current.focusMode === 'todo' && !action.visible
						? 'feed'
						: current.focusMode,
				todoCursorMode: action.visible ? 'auto' : current.todoCursorMode,
			};
		case 'set_todo_show_done':
			if (current.todoShowDone === action.showDone) return current;
			return {...current, todoShowDone: action.showDone};
		case 'move_todo_cursor': {
			const nextCursor =
				ctx.todoVisibleCount <= 0
					? 0
					: clamp(
							current.todoCursor + action.delta,
							0,
							ctx.todoVisibleCount - 1,
						);
			if (
				nextCursor === current.todoCursor &&
				current.todoCursorMode === 'manual'
			) {
				return current;
			}
			return {...current, todoCursor: nextCursor, todoCursorMode: 'manual'};
		}
		case 'set_todo_cursor': {
			const nextCursor =
				ctx.todoVisibleCount <= 0
					? 0
					: clamp(action.cursor, 0, ctx.todoVisibleCount - 1);
			if (
				nextCursor === current.todoCursor &&
				current.todoCursorMode === 'manual'
			) {
				return current;
			}
			return {...current, todoCursor: nextCursor, todoCursorMode: 'manual'};
		}
		case 'reveal_feed_entry': {
			const feed = computeFeedState(
				action.cursor,
				current.feedViewportStart,
				false,
				ctx,
			);
			if (
				current.focusMode === 'feed' &&
				feed.feedCursor === current.feedCursor &&
				feed.feedViewportStart === current.feedViewportStart &&
				feed.tailFollow === current.tailFollow
			) {
				return current;
			}
			return {...current, focusMode: 'feed', ...feed};
		}
		case 'set_search_match_pos':
			if (current.searchMatchPos === action.position) return current;
			return {...current, searchMatchPos: action.position};
		case 'set_message_tab':
			if (current.messagePanelTab === action.tab) return current;
			return {...current, messagePanelTab: action.tab};
		case 'move_message_cursor':
			return withMessageChange(
				current,
				computeMessageState(
					current.messageCursor + action.delta,
					current.messageViewportStart,
					false,
					ctx,
				),
			);
		case 'jump_message_tail':
			return withMessageChange(current, {
				messageCursor: maxMessageCursor(ctx),
				messageViewportStart: maxMessageViewportStart(ctx),
				messageTailFollow: true,
			});
		case 'jump_message_top':
			return withMessageChange(current, {
				messageCursor: 0,
				messageViewportStart: 0,
				messageTailFollow: false,
			});
		default:
			return current;
	}
}
