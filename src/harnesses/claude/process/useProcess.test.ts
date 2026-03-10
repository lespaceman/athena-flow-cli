/**
 * @vitest-environment jsdom
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {renderHook, act, waitFor} from '@testing-library/react';
import {useClaudeProcess} from './useProcess';
import * as spawnModule from './spawn';
import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import type {WorkflowConfig} from '../../../core/workflows/types';

// Create mock child process
function createMockChildProcess(): ChildProcess {
	const mockProcess = new EventEmitter() as ChildProcess;
	mockProcess.kill = vi.fn().mockReturnValue(true);
	return mockProcess;
}

vi.mock('./spawn', () => ({
	spawnClaude: vi.fn(),
}));

describe('useClaudeProcess', () => {
	const TEST_INSTANCE_ID = 12345;
	let mockProcess: ChildProcess;
	let capturedCallbacks: {
		onStdout?: (data: string) => void;
		onStderr?: (data: string) => void;
		onExit?: (code: number | null) => void;
		onError?: (error: Error) => void;
		onFilteredStdout?: (data: string) => void;
		onJqStderr?: (data: string) => void;
	};
	let capturedOptions: Record<string, unknown>;

	beforeEach(() => {
		mockProcess = createMockChildProcess();
		capturedCallbacks = {};

		vi.mocked(spawnModule.spawnClaude).mockImplementation(options => {
			capturedCallbacks.onStdout = options.onStdout;
			capturedCallbacks.onStderr = options.onStderr;
			capturedCallbacks.onExit = options.onExit;
			capturedCallbacks.onError = options.onError;
			capturedCallbacks.onFilteredStdout = options.onFilteredStdout;
			capturedCallbacks.onJqStderr = options.onJqStderr;
			capturedOptions = options as unknown as Record<string, unknown>;
			return mockProcess;
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	async function startSpawn(
		result: {current: ReturnType<typeof useClaudeProcess>},
		prompt: string,
		...args: Parameters<ReturnType<typeof useClaudeProcess>['spawn']> extends [
			string,
			...infer Rest,
		]
			? Rest
			: never
	): Promise<{
		spawnPromise: ReturnType<typeof useClaudeProcess>['spawn'];
	}> {
		const priorSpawnCalls = vi.mocked(spawnModule.spawnClaude).mock.calls.length;
		let spawnPromise!: ReturnType<typeof result.current.spawn>;
		await act(async () => {
			spawnPromise = result.current.spawn(prompt, ...args);
		});
		await waitFor(() => {
			expect(spawnModule.spawnClaude).toHaveBeenCalledTimes(priorSpawnCalls + 1);
		});
		return {spawnPromise};
	}

	async function completeSpawn(
		spawnPromise: Promise<unknown>,
		code: number | null = 0,
	): Promise<void> {
		await act(async () => {
			capturedCallbacks.onExit?.(code);
			await spawnPromise;
		});
	}

	async function failSpawn(
		spawnPromise: Promise<unknown>,
		error: Error,
	): Promise<void> {
		await act(async () => {
			capturedCallbacks.onError?.(error);
			await spawnPromise;
		});
	}

	it('should initialize with isRunning false', () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		expect(result.current.isRunning).toBe(false);
	});

	it('should initialize with empty output', () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		expect(result.current.output).toEqual([]);
	});

	it('should set isRunning to true when spawn is called', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test prompt');

		expect(result.current.isRunning).toBe(true);
		await completeSpawn(spawnPromise);
	});

	it('should call spawnClaude with correct arguments including instanceId', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test/dir', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'my prompt');

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'my prompt',
				projectDir: '/test/dir',
				instanceId: TEST_INSTANCE_ID,
			}),
		);
		await completeSpawn(spawnPromise);
	});

	it('should use injected token parser strategy when provided', async () => {
		const parser = {
			feed: vi.fn(),
			flush: vi.fn(),
			reset: vi.fn(),
			getUsage: vi.fn(() => ({
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				total: null,
				contextSize: null,
				contextWindowSize: null,
			})),
		};
		const tokenParserFactory = vi.fn(() => parser);

		const {result} = renderHook(() =>
			useClaudeProcess(
				'/test',
				TEST_INSTANCE_ID,
				undefined,
				undefined,
				false,
				undefined,
				{
					tokenParserFactory,
				},
			),
		);

		const {spawnPromise} = await startSpawn(result, 'test parser');

		expect(tokenParserFactory).toHaveBeenCalled();
		expect(parser.reset).toHaveBeenCalled();

		act(() => {
			capturedCallbacks.onStdout?.('{"type":"message"}\n');
		});
		expect(parser.feed).toHaveBeenCalledWith('{"type":"message"}\n');

		await completeSpawn(spawnPromise);
		expect(parser.flush).toHaveBeenCalled();
	});

	it('does not publish token usage when the parsed values are unchanged', async () => {
		const parser = {
			feed: vi.fn(),
			flush: vi.fn(),
			reset: vi.fn(),
			getUsage: vi.fn(() => ({
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				total: null,
				contextSize: null,
				contextWindowSize: null,
			})),
		};

		const {result} = renderHook(() =>
			useClaudeProcess(
				'/test',
				TEST_INSTANCE_ID,
				undefined,
				undefined,
				false,
				undefined,
				{
					tokenParserFactory: () => parser,
					trackOutput: false,
				},
			),
		);

		const initialTokenUsage = result.current.tokenUsage;

		const {spawnPromise} = await startSpawn(result, 'test');

		act(() => {
			capturedCallbacks.onStdout?.('{"type":"message"}\n');
		});

		expect(result.current.tokenUsage).toBe(initialTokenUsage);
		await completeSpawn(spawnPromise);
	});

	it('should add stdout data to output', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		act(() => {
			capturedCallbacks.onStdout?.('line 1');
		});

		act(() => {
			capturedCallbacks.onStdout?.('line 2');
		});

		expect(result.current.output).toEqual(['line 1', 'line 2']);
		await completeSpawn(spawnPromise);
	});

	it('should add stderr data to output with prefix', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		act(() => {
			capturedCallbacks.onStderr?.('error message');
		});

		expect(result.current.output).toEqual(['[stderr] error message']);
		await completeSpawn(spawnPromise);
	});

	it('reports preflight spawn errors without leaving the process running', async () => {
		const onLifecycleEvent = vi.fn();
		vi.mocked(spawnModule.spawnClaude).mockImplementationOnce(() => {
			const error = new Error('Claude binary not found') as Error & {
				failureCode?: string;
			};
			error.failureCode = 'claude_binary_missing';
			throw error;
		});

		const {result} = renderHook(() =>
			useClaudeProcess(
				'/test',
				TEST_INSTANCE_ID,
				undefined,
				undefined,
				false,
				undefined,
				{onLifecycleEvent},
			),
		);

		const {spawnPromise} = await startSpawn(result, 'test');
		await act(async () => {
			await spawnPromise;
		});

		expect(result.current.isRunning).toBe(false);
		expect(onLifecycleEvent).toHaveBeenCalledWith({
			type: 'spawn_error',
			message: 'Claude binary not found',
			failureCode: 'claude_binary_missing',
		});
	});

	it('should set isRunning to false when process exits', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		expect(result.current.isRunning).toBe(true);

		await completeSpawn(spawnPromise);

		expect(result.current.isRunning).toBe(false);
	});

	it('should reset output when spawning new process', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise: firstSpawnPromise} = await startSpawn(result, 'test1');
		const firstOnExit = capturedCallbacks.onExit;

		act(() => {
			capturedCallbacks.onStdout?.('old output');
		});

		expect(result.current.output).toEqual(['old output']);

		let secondSpawnPromise!: ReturnType<typeof result.current.spawn>;
		act(() => {
			secondSpawnPromise = result.current.spawn('test2');
		});
		act(() => {
			firstOnExit?.(0);
		});
		await waitFor(() => {
			expect(spawnModule.spawnClaude).toHaveBeenCalledTimes(2);
		});
		await completeSpawn(secondSpawnPromise);

		expect(result.current.output).toEqual([]);
		await firstSpawnPromise;
	});

	it('should kill existing process when spawning new one and wait for exit', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise: firstSpawnPromise} = await startSpawn(result, 'test1');
		const firstOnExit = capturedCallbacks.onExit;

		let secondSpawnPromise!: ReturnType<typeof result.current.spawn>;
		act(() => {
			secondSpawnPromise = result.current.spawn('test2');
		});
		act(() => {
			firstOnExit?.(0);
		});
		await waitFor(() => {
			expect(spawnModule.spawnClaude).toHaveBeenCalledTimes(2);
		});
		await completeSpawn(secondSpawnPromise);

		expect(mockProcess.kill).toHaveBeenCalled();
		await firstSpawnPromise;
	});

	it('should kill process when kill is called and wait for exit', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await startSpawn(result, 'test');

		await act(async () => {
			const killPromise = result.current.kill();
			// Simulate process exit
			capturedCallbacks.onExit?.(0);
			await killPromise;
		});

		expect(mockProcess.kill).toHaveBeenCalled();
		expect(result.current.isRunning).toBe(false);
	});

	it('should handle kill when no process is running', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		// Should not throw
		await expect(
			act(async () => {
				await result.current.kill();
			}),
		).resolves.not.toThrow();
	});

	it('should kill process on unmount', async () => {
		const {result, unmount} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		unmount();
		capturedCallbacks.onExit?.(0);
		await spawnPromise;

		expect(mockProcess.kill).toHaveBeenCalled();
	});

	it('should not update state after unmount', async () => {
		const {result, unmount} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		unmount();

		// These should not throw or cause React warnings
		expect(() => {
			capturedCallbacks.onStdout?.('data after unmount');
			capturedCallbacks.onStderr?.('error after unmount');
			capturedCallbacks.onExit?.(0);
		}).not.toThrow();
		await spawnPromise;
	});

	it('should handle spawn error', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		await failSpawn(spawnPromise, new Error('spawn claude ENOENT'));

		expect(result.current.isRunning).toBe(false);
		expect(result.current.output).toContain('[error] spawn claude ENOENT');
	});

	it('emits lifecycle event for spawn errors even when output tracking is disabled', async () => {
		const onLifecycleEvent = vi.fn();
		const {result} = renderHook(() =>
			useClaudeProcess(
				'/test',
				TEST_INSTANCE_ID,
				undefined,
				undefined,
				false,
				undefined,
				{
					trackOutput: false,
					onLifecycleEvent,
				},
			),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		await failSpawn(spawnPromise, new Error('spawn claude ENOENT'));

		expect(onLifecycleEvent).toHaveBeenCalledWith({
			type: 'spawn_error',
			message: 'spawn claude ENOENT',
		});
	});

	it('should log non-zero exit code', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');
		await completeSpawn(spawnPromise, 1);

		expect(result.current.isRunning).toBe(false);
		expect(result.current.output).toContain('[exit code: 1]');
	});

	it('emits lifecycle event for non-zero exits with stderr context', async () => {
		const onLifecycleEvent = vi.fn();
		const {result} = renderHook(() =>
			useClaudeProcess(
				'/test',
				TEST_INSTANCE_ID,
				undefined,
				undefined,
				false,
				undefined,
				{
					trackOutput: false,
					onLifecycleEvent,
				},
			),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		await act(async () => {
			capturedCallbacks.onStderr?.('permission denied');
			capturedCallbacks.onExit?.(1);
			await spawnPromise;
		});

		expect(onLifecycleEvent).toHaveBeenCalledWith({
			type: 'exit_nonzero',
			code: 1,
			message: 'Claude exited with code 1. Stderr: permission denied',
		});
		expect(result.current.isRunning).toBe(false);
	});

	it('should not log zero exit code', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');
		await completeSpawn(spawnPromise, 0);

		expect(result.current.output).not.toContain('[exit code: 0]');
	});

	it('should limit output size to prevent memory issues', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		// Add more than MAX_OUTPUT (1000) lines
		act(() => {
			for (let i = 0; i < 1100; i++) {
				capturedCallbacks.onStdout?.(`line ${i}`);
			}
		});

		// Should be limited to 1000
		expect(result.current.output.length).toBe(1000);
		// Should keep the most recent lines
		expect(result.current.output[999]).toBe('line 1099');
		await completeSpawn(spawnPromise);
	});

	it('should start a fresh Claude turn when no continuation is provided', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'my prompt');

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'my prompt',
				projectDir: '/test',
				instanceId: TEST_INSTANCE_ID,
				sessionId: undefined,
			}),
		);
		await completeSpawn(spawnPromise);
	});

	it('should resume Claude when an explicit continuation handle is provided', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'my prompt', {
			mode: 'resume',
			handle: 'abc-123-session',
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'my prompt',
				projectDir: '/test',
				instanceId: TEST_INSTANCE_ID,
				sessionId: 'abc-123-session',
			}),
		);
		await completeSpawn(spawnPromise);
	});

	it('should merge pluginMcpConfig into isolation for every spawn', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess(
				'/test',
				TEST_INSTANCE_ID,
				'strict',
				'/tmp/plugin-mcp.json',
			),
		);

		const {spawnPromise} = await startSpawn(result, 'test prompt');

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: expect.objectContaining({
					mcpConfig: '/tmp/plugin-mcp.json',
				}),
			}),
		);
		await completeSpawn(spawnPromise);
	});

	it('should keep pluginMcpConfig over per-command mcpConfig override', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess(
				'/test',
				TEST_INSTANCE_ID,
				'strict',
				'/tmp/plugin-mcp.json',
			),
		);

		const {spawnPromise} = await startSpawn(
			result,
			'test prompt',
			undefined,
			{
				mcpConfig: '/per-command/mcp.json',
			},
		);

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: expect.objectContaining({
					mcpConfig: '/tmp/plugin-mcp.json',
				}),
			}),
		);
		await completeSpawn(spawnPromise);
	});

	it('should not include pluginMcpConfig when not provided', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID, 'strict'),
		);

		const {spawnPromise} = await startSpawn(result, 'test prompt');

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: 'strict',
			}),
		);
		await completeSpawn(spawnPromise);
	});

	it('should initialize streamingText as empty string', () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		expect(result.current.streamingText).toBe('');
	});

	describe('debug mode', () => {
		it('should pass jqFilter when debug is true', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID, undefined, undefined, true),
			);

			const {spawnPromise} = await startSpawn(result, 'test');

			expect(capturedOptions.jqFilter).toBeDefined();
			expect(typeof capturedOptions.jqFilter).toBe('string');
			await completeSpawn(spawnPromise);
		});

		it('should not pass jqFilter when debug is false', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess(
					'/test',
					TEST_INSTANCE_ID,
					undefined,
					undefined,
					false,
				),
			);

			const {spawnPromise} = await startSpawn(result, 'test');

			expect(capturedOptions.jqFilter).toBeUndefined();
			await completeSpawn(spawnPromise);
		});

		it('should not pass jqFilter when debug is not provided', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID),
			);

			const {spawnPromise} = await startSpawn(result, 'test');

			expect(capturedOptions.jqFilter).toBeUndefined();
			await completeSpawn(spawnPromise);
		});

		it('should accumulate onFilteredStdout into streamingText', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID, undefined, undefined, true),
			);

			const {spawnPromise} = await startSpawn(result, 'test');

			act(() => {
				capturedCallbacks.onFilteredStdout?.('Hello ');
			});

			act(() => {
				capturedCallbacks.onFilteredStdout?.('world');
			});

			expect(result.current.streamingText).toBe('Hello world');
			await completeSpawn(spawnPromise);
		});

		it('should reset streamingText on new spawn', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID, undefined, undefined, true),
			);

			const {spawnPromise: firstSpawnPromise} = await startSpawn(
				result,
				'test1',
			);
			const firstOnExit = capturedCallbacks.onExit;

			act(() => {
				capturedCallbacks.onFilteredStdout?.('old text');
			});

			expect(result.current.streamingText).toBe('old text');

			let secondSpawnPromise!: ReturnType<typeof result.current.spawn>;
			act(() => {
				secondSpawnPromise = result.current.spawn('test2');
			});
			act(() => {
				firstOnExit?.(0);
			});
			await waitFor(() => {
				expect(spawnModule.spawnClaude).toHaveBeenCalledTimes(2);
			});
			await completeSpawn(secondSpawnPromise);

			expect(result.current.streamingText).toBe('');
			await firstSpawnPromise;
		});

		it('should route jq stderr to output with [jq] prefix', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID, undefined, undefined, true),
			);

			const {spawnPromise} = await startSpawn(result, 'test');

			act(() => {
				capturedCallbacks.onJqStderr?.('parse error');
			});

			expect(result.current.output).toContain('[jq] parse error');
			await completeSpawn(spawnPromise);
		});
	});

	it('should send SIGINT when sendInterrupt is called', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		const {spawnPromise} = await startSpawn(result, 'test');

		act(() => {
			result.current.sendInterrupt();
		});

		expect(mockProcess.kill).toHaveBeenCalledWith('SIGINT');
		await completeSpawn(spawnPromise);
	});

	it('should be a no-op when sendInterrupt is called with no process', () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		// Should not throw
		expect(() => {
			result.current.sendInterrupt();
		}).not.toThrow();
	});

	it('should resolve kill after timeout if process does not exit', async () => {
		vi.useFakeTimers();
		try {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID),
			);

			let spawnPromise!: ReturnType<typeof result.current.spawn>;
			await act(async () => {
				spawnPromise = result.current.spawn('test');
				await Promise.resolve();
			});

			let killResolved = false;
			const killPromise = result.current.kill();
			void killPromise.then(() => {
				killResolved = true;
			});

			// Should not be resolved yet (no exit event, no timeout)
			expect(killResolved).toBe(false);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3100);
			});
			await act(async () => {
				await killPromise;
			});
			void spawnPromise;

			expect(killResolved).toBe(true);
			expect(result.current.isRunning).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should pass pluginDirs through to spawnClaude when present in isolation config', async () => {
		const isolationWithPlugins = {
			preset: 'strict' as const,
			pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'],
		};

		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID, isolationWithPlugins),
		);

		const {spawnPromise} = await startSpawn(result, 'test prompt');

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: expect.objectContaining({
					pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'],
				}),
			}),
		);
		await completeSpawn(spawnPromise);
	});

	it('should preserve pluginDirs when merging with pluginMcpConfig', async () => {
		const isolationWithPlugins = {
			preset: 'strict' as const,
			pluginDirs: ['/path/to/plugin1'],
		};

		const {result} = renderHook(() =>
			useClaudeProcess(
				'/test',
				TEST_INSTANCE_ID,
				isolationWithPlugins,
				'/tmp/plugin-mcp.json',
			),
		);

		const {spawnPromise} = await startSpawn(result, 'test prompt');

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: expect.objectContaining({
					pluginDirs: ['/path/to/plugin1'],
					mcpConfig: '/tmp/plugin-mcp.json',
				}),
			}),
		);
		await completeSpawn(spawnPromise);
	});

	it('passes workflow env through to Claude spawn without applying workflow logic internally', async () => {
		const workflow: WorkflowConfig = {
			name: 'wf',
			plugins: [],
			promptTemplate: 'Wrapped: {input}',
			systemPromptFile: 'workflow-prompt.md',
			env: {ATHENA_WORKFLOW: '1'},
			loop: {
				enabled: true,
				completionMarker: '<!-- DONE -->',
				maxIterations: 5,
			},
		};

		const {result} = renderHook(() =>
			useClaudeProcess(
				'/test',
				TEST_INSTANCE_ID,
				undefined,
				undefined,
				false,
				workflow,
			),
		);

		const {spawnPromise} = await startSpawn(result, 'test prompt');

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'test prompt',
				env: {ATHENA_WORKFLOW: '1'},
			}),
		);
		expect(capturedOptions['isolation']).toBeUndefined();
		await completeSpawn(spawnPromise);
	});
});
