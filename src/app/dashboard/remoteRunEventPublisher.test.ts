import {describe, expect, it, vi} from 'vitest';
import type {RunStreamClient} from './runStreamClient';
import {createRemoteRunEventPublisher} from './remoteRunEventPublisher';

describe('RemoteRunEventPublisher', () => {
	it('falls back to legacy run_event when the per-run stream cannot connect', async () => {
		const sentLegacy: unknown[] = [];
		const close = vi.fn(async () => {});
		const publisher = await createRemoteRunEventPublisher({
			runId: 'run-1',
			callbackWsUrl: 'wss://dashboard.test/run-1',
			callbackToken: 'token',
			client: {sendRunEvent: frame => sentLegacy.push(frame)},
			createRunStreamClient: () =>
				({
					connect: async () => {
						throw new Error('offline');
					},
					sendEvent: vi.fn(),
					whenTerminated: async () => {},
					close,
				}) satisfies RunStreamClient,
		});

		publisher.publish('progress', {message: 'hello'}, 1234);

		expect(sentLegacy).toEqual([
			{
				runId: 'run-1',
				seq: 1,
				ts: 1234,
				kind: 'progress',
				payload: {message: 'hello'},
			},
		]);
		expect(close).not.toHaveBeenCalled();
		await publisher.close();
	});
});
