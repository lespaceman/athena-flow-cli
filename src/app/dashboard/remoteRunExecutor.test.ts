import {describe, expect, it, vi} from 'vitest';
import {executeRemoteAssignment} from './remoteRunExecutor';
import type {ExecRunOptions} from '../exec/types';

describe('executeRemoteAssignment', () => {
	it('runs the assigned prompt and streams exec events back to the dashboard', async () => {
		const sent: unknown[] = [];
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

		await executeRemoteAssignment({
			frame: {
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {
					prompt: 'say hello',
					sessionId: 'athena-run_42',
					workflow: {ref: 'exploratory-testing@0.0.14'},
					timeoutSec: 12,
					env: {FOO: 'bar'},
				},
			},
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			projectDir: '/tmp/project',
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
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
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: 'exploratory-testing',
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
			now: () => 999,
		});

		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'say hello',
				projectDir: '/tmp/project',
				athenaSessionId: 'athena-run_42',
				json: true,
				timeoutMs: 12_000,
				onPermission: 'fail',
				onQuestion: 'fail',
			}),
		);
		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_42',
				seq: 2,
				kind: 'exec.started',
			}),
		);
		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_42',
				seq: 3,
				kind: 'completion',
				payload: expect.objectContaining({success: true}),
			}),
		);
	});

	it('sends a terminal error when the assignment has no prompt', async () => {
		const sent: unknown[] = [];

		await executeRemoteAssignment({
			frame: {
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {sessionId: 'athena-run_42'},
			},
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			runExecFn: vi.fn(),
		});

		expect(sent).toEqual([
			expect.objectContaining({
				runId: 'run_42',
				seq: 1,
				kind: 'progress',
			}),
			expect.objectContaining({
				runId: 'run_42',
				seq: 2,
				kind: 'error',
				payload: expect.objectContaining({
					message: expect.stringContaining('missing prompt'),
				}),
			}),
		]);
	});

	it('sends a terminal error when runtime bootstrap fails', async () => {
		const sent: unknown[] = [];

		await executeRemoteAssignment({
			frame: {
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {prompt: 'hello'},
			},
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			bootstrapRuntimeConfigFn: () => {
				throw new Error('workflow not installed');
			},
			runExecFn: vi.fn(),
			now: () => 123,
		});

		expect(sent).toEqual([
			expect.objectContaining({
				runId: 'run_42',
				seq: 1,
				kind: 'progress',
				payload: {message: 'assignment received'},
			}),
			expect.objectContaining({
				runId: 'run_42',
				seq: 2,
				kind: 'error',
				payload: expect.objectContaining({
					message: 'workflow not installed',
				}),
			}),
		]);
	});

	it('uses the structured exec failure message when the JSON completion is generic', async () => {
		const sent: unknown[] = [];
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			options.stdout?.write(
				JSON.stringify({
					type: 'exec.completed',
					ts: 101,
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
					kind: 'workflow',
					state: 'blocked',
					message: 'Agent did not replace the tracker skeleton.',
				},
			};
		});

		await executeRemoteAssignment({
			frame: {
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {prompt: 'hello'},
			},
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
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
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: 'playwright-automation',
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
		});

		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_42',
				kind: 'error',
				payload: expect.objectContaining({
					message: 'Agent did not replace the tracker skeleton.',
				}),
			}),
		);
		expect(
			sent.filter(
				frame =>
					typeof frame === 'object' &&
					frame !== null &&
					(frame as {kind?: unknown}).kind === 'error',
			),
		).toHaveLength(1);
	});

	it('sends a terminal error when exec throws before emitting completion', async () => {
		const sent: unknown[] = [];

		await executeRemoteAssignment({
			frame: {
				type: 'job_assignment',
				runId: 'run_42',
				runSpec: {prompt: 'hello'},
			},
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			runExecFn: vi.fn(async () => {
				throw new Error('exec crashed');
			}),
			bootstrapRuntimeConfigFn: () => ({
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
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: undefined,
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
		});

		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_42',
				kind: 'error',
				payload: expect.objectContaining({
					message: 'exec crashed',
				}),
			}),
		);
	});

	it('passes cancellation through to exec and reports a terminal error', async () => {
		const sent: unknown[] = [];
		const controller = new AbortController();
		let resolveExec: (value: ExecRunOptions) => void = () => {};
		const execOptions = new Promise<ExecRunOptions>(resolve => {
			resolveExec = resolve;
		});
		const runExecFn = vi.fn(async (options: ExecRunOptions) => {
			resolveExec(options);
			await new Promise<void>(resolve => {
				options.signal?.addEventListener('abort', () => resolve(), {
					once: true,
				});
			});
			return {
				success: false,
				exitCode: 4,
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
					kind: 'process',
					message: 'Execution cancelled.',
				},
			};
		});

		const pending = executeRemoteAssignment({
			frame: {
				type: 'job_assignment',
				runId: 'run_cancel',
				runSpec: {prompt: 'hello'},
			},
			client: {
				sendRunEvent: frame => sent.push(frame),
			},
			runExecFn,
			bootstrapRuntimeConfigFn: () => ({
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
				harness: 'openai-codex',
				isolationConfig: {preset: 'minimal', additionalDirectories: []},
				workflowRef: undefined,
				workflow: undefined,
				workflowPlan: undefined,
				modelName: null,
				warnings: [],
			}),
			abortSignal: controller.signal,
		});

		const options = await execOptions;
		expect(options.signal).toBe(controller.signal);
		controller.abort();
		await pending;

		expect(sent).toContainEqual(
			expect.objectContaining({
				runId: 'run_cancel',
				kind: 'error',
				payload: expect.objectContaining({
					message: 'Execution cancelled.',
				}),
			}),
		);
	});
});
