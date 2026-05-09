import {describe, expect, it, vi} from 'vitest';
import {runDashboardRuntimeDaemon} from './runtimeDaemon';
import type {
	InstanceSocketClient,
	InstanceSocketFrame,
} from './instanceSocketClient';
import type {DashboardClientConfig} from '../../infra/config/dashboardClient';

function makeFakeSocket() {
	const frameHandlers: Array<(frame: InstanceSocketFrame) => void> = [];
	const closeHandlers: Array<(reason: string) => void> = [];
	const calls = {connect: 0, close: [] as string[]};
	const client: InstanceSocketClient = {
		connect: async () => {
			calls.connect += 1;
		},
		close: (reason?: string) => calls.close.push(reason ?? ''),
		onFrame: handler => {
			frameHandlers.push(handler);
		},
		onClose: handler => {
			closeHandlers.push(handler);
		},
		sendRunEvent: () => {},
	};
	return {
		client,
		calls,
		emitFrame: (frame: InstanceSocketFrame) => {
			for (const handler of frameHandlers) handler(frame);
		},
		emitClose: (reason: string) => {
			for (const handler of closeHandlers) handler(reason);
		},
	};
}

const stored: DashboardClientConfig = {
	dashboardUrl: 'https://example.com',
	instanceId: 'inst_1',
	refreshToken: 'refresh',
	fingerprint: 'fp',
	pairedAt: 1,
};

describe('runDashboardRuntimeDaemon', () => {
	it('connects with a refreshed token and executes each assignment once', async () => {
		const fake = makeFakeSocket();
		const executor = vi.fn(async () => {});

		const stop = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'access_1',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: opts => {
				expect(opts).toMatchObject({
					dashboardUrl: 'https://example.com',
					instanceId: 'inst_1',
					accessToken: 'access_1',
				});
				return fake.client;
			},
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
		});

		const frame: InstanceSocketFrame = {
			type: 'job_assignment',
			runId: 'run_1',
			runSpec: {prompt: 'hi'},
		};
		fake.emitFrame(frame);
		fake.emitFrame(frame);
		await Promise.resolve();

		expect(fake.calls.connect).toBe(1);
		expect(executor).toHaveBeenCalledTimes(1);
		expect(executor.mock.calls[0]![0]).toMatchObject({frame});

		await stop.stop('test');
	});

	it('aborts an active assignment when a cancel frame arrives', async () => {
		const fake = makeFakeSocket();
		let seenSignal: AbortSignal | undefined;
		let resolveExecutor: () => void = () => {};
		const executor = vi.fn(async input => {
			seenSignal = input.abortSignal;
			await new Promise<void>(resolve => {
				resolveExecutor = resolve;
			});
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'access_1',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
		});

		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_cancel',
			runSpec: {prompt: 'hi'},
		});
		await Promise.resolve();
		expect(seenSignal?.aborted).toBe(false);

		fake.emitFrame({type: 'cancel', runId: 'run_cancel'});
		expect(seenSignal?.aborted).toBe(true);
		resolveExecutor();
		await daemon.stop('test');
	});

	it('reconnects after an unsolicited socket close', async () => {
		const first = makeFakeSocket();
		const second = makeFakeSocket();
		const sockets = [first.client, second.client];
		const refreshAccessToken = vi
			.fn()
			.mockResolvedValueOnce({
				instanceId: 'inst_1',
				accessToken: 'access_1',
				expiresInSec: 900,
			})
			.mockResolvedValueOnce({
				instanceId: 'inst_1',
				accessToken: 'access_2',
				expiresInSec: 900,
			});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken,
			makeInstanceSocketClient: () => sockets.shift() ?? second.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			reconnectDelaysMs: [0],
		});

		first.emitClose('network dropped');
		await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledTimes(2));
		expect(first.calls.connect).toBe(1);
		expect(second.calls.connect).toBe(1);

		await daemon.stop('test');
	});
});
