import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startDaemon, type DaemonHandle} from '../daemon';
import type {GatewayPaths} from '../paths';
import {
	connect,
	GatewayUnauthorizedError,
	GatewayUnreachableError,
} from './client';
import type {
	PingResponsePayload,
	StatusResponsePayload,
} from '../../shared/gateway-protocol';

function tmpPaths(): GatewayPaths {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-gw-ctl-'));
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

describe('gateway control plane', () => {
	let paths: GatewayPaths;
	let daemon: DaemonHandle | undefined;
	beforeEach(() => {
		paths = tmpPaths();
		daemon = undefined;
	});
	afterEach(async () => {
		if (daemon) await daemon.stop();
		try {
			fs.rmSync(path.dirname(paths.runDir), {recursive: true, force: true});
		} catch {
			// best-effort
		}
	});

	it('round-trips ping with the right token', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();
		const client = await connect({socketPath: paths.socketPath, token});
		const res = await client.request<
			Record<string, never>,
			PingResponsePayload
		>('ping', {});
		expect(res.pong).toBe(true);
		expect(res.daemonPid).toBe(process.pid);
		expect(res.uptimeMs).toBeGreaterThanOrEqual(0);
		client.close();
	});

	it('returns status snapshot', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();
		const client = await connect({socketPath: paths.socketPath, token});
		const res = await client.request<
			Record<string, never>,
			StatusResponsePayload
		>('status', {});
		expect(res.daemonPid).toBe(process.pid);
		expect(res.startedAt).toBeLessThanOrEqual(Date.now());
		expect(res.channels).toEqual([]);
		expect(typeof res.version).toBe('string');
		client.close();
	});

	it('includes active runtime binding in status snapshot', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();
		const client = await connect({socketPath: paths.socketPath, token});
		await client.request('session.register', {
			runtimeId: 'runtime-1',
			defaultAgentId: 'main',
			pid: 1234,
		});

		const res = await client.request<
			Record<string, never>,
			StatusResponsePayload
		>('status', {});

		expect(res.runtimes).toEqual([
			{
				runtimeId: 'runtime-1',
				defaultAgentId: 'main',
				pid: 1234,
				registeredAt: expect.any(Number),
				binding: {
					state: 'active',
					boundAt: expect.any(Number),
				},
				pendingDispatchCount: 0,
			},
		]);
		client.close();
	});

	it('rejects connect with wrong token', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		await expect(
			connect({socketPath: paths.socketPath, token: 'definitely-wrong'}),
		).rejects.toBeInstanceOf(GatewayUnauthorizedError);
	});

	it('reports unreachable when no daemon is running', async () => {
		await expect(
			connect({
				socketPath: path.join(paths.runDir, 'nonexistent.sock'),
				token: 'whatever',
				timeoutMs: 500,
			}),
		).rejects.toBeInstanceOf(GatewayUnreachableError);
	});

	it('returns error envelope for unknown kind', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();
		const client = await connect({socketPath: paths.socketPath, token});
		await expect(client.request('not_a_real_kind', {})).rejects.toThrow(
			/unknown_kind/,
		);
		client.close();
	});
});
