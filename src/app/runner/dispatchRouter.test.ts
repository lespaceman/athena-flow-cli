import {describe, expect, it, vi} from 'vitest';

import {makeDispatchRouter} from './dispatchRouter';
import type {RunnerSession} from './runnerSession';

const baseLocation = {channelId: 'runner:r1', accountId: 'runner:r1'};

function makePayload(text: string, dispatchId = 'd-1') {
	return {
		dispatchId,
		sessionKey: 'k',
		agentId: 'main',
		inbound: {
			location: baseLocation,
			sender: {id: 's'},
			text,
			receivedAt: 1,
			idempotencyKey: dispatchId,
			providerMessageId: dispatchId,
		},
	};
}

describe('makeDispatchRouter', () => {
	it('routes a recognised runner envelope to the runner session and skips fallback', () => {
		const handle = vi.fn(() => ({
			recognised: true,
			completed: Promise.resolve(),
		}));
		const session: RunnerSession = {handleDispatch: handle};
		const fallback = vi.fn();

		const router = makeDispatchRouter({runnerSession: session, fallback});
		router(
			makePayload(
				JSON.stringify({
					kind: 'job_assignment',
					runId: 'r',
					runSpec: {prompt: 'go'},
				}),
			),
		);

		expect(handle).toHaveBeenCalledTimes(1);
		expect(fallback).not.toHaveBeenCalled();
	});

	it('passes plain chat text through to the fallback', () => {
		const handle = vi.fn(() => ({
			recognised: false,
			completed: Promise.resolve(),
		}));
		const session: RunnerSession = {handleDispatch: handle};
		const fallback = vi.fn();

		const router = makeDispatchRouter({runnerSession: session, fallback});
		const payload = makePayload('hello');
		router(payload);

		expect(handle).toHaveBeenCalledTimes(1);
		expect(fallback).toHaveBeenCalledWith(payload);
	});

	it('falls through to fallback when no runner session is configured', () => {
		const fallback = vi.fn();
		const router = makeDispatchRouter({runnerSession: null, fallback});
		const payload = makePayload(
			JSON.stringify({kind: 'job_assignment', runId: 'r'}),
		);
		router(payload);
		expect(fallback).toHaveBeenCalledWith(payload);
	});
});
