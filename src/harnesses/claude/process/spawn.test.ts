import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import * as childProcess from 'node:child_process';
import {spawnClaude} from './spawn';
import {EventEmitter} from 'node:events';

const mockCleanup = vi.fn();

vi.mock('../hooks/generateHookSettings', () => ({
	generateHookSettings: vi.fn(() => ({
		settingsPath: '/tmp/mock-settings.json',
		cleanup: mockCleanup,
	})),
	registerCleanupOnExit: vi.fn(),
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

describe('spawnClaude', () => {
	let mockChildProcess: ReturnType<typeof createMockChildProcess>;
	const mockResolveClaudeBinary = vi.mocked(resolveClaudeBinary);

	beforeEach(() => {
		mockChildProcess = createMockChildProcess();
		vi.mocked(childProcess.spawn).mockReturnValue(mockChildProcess);
		mockResolveClaudeBinary.mockReturnValue('/resolved/claude');
		mockCleanup.mockClear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('spawns claude with correct args, cwd, and ATHENA_INSTANCE_ID env var', () => {
		spawnClaude({
			prompt: 'Hello, Claude!',
			projectDir: '/test/project',
			instanceId: 12345,
		});

		expect(childProcess.spawn).toHaveBeenCalledWith(
			'/resolved/claude',
			expect.arrayContaining([
				'-p',
				'Hello, Claude!',
				'--output-format',
				'stream-json',
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
				}),
			}),
		);
	});

	it('falls back to bare claude when binary resolution misses', () => {
		mockResolveClaudeBinary.mockReturnValue(null);

		spawnClaude({
			prompt: 'Hello, Claude!',
			projectDir: '/test/project',
			instanceId: 12345,
		});

		expect(childProcess.spawn).toHaveBeenCalledWith(
			'claude',
			expect.any(Array),
			expect.any(Object),
		);
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

		it('mcpConfig takes precedence over strictMcpConfig', () => {
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
			expect(args).not.toContain('--strict-mcp-config');
		});

		it('minimal preset disables strict MCP config', () => {
			spawnClaude({
				prompt: 'Test',
				projectDir: '/test',
				instanceId: 1,
				isolation: 'minimal',
			});

			const args = vi.mocked(childProcess.spawn).mock.calls[0]?.[1] as string[];
			expect(args).not.toContain('--strict-mcp-config');
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
