import {describe, expect, it, vi} from 'vitest';

import {SessionBridge} from './sessionBridge';
import type {ControlClient} from './gatewayControlClient';

function makeFakeClient(
	captured: Array<{kind: string; payload: unknown}>,
): ControlClient {
	return {
		request: async (kind, payload) => {
			captured.push({kind, payload});
			if (kind === 'session.register') {
				return {registeredAt: 1, gatewayStartedAt: 0} as never;
			}
			if (kind === 'session.run.event') {
				return {} as never;
			}
			return {} as never;
		},
		onPush: () => () => {},
		onClose: () => () => {},
		close: () => {},
	};
}

describe('SessionBridge.sendRunEvent', () => {
	it('issues a session.run.event request carrying the runtime id and event fields', async () => {
		const captured: Array<{kind: string; payload: unknown}> = [];
		const bridge = new SessionBridge({
			runtimeId: 'rt-1',
			defaultAgentId: 'main',
			endpoint: {mode: 'remote', url: 'ws://unused', token: 't'},
			connectClient: async () => makeFakeClient(captured),
		});
		await bridge.start();

		await bridge.sendRunEvent({
			location: {channelId: 'runner:r1', accountId: 'runner:r1'},
			runId: 'run-1',
			seq: 7,
			ts: 12345,
			kind: 'progress',
			payload: {message: 'hello'},
		});

		const runEvent = captured.find(c => c.kind === 'session.run.event');
		expect(runEvent).toBeDefined();
		expect(runEvent!.payload).toEqual({
			runtimeId: 'rt-1',
			location: {channelId: 'runner:r1', accountId: 'runner:r1'},
			runId: 'run-1',
			seq: 7,
			ts: 12345,
			kind: 'progress',
			payload: {message: 'hello'},
		});
	});

	it('omits payload when not provided', async () => {
		const captured: Array<{kind: string; payload: unknown}> = [];
		const bridge = new SessionBridge({
			runtimeId: 'rt-2',
			defaultAgentId: 'main',
			endpoint: {mode: 'remote', url: 'ws://unused', token: 't'},
			connectClient: async () => makeFakeClient(captured),
		});
		await bridge.start();

		await bridge.sendRunEvent({
			location: {channelId: 'runner:r1', accountId: 'runner:r1'},
			runId: 'run-2',
			seq: 1,
			ts: 1,
			kind: 'completion',
		});

		const runEvent = captured.find(c => c.kind === 'session.run.event');
		expect(runEvent!.payload).toEqual({
			runtimeId: 'rt-2',
			location: {channelId: 'runner:r1', accountId: 'runner:r1'},
			runId: 'run-2',
			seq: 1,
			ts: 1,
			kind: 'completion',
		});
	});

	it('throws when the bridge has not started', async () => {
		const bridge = new SessionBridge({
			runtimeId: 'rt-3',
			defaultAgentId: 'main',
			endpoint: {mode: 'remote', url: 'ws://unused', token: 't'},
			connectClient: vi.fn(),
		});
		await expect(
			bridge.sendRunEvent({
				location: {channelId: 'runner:r1', accountId: 'runner:r1'},
				runId: 'r',
				seq: 1,
				ts: 0,
				kind: 'progress',
			}),
		).rejects.toThrow(/not started/);
	});
});
