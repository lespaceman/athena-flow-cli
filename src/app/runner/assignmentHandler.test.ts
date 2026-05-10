import {describe, expect, it, vi} from 'vitest';

import type {ExecRunOptions} from '../exec/types';
import {executeAssignment} from './assignmentHandler';

type Captured = {
	runEvents: Array<{
		runId: string;
		seq: number;
		ts: number;
		kind: string;
		payload?: unknown;
	}>;
	completes: Array<{
		dispatchId: string;
		idempotencyKey: string;
		envelope: Record<string, unknown>;
	}>;
};

function makeBridge(captured: Captured) {
	return {
		sendRunEvent: vi.fn(async input => {
			captured.runEvents.push(input);
		}),
		completeTurn: vi.fn(async input => {
			captured.completes.push({
				dispatchId: input.dispatchId,
				idempotencyKey: input.idempotencyKey,
				envelope: JSON.parse(input.text) as Record<string, unknown>,
			});
			return {delivered: true};
		}),
	};
}

const baseRuntimeConfig = () => ({
	globalConfig: {
		plugins: [],
		additionalDirectories: [],
		workflowMarketplaceSources: [],
		workflowSelections: {},
	},
	projectConfig: {
		plugins: [],
		additionalDirectories: [],
		workflowMarketplaceSources: [],
		workflowSelections: {},
	},
	harness: 'openai-codex' as const,
	isolationConfig: {preset: 'minimal' as const, additionalDirectories: []},
	workflowRef: undefined,
	workflow: undefined,
	workflowPlan: undefined,
	modelName: null,
	warnings: [],
});

const baseLocation = {channelId: 'runner:r1', accountId: 'runner:r1'};

