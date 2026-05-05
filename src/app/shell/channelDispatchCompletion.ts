import type {FeedEvent} from '../../core/feed/types';

export function findChannelDispatchReply(
	feedEvents: FeedEvent[],
	afterFeedEventCount: number,
): Extract<FeedEvent, {kind: 'agent.message'}> | undefined {
	return feedEvents
		.slice(afterFeedEventCount)
		.reverse()
		.find(
			(fe): fe is Extract<FeedEvent, {kind: 'agent.message'}> =>
				fe.kind === 'agent.message' && fe.data.scope === 'root',
		);
}
