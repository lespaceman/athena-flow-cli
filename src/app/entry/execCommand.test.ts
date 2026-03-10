import {describe, expect, it, vi} from 'vitest';
import {runExecCommand, type ExecRuntimeConfig} from './execCommand';
import {EXEC_EXIT_CODE} from '../exec';

const BASE_RUNTIME_CONFIG: ExecRuntimeConfig = {
	harness: 'claude-code' as const,
	isolationConfig: {},
	pluginMcpConfig: undefined,
	workflow: undefined,
	workflowPlan: undefined,
};

const BASE_FLAGS = {
	continueFlag: undefined,
	json: false,
	outputLastMessage: undefined,
	ephemeral: false,
	onPermission: 'fail',
	onQuestion: 'fail',
	timeoutMs: undefined,
	verbose: false,
};

describe('runExecCommand', () => {
	it('fails usage on invalid permission policy', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, onPermission: 'invalid'},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{logError, runExecFn: runExecFn as never},
		);

		expect(code).toBe(EXEC_EXIT_CODE.USAGE);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails usage on invalid question policy', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, onQuestion: 'invalid'},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{logError, runExecFn: runExecFn as never},
		);

		expect(code).toBe(EXEC_EXIT_CODE.USAGE);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails usage on invalid timeout', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, timeoutMs: 0},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{logError, runExecFn: runExecFn as never},
		);

		expect(code).toBe(EXEC_EXIT_CODE.USAGE);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails usage on --ephemeral with --continue', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, ephemeral: true, continueFlag: ''},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{logError, runExecFn: runExecFn as never},
		);

		expect(code).toBe(EXEC_EXIT_CODE.USAGE);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails runtime when --continue has no prior sessions', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, continueFlag: ''},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				logError,
				runExecFn: runExecFn as never,
				getMostRecentSessionFn: () => null,
			},
		);

		expect(code).toBe(EXEC_EXIT_CODE.RUNTIME);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails runtime when explicit --continue id is unknown', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, continueFlag: 'unknown-id'},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				logError,
				runExecFn: runExecFn as never,
				getSessionMetaFn: () => null,
			},
		);

		expect(code).toBe(EXEC_EXIT_CODE.RUNTIME);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalled();
	});

	it('fails runtime when continue resolution throws', async () => {
		const logError = vi.fn();
		const runExecFn = vi.fn();

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, continueFlag: ''},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				logError,
				runExecFn: runExecFn as never,
				getMostRecentSessionFn: () => {
					throw new Error('registry unavailable');
				},
			},
		);

		expect(code).toBe(EXEC_EXIT_CODE.RUNTIME);
		expect(runExecFn).not.toHaveBeenCalled();
		expect(logError).toHaveBeenCalledWith(
			expect.stringContaining('Failed to resolve --continue session'),
		);
	});

	it('runs exec with resolved resume info and returns exit code', async () => {
		const runExecFn = vi
			.fn()
			.mockResolvedValue({exitCode: EXEC_EXIT_CODE.POLICY});

		const code = await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, onPermission: 'allow', onQuestion: 'empty'},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				runExecFn,
				createSessionId: () => 'athena-new',
			},
		);

		expect(code).toBe(EXEC_EXIT_CODE.POLICY);
		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				athenaSessionId: 'athena-new',
				onPermission: 'allow',
				onQuestion: 'empty',
			}),
		);
	});

	it('uses most recent session when bare --continue is provided', async () => {
		const runExecFn = vi
			.fn()
			.mockResolvedValue({exitCode: EXEC_EXIT_CODE.SUCCESS});

		await runExecCommand(
			{
				projectDir: '/tmp',
				prompt: 'hello',
				flags: {...BASE_FLAGS, continueFlag: ''},
				runtimeConfig: BASE_RUNTIME_CONFIG,
			},
			{
				runExecFn,
				getMostRecentSessionFn: () => ({
					id: 'athena-1',
					adapterSessionIds: ['a-1', 'a-2'],
					projectDir: '/tmp',
					createdAt: 0,
					updatedAt: 0,
				}),
			},
		);

		expect(runExecFn).toHaveBeenCalledWith(
			expect.objectContaining({
				athenaSessionId: 'athena-1',
				adapterResumeSessionId: 'a-2',
			}),
		);
	});
});
