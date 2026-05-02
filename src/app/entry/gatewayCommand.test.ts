import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runGatewayCommand} from './gatewayCommand';
import {startDaemon, type DaemonHandle} from '../../gateway/daemon';
import type {GatewayPaths} from '../../gateway/paths';
import type {RuntimeEndpoint} from '../../shared/gateway-protocol';

function captureLogs() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		baseDeps: {
			logOut: (m: string) => out.push(m),
			logError: (m: string) => err.push(m),
			resolveDaemonEntry: () => '/nonexistent/daemon.js',
			readClientConfig: () => ({mode: 'local' as const}),
		},
	};
}

function tmpPaths(): GatewayPaths {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-gw-cmd-'));
	const runDir = path.join(tmp, 'run');
	const configDir = path.join(tmp, 'config');
	return {
		runDir,
		configDir,
		socketPath: path.join(runDir, 'gw.sock'),
		lockPath: path.join(runDir, 'gw.lock'),
		tokenPath: path.join(configDir, 'token'),
		statePath: path.join(configDir, 'state.db'),
	};
}

describe('runGatewayCommand', () => {
	it('prints usage with no subcommand', async () => {
		const cap = captureLogs();
		const code = await runGatewayCommand(
			{subcommand: '', subcommandArgs: []},
			cap.baseDeps,
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('Usage');
	});

	it('prints usage on help', async () => {
		const cap = captureLogs();
		const code = await runGatewayCommand(
			{subcommand: 'help', subcommandArgs: []},
			cap.baseDeps,
		);
		expect(code).toBe(0);
		expect(cap.out.join('\n')).toContain('Usage');
	});

	it('rejects unknown subcommand', async () => {
		const cap = captureLogs();
		const code = await runGatewayCommand(
			{subcommand: 'wat', subcommandArgs: []},
			cap.baseDeps,
		);
		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('Unknown gateway subcommand');
	});

	it('link writes remote gateway endpoint config', async () => {
		const cap = captureLogs();
		let written: RuntimeEndpoint | undefined;
		const code = await runGatewayCommand(
			{
				subcommand: 'link',
				subcommandArgs: ['ws://127.0.0.1:18789', '--token', 'secret-token'],
			},
			{
				...cap.baseDeps,
				writeClientConfig: config => {
					written = config;
				},
			},
		);

		expect(code).toBe(0);
		expect(written).toEqual({
			mode: 'remote',
			url: 'ws://127.0.0.1:18789',
			token: 'secret-token',
		});
		expect(cap.out.join('\n')).toContain('linked');
	});

	it('link requires --token', async () => {
		const cap = captureLogs();
		const code = await runGatewayCommand(
			{subcommand: 'link', subcommandArgs: ['ws://127.0.0.1:18789']},
			cap.baseDeps,
		);

		expect(code).toBe(2);
		expect(cap.err.join('\n')).toContain('--token');
	});

	it('unlink rewrites gateway endpoint config to local mode', async () => {
		const cap = captureLogs();
		let written: RuntimeEndpoint | undefined;
		const code = await runGatewayCommand(
			{subcommand: 'unlink', subcommandArgs: []},
			{
				...cap.baseDeps,
				writeClientConfig: config => {
					written = config;
				},
			},
		);

		expect(code).toBe(0);
		expect(written).toEqual({mode: 'local'});
		expect(cap.out.join('\n')).toContain('local');
	});

	// Smoke-only: with a nonexistent daemon binary, spawn fails or exits non-zero.
	it('start returns non-zero if the daemon binary is missing', async () => {
		const cap = captureLogs();
		const code = await runGatewayCommand(
			{subcommand: 'start', subcommandArgs: []},
			cap.baseDeps,
		);
		expect(code).not.toBe(0);
	});

	it('start forwards bind flags to the daemon entry', async () => {
		const cap = captureLogs();
		const spawned = vi.fn((_entry: string, _args: string[]) => {
			const child = new EventEmitter() as EventEmitter & {
				once: EventEmitter['once'];
			};
			setTimeout(() => child.emit('exit', 0), 0);
			return child as never;
		});

		const code = await runGatewayCommand(
			{
				subcommand: 'start',
				subcommandArgs: [
					'--bind',
					'127.0.0.1:0',
					'--insecure',
					'--grace-period-ms',
					'1000',
				],
			},
			{...cap.baseDeps, spawnDaemon: spawned},
		);

		expect(code).toBe(0);
		expect(spawned).toHaveBeenCalledWith('/nonexistent/daemon.js', [
			'--bind',
			'127.0.0.1:0',
			'--insecure',
			'--grace-period-ms',
			'1000',
		]);
	});

	describe('with a running daemon', () => {
		let paths: GatewayPaths;
		let daemon: DaemonHandle | undefined;
		beforeEach(async () => {
			paths = tmpPaths();
			daemon = await startDaemon({
				foreground: true,
				silent: true,
				paths,
				skipSignalHandlers: true,
				skipChannelLoad: true,
			});
		});
		afterEach(async () => {
			if (daemon) await daemon.stop();
			try {
				fs.rmSync(path.dirname(paths.runDir), {recursive: true, force: true});
			} catch {
				// best-effort
			}
		});

		it('probe returns 0 and human output', async () => {
			const cap = captureLogs();
			const code = await runGatewayCommand(
				{subcommand: 'probe', subcommandArgs: []},
				{
					...cap.baseDeps,
					resolveSocketPath: () => paths.socketPath,
					resolveTokenPath: () => paths.tokenPath,
				},
			);
			expect(code).toBe(0);
			expect(cap.out.join('\n')).toContain('reachable');
		});

		it('probe --json returns parseable JSON', async () => {
			const cap = captureLogs();
			const code = await runGatewayCommand(
				{subcommand: 'probe', subcommandArgs: ['--json']},
				{
					...cap.baseDeps,
					resolveSocketPath: () => paths.socketPath,
					resolveTokenPath: () => paths.tokenPath,
				},
			);
			expect(code).toBe(0);
			const parsed = JSON.parse(cap.out[0]!);
			expect(parsed.ok).toBe(true);
			expect(parsed.reachable).toBe(true);
			expect(typeof parsed.latency_ms).toBe('number');
			expect(parsed.daemon_pid).toBe(process.pid);
		});

		it('status reports daemon details', async () => {
			const cap = captureLogs();
			const code = await runGatewayCommand(
				{subcommand: 'status', subcommandArgs: ['--json']},
				{
					...cap.baseDeps,
					resolveSocketPath: () => paths.socketPath,
					resolveTokenPath: () => paths.tokenPath,
				},
			);
			expect(code).toBe(0);
			const parsed = JSON.parse(cap.out[0]!);
			expect(parsed.daemonPid).toBe(process.pid);
			expect(Array.isArray(parsed.channels)).toBe(true);
		});

		it('status human output reports connected runtime', async () => {
			const cap = captureLogs();
			const close = vi.fn();
			const request = vi.fn(async () => ({
				daemonPid: 4321,
				startedAt: 100,
				uptimeMs: 50,
				version: 'test',
				channels: [],
				runtimes: [
					{
						runtimeId: 'runtime-1',
						defaultAgentId: 'main',
						pid: 1234,
						registeredAt: 110,
						binding: {state: 'active', boundAt: 120},
						pendingDispatchCount: 0,
					},
				],
			}));
			const code = await runGatewayCommand(
				{subcommand: 'status', subcommandArgs: []},
				{
					...cap.baseDeps,
					connectGateway: async () => ({
						request,
						onPush: vi.fn(),
						close,
					}),
				},
			);

			expect(code).toBe(0);
			expect(cap.out.join('\n')).toContain(
				'runtime=runtime-1 binding=active pid=1234',
			);
		});

		it('status uses the linked remote endpoint when configured', async () => {
			const cap = captureLogs();
			const close = vi.fn();
			const request = vi.fn(async () => ({
				daemonPid: 4321,
				startedAt: 100,
				uptimeMs: 50,
				version: 'test',
				channels: [],
				runtimes: [
					{
						runtimeId: 'runtime-1',
						defaultAgentId: 'main',
						pid: 1234,
						registeredAt: 110,
						binding: {state: 'active', boundAt: 120},
						pendingDispatchCount: 0,
					},
				],
			}));
			const connectGateway = vi.fn(async () => ({
				request,
				onPush: vi.fn(),
				close,
			}));
			const code = await runGatewayCommand(
				{subcommand: 'status', subcommandArgs: ['--json']},
				{
					...cap.baseDeps,
					readClientConfig: () => ({
						mode: 'remote',
						url: 'ws://127.0.0.1:18789',
						token: 'remote-token',
					}),
					connectGateway,
				},
			);

			expect(code).toBe(0);
			expect(connectGateway).toHaveBeenCalledWith(
				expect.objectContaining({
					endpoint: {
						mode: 'remote',
						url: 'ws://127.0.0.1:18789',
						token: 'remote-token',
					},
				}),
			);
			expect(close).toHaveBeenCalledTimes(1);
			expect(JSON.parse(cap.out[0]!).runtimes).toHaveLength(1);
		});
	});

	it('probe reports unreachable when no daemon is running', async () => {
		const cap = captureLogs();
		const paths = tmpPaths();
		fs.mkdirSync(paths.configDir, {recursive: true, mode: 0o700});
		fs.writeFileSync(paths.tokenPath, 'fake-token-1234567890123456');
		const code = await runGatewayCommand(
			{subcommand: 'probe', subcommandArgs: []},
			{
				...cap.baseDeps,
				resolveSocketPath: () => paths.socketPath,
				resolveTokenPath: () => paths.tokenPath,
			},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('not reachable');
		try {
			fs.rmSync(path.dirname(paths.runDir), {recursive: true, force: true});
		} catch {
			// best-effort
		}
	});

	it('probe reports clear error when token file is missing', async () => {
		const cap = captureLogs();
		const paths = tmpPaths();
		const code = await runGatewayCommand(
			{subcommand: 'probe', subcommandArgs: []},
			{
				...cap.baseDeps,
				resolveSocketPath: () => paths.socketPath,
				resolveTokenPath: () => paths.tokenPath,
			},
		);
		expect(code).toBe(1);
		expect(cap.err.join('\n')).toContain('token missing');
	});
});
