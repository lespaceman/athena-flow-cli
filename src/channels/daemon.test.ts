import {describe, expect, it} from 'vitest';
import {
	CHANNEL_BROADCAST_SESSION_ID,
	expandBroadcastEvent,
	fanoutEventToSessions,
} from './daemon';
import type {ChannelEventMessage} from './types';

describe('daemon event fanout', () => {
	it('rewrites channel broadcast events to each attached session', () => {
		const event: ChannelEventMessage = {
			session_id: CHANNEL_BROADCAST_SESSION_ID,
			event: 'chat.message',
			params: {content: 'hello', meta: {sender_id: '123'}},
		};

		expect(expandBroadcastEvent(event, ['session-a', 'session-b'])).toEqual([
			{
				session_id: 'session-a',
				event: 'chat.message',
				params: {content: 'hello', meta: {sender_id: '123'}},
			},
			{
				session_id: 'session-b',
				event: 'chat.message',
				params: {content: 'hello', meta: {sender_id: '123'}},
			},
		]);
	});

	it('leaves session-scoped channel events targeted to their session', () => {
		const event: ChannelEventMessage = {
			session_id: 'session-a',
			event: 'ready',
			params: {name: 'telegram', version: '1'},
		};

		expect(expandBroadcastEvent(event, ['session-a', 'session-b'])).toEqual([
			event,
		]);
	});

	it('rewrites daemon-level events to every attached session', () => {
		const event: ChannelEventMessage = {
			session_id: 'first-session',
			event: 'error',
			params: {message: 'channel subprocess exited', fatal: true},
		};

		expect(fanoutEventToSessions(event, ['session-a', 'session-b'])).toEqual([
			{
				session_id: 'session-a',
				event: 'error',
				params: {message: 'channel subprocess exited', fatal: true},
			},
			{
				session_id: 'session-b',
				event: 'error',
				params: {message: 'channel subprocess exited', fatal: true},
			},
		]);
	});
});
