import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {spawnClaude} from './spawn';
import {EventEmitter} from 'node:events';

const mockCleanup = vi.fn();

vi.mock('../hooks/generateHookSettings', () => ({
	generateHookSettings: vi.fn(() => ({
		settingsPath: '/tmp/mock-settings.json',
		cleanup: mockCleanup,
	})),
	registerCleanupOnExit: vi.fn(),
	resolveHookForwarderCommand: vi.fn(),
}));

function createMockChildProcess(opts?: {withStdin?: boolean}) {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const stdin = opts?.withStdin
		? Object.assign(new EventEmitter(), {
				write: vi.fn(),
				end: vi.fn(),
			})
		: undefined;
	return Object.assign(new EventEmitter(), {
		stdout,
		stderr,
		stdin,
		kill: vi.fn().mockReturnValue(true),
	}) as unknown as childProcess.ChildProcess & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		stdin: typeof stdin;
		kill: ReturnType<typeof vi.fn>;
	};
}

vi.mock('node:child_process', () => ({
	spawn: vi.fn(),
}));

vi.mock('../system/resolveBinary', () => ({
	resolveClaudeBinary: vi.fn(() => '/resolved/claude'),
}));

import {resolveClaudeBinary} from '../system/resolveBinary';
import {
	generateHookSettings,
	resolveHookForwarderCommand,
} from '../hooks/generateHookSettings';

vi.mock('../auth/runtimeAuth', () => ({
	resolveRuntimeAuthOverlay: vi.fn(() => null),
}));

import {resolveRuntimeAuthOverlay} from '../auth/runtimeAuth';

