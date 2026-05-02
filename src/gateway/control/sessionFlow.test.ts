/**
 * M5 end-to-end integration test for the gateway control plane.
 *
 * Boots a real daemon over a tmpdir UDS, connects two clients (a "runtime"
 * that registers, plus the gateway itself which holds a fake channel
 * adapter), simulates an inbound chat, asserts a `session.dispatch.turn`
 * push lands on the runtime, then sends `session.turn.complete` and asserts
 * the fake adapter receives the outbound `send`.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startDaemon, type DaemonHandle} from '../daemon';
import type {GatewayPaths} from '../paths';
import type {
	AdapterContext,
	ChannelAdapter,
	ChannelHealthListener,
	ChannelInboundListener,
	NormalizedInbound,
	OutboundMessage,
	SessionDispatchTurnPushPayload,
	StopReason,
} from '../../shared/gateway-protocol';
import {connect} from './client';

class FakeAdapter implements ChannelAdapter {
	readonly id = 'fake';
	readonly capabilities = {chat: true, threads: false} as const;
	private inboundListeners = new Set<ChannelInboundListener>();
	private healthListeners = new Set<ChannelHealthListener>();
	sentMessages: OutboundMessage[] = [];

	async start(_ctx: AdapterContext): Promise<void> {}
	async stop(_reason: StopReason): Promise<void> {}
	async send(msg: OutboundMessage) {
		this.sentMessages.push(msg);
		return {providerMessageId: 'pm1', deliveredAt: 1};
	}
	async probe() {
		return {ok: true, checkedAt: 1};
	}
	on(event: 'inbound', cb: ChannelInboundListener): void;
	on(event: 'health', cb: ChannelHealthListener): void;
	on(event: 'inbound' | 'health', cb: unknown): void {
		if (event === 'inbound')
			this.inboundListeners.add(cb as ChannelInboundListener);
		else this.healthListeners.add(cb as ChannelHealthListener);
	}
	off(event: 'inbound', cb: ChannelInboundListener): void;
	off(event: 'health', cb: ChannelHealthListener): void;
	off(event: 'inbound' | 'health', cb: unknown): void {
		if (event === 'inbound')
			this.inboundListeners.delete(cb as ChannelInboundListener);
		else this.healthListeners.delete(cb as ChannelHealthListener);
	}
	emitInbound(msg: NormalizedInbound): void {
		for (const cb of this.inboundListeners) cb(msg);
	}
}

function tmpPaths(): GatewayPaths {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-gw-m5-'));
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

const inbound: NormalizedInbound = {
	location: {
		channelId: 'fake',
		accountId: 'a',
		peer: {id: '12345', kind: 'user'},
	},
	sender: {id: '99', displayName: 'alice'},
	text: 'hello bot',
	receivedAt: 100,
	idempotencyKey: 'fk:1',
	providerMessageId: '5',
};

describe('M5 session flow', () => {
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

	it('round-trips inbound → dispatch.turn push → turn.complete → send()', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);

		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();
		const client = await connect({socketPath: paths.socketPath, token});
		try {
			const dispatchPushed =
				vi.fn<(p: SessionDispatchTurnPushPayload) => void>();
			client.onPush('session.dispatch.turn', env =>
				dispatchPushed(env.payload as SessionDispatchTurnPushPayload),
			);

			await client.request('session.register', {
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 9999,
			});

			adapter.emitInbound(inbound);

			await waitUntil(() => dispatchPushed.mock.calls.length === 1);
			const pushed = dispatchPushed.mock.calls[0]?.[0];
			expect(pushed?.sessionKey).toBe('peer:fake:a:12345');
			expect(pushed?.agentId).toBe('main');
			expect(pushed?.inbound.idempotencyKey).toBe('fk:1');
			const dispatchId = pushed?.dispatchId ?? '';
			expect(dispatchId.length).toBeGreaterThan(0);

			const reply = await client.request<
				{
					runtimeId: string;
					dispatchId: string;
					location: typeof inbound.location;
					text: string;
					idempotencyKey: string;
				},
				{delivered: boolean; providerMessageId?: string}
			>('session.turn.complete', {
				runtimeId: 'r1',
				dispatchId,
				location: inbound.location,
				text: 'hi back',
				idempotencyKey: 'reply:1',
			});
			expect(reply).toEqual({delivered: true, providerMessageId: 'pm1'});
			expect(adapter.sentMessages[0]?.text).toBe('hi back');
		} finally {
			client.close();
		}
	});

	it('rejects duplicate session.register with already_registered code', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();
		const client1 = await connect({socketPath: paths.socketPath, token});
		const client2 = await connect({socketPath: paths.socketPath, token});
		try {
			await client1.request('session.register', {
				runtimeId: 'r1',
				defaultAgentId: 'main',
				pid: 1,
			});
			await expect(
				client2.request('session.register', {
					runtimeId: 'r2',
					defaultAgentId: 'main',
					pid: 2,
				}),
			).rejects.toThrow(/already_registered/);
		} finally {
			client1.close();
			client2.close();
		}
	});

	it('cleans up registration when the runtime connection closes', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();
		const c1 = await connect({socketPath: paths.socketPath, token});
		await c1.request('session.register', {
			runtimeId: 'r1',
			defaultAgentId: 'main',
			pid: 1,
		});
		c1.close();
		await waitUntil(() => daemon!.registry.getCurrent() === null);
		// After cleanup, a fresh runtime can register.
		const c2 = await connect({socketPath: paths.socketPath, token});
		try {
			await c2.request('session.register', {
				runtimeId: 'r2',
				defaultAgentId: 'main',
				pid: 2,
			});
			expect(daemon!.registry.getCurrent()?.runtimeId).toBe('r2');
		} finally {
			c2.close();
		}
	});
});

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return;
		await new Promise(r => setTimeout(r, 10));
	}
	throw new Error('timeout waiting for condition');
}
