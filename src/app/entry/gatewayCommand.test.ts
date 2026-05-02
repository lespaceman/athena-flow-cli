import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runGatewayCommand} from './gatewayCommand';
import {startDaemon, type DaemonHandle} from '../../gateway/daemon';
import type {GatewayPaths} from '../../gateway/paths';

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

	// Smoke-only: with a nonexistent daemon binary, spawn fails or exits non-zero.
	it('start returns non-zero if the daemon binary is missing', async () => {
		const cap = captureLogs();
		const code = await runGatewayCommand(
			{subcommand: 'start', subcommandArgs: []},
			cap.baseDeps,
		);
		expect(code).not.toBe(0);
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
