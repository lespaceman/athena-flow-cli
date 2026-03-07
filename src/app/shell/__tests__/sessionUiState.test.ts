import {describe, expect, it} from 'vitest';
import {
	initialSessionUiState,
	reduceSessionUiState,
	resolveSessionUiState,
	type SessionUiContext,
	type SessionUiState,
} from '../sessionUiState';

function makeContext(
	overrides: Partial<SessionUiContext> = {},
): SessionUiContext {
	return {
		feedEntryCount: 10,
		feedContentRows: 4,
		searchMatchCount: 0,
		todoVisibleCount: 0,
		todoListHeight: 0,
		todoFocusable: false,
		todoAnchorIndex: -1,
		staticFloor: 0,
		...overrides,
	};
}

function resolve(
	state: Partial<SessionUiState>,
	ctx: Partial<SessionUiContext> = {},
) {
	return resolveSessionUiState(
		{...initialSessionUiState, ...state},
		makeContext(ctx),
	);
}

describe('sessionUiState', () => {
	it('resolveSessionUiState returns same reference when state is already resolved', () => {
		const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
		const state: SessionUiState = {
			...initialSessionUiState,
			feedCursor: 9,
			feedViewportStart: 6,
			tailFollow: true,
		};
		const result = resolveSessionUiState(state, ctx);
		expect(result).toBe(state);
	});

	it('falls back to feed focus when todo focus is no longer valid', () => {
		const result = resolve({
			focusMode: 'todo',
			todoVisible: true,
		});

		expect(result.focusMode).toBe('feed');
	});

	it('keeps auto todo cursor anchored on the preferred item', () => {
		const result = resolve(
			{
				todoCursor: 0,
				todoCursorMode: 'auto',
			},
			{
				todoVisibleCount: 6,
				todoFocusable: true,
				todoAnchorIndex: 3,
			},
		);

		expect(result.todoCursor).toBe(3);
	});

	it('clamps todo scroll into the visible window without a corrective effect', () => {
		const result = resolve(
			{
				todoCursor: 6,
				todoScroll: 0,
				todoCursorMode: 'manual',
			},
			{
				todoVisibleCount: 8,
				todoFocusable: true,
				todoListHeight: 2,
			},
		);

		expect(result.todoScroll).toBe(5);
	});

	it('clamps searchMatchPos when the match count shrinks', () => {
		const result = resolve(
			{
				searchMatchPos: 5,
			},
			{
				searchMatchCount: 2,
			},
		);

		expect(result.searchMatchPos).toBe(1);
	});

	it('cycles focus through todo only when the panel has focusable items', () => {
		const ctx = makeContext({
			todoVisibleCount: 3,
			todoFocusable: true,
			todoAnchorIndex: 1,
		});
		const afterFeed = reduceSessionUiState(
			initialSessionUiState,
			{type: 'cycle_focus'},
			ctx,
		);
		const afterInput = reduceSessionUiState(
			afterFeed,
			{type: 'cycle_focus'},
			ctx,
		);

		expect(afterFeed.focusMode).toBe('input');
		expect(afterInput.focusMode).toBe('todo');
		expect(afterInput.todoCursorMode).toBe('auto');
	});

	describe('identity preservation on no-op', () => {
		it('move_feed_cursor at top boundary returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 0,
				feedViewportStart: 0,
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: -1},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('move_feed_cursor at bottom boundary returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 9,
				feedViewportStart: 6,
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_feed_cursor', delta: 1},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('jump_feed_tail when already at tail returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 9,
				feedViewportStart: 6,
				tailFollow: true,
			};
			const result = reduceSessionUiState(state, {type: 'jump_feed_tail'}, ctx);
			expect(result).toBe(state);
		});

		it('jump_feed_top when already at top returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 0,
				feedViewportStart: 0,
				tailFollow: false,
			};
			const result = reduceSessionUiState(state, {type: 'jump_feed_top'}, ctx);
			expect(result).toBe(state);
		});

		it('set_tail_follow(false) when already false returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 5,
				feedViewportStart: 3,
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'set_tail_follow', tailFollow: false},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('set_tail_follow(true) when already at tail returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 9,
				feedViewportStart: 6,
				tailFollow: true,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'set_tail_follow', tailFollow: true},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('move_todo_cursor at top boundary returns same reference', () => {
			const ctx = makeContext({todoVisibleCount: 5, todoFocusable: true});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 9,
				feedViewportStart: 6,
				todoCursor: 0,
				todoCursorMode: 'manual',
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_todo_cursor', delta: -1},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('move_todo_cursor at bottom boundary returns same reference', () => {
			const ctx = makeContext({todoVisibleCount: 5, todoFocusable: true});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 9,
				feedViewportStart: 6,
				todoCursor: 4,
				todoCursorMode: 'manual',
			};
			const result = reduceSessionUiState(
				state,
				{type: 'move_todo_cursor', delta: 1},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('set_feed_cursor to current position returns same reference', () => {
			const ctx = makeContext({feedEntryCount: 10, feedContentRows: 4});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 5,
				feedViewportStart: 3,
				tailFollow: false,
			};
			const result = reduceSessionUiState(
				state,
				{type: 'set_feed_cursor', cursor: 5},
				ctx,
			);
			expect(result).toBe(state);
		});

		it('set_todo_cursor to current position returns same reference', () => {
			const ctx = makeContext({todoVisibleCount: 5, todoFocusable: true});
			const state: SessionUiState = {
				...initialSessionUiState,
				feedCursor: 9,
				feedViewportStart: 6,
				todoCursor: 2,
				todoCursorMode: 'manual',
			};
			const result = reduceSessionUiState(
				state,
				{type: 'set_todo_cursor', cursor: 2},
				ctx,
			);
			expect(result).toBe(state);
		});
	});
});