describe('executeAssignment', () => {
	it('streams progress via sendRunEvent and completes the dispatch with a terminal run_event envelope', async () => {
		const captured: Captured = {runEvents: [], completes: []};
		const bridge = makeBridge(captured);
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			options.stdout?.write(
				JSON.stringify({
					type: 'exec.started',
					ts: 100,
					data: {athenaSessionId: options.athenaSessionId},
				}) + '\n',
			);
			options.stdout?.write(
				JSON.stringify({
					type: 'exec.completed',
					ts: 101,
					data: {success: true, exitCode: 0, finalMessage: 'done'},
				}) + '\n',
			);
			return {
				success: true,
				exitCode: 0,
				athenaSessionId: options.athenaSessionId ?? null,
				adapterSessionId: null,
				finalMessage: 'done',
				tokens: {
					input: null,
					output: null,
					cacheRead: null,
					cacheWrite: null,
					total: null,
					contextSize: null,
					contextWindowSize: null,
				},
				durationMs: 1,
			};
		});

		await executeAssignment({
			envelope: {
				kind: 'job_assignment',
				runId: 'run_42',
				runSpec: {prompt: 'say hello', sessionId: 'athena-run_42'},
			},
			bridge,
			dispatchId: 'dispatch-1',
			location: baseLocation,
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn: baseRuntimeConfig,
			now: () => 999,
		});

		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'say hello',
				projectDir: '/tmp/project',
				athenaSessionId: 'athena-run_42',
				json: true,
			}),
		);

		expect(captured.runEvents).toEqual([
			expect.objectContaining({
				runId: 'run_42',
				seq: 1,
				kind: 'progress',
				payload: {message: 'assignment received'},
			}),
			expect.objectContaining({
				runId: 'run_42',
				seq: 2,
				kind: 'exec.started',
			}),
		]);

		expect(captured.completes).toHaveLength(1);
		const completion = captured.completes[0]!;
		expect(completion.dispatchId).toBe('dispatch-1');
		expect(completion.envelope).toEqual({
			kind: 'run_event',
			runId: 'run_42',
			seq: 3,
			ts: 101,
			eventKind: 'completion',
			payload: expect.objectContaining({success: true}),
		});
	});

	it('terminates with an error envelope when the run spec is missing a prompt', async () => {
		const captured: Captured = {runEvents: [], completes: []};
		const bridge = makeBridge(captured);

		await executeAssignment({
			envelope: {
				kind: 'job_assignment',
				runId: 'run_x',
				runSpec: {sessionId: 'athena-x'},
			},
			bridge,
			dispatchId: 'd-1',
			location: baseLocation,
			runExecFn: vi.fn(),
			now: () => 555,
		});

		expect(captured.completes).toHaveLength(1);
		expect(captured.completes[0]!.envelope).toEqual({
			kind: 'run_event',
			runId: 'run_x',
			seq: 2,
			ts: 555,
			eventKind: 'error',
			payload: expect.objectContaining({
				message: expect.stringContaining('missing prompt'),
			}),
		});
	});

	it('terminates with an error envelope when bootstrap throws', async () => {
		const captured: Captured = {runEvents: [], completes: []};
		const bridge = makeBridge(captured);

		await executeAssignment({
			envelope: {
				kind: 'job_assignment',
				runId: 'run_y',
				runSpec: {prompt: 'go'},
			},
			bridge,
			dispatchId: 'd-2',
			location: baseLocation,
			runExecFn: vi.fn(),
			bootstrapRuntimeConfigFn: () => {
				throw new Error('workflow not installed');
			},
			now: () => 222,
		});

		expect(captured.completes).toHaveLength(1);
		expect(captured.completes[0]!.envelope).toMatchObject({
			eventKind: 'error',
			payload: {message: 'workflow not installed'},
		});
	});

	it('terminates with an error envelope when runExec throws', async () => {
		const captured: Captured = {runEvents: [], completes: []};
		const bridge = makeBridge(captured);

		await executeAssignment({
			envelope: {
				kind: 'job_assignment',
				runId: 'run_z',
				runSpec: {prompt: 'go'},
			},
			bridge,
			dispatchId: 'd-3',
			location: baseLocation,
			runExecFn: vi.fn(async () => {
				throw new Error('exec exploded');
			}),
			bootstrapRuntimeConfigFn: baseRuntimeConfig,
		});

		expect(captured.completes).toHaveLength(1);
		expect(captured.completes[0]!.envelope).toMatchObject({
			eventKind: 'error',
			payload: {message: 'exec exploded'},
		});
	});

	it('uses the structured exec failure message when JSON completion is generic', async () => {
		const captured: Captured = {runEvents: [], completes: []};
		const bridge = makeBridge(captured);

		await executeAssignment({
			envelope: {
				kind: 'job_assignment',
				runId: 'run_q',
				runSpec: {prompt: 'go'},
			},
			bridge,
			dispatchId: 'd-4',
			location: baseLocation,
			runExecFn: vi.fn(async (options: ExecRunOptions) => {
				options.stdout?.write(
					JSON.stringify({
						type: 'exec.completed',
						ts: 200,
						data: {success: false, exitCode: 4, finalMessage: null},
					}) + '\n',
				);
				return {
					success: false,
					exitCode: 8,
					athenaSessionId: options.athenaSessionId ?? null,
					adapterSessionId: null,
					finalMessage: null,
					tokens: {
						input: null,
						output: null,
						cacheRead: null,
						cacheWrite: null,
						total: null,
						contextSize: null,
						contextWindowSize: null,
					},
					durationMs: 1,
					failure: {
						kind: 'workflow' as const,
						state: 'blocked' as const,
						message: 'Agent did not replace the tracker skeleton.',
					},
				};
			}),
			bootstrapRuntimeConfigFn: baseRuntimeConfig,
		});

		expect(captured.completes).toHaveLength(1);
		expect(captured.completes[0]!.envelope).toMatchObject({
			eventKind: 'error',
			payload: {
				message: 'Agent did not replace the tracker skeleton.',
				exitCode: 8,
			},
		});
	});
});
