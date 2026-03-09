/** @vitest-environment jsdom */
import {describe, it, expect} from 'vitest';
import {renderHook} from '@testing-library/react';
import {mergeFeedItems, buildPostByToolUseId} from '../../core/feed/items';
import type {FeedEvent} from '../../core/feed/types';
import {getTimelineEntrySearchText, useTimeline} from './useTimeline';

function makeEvent(
	kind: FeedEvent['kind'],
	seq: number,
	data: Record<string, unknown>,
): FeedEvent {
	return {
		event_id: `evt-${seq}-${kind}`,
		seq,
		ts: 1_700_000_000_000 + seq,
		session_id: 's1',
		run_id: 's1:R1',
		kind,
		level: 'info',
		actor_id: 'agent:root',
		title: kind,
		data,
	} as FeedEvent;
}

describe('useTimeline', () => {
	it('reuses existing timeline entries when new feed items append', () => {
		const first = makeEvent('notification', 1, {message: 'first'});
		const initialEvents = [first];
		const {result, rerender} = renderHook(
			({feedEvents}: {feedEvents: FeedEvent[]}) =>
				useTimeline({
					feedItems: mergeFeedItems([], feedEvents),
					feedEvents,
					currentRun: null,
					searchQuery: '',
					postByToolUseId: buildPostByToolUseId(feedEvents),
					verbose: true,
				}),
			{
				initialProps: {feedEvents: initialEvents},
			},
		);

		const originalEntry = result.current.timelineEntries[0];
		const nextEvents = [
			...initialEvents,
			makeEvent('notification', 2, {message: 'second'}),
		];
		rerender({feedEvents: nextEvents});

		expect(result.current.timelineEntries).toHaveLength(2);
		expect(result.current.timelineEntries[0]).toBe(originalEntry);
	});

	it('patches an existing tool.pre row when the matching tool.post arrives', () => {
		const pre = makeEvent('tool.pre', 1, {
			tool_name: 'Bash',
			tool_input: {command: 'echo hi'},
			tool_use_id: 'tu-1',
		});
		const initialEvents = [pre];
		const {result, rerender} = renderHook(
			({feedEvents}: {feedEvents: FeedEvent[]}) =>
				useTimeline({
					feedItems: mergeFeedItems([], feedEvents),
					feedEvents,
					currentRun: null,
					searchQuery: '',
					postByToolUseId: buildPostByToolUseId(feedEvents),
					verbose: true,
				}),
			{
				initialProps: {feedEvents: initialEvents},
			},
		);

		expect(result.current.timelineEntries).toHaveLength(1);
		expect(result.current.timelineEntries[0]?.pairedPostEvent).toBeUndefined();

		const post = makeEvent('tool.post', 2, {
			tool_name: 'Bash',
			tool_input: {command: 'echo hi'},
			tool_use_id: 'tu-1',
			tool_response: 'ok',
		});
		rerender({feedEvents: [...initialEvents, post]});

		expect(result.current.timelineEntries).toHaveLength(1);
		expect(result.current.timelineEntries[0]?.pairedPostEvent).toBe(post);
		expect(result.current.timelineEntries[0]?.opTag).toBe('tool.ok');
	});

	it('materializes feed search text lazily from event details', () => {
		const event = makeEvent('tool.pre', 1, {
			tool_name: 'Bash',
			tool_input: {command: 'printf needle'},
			tool_use_id: 'tu-2',
		});
		const {result} = renderHook(() =>
			useTimeline({
				feedItems: mergeFeedItems([], [event]),
				feedEvents: [event],
				currentRun: null,
				searchQuery: '',
				postByToolUseId: buildPostByToolUseId([event]),
				verbose: true,
			}),
		);

		const entry = result.current.timelineEntries[0]!;
		expect(entry.details).toBe('');
		expect(getTimelineEntrySearchText(entry)).toContain('needle');
	});

	it('keeps notification entries visible when verbose is false', () => {
		const event = makeEvent('notification', 1, {
			message: 'Athena failed to start Claude: spawn claude ENOENT',
			title: 'Claude Process Error',
		});
		const {result} = renderHook(() =>
			useTimeline({
				feedItems: mergeFeedItems([], [event]),
				feedEvents: [event],
				currentRun: null,
				searchQuery: '',
				postByToolUseId: buildPostByToolUseId([event]),
				verbose: false,
			}),
		);

		expect(result.current.timelineEntries).toHaveLength(1);
		expect(result.current.timelineEntries[0]?.opTag).toBe('notify');
		expect(result.current.timelineEntries[0]?.summary).toContain(
			'spawn claude ENOENT',
		);
	});
});
