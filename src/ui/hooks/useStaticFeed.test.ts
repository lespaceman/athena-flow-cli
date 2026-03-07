/**
 * @vitest-environment jsdom
 */
import {describe, it, expect} from 'vitest';
import {renderHook} from '@testing-library/react';
import {useStaticFeed, type UseStaticFeedOptions} from './useStaticFeed';
import {type TimelineEntry} from '../../core/feed/timeline';
import {type FeedEventBase} from '../../core/feed/types';

function base(overrides: Partial<FeedEventBase> = {}): FeedEventBase {
	return {
		event_id: 'e1',
		seq: 1,
		ts: 1000000,
		session_id: 's1',
		run_id: 'R1',
		kind: 'run.start',
		level: 'info',
		actor_id: 'agent:root',
		title: '',
		...overrides,
	};
}

function makeEntry(
	id: string,
	overrides: Partial<TimelineEntry> = {},
): TimelineEntry {
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
		...overrides,
	};
}

function stableToolEntry(id: string): TimelineEntry {
	return makeEntry(id, {
		feedEvent: {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Read', tool_input: {}},
		},
		pairedPostEvent: {
			...base({kind: 'tool.post'}),
			kind: 'tool.post' as const,
			data: {tool_name: 'Read', tool_input: {}, tool_response: {}},
		},
	});
}

function unstableToolEntry(id: string): TimelineEntry {
	return makeEntry(id, {
		feedEvent: {
			...base({kind: 'tool.pre'}),
			kind: 'tool.pre' as const,
			data: {tool_name: 'Read', tool_input: {}},
		},
	});
}

