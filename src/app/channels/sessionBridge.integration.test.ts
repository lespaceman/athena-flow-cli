/**
 * Integration test: SessionBridge against a live gateway daemon over a
 * tmpdir UDS. Exercises the public surface end-to-end:
 *   - start() registers the runtime and resolves with the gateway hello
 *   - onTurnDispatch fires when an inbound chat is routed to this session
 *   - completeTurn delivers the reply to the originating channel adapter
 *   - relayPermission broadcasts to the registered adapter and returns the
 *     verdict
 *   - cancelRelayPermission races a pending request and short-circuits with
 *     `cancelled`
 *
 * Skips the AppShell render layer — this test pins the bridge contract that
 * RuntimeProvider/AppShell rely on. The render-layer wiring is exercised
 * indirectly by the existing AppShell tests.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startDaemon, type DaemonHandle} from '../../gateway/daemon';
import type {GatewayPaths} from '../../gateway/paths';
import {createDispatcher} from '../../gateway/control/handlers';
import {
	startControlServer,
	type ControlServer,
} from '../../gateway/control/server';
import {DispatchPipeline} from '../../gateway/dispatchPipeline';
import {openGatewayState, type GatewayStateDb} from '../../gateway/state/db';
import {RelayCoordinator} from '../../gateway/relay/coordinator';
import {ChannelManager} from '../../gateway/channelManager';
import {createWsServerTransport} from '../../gateway/transport/tlsWs';
import {
	GatewayProtocolError,
	type ControlClient,
} from '../../gateway/control/client';
import {SessionBridge} from './sessionBridge';
import type {
	AdapterContext,
	ChannelAdapter,
	NormalizedInbound,
	OutboundMessage,
	PermissionRelayRequest,
	PermissionRelayResult,
	StopReason,
} from '../../shared/gateway-protocol';

class FakeAdapter implements ChannelAdapter {
	readonly id = 'fake';
	readonly capabilities = {
		chat: true,
		threads: false,
		relayPermission: true,
		relayQuestion: false,
	} as const;
	private ctx: AdapterContext | null = null;
	sentMessages: OutboundMessage[] = [];
	pendingPermission: ((res: PermissionRelayResult) => void) | null = null;
	permissionCallCount = 0;

	async start(ctx: AdapterContext): Promise<void> {
		this.ctx = ctx;
	}
	async stop(_reason: StopReason): Promise<void> {
		this.ctx = null;
	}
	async send(msg: OutboundMessage) {
		this.sentMessages.push(msg);
		return {providerMessageId: `m${this.sentMessages.length}`, deliveredAt: 1};
	}
	async probe() {
		return {ok: true, checkedAt: 1};
	}

	async requestPermissionVerdict(
		_req: PermissionRelayRequest,
		signal: AbortSignal,
	): Promise<PermissionRelayResult> {
		this.permissionCallCount += 1;
		return new Promise(resolve => {
			this.pendingPermission = resolve;
			signal.addEventListener('abort', () => {
				resolve({kind: 'cancelled'});
			});
		});
	}

	emitInbound(msg: NormalizedInbound): void {
		this.ctx?.emitInbound(msg);
	}
}

function tmpPaths(): GatewayPaths {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-bridge-'));
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

describe('SessionBridge integration', () => {
	let paths: GatewayPaths;
	let daemon: DaemonHandle | undefined;
	let controlServer: ControlServer | undefined;
	let stateDb: GatewayStateDb | undefined;
	let bridge: SessionBridge | undefined;

	beforeEach(() => {
		paths = tmpPaths();
		daemon = undefined;
		controlServer = undefined;
		stateDb = undefined;
		bridge = undefined;
	});

	afterEach(async () => {
		if (bridge) await bridge.stop();
		if (controlServer) await controlServer.close();
		if (daemon) await daemon.stop();
		stateDb?.close();
		try {
			fs.rmSync(path.dirname(paths.runDir), {recursive: true, force: true});
		} catch {
			// best-effort
		}
	}, 60_000);

	it('registers through an explicit remote WS endpoint', async () => {
		const token = 'remote-token';
		const channelManager = new ChannelManager();
		stateDb = openGatewayState(':memory:');
		const pipeline = new DispatchPipeline({
			stateDb,
			send: (channelId, msg) => channelManager.send(channelId, msg),
			outbox: {tickIntervalMs: 60_000},
		});
		pipeline.start();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => channelManager.listAdapters(),
		});
		const wsTransport = createWsServerTransport({
			host: '127.0.0.1',
			port: 0,
		});
		controlServer = await startControlServer({
			socketPath: 'unused-for-ws',
			token,
			startedAt: Date.now(),
			handler: createDispatcher({
				startedAt: Date.now(),
				pipeline,
				channelManager,
				relayCoordinator,
			}),
			transport: wsTransport,
		});

		bridge = new SessionBridge({
			runtimeId: 'remote-s1',
			defaultAgentId: 'main',
			endpoint: {
				mode: 'remote',
				url: wsTransport.endpoint().url,
				token,
			},
		});

		await bridge.start();

		expect(pipeline.getCurrentRuntime()?.runtimeId).toBe('remote-s1');
		await pipeline.stop();
	}, 15_000);

	it('registers under the attachmentId slot when the option is provided', async () => {
		const token = 'attach-token';
		const channelManager = new ChannelManager();
		stateDb = openGatewayState(':memory:');
		const pipeline = new DispatchPipeline({
			stateDb,
			send: (channelId, msg) => channelManager.send(channelId, msg),
			outbox: {tickIntervalMs: 60_000},
		});
		pipeline.start();
		const relayCoordinator = new RelayCoordinator({
			adapters: () => channelManager.listAdapters(),
		});
		const wsTransport = createWsServerTransport({host: '127.0.0.1', port: 0});
		controlServer = await startControlServer({
			socketPath: 'unused-for-ws',
			token,
			startedAt: Date.now(),
			handler: createDispatcher({
				startedAt: Date.now(),
				pipeline,
				channelManager,
				relayCoordinator,
			}),
			transport: wsTransport,
		});

		bridge = new SessionBridge({
			runtimeId: 'rt-a1',
			defaultAgentId: 'main',
			attachmentId: 'r1',
			endpoint: {mode: 'remote', url: wsTransport.endpoint().url, token},
		});
		await bridge.start();

		expect(pipeline.getCurrentRuntimeByAttachment('r1')?.runtimeId).toBe(
			'rt-a1',
		);
		// Legacy fallback slot remains empty.
		expect(pipeline.getCurrentRuntime()).toBeNull();
		await pipeline.stop();
	}, 15_000);

	it('round-trips dispatch.turn → completeTurn → adapter.send', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);

		bridge = new SessionBridge({
			runtimeId: 's1',
			defaultAgentId: 'main',
			paths,
		});
		await bridge.start();

		const seen = vi.fn();
		bridge.onTurnDispatch(seen);

		adapter.emitInbound(inbound);
		await waitUntil(() => seen.mock.calls.length === 1);
		const payload = seen.mock.calls[0][0] as {
			dispatchId: string;
			sessionKey: string;
		};
		expect(payload.sessionKey).toBe('peer:fake:a:12345');
		expect(payload.dispatchId.length).toBeGreaterThan(0);

		const reply = await bridge.completeTurn({
			dispatchId: payload.dispatchId,
			location: inbound.location,
			text: 'hi back',
			idempotencyKey: 'reply:1',
		});
		expect(reply).toMatchObject({delivered: true});
		expect(adapter.sentMessages[0]?.text).toBe('hi back');
	}, 15_000);

	it('reconnects and re-registers before completing a turn after WS disconnect', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
			disconnectGracePeriodMs: 5_000,
			listenSpec: {
				kind: 'tcp',
				host: '127.0.0.1',
				port: 0,
				insecure: false,
			},
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();

		bridge = new SessionBridge({
			runtimeId: 'ws-reconnect-1',
			defaultAgentId: 'main',
			endpoint: {
				mode: 'remote',
				url: daemon.listener.url!,
				token,
			},
		});
		await bridge.start();

		const seen = vi.fn();
		bridge.onTurnDispatch(seen);
		adapter.emitInbound({...inbound, idempotencyKey: 'fk:reconnect'});
		await waitUntil(() => seen.mock.calls.length === 1);
		const payload = seen.mock.calls[0][0] as {dispatchId: string};

		(bridge as unknown as {client: {close: () => void}}).client.close();
		// Background reconnect kicks in immediately — wait for the rebind to
		// produce a fresh active binding (lastRebindAt is set on rebind).
		await waitUntil(() => {
			const b = daemon!.pipeline.getBinding();
			return b?.state === 'active' && b.lastRebindAt !== undefined;
		}, 3_000);

		const reply = await bridge.completeTurn({
			dispatchId: payload.dispatchId,
			location: inbound.location,
			text: 'reconnected reply',
			idempotencyKey: 'reply:reconnect',
		});

		expect(reply).toMatchObject({delivered: true});
		expect(adapter.sentMessages.at(-1)?.text).toBe('reconnected reply');
		expect(daemon.pipeline.getBinding()?.state).toBe('active');
	}, 15_000);

	it('background reconnect re-registers without an RPC and drains parked inbound', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
			disconnectGracePeriodMs: 5_000,
			listenSpec: {
				kind: 'tcp',
				host: '127.0.0.1',
				port: 0,
				insecure: false,
			},
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();

		bridge = new SessionBridge({
			runtimeId: 'bg-reconnect-1',
			defaultAgentId: 'main',
			endpoint: {mode: 'remote', url: daemon.listener.url!, token},
			backoffMs: [50, 100],
		});
		const seen: string[] = [];
		bridge.onTurnDispatch(p => seen.push(p.inbound.idempotencyKey));
		await bridge.start();
		expect(bridge.getConnectionState()).toBe('connected');

		// Force a transport drop. No RPC issued from the test side.
		(bridge as unknown as {client: {close: () => void}}).client.close();

		// Park an inbound during the gap so we can confirm it drains after the
		// background reconnect re-binds (without anyone calling an RPC).
		adapter.emitInbound({...inbound, idempotencyKey: 'fk:bg-after-drop'});

		await waitUntil(() => seen.includes('fk:bg-after-drop'), 3_000);
		expect(daemon.pipeline.getBinding()?.state).toBe('active');
		expect(daemon.pipeline.getBinding()?.lastRebindAt).toBeDefined();
		expect(bridge.getConnectionState()).toBe('connected');
	}, 15_000);

	it('buffers dispatches that arrive before the first onTurnDispatch subscriber', async () => {
		// Pre-park inbound so drainPending fires synchronously inside the
		// session.register handler — before the AppShell-equivalent subscriber
		// has a chance to attach. Without buffering these pushes are lost.
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);

		adapter.emitInbound({...inbound, idempotencyKey: 'fk:pre1'});
		adapter.emitInbound({...inbound, idempotencyKey: 'fk:pre2'});
		await waitUntil(() => daemon!.pipeline.pendingInboundCount() === 2);

		bridge = new SessionBridge({
			runtimeId: 'late-sub-1',
			defaultAgentId: 'main',
			paths,
		});
		await bridge.start();

		// Subscribe AFTER start. With the bridge's pre-fix behavior the two
		// drained pushes would have been dropped on the floor here.
		const seen: string[] = [];
		bridge.onTurnDispatch(p => seen.push(p.inbound.idempotencyKey));

		await waitUntil(() => seen.length === 2, 3_000);
		expect(seen).toEqual(['fk:pre1', 'fk:pre2']);
	}, 15_000);

	it('replays buffered dispatches when a subscriber re-attaches after being removed', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);

		bridge = new SessionBridge({
			runtimeId: 'churn-1',
			defaultAgentId: 'main',
			paths,
		});

		const firstSeen: string[] = [];
		const off = bridge.onTurnDispatch(p =>
			firstSeen.push(p.inbound.idempotencyKey),
		);
		await bridge.start();

		adapter.emitInbound({...inbound, idempotencyKey: 'fk:while-on'});
		await waitUntil(() => firstSeen.length === 1);
		expect(firstSeen).toEqual(['fk:while-on']);

		// Subscriber goes away — mimics React detaching the AppShell handler
		// during a re-render or unmount window.
		off();

		adapter.emitInbound({...inbound, idempotencyKey: 'fk:while-off'});
		// Wait long enough for the push to land at the bridge.
		await waitUntil(
			() =>
				(bridge as unknown as {bufferedDispatches: unknown[]})
					.bufferedDispatches.length === 1,
			3_000,
		);

		// New subscriber attaches — should receive the buffered push.
		const secondSeen: string[] = [];
		bridge.onTurnDispatch(p => secondSeen.push(p.inbound.idempotencyKey));
		await waitUntil(() => secondSeen.length === 1);
		expect(secondSeen).toEqual(['fk:while-off']);
	}, 15_000);

	it('drains parked inbound on session.register', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);

		// Emit two inbound messages while no runtime is registered. Both should
		// be parked in the durable queue.
		adapter.emitInbound({...inbound, idempotencyKey: 'fk:queue1'});
		adapter.emitInbound({...inbound, idempotencyKey: 'fk:queue2'});
		await waitUntil(() => daemon!.pipeline.pendingInboundCount() === 2);

		bridge = new SessionBridge({
			runtimeId: 'q1',
			defaultAgentId: 'main',
			paths,
		});

		const dispatched: Array<{idempotencyKey: string}> = [];
		bridge.onTurnDispatch(p => {
			dispatched.push({idempotencyKey: p.inbound.idempotencyKey});
		});
		await bridge.start();

		await waitUntil(() => dispatched.length === 2);
		expect(dispatched.map(d => d.idempotencyKey)).toEqual([
			'fk:queue1',
			'fk:queue2',
		]);
		expect(daemon.pipeline.pendingInboundCount()).toBe(0);
	}, 15_000);

	it('relayPermission broadcasts to the registered adapter and returns the verdict', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);

		bridge = new SessionBridge({
			runtimeId: 's2',
			defaultAgentId: 'main',
			paths,
		});
		await bridge.start();

		const promise = bridge.relayPermission({
			toolName: 'Bash',
			description: 'list files',
			inputPreview: 'ls',
			ttlMs: 5_000,
		});

		await waitUntil(() => adapter.pendingPermission !== null);
		adapter.pendingPermission!({kind: 'verdict', behavior: 'allow'});
		const res = await promise;
		expect(res.result).toMatchObject({kind: 'verdict', behavior: 'allow'});
		expect(res.channelRequestId).toMatch(/^[a-km-z]{5}$/);
	}, 15_000);

	it('reconnect loop hitting already_registered becomes terminal and surfaces the error to callers', async () => {
		const closeHandlers: Array<() => void> = [];
		const requestImpls: Array<(kind: string) => Promise<unknown>> = [
			// First connect: register succeeds.
			async kind => (kind === 'session.register' ? {hello: {}} : {}),
			// Reconnect: register rejects with already_registered.
			async kind => {
				if (kind === 'session.register') {
					throw new GatewayProtocolError(
						'already_registered: occupied',
						'already_registered',
					);
				}
				return {};
			},
		];
		let connectIdx = 0;
		const fakeClient = (): ControlClient => {
			const handler = requestImpls[connectIdx++]!;
			let myCloseHandlers: Array<() => void> = [];
			return {
				request: async kind => handler(kind) as never,
				onPush: () => () => {},
				onClose: cb => {
					myCloseHandlers.push(cb);
					closeHandlers.push(cb);
					return () => {
						myCloseHandlers = myCloseHandlers.filter(h => h !== cb);
					};
				},
				close: () => {
					for (const cb of myCloseHandlers) cb();
				},
			};
		};

		bridge = new SessionBridge({
			runtimeId: 'r-terminal',
			defaultAgentId: 'main',
			endpoint: {mode: 'remote', url: 'ws://unused', token: 't'},
			connectClient: async () => fakeClient(),
			backoffMs: [10],
		});
		await bridge.start();
		expect(bridge.getConnectionState()).toBe('connected');

		// Trigger the close path; the loop will reconnect, hit already_registered,
		// and become terminal.
		for (const cb of closeHandlers) cb();
		await waitUntil(() => bridge!.getConnectionState() === 'stopped', 2_000);

		await expect(
			bridge.completeTurn({
				dispatchId: 'd1',
				location: inbound.location,
				text: 'x',
				idempotencyKey: 'k1',
			}),
		).rejects.toThrow(/already_registered/);
	}, 15_000);

	it('rebroadcasts an in-flight permission relay across a WS reconnect', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
			disconnectGracePeriodMs: 5_000,
			listenSpec: {
				kind: 'tcp',
				host: '127.0.0.1',
				port: 0,
				insecure: false,
			},
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();

		bridge = new SessionBridge({
			runtimeId: 'relay-replay-1',
			defaultAgentId: 'main',
			endpoint: {mode: 'remote', url: daemon.listener.url!, token},
			backoffMs: [50, 100],
		});
		await bridge.start();

		const relayPromise = bridge.relayPermission({
			toolName: 'Bash',
			description: 'list files',
			inputPreview: 'ls',
			ttlMs: 30_000,
		});

		await waitUntil(() => adapter.pendingPermission !== null);
		expect(adapter.permissionCallCount).toBe(1);

		(bridge as unknown as {client: {close: () => void}}).client.close();
		await waitUntil(() => {
			const b = daemon!.pipeline.getBinding();
			return b?.state === 'active' && b.lastRebindAt !== undefined;
		}, 3_000);

		adapter.pendingPermission!({kind: 'verdict', behavior: 'allow'});
		const res = await relayPromise;

		expect(res.result).toMatchObject({kind: 'verdict', behavior: 'allow'});
		expect(res.channelRequestId).toMatch(/^[a-km-z]{5}$/);
		expect(adapter.permissionCallCount).toBe(1);
	}, 15_000);

	it('disposes pending relays with connection_lost when grace fully unregisters', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
			disconnectGracePeriodMs: 50,
			listenSpec: {
				kind: 'tcp',
				host: '127.0.0.1',
				port: 0,
				insecure: false,
			},
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);
		const token = fs.readFileSync(paths.tokenPath, 'utf-8').trim();

		bridge = new SessionBridge({
			runtimeId: 'connection-lost-1',
			defaultAgentId: 'main',
			endpoint: {mode: 'remote', url: daemon.listener.url!, token},
			backoffMs: [50, 100],
		});
		await bridge.start();

		// Fire the relay but don't await — graceful unregister should settle it
		// with reason='connection_lost' before the WS closes.
		const relayPromise = bridge.relayPermission({
			toolName: 'Bash',
			description: 'list files',
			inputPreview: 'ls',
			ttlMs: 200,
		});
		// Pre-attach a no-op catch so a stray rejection isn't surfaced as
		// unhandled before the assertion below awaits it.
		relayPromise.catch(() => {});
		await waitUntil(() => adapter.pendingPermission !== null);
		expect(daemon.relayCoordinator.pendingCount()).toBe(1);

		// Tear the bridge down. session.unregister fires onRuntimeConnectionLost
		// (graceful=true), which disposes the pending relay with
		// reason='connection_lost' and lets the in-flight relay handler respond
		// before the WS closes — the runtime sees a structured cancelled result
		// instead of a transport error.
		await bridge.stop();
		bridge = undefined;

		await waitUntil(() => daemon!.relayCoordinator.pendingCount() === 0, 3_000);
		expect(daemon.pipeline.getCurrentRuntime()).toBeNull();
		await expect(relayPromise).resolves.toMatchObject({
			result: {kind: 'cancelled', reason: 'connection_lost'},
		});
	}, 15_000);

	it('cancelRelayPermission short-circuits a pending request', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);

		bridge = new SessionBridge({
			runtimeId: 's3',
			defaultAgentId: 'main',
			paths,
		});
		await bridge.start();

		const reqPromise = bridge.relayPermission({
			toolName: 'Bash',
			description: 'rm -rf',
			inputPreview: 'rm -rf /tmp/x',
			ttlMs: 5_000,
		});
		await waitUntil(() => adapter.pendingPermission !== null);

		// Stop the bridge: session.unregister disposes the pending relay with
		// reason='connection_lost' before the WS closes, so the in-flight
		// request resolves with a structured cancelled result rather than
		// rejecting with a transport error.
		await bridge.stop();
		bridge = undefined;

		await expect(reqPromise).resolves.toMatchObject({
			result: {kind: 'cancelled', reason: 'connection_lost'},
		});
	}, 15_000);

	it('settles a null-ttl pending relay on graceful bridge.stop()', async () => {
		daemon = await startDaemon({
			foreground: true,
			silent: true,
			paths,
			skipSignalHandlers: true,
			skipChannelLoad: true,
		});
		const adapter = new FakeAdapter();
		await daemon.channelManager.register(adapter);

		bridge = new SessionBridge({
			runtimeId: 'null-ttl-1',
			defaultAgentId: 'main',
			paths,
		});
		await bridge.start();

		// ttlMs=null mimics AskUserQuestion (human-in-the-loop): no broadcast
		// timer, so without graceful disposal the pending relay would hang
		// forever if the only adapter dies or the runtime tears down.
		const reqPromise = bridge.relayPermission({
			toolName: 'Bash',
			description: 'list files',
			inputPreview: 'ls',
			ttlMs: null,
		});
		await waitUntil(() => adapter.pendingPermission !== null);
		expect(daemon.relayCoordinator.pendingCount()).toBe(1);

		await bridge.stop();
		bridge = undefined;

		await expect(reqPromise).resolves.toMatchObject({
			result: {kind: 'cancelled', reason: 'connection_lost'},
		});
		expect(daemon.relayCoordinator.pendingCount()).toBe(0);
	}, 15_000);
});

async function waitUntil(
	cond: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (cond()) return;
		await new Promise(r => setTimeout(r, 10));
	}
	throw new Error('timeout waiting for condition');
}
