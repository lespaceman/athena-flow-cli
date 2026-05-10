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

	it('writes the local attachment mirror when an attachments.changed frame arrives', async () => {
		const fake = makeFakeSocket();
		const writeMirror = vi.fn();

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			reconnectDelaysMs: [],
			writeMirror,
			now: () => 4242,
		});

		fake.emitFrame({
			type: 'attachments.changed',
			attachments: [
				{
					runnerId: 'r1',
					name: 'laptop',
					executionTarget: 'local',
					remoteInstanceId: 'inst_1',
				},
				{runnerId: 'r2'},
			],
		});

		expect(writeMirror).toHaveBeenCalledTimes(1);
		expect(writeMirror).toHaveBeenCalledWith({
			instanceId: 'inst_1',
			fetchedAt: 4242,
			attachments: [
				{
					runnerId: 'r1',
					name: 'laptop',
					executionTarget: 'local',
					remoteInstanceId: 'inst_1',
				},
				{runnerId: 'r2'},
			],
		});

		await daemon.stop('test');
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

	it('rejects assignments over the concurrency cap', async () => {
		const fake = makeFakeSocket();
		let resolveFirst: () => void = () => {};
		const executor = vi.fn(async () => {
			await new Promise<void>(resolve => {
				resolveFirst = resolve;
			});
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			maxConcurrentRuns: 1,
		});

		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_1',
			runSpec: {prompt: 'first'},
		});
		await Promise.resolve();
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_2',
			runSpec: {prompt: 'second'},
		});
		await Promise.resolve();

		// Only the first ran; second was rejected via run_event.
		expect(executor).toHaveBeenCalledTimes(1);

		const runs = daemon.listRuns();
		expect(runs.find(r => r.runId === 'run_2')?.status).toBe('rejected');

		resolveFirst();
		await daemon.stop('test');
	});

	it('schedules a proactive refresh at expiresInSec - leadSec', async () => {
		vi.useFakeTimers();
		try {
			const fake = makeFakeSocket();
			const refresh = vi
				.fn()
				.mockResolvedValueOnce({
					instanceId: 'inst_1',
					accessToken: 'first',
					expiresInSec: 200,
				})
				.mockResolvedValueOnce({
					instanceId: 'inst_1',
					accessToken: 'second',
					expiresInSec: 200,
				});

			const daemon = await runDashboardRuntimeDaemon({
				readConfig: () => stored,
				refreshAccessToken: refresh,
				makeInstanceSocketClient: () => fake.client,
				executeRemoteAssignment: vi.fn(async () => {}),
				reconnectDelaysMs: [],
				refreshLeadSec: 60,
			});

			expect(refresh).toHaveBeenCalledTimes(1);
			// Lead = 60s, expires = 200s → fires at 140s.
			await vi.advanceTimersByTimeAsync(140_000);
			expect(refresh).toHaveBeenCalledTimes(2);

			await daemon.stop('test');
		} finally {
			vi.useRealTimers();
		}
	});

	it('exposes a snapshot for the UDS handler', async () => {
		const fake = makeFakeSocket();
		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			reconnectDelaysMs: [],
		});
		const snap = daemon.snapshot();
		expect(snap).toMatchObject({
			socketConnected: true,
			activeRuns: 0,
			completedRuns: 0,
			instanceId: 'inst_1',
			dashboardUrl: 'https://example.com',
		});
		await daemon.stop('test');
	});

	it('exposes refresh circuit-breaker state in the snapshot', async () => {
		const fake = makeFakeSocket();
		// First call succeeds (initial connect). Subsequent refreshes fail and
		// trip the breaker after refreshFailureLimit consecutive failures.
		let calls = 0;
		const refresh = vi.fn(async () => {
			calls += 1;
			if (calls === 1) {
				return {
					instanceId: 'inst_1',
					accessToken: 'a',
					expiresInSec: 900,
				};
			}
			throw new Error('refresh denied');
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: refresh,
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(async () => {}),
			// Small but non-zero so the reconnect loop yields between attempts.
			reconnectDelaysMs: [5],
			refreshFailureLimit: 3,
			refreshFailureWindowMs: 60_000,
			refreshCooldownMs: 60_000,
		});

		// Trigger reconnects so refresh fires repeatedly.
		fake.emitClose('test');
		await vi.waitFor(
			() => {
				const snap = daemon.snapshot();
				expect(snap.refreshState?.cooldownUntilMs).toBeGreaterThan(0);
			},
			{timeout: 2_000, interval: 25},
		);

		// Stop before the test ends so the cooldown sleep doesn't keep node alive.
		await daemon.stop('test');
	});

	it('logs a warning when sendRunEvent fails during rejection', async () => {
		const fake = makeFakeSocket();
		// Patch the shared client factory's sendRunEvent to throw.
		fake.client.sendRunEvent = (() => {
			throw new Error('send failed');
		}) as InstanceSocketClient['sendRunEvent'];

		const logs: Array<{level: string; message: string}> = [];
		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: vi.fn(
				async (input: {abortSignal?: AbortSignal}) => {
					await new Promise<void>(resolve => {
						input.abortSignal?.addEventListener('abort', () => resolve());
					});
				},
			),
			reconnectDelaysMs: [],
			maxConcurrentRuns: 1,
			log: (level, message) => logs.push({level, message}),
		});

		// First fills the cap.
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_1',
			runSpec: {prompt: 'first'},
		});
		await Promise.resolve();
		// Second is rejected — sendRunEvent throws and must be logged.
		fake.emitFrame({
			type: 'job_assignment',
			runId: 'run_2',
			runSpec: {prompt: 'second'},
		});
		await Promise.resolve();

		expect(
			logs.some(
				l =>
					l.level === 'warn' &&
					l.message.includes('failed to send rejected for run_2'),
			),
		).toBe(true);

		await daemon.stop('test');
	});

	it('listRuns applies limit before active filter', async () => {
		const fake = makeFakeSocket();
		const executors: Array<() => void> = [];
		const executor = vi.fn(async () => {
			await new Promise<void>(resolve => executors.push(resolve));
		});

		const daemon = await runDashboardRuntimeDaemon({
			readConfig: () => stored,
			refreshAccessToken: async () => ({
				instanceId: 'inst_1',
				accessToken: 'a',
				expiresInSec: 900,
			}),
			makeInstanceSocketClient: () => fake.client,
			executeRemoteAssignment: executor,
			reconnectDelaysMs: [],
			maxConcurrentRuns: 5,
		});

		// Start 3 runs, complete the first.
		for (let i = 0; i < 3; i += 1) {
			fake.emitFrame({
				type: 'job_assignment',
				runId: `run_${i}`,
				runSpec: {prompt: 'x'},
			});
		}
		await Promise.resolve();
		executors[0]?.(); // resolve run_0 → completed
		await Promise.resolve();
		await Promise.resolve();

		// Limit 2 → last 2 records (run_1, run_2). With active filter, both run_1
		// and run_2 are still running, so we get 2.
		const limited = daemon.listRuns({active: true, limit: 2});
		expect(limited).toHaveLength(2);
		expect(limited.map(r => r.runId)).toEqual(['run_1', 'run_2']);

		// Resolve the rest so stop can drain.
		for (const resolve of executors) resolve();
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
