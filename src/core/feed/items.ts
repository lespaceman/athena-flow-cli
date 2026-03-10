import type {Message} from '../../shared/types/common';
import type {FeedEvent} from './types';
import {shouldExcludeFromFeed} from './filter';

export type FeedItem =
	| {type: 'message'; data: Message}
	| {type: 'feed'; data: FeedEvent};

/** Merge messages and feed events into a single sorted list by seq. */
export function mergeFeedItems(
	messages: Message[],
	feedEvents: FeedEvent[],
): FeedItem[] {
	const messageItems: FeedItem[] = messages.map(message => ({
		type: 'message',
		data: message,
	}));
	const feedItems: FeedItem[] = feedEvents
		.filter(event => !shouldExcludeFromFeed(event))
		.map(event => ({type: 'feed', data: event}));

	return [...messageItems, ...feedItems].sort((left, right) => {
		if (left.data.seq !== right.data.seq) return left.data.seq - right.data.seq;
		// Tie-break: messages before feed events at same seq
		if (left.type === 'message' && right.type !== 'message') return -1;
		if (left.type !== 'message' && right.type === 'message') return 1;
		return 0;
	});
}

/** Build a lookup index: tool_use_id → latest delta/post/failure FeedEvent. */
export function buildPostByToolUseId(
	events: FeedEvent[],
): Map<string, FeedEvent> {
	const map = new Map<string, FeedEvent>();
	for (const event of events) {
		if (
			event.kind !== 'tool.delta' &&
			event.kind !== 'tool.post' &&
			event.kind !== 'tool.failure'
		) {
			continue;
		}
		const toolUseId = event.data.tool_use_id;
		if (toolUseId) map.set(toolUseId, event);
	}
	return map;
}
