import {describe, expect, it, vi} from 'vitest';
import {
	createDashboardPairedExecution,
	type DashboardPairedExecutionExecutor,
} from './dashboardPairedExecution';
import type {
	InstanceSocketClient,
	InstanceSocketFrame,
} from './instanceSocketClient';

function makeClient() {
	const runEvents: unknown[] = [];
	const decisionAcks: unknown[] = [];
	const client = {
		sendRunEvent: frame => runEvents.push(frame),
		sendDecisionAck: frame => decisionAcks.push(frame),
	} as Pick<InstanceSocketClient, 'sendRunEvent' | 'sendDecisionAck'>;
	return {client, runEvents, decisionAcks};
}

function makeDecisionInbox() {
	return {
		enqueue: vi.fn(),
		pendingForSession: vi.fn(() => []),
		markConsumed: vi.fn(),
		close: vi.fn(),
	};
}

describe('DashboardPairedExecution', () => {
	it('accepts an assignment and forwards env plus the decision inbox to the executor', async () => {
		const {client} = makeClient();
		const decisionInbox = makeDecisionInbox();
		const executor = vi.fn(async () => {}) as DashboardPairedExecutionExecutor;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox,
			now: () => 100,
		});

		const frame: InstanceSocketFrame = {
			type: 'job_assignment',
			runId: 'run_1',
			runSpec: {prompt: 'hi', env: {FOO: 'bar'}},
		};
		expect(execution.handleFrame(frame)).toBe(true);
		await Promise.resolve();

		expect(executor).toHaveBeenCalledWith(
			expect.objectContaining({
				frame,
				projectDir: '/tmp/project',
				decisionInbox,
			}),
		);
		expect(execution.listRuns()).toEqual([
			expect.objectContaining({runId: 'run_1', status: 'completed'}),
		]);
	});

	it('rejects a duplicate active assignment', async () => {
		const {client, runEvents} = makeClient();
		let resolveFirst: () => void = () => {};
		const executor = vi.fn(
			async () =>
				new Promise<void>(resolve => {
					resolveFirst = resolve;
				}),
		) as DashboardPairedExecutionExecutor;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
			now: () => 100,
		});

		const frame: InstanceSocketFrame = {
			type: 'job_assignment',
			runId: 'run_dup',
			runSpec: {prompt: 'hi'},
		};
		execution.handleFrame(frame);
		execution.handleFrame(frame);
		await Promise.resolve();

		expect(executor).toHaveBeenCalledTimes(1);
		expect(runEvents).toContainEqual(
			expect.objectContaining({
				runId: 'run_dup',
				kind: 'rejected',
				payload: expect.objectContaining({
					reason: expect.stringContaining('duplicate'),
				}),
			}),
		);
		resolveFirst();
		await execution.stop();
	});

	it('rejects assignments when the runner capacity is full', async () => {
		const {client, runEvents} = makeClient();
		let resolveFirst: () => void = () => {};
		const executor = vi.fn(
			async () =>
				new Promise<void>(resolve => {
					resolveFirst = resolve;
				}),
		) as DashboardPairedExecutionExecutor;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
			maxConcurrentRuns: 1,
			now: () => 100,
		});

		execution.handleFrame({
			type: 'job_assignment',
			runId: 'run_a',
			runnerId: 'runner-1',
			runSpec: {prompt: 'a'},
		});
		execution.handleFrame({
			type: 'job_assignment',
			runId: 'run_b',
			runnerId: 'runner-1',
			runSpec: {prompt: 'b'},
		});
		await Promise.resolve();

		expect(executor).toHaveBeenCalledTimes(1);
		expect(runEvents).toContainEqual(
			expect.objectContaining({
				runId: 'run_b',
				kind: 'rejected',
				payload: expect.objectContaining({
					reason: expect.stringContaining('concurrency cap'),
				}),
			}),
		);
		resolveFirst();
		await execution.stop();
	});

	it('cancels an active run by runId', async () => {
		const {client} = makeClient();
		let seenSignal: AbortSignal | undefined;
		let resolveFirst: () => void = () => {};
		const executor = vi.fn(
			async input =>
				new Promise<void>(resolve => {
					seenSignal = input.abortSignal;
					resolveFirst = resolve;
				}),
		) as DashboardPairedExecutionExecutor;
		const execution = createDashboardPairedExecution({
			client,
			executor,
			projectDir: '/tmp/project',
			decisionInbox: makeDecisionInbox(),
		});

		execution.handleFrame({
			type: 'job_assignment',
			runId: 'run_cancel',
			runnerId: 'runner-1',
			runSpec: {prompt: 'a'},
		});
		await Promise.resolve();
		execution.handleFrame({type: 'cancel', runId: 'run_cancel'});

		expect(seenSignal?.aborted).toBe(true);
		expect(execution.listRuns()).toEqual([
			expect.objectContaining({runId: 'run_cancel', status: 'cancelled'}),
		]);
		resolveFirst();
		await execution.stop();
	});

	it('forwards dashboard decisions to the inbox', () => {
		const {client, decisionAcks} = makeClient();
		const decisionInbox = makeDecisionInbox();
		const execution = createDashboardPairedExecution({
			client,
			executor: vi.fn(async () => {}) as DashboardPairedExecutionExecutor,
			projectDir: '/tmp/project',
			decisionInbox,
			now: () => 555,
		});

		expect(
			execution.handleFrame({
				type: 'dashboard_decision',
				athenaSessionId: 'athena-1',
				requestId: 'req-1',
				decision: {
					type: 'json',
					source: 'user',
					intent: {kind: 'permission_allow'},
				},
			}),
		).toBe(true);

		expect(decisionInbox.enqueue).toHaveBeenCalledWith({
			athenaSessionId: 'athena-1',
			requestId: 'req-1',
			decision: {
				type: 'json',
				source: 'user',
				intent: {kind: 'permission_allow'},
			},
			receivedAt: 555,
		});
		expect(decisionAcks).toEqual([
			{athenaSessionId: 'athena-1', requestId: 'req-1'},
		]);
	});
});