describe('useStaticFeed', () => {
	it('returns 0 initially with empty entries', () => {
		const {result} = renderHook(() =>
			useStaticFeed({
				filteredEntries: [],
				feedViewportStart: 0,
				tailFollow: true,
			}),
		);
		expect(result.current).toBe(0);
	});

	it('advances high-water mark for stable entries below viewport', () => {
		const entries = [
			stableToolEntry('e1'),
			stableToolEntry('e2'),
			stableToolEntry('e3'),
			unstableToolEntry('e4'),
		];
		const {result} = renderHook(() =>
			useStaticFeed({
				filteredEntries: entries,
				feedViewportStart: 3,
				tailFollow: true,
			}),
		);
		// e1, e2, e3 are stable and below viewport (indices 0,1,2 < 3)
		expect(result.current).toBe(3);
	});

	it('stops at unstable entry (no gaps)', () => {
		const entries = [
			stableToolEntry('e1'),
			unstableToolEntry('e2'),
			stableToolEntry('e3'),
		];
		const {result} = renderHook(() =>
			useStaticFeed({
				filteredEntries: entries,
				feedViewportStart: 3,
				tailFollow: true,
			}),
		);
		// Stops at e2 (index 1) because it's unstable
		expect(result.current).toBe(1);
	});

	it('does not advance when tailFollow is false', () => {
		const entries = [stableToolEntry('e1'), stableToolEntry('e2')];
		const {result} = renderHook(() =>
			useStaticFeed({
				filteredEntries: entries,
				feedViewportStart: 2,
				tailFollow: false,
			}),
		);
		expect(result.current).toBe(0);
	});

	it('does not advance past feedViewportStart', () => {
		const entries = [
			stableToolEntry('e1'),
			stableToolEntry('e2'),
			stableToolEntry('e3'),
		];
		const {result} = renderHook(() =>
			useStaticFeed({
				filteredEntries: entries,
				feedViewportStart: 1,
				tailFollow: true,
			}),
		);
		// Only e1 is below viewport
		expect(result.current).toBe(1);
	});

	it('high-water mark is monotonic across re-renders', () => {
		const entries = [
			stableToolEntry('e1'),
			stableToolEntry('e2'),
			stableToolEntry('e3'),
		];
		const initialProps: UseStaticFeedOptions = {
			filteredEntries: entries,
			feedViewportStart: 2,
			tailFollow: true,
		};
		const {result, rerender} = renderHook(
			(props: UseStaticFeedOptions) => useStaticFeed(props),
			{initialProps},
		);
		expect(result.current).toBe(2);

		// Re-render with feedViewportStart advanced further
		rerender({
			filteredEntries: entries,
			feedViewportStart: 3,
			tailFollow: true,
		});
		expect(result.current).toBe(3);
	});

	it('treats entries without feedEvent as stable', () => {
		const entries = [
			makeEntry('msg1'), // no feedEvent = message, always stable
			stableToolEntry('e2'),
		];
		const {result} = renderHook(() =>
			useStaticFeed({
				filteredEntries: entries,
				feedViewportStart: 2,
				tailFollow: true,
			}),
		);
		expect(result.current).toBe(2);
	});

	it('returns same value when new entries arrive but HWM cannot advance', () => {
		const initialEntries = [
			stableToolEntry('e1'),
			stableToolEntry('e2'),
			unstableToolEntry('e3'), // blocks HWM advancement
		];
		const initialProps: UseStaticFeedOptions = {
			filteredEntries: initialEntries,
			feedViewportStart: 2,
			tailFollow: true,
		};
		const {result, rerender} = renderHook(
			(props: UseStaticFeedOptions) => useStaticFeed(props),
			{initialProps},
		);
		expect(result.current).toBe(2);

		// Append new entry — HWM should not advance (e3 still unstable)
		const updatedEntries = [...initialEntries, stableToolEntry('e4')];
		rerender({
			filteredEntries: updatedEntries,
			feedViewportStart: 3,
			tailFollow: true,
		});
		// HWM stays at 2 because e3 (index 2) is still unstable
		expect(result.current).toBe(2);
	});

	it('advances HWM when previously unstable entry becomes stable', () => {
		const unstableE2 = unstableToolEntry('e2');
		const entries = [stableToolEntry('e1'), unstableE2];
		const initialProps: UseStaticFeedOptions = {
			filteredEntries: entries,
			feedViewportStart: 2,
			tailFollow: true,
		};
		const {result, rerender} = renderHook(
			(props: UseStaticFeedOptions) => useStaticFeed(props),
			{initialProps},
		);
		// Blocked at e2
		expect(result.current).toBe(1);

		// e2 now has a paired post event — becomes stable
		const stableE2 = stableToolEntry('e2');
		rerender({
			filteredEntries: [stableToolEntry('e1'), stableE2, stableToolEntry('e3')],
			feedViewportStart: 3,
			tailFollow: true,
		});
		expect(result.current).toBe(3);
	});

	it('does not advance on stability-only rerenders while the viewport is stationary', () => {
		const initialProps: UseStaticFeedOptions = {
			filteredEntries: [stableToolEntry('e1'), unstableToolEntry('e2')],
			feedViewportStart: 2,
			tailFollow: true,
		};
		const {result, rerender} = renderHook(
			(props: UseStaticFeedOptions) => useStaticFeed(props),
			{initialProps},
		);
		expect(result.current).toBe(1);

		rerender({
			filteredEntries: [stableToolEntry('e1'), stableToolEntry('e2')],
			feedViewportStart: 2,
			tailFollow: true,
		});

		expect(result.current).toBe(1);
	});

	it('flushes newly stable rows once the viewport advances again', () => {
		const initialProps: UseStaticFeedOptions = {
			filteredEntries: [stableToolEntry('e1'), unstableToolEntry('e2')],
			feedViewportStart: 2,
			tailFollow: true,
		};
		const {result, rerender} = renderHook(
			(props: UseStaticFeedOptions) => useStaticFeed(props),
			{initialProps},
		);
		expect(result.current).toBe(1);

		rerender({
			filteredEntries: [
				stableToolEntry('e1'),
				stableToolEntry('e2'),
				stableToolEntry('e3'),
			],
			feedViewportStart: 2,
			tailFollow: true,
		});
		expect(result.current).toBe(1);

		rerender({
			filteredEntries: [
				stableToolEntry('e1'),
				stableToolEntry('e2'),
				stableToolEntry('e3'),
				stableToolEntry('e4'),
			],
			feedViewportStart: 3,
			tailFollow: true,
		});
		expect(result.current).toBe(3);
	});

	it('batches static flushes for large feeds to avoid one-row churn', () => {
		const largeEntries = Array.from({length: 80}, (_, index) =>
			stableToolEntry(`e${index + 1}`),
		);
		const {result, rerender} = renderHook(
			(props: UseStaticFeedOptions) => useStaticFeed(props),
			{
				initialProps: {
					filteredEntries: largeEntries,
					feedViewportStart: 10,
					tailFollow: true,
				},
			},
		);

		expect(result.current).toBe(8);

		rerender({
			filteredEntries: largeEntries,
			feedViewportStart: 11,
			tailFollow: true,
		});
		expect(result.current).toBe(8);

		rerender({
			filteredEntries: largeEntries,
			feedViewportStart: 14,
			tailFollow: true,
		});
		expect(result.current).toBe(8);

		rerender({
			filteredEntries: largeEntries,
			feedViewportStart: 16,
			tailFollow: true,
		});
		expect(result.current).toBe(14);
	});

	it('clamps the high-water mark when the filtered feed shrinks', () => {
		const {result, rerender} = renderHook(
			(props: UseStaticFeedOptions) => useStaticFeed(props),
			{
				initialProps: {
					filteredEntries: [
						stableToolEntry('e1'),
						stableToolEntry('e2'),
						stableToolEntry('e3'),
					],
					feedViewportStart: 2,
					tailFollow: true,
				},
			},
		);

		expect(result.current).toBe(2);

		rerender({
			filteredEntries: [stableToolEntry('e1')],
			feedViewportStart: 0,
			tailFollow: true,
		});

		expect(result.current).toBe(0);
	});
});