describe('spawnClaude', () => {
	let mockChildProcess: ReturnType<typeof createMockChildProcess>;
	const mockResolveClaudeBinary = vi.mocked(resolveClaudeBinary);
	const mockResolveHookForwarderCommand = vi.mocked(
		resolveHookForwarderCommand,
	);
	const mockResolveRuntimeAuthOverlay = vi.mocked(resolveRuntimeAuthOverlay);
	let tempHookForwarderPath = '';

	beforeEach(() => {
		tempHookForwarderPath = path.join(
			os.tmpdir(),
			`drisp-hook-forwarder-${Date.now()}.js`,
		);
		fs.writeFileSync(tempHookForwarderPath, 'console.log("ok");');
		mockChildProcess = createMockChildProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockChildProcess);
		mockResolveClaudeBinary.mockReturnValue('/resolved/claude');
		mockResolveHookForwarderCommand.mockReturnValue({
			command: `'${process.execPath}' '${tempHookForwarderPath}'`,
			executable: process.execPath,
			args: [tempHookForwarderPath],
			source: 'bundled',
			scriptPath: tempHookForwarderPath,
		});
		mockResolveRuntimeAuthOverlay.mockReturnValue(null);
		mockCleanup.mockClear();
	});

	afterEach(() => {
		try {
			fs.unlinkSync(tempHookForwarderPath);
		} catch {
			// ignore
		}
		vi.clearAllMocks();
	});

	it('spawns claude with correct args, cwd, and hook routing env vars', () => {
		spawnClaude({
			prompt: 'Hello, Claude!',
			projectDir: '/test/project',
			instanceId: 12345,
			hookSocketPath: '/tmp/athena-test/run/ink-12345.sock',
		});

		expect(childProcess.spawn).toHaveBeenCalledWith(
			'/resolved/claude',
			expect.arrayContaining([
				'-p',
				'Hello, Claude!',
				'--output-format',
				'stream-json',
				'--verbose',
				'--include-partial-messages',
				'--settings',
				'/tmp/mock-settings.json',
				'--setting-sources',
				'',
				'--strict-mcp-config', // default strict preset
			]),
			expect.objectContaining({
				cwd: '/test/project',
				stdio: ['ignore', 'pipe', 'pipe'],
				env: expect.objectContaining({
					ATHENA_INSTANCE_ID: '12345',
					ATHENA_HOOK_SOCKET: '/tmp/athena-test/run/ink-12345.sock',
					CLAUDE_CODE_AUTO_COMPACT_WINDOW: '185000',
				}),
			}),
		);
	});

	it('uses a hook socket path outside the child cwd by default', () => {
		spawnClaude({
			prompt: 'Hello, Claude!',
			projectDir: '/test/project',
			instanceId: 12345,
		});

		const options = vi.mocked(childProcess.spawn).mock.calls[0]?.[2] as {
			env?: Record<string, string>;
		};
		const hookSocket = options.env?.['ATHENA_HOOK_SOCKET'];
		expect(hookSocket).toBeDefined();
		expect(path.isAbsolute(hookSocket!)).toBe(true);
		expect(hookSocket).toMatch(/\/run\/ink-12345\.sock$/);
		expect(hookSocket).not.toContain('/test/project');
	});

	it('lets per-call env override ambient process env', () => {
		const priorApiKey = process.env['ANTHROPIC_API_KEY'];
		process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-from-process';

		try {
			spawnClaude({
				prompt: 'Hello, Claude!',
				projectDir: '/test/project',
				instanceId: 12345,
				env: {ANTHROPIC_API_KEY: 'sk-ant-api03-from-workflow'},
			});

			expect(childProcess.spawn).toHaveBeenCalledWith(
				'/resolved/claude',
				expect.any(Array),
				expect.objectContaining({
					env: expect.objectContaining({
						ANTHROPIC_API_KEY: 'sk-ant-api03-from-workflow',
					}),
				}),
			);
		} finally {
			if (priorApiKey === undefined) {
				delete process.env['ANTHROPIC_API_KEY'];
			} else {
				process.env['ANTHROPIC_API_KEY'] = priorApiKey;
			}
		}
	});

	it('passes portable auth env discovered from Claude settings into generated hook settings', () => {
		mockResolveRuntimeAuthOverlay.mockReturnValue({
			env: {ANTHROPIC_API_KEY: 'sk-ant-api03-from-settings'},
		});

		spawnClaude({
			prompt: 'Hello, Claude!',
			projectDir: '/test/project',
			instanceId: 12345,
		});

		expect(vi.mocked(generateHookSettings)).toHaveBeenCalledWith(undefined, {
			env: {ANTHROPIC_API_KEY: 'sk-ant-api03-from-settings'},
		});
	});

	it('passes portable apiKeyHelper discovered from Claude settings into generated hook settings', () => {
		mockResolveRuntimeAuthOverlay.mockReturnValue({
			apiKeyHelper: '/bin/portable-helper',
		});

		spawnClaude({
			prompt: 'Hello, Claude!',
			projectDir: '/test/project',
			instanceId: 12345,
		});

		expect(vi.mocked(generateHookSettings)).toHaveBeenCalledWith(undefined, {
			apiKeyHelper: '/bin/portable-helper',
		});
	});

	it('throws a preflight error when claude binary resolution misses', () => {
		mockResolveClaudeBinary.mockReturnValue(null);

		expect(() =>
			spawnClaude({
				prompt: 'Hello, Claude!',
				projectDir: '/test/project',
				instanceId: 12345,
			}),
		).toThrow(/Claude binary not found/);
	});

	it('throws a preflight error when hook forwarder cannot be resolved', () => {
		mockResolveHookForwarderCommand.mockReturnValue({
			command: 'drisp-hook-forwarder',
			executable: 'drisp-hook-forwarder',
			args: [],
			source: 'path',
		});
		const originalPath = process.env['PATH'];
		process.env['PATH'] = '';

		try {
			expect(() =>
				spawnClaude({
					prompt: 'Hello, Claude!',
					projectDir: '/test/project',
					instanceId: 12345,
				}),
			).toThrow(/drisp-hook-forwarder/);
		} finally {
			process.env['PATH'] = originalPath;
		}
	});

	it('wires stdout, stderr, exit, and error callbacks correctly', () => {
		const onStdout = vi.fn();
		const onStderr = vi.fn();
		const onExit = vi.fn();
		const onError = vi.fn();

		spawnClaude({
			prompt: 'Test',
			projectDir: '/test',
			instanceId: 1,
			onStdout,
			onStderr,
			onExit,
			onError,
		});

		mockChildProcess.stdout.emit('data', Buffer.from('out'));
		mockChildProcess.stderr.emit('data', Buffer.from('err'));
		mockChildProcess.emit('exit', 42);

		expect(onStdout).toHaveBeenCalledWith('out');
		expect(onStderr).toHaveBeenCalledWith('err');
		expect(onExit).toHaveBeenCalledWith(42);

		// Test error separately (can only emit once meaningfully)
		const child2 = createMockChildProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(child2);
		spawnClaude({
			prompt: 'Test',
			projectDir: '/test',
			instanceId: 2,
			onError,
		});
		child2.emit('error', new Error('ENOENT'));
		expect(onError).toHaveBeenCalledWith(expect.any(Error));
	});

	it('does not throw when error event fires without onError handler', () => {
		spawnClaude({prompt: 'Test', projectDir: '/test', instanceId: 1});

		expect(() => {
			mockChildProcess.emit('error', new Error('ENOENT'));
		}).not.toThrow();
	});

	it('adds --resume flag when sessionId is provided', () => {
		spawnClaude({
			prompt: 'Test',
			projectDir: '/test',
			instanceId: 1,
			sessionId: 'abc-123',
		});

		const args = vi.mocked(childProcess.spawn).mock.calls[0]?.[1] as string[];
		expect(args).toContain('--resume');
		expect(args).toContain('abc-123');
	});

	describe('isolation config', () => {
		it('passes all isolation options as CLI flags', () => {
			spawnClaude({
				prompt: 'Test',
				projectDir: '/test',
				instanceId: 1,
				isolation: {
					mcpConfig: '/mcp.json',
					allowedTools: ['Read', 'Write'],
					disallowedTools: ['Bash'],
					permissionMode: 'plan',
					additionalDirectories: ['/extra'],
					pluginDirs: ['/plugin1', '/plugin2'],
					model: 'opus',
					maxTurns: 10,
				},
			});

			const args = vi.mocked(childProcess.spawn).mock.calls[0]?.[1] as string[];

			// MCP config
			expect(args).toContain('--mcp-config');
			expect(args).toContain('/mcp.json');

			// Tool access — allowedTools no longer emitted as CLI flags
			expect(args).not.toContain('--allowedTools');
			expect(args).toContain('--disallowedTools');
			expect(args).toContain('Bash');

			// Permission
			expect(args).toContain('--permission-mode');
			expect(args).toContain('plan');

			// Directories
			expect(args).toContain('--add-dir');
			expect(args).toContain('/extra');

			// Plugins
			expect(args).toContain('--plugin-dir');
			expect(args).toContain('/plugin1');
			expect(args).toContain('/plugin2');

			// Model
			expect(args).toContain('--model');
			expect(args).toContain('opus');

			// Limits
			expect(args).toContain('--max-turns');
			expect(args).toContain('10');
		});

		it('emits both --mcp-config and --strict-mcp-config together', () => {
			spawnClaude({
				prompt: 'Test',
				projectDir: '/test',
				instanceId: 1,
				isolation: {
					strictMcpConfig: true,
					mcpConfig: '/mcp.json',
				},
			});

			const args = vi.mocked(childProcess.spawn).mock.calls[0]?.[1] as string[];
			expect(args).toContain('--mcp-config');
			expect(args).toContain('--strict-mcp-config');
		});

		it('minimal preset enables strict MCP config', () => {
			spawnClaude({
				prompt: 'Test',
				projectDir: '/test',
				instanceId: 1,
				isolation: 'minimal',
			});

			const args = vi.mocked(childProcess.spawn).mock.calls[0]?.[1] as string[];
			expect(args).toContain('--strict-mcp-config');
		});

		it('merges preset with custom overrides', () => {
			spawnClaude({
				prompt: 'Test',
				projectDir: '/test',
				instanceId: 1,
				isolation: {
					preset: 'strict',
					allowedTools: ['Read'],
				},
			});

			const args = vi.mocked(childProcess.spawn).mock.calls[0]?.[1] as string[];
			expect(args).toContain('--strict-mcp-config'); // from preset
		});

		it('logs warning to stderr for conflicting flags', () => {
			const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			spawnClaude({
				prompt: 'Test',
				projectDir: '/test',
				instanceId: 1,
				isolation: {chrome: true, noChrome: true},
			});

			expect(stderrSpy).toHaveBeenCalledWith(
				expect.stringContaining('[athena] Conflicting flags'),
			);
			stderrSpy.mockRestore();
		});
	});

	describe('cleanup', () => {
		it('cleans up settings file on process exit', () => {
			spawnClaude({prompt: 'Test', projectDir: '/test', instanceId: 1});

			expect(mockCleanup).not.toHaveBeenCalled();
			mockChildProcess.emit('exit', 0);
			expect(mockCleanup).toHaveBeenCalled();
		});

		it('cleans up settings file on process error', () => {
			spawnClaude({prompt: 'Test', projectDir: '/test', instanceId: 1});

			mockChildProcess.emit('error', new Error('failed'));
			expect(mockCleanup).toHaveBeenCalled();
		});
	});

	describe('jq filter sidecar', () => {
		it('pipes claude stdout through jq and wires callbacks', () => {
			const jqProcess = createMockChildProcess({withStdin: true});
			vi.mocked(childProcess.spawn)
				.mockReturnValueOnce(mockChildProcess)
				.mockReturnValueOnce(jqProcess);

			const onFilteredStdout = vi.fn();
			const onJqStderr = vi.fn();

			spawnClaude({
				prompt: 'Test',
				projectDir: '/test',
				instanceId: 1,
				jqFilter: '.text',
				onFilteredStdout,
				onJqStderr,
			});

			// Verify jq spawned with correct args
			expect(childProcess.spawn).toHaveBeenNthCalledWith(
				2,
				'jq',
				['--unbuffered', '-rj', '.text'],
				{stdio: ['pipe', 'pipe', 'pipe']},
			);

			// Claude stdout → jq stdin
			const data = Buffer.from('{"text":"hello"}');
			mockChildProcess.stdout.emit('data', data);
			expect(jqProcess.stdin!.write).toHaveBeenCalledWith(data);

			// jq stdout → onFilteredStdout
			jqProcess.stdout.emit('data', Buffer.from('hello'));
			expect(onFilteredStdout).toHaveBeenCalledWith('hello');

			// jq stderr → onJqStderr
			jqProcess.stderr.emit('data', Buffer.from('parse error'));
			expect(onJqStderr).toHaveBeenCalledWith('parse error');

			// Claude stdout end → jq stdin end
			mockChildProcess.stdout.emit('end');
			expect(jqProcess.stdin!.end).toHaveBeenCalled();
		});

		it('reports jq spawn errors via onJqStderr', () => {
			const jqProcess = createMockChildProcess({withStdin: true});
			vi.mocked(childProcess.spawn)
				.mockReturnValueOnce(mockChildProcess)
				.mockReturnValueOnce(jqProcess);

			const onJqStderr = vi.fn();
			spawnClaude({
				prompt: 'Test',
				projectDir: '/test',
				instanceId: 1,
				jqFilter: '.text',
				onJqStderr,
			});

			jqProcess.emit('error', new Error('spawn jq ENOENT'));
			expect(onJqStderr).toHaveBeenCalledWith('[jq error] spawn jq ENOENT');
		});
	});
});
