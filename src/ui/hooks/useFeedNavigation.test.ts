/** @vitest-environment jsdom */
import {act, renderHook} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {
	useFeedNavigation,
	type UseFeedNavigationOptions,
} from './useFeedNavigation';
import {type TimelineEntry} from '../../core/feed/timeline';

function makeEntry(id: string): TimelineEntry {
	return {
		id,
		ts: 1000,
		op: 'Tool Call',
		opTag: 'tool.call',
		actor: 'root',
		actorId: 'agent:root',
		toolColumn: '',
		summary: '',
		summarySegments: [],
		searchText: '',
		error: false,
		expandable: false,
		details: '',
		duplicateActor: false,
	};
}

function makeEntries(count: number): TimelineEntry[] {
	return Array.from({length: count}, (_, index) => makeEntry(`e${index + 1}`));
}

describe('useFeedNavigation', () => {
	it('tracks appended entries in tail-follow mode without a second corrective render', () => {
		let renders = 0;
		const initialProps: UseFeedNavigationOptions = {
			filteredEntries: makeEntries(3),
			feedContentRows: 2,
		};
		const {result, rerender} = renderHook((props: UseFeedNavigationOptions) => {
			renders += 1;
			return useFeedNavigation(props);
		}, {initialProps});

		expect(result.current.tailFollow).toBe(true);
		expect(result.current.feedCursor).toBe(2);
		expect(renders).toBe(1);

		rerender({
			filteredEntries: makeEntries(4),
			feedContentRows: 2,
		});

		expect(result.current.tailFollow).toBe(true);
		expect(result.current.feedCursor).toBe(3);
		expect(renders).toBe(2);
	});

	it('preserves the live tail position when tail-follow is turned off', () => {
		const {result, rerender} = renderHook(
			(props: UseFeedNavigationOptions) => useFeedNavigation(props),
			{
				initialProps: {
					filteredEntries: makeEntries(3),
					feedContentRows: 2,
				},
			},
		);

		rerender({
			filteredEntries: makeEntries(5),
			feedContentRows: 2,
		});
		expect(result.current.feedCursor).toBe(4);

		act(() => {
			result.current.setTailFollow(false);
		});

		expect(result.current.tailFollow).toBe(false);
		expect(result.current.feedCursor).toBe(4);
	});

	it('moves off the tail in a single navigation update', () => {
		const {result} = renderHook(() =>
			useFeedNavigation({
				filteredEntries: makeEntries(5),
				feedContentRows: 3,
			}),
		);

		act(() => {
			result.current.moveFeedCursor(-1);
		});

		expect(result.current.tailFollow).toBe(false);
		expect(result.current.feedCursor).toBe(3);
		expect(result.current.feedViewportStart).toBe(2);
	});

	it('keeps the viewport anchored until the cursor leaves the visible window', () => {
		const {result} = renderHook(() =>
			useFeedNavigation({
				filteredEntries: makeEntries(10),
				feedContentRows: 4,
			}),
		);

		act(() => {
			result.current.jumpToTop();
		});
		expect(result.current.feedViewportStart).toBe(0);
		expect(result.current.feedCursor).toBe(0);

		act(() => {
			result.current.moveFeedCursor(1);
			result.current.moveFeedCursor(1);
			result.current.moveFeedCursor(1);
		});

		expect(result.current.feedCursor).toBe(3);
		expect(result.current.feedViewportStart).toBe(0);

		act(() => {
			result.current.moveFeedCursor(1);
		});

		expect(result.current.feedCursor).toBe(4);
		expect(result.current.feedViewportStart).toBe(1);
	});

	it('treats explicit cursor jumps as leaving tail-follow mode', () => {
		const {result} = renderHook(() =>
			useFeedNavigation({
				filteredEntries: makeEntries(8),
				feedContentRows: 4,
			}),
		);

		act(() => {
			result.current.setFeedCursor(2);
		});

		expect(result.current.tailFollow).toBe(false);
		expect(result.current.feedCursor).toBe(2);
		expect(result.current.feedViewportStart).toBe(2);
	});
});
