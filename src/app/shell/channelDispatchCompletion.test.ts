import {describe, expect, it} from 'vitest';
import type {FeedEvent} from '../../core/feed/types';
import {findChannelDispatchReply} from './channelDispatchCompletion';

function agentMessage(message: string, seq: number): FeedEvent {
	return {
		event_id: `event-${seq}`,
		seq,
		ts: seq,
		session_id: 'session-1',
		run_id: 'run-1',
		kind: 'agent.message',
		level: 'info',
		actor_id: 'agent:root',
		title: 'Agent',
		data: {
			message,
			source: 'hook',
			scope: 'root',
		},
	};
}

describe('findChannelDispatchReply', () => {
	it('ignores agent messages that existed before the dispatch was parked', () => {
		const events = [
			agentMessage('previous answer', 1),
			agentMessage('new answer', 2),
		];

		expect(findChannelDispatchReply(events, 1)?.data.message).toBe(
			'new answer',
		);
	});

	it('returns no reply when only pre-dispatch agent messages exist', () => {
		expect(
			findChannelDispatchReply([agentMessage('previous answer', 1)], 1),
		).toBe(undefined);
	});
});
