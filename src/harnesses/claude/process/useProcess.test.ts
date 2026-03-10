/**
 * @vitest-environment jsdom
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {renderHook, act} from '@testing-library/react';
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

		await act(async () => {
			await result.current.spawn('test prompt');
		});

		expect(result.current.isRunning).toBe(true);
	});

	it('should call spawnClaude with correct arguments including instanceId', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test/dir', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('my prompt');
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'my prompt',
				projectDir: '/test/dir',
				instanceId: TEST_INSTANCE_ID,
			}),
		);
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

		await act(async () => {
			await result.current.spawn('test parser');
		});

		expect(tokenParserFactory).toHaveBeenCalled();
		expect(parser.reset).toHaveBeenCalled();

		act(() => {
			capturedCallbacks.onStdout?.('{"type":"message"}\n');
		});
		expect(parser.feed).toHaveBeenCalledWith('{"type":"message"}\n');

		act(() => {
			capturedCallbacks.onExit?.(0);
		});
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

		await act(async () => {
			await result.current.spawn('test');
		});

		act(() => {
			capturedCallbacks.onStdout?.('{"type":"message"}\n');
		});

		expect(result.current.tokenUsage).toBe(initialTokenUsage);
	});

	it('should add stdout data to output', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test');
		});

		act(() => {
			capturedCallbacks.onStdout?.('line 1');
		});

		act(() => {
			capturedCallbacks.onStdout?.('line 2');
		});

		expect(result.current.output).toEqual(['line 1', 'line 2']);
	});

	it('should add stderr data to output with prefix', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test');
		});

		act(() => {
			capturedCallbacks.onStderr?.('error message');
		});

		expect(result.current.output).toEqual(['[stderr] error message']);
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

		await act(async () => {
			await result.current.spawn('test');
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

		await act(async () => {
			await result.current.spawn('test');
		});

		expect(result.current.isRunning).toBe(true);

		act(() => {
			capturedCallbacks.onExit?.(0);
		});

		expect(result.current.isRunning).toBe(false);
	});

	it('should reset output when spawning new process', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test1');
		});

		act(() => {
			capturedCallbacks.onStdout?.('old output');
		});

		expect(result.current.output).toEqual(['old output']);

		// Trigger exit so spawn can complete kill
		await act(async () => {
			const spawnPromise = result.current.spawn('test2');
			capturedCallbacks.onExit?.(0);
			await spawnPromise;
		});

		expect(result.current.output).toEqual([]);
	});

	it('should kill existing process when spawning new one and wait for exit', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test1');
		});

		// Spawn new process - kill will wait for exit
		await act(async () => {
			const spawnPromise = result.current.spawn('test2');
			// Simulate process exit
			capturedCallbacks.onExit?.(0);
			await spawnPromise;
		});

		expect(mockProcess.kill).toHaveBeenCalled();
	});

	it('should kill process when kill is called and wait for exit', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test');
		});

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

		await act(async () => {
			await result.current.spawn('test');
		});

		unmount();

		expect(mockProcess.kill).toHaveBeenCalled();
	});

	it('should not update state after unmount', async () => {
		const {result, unmount} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test');
		});

		unmount();

		// These should not throw or cause React warnings
		expect(() => {
			capturedCallbacks.onStdout?.('data after unmount');
			capturedCallbacks.onStderr?.('error after unmount');
			capturedCallbacks.onExit?.(0);
		}).not.toThrow();
	});

	it('should handle spawn error', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test');
		});

		act(() => {
			capturedCallbacks.onError?.(new Error('spawn claude ENOENT'));
		});

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

		await act(async () => {
			await result.current.spawn('test');
		});

		act(() => {
			capturedCallbacks.onError?.(new Error('spawn claude ENOENT'));
		});

		expect(onLifecycleEvent).toHaveBeenCalledWith({
			type: 'spawn_error',
			message: 'spawn claude ENOENT',
		});
	});

	it('should log non-zero exit code', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test');
		});

		act(() => {
			capturedCallbacks.onExit?.(1);
		});

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

		await act(async () => {
			await result.current.spawn('test');
		});

		act(() => {
			capturedCallbacks.onStderr?.('permission denied');
			capturedCallbacks.onExit?.(1);
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

		await act(async () => {
			await result.current.spawn('test');
		});

		act(() => {
			capturedCallbacks.onExit?.(0);
		});

		expect(result.current.output).not.toContain('[exit code: 0]');
	});

	it('should limit output size to prevent memory issues', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test');
		});

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
	});

	it('should not pass sessionId to spawnClaude when not provided', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('my prompt');
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'my prompt',
				projectDir: '/test',
				instanceId: TEST_INSTANCE_ID,
				sessionId: undefined,
			}),
		);
	});

	it('should pass sessionId to spawnClaude when provided', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('my prompt', 'abc-123-session');
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'my prompt',
				projectDir: '/test',
				instanceId: TEST_INSTANCE_ID,
				sessionId: 'abc-123-session',
			}),
		);
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

		await act(async () => {
			await result.current.spawn('test prompt');
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: expect.objectContaining({
					mcpConfig: '/tmp/plugin-mcp.json',
				}),
			}),
		);
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

		await act(async () => {
			await result.current.spawn('test prompt', undefined, {
				mcpConfig: '/per-command/mcp.json',
			});
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: expect.objectContaining({
					mcpConfig: '/tmp/plugin-mcp.json',
				}),
			}),
		);
	});

	it('should not include pluginMcpConfig when not provided', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID, 'strict'),
		);

		await act(async () => {
			await result.current.spawn('test prompt');
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: 'strict',
			}),
		);
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

			await act(async () => {
				await result.current.spawn('test');
			});

			expect(capturedOptions.jqFilter).toBeDefined();
			expect(typeof capturedOptions.jqFilter).toBe('string');
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

			await act(async () => {
				await result.current.spawn('test');
			});

			expect(capturedOptions.jqFilter).toBeUndefined();
		});

		it('should not pass jqFilter when debug is not provided', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID),
			);

			await act(async () => {
				await result.current.spawn('test');
			});

			expect(capturedOptions.jqFilter).toBeUndefined();
		});

		it('should accumulate onFilteredStdout into streamingText', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID, undefined, undefined, true),
			);

			await act(async () => {
				await result.current.spawn('test');
			});

			act(() => {
				capturedCallbacks.onFilteredStdout?.('Hello ');
			});

			act(() => {
				capturedCallbacks.onFilteredStdout?.('world');
			});

			expect(result.current.streamingText).toBe('Hello world');
		});

		it('should reset streamingText on new spawn', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID, undefined, undefined, true),
			);

			await act(async () => {
				await result.current.spawn('test1');
			});

			act(() => {
				capturedCallbacks.onFilteredStdout?.('old text');
			});

			expect(result.current.streamingText).toBe('old text');

			// Spawn new process
			await act(async () => {
				const spawnPromise = result.current.spawn('test2');
				capturedCallbacks.onExit?.(0);
				await spawnPromise;
			});

			expect(result.current.streamingText).toBe('');
		});

		it('should route jq stderr to output with [jq] prefix', async () => {
			const {result} = renderHook(() =>
				useClaudeProcess('/test', TEST_INSTANCE_ID, undefined, undefined, true),
			);

			await act(async () => {
				await result.current.spawn('test');
			});

			act(() => {
				capturedCallbacks.onJqStderr?.('parse error');
			});

			expect(result.current.output).toContain('[jq] parse error');
		});
	});

	it('should send SIGINT when sendInterrupt is called', async () => {
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test');
		});

		act(() => {
			result.current.sendInterrupt();
		});

		expect(mockProcess.kill).toHaveBeenCalledWith('SIGINT');
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
		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID),
		);

		await act(async () => {
			await result.current.spawn('test');
		});

		let killResolved = false;
		let killPromise: Promise<void>;

		act(() => {
			killPromise = result.current.kill();
			killPromise.then(() => {
				killResolved = true;
			});
		});

		// Should not be resolved yet (no exit event, no timeout)
		expect(killResolved).toBe(false);

		// Advance timer past KILL_TIMEOUT_MS (3000ms)
		await act(async () => {
			vi.advanceTimersByTime(3100);
		});

		// Wait for promise to resolve
		await act(async () => {
			await killPromise!;
		});

		expect(killResolved).toBe(true);
		expect(result.current.isRunning).toBe(false);

		vi.useRealTimers();
	});

	it('should pass pluginDirs through to spawnClaude when present in isolation config', async () => {
		const isolationWithPlugins = {
			preset: 'strict' as const,
			pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'],
		};

		const {result} = renderHook(() =>
			useClaudeProcess('/test', TEST_INSTANCE_ID, isolationWithPlugins),
		);

		await act(async () => {
			await result.current.spawn('test prompt');
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: expect.objectContaining({
					pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'],
				}),
			}),
		);
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

		await act(async () => {
			await result.current.spawn('test prompt');
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				isolation: expect.objectContaining({
					pluginDirs: ['/path/to/plugin1'],
					mcpConfig: '/tmp/plugin-mcp.json',
				}),
			}),
		);
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

		await act(async () => {
			await result.current.spawn('test prompt');
		});

		expect(spawnModule.spawnClaude).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'test prompt',
				env: {ATHENA_WORKFLOW: '1'},
			}),
		);
		expect(capturedOptions['isolation']).toBeUndefined();
	});
});
