/**
 * GatewayDaemon — long-running process that owns channel adapters, brokers
 * cloud function invocations, and dispatches inbound chats to a registered
 * Athena interactive runtime over a UDS NDJSON control plane.
 *
 * M3 wired lock acquisition, token loading, and the control-plane server.
 * M5 adds the channel manager + session registry + dispatcher and routes
 * push frames to whichever connection has the registered runtime. Channel
 * registration from config and the cloud function invoker land in M6+.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import {loadChannelSidecars} from '../infra/config/channels';
import {instantiateAdapter} from './adapters/factory';
import {loadOrCreateToken, requireTokenForBind} from './auth';
import {ChannelManager} from './channelManager';
import {createDispatcher} from './control/handlers';
import {
	startControlServer,
	type ConnectionContext,
	type ControlServer,
} from './control/server';
import {Dispatcher} from './dispatcher';
import {acquireLock, type LockHandle} from './lock';
import {
	isLoopbackHost,
	resolveGatewayPaths,
	resolveListenSpec,
	type GatewayListenSpec,
	type GatewayPaths,
} from './paths';
import {OutboundDispatcher} from './outboundDispatcher';
import {RelayCoordinator} from './relay/coordinator';
import {SessionRegistry} from './sessionRegistry';
import {openGatewayState, type GatewayStateDb} from './state/db';
import {InboundQueue} from './state/inboundQueue';
import {Outbox} from './state/outbox';
import {createWsServerTransport} from './transport/tlsWs';
import {writeGatewayTrace} from './transport/trace';

export type DaemonOptions = {
	/** When true the daemon stays in foreground (no detach). */
	foreground: boolean;
	silent?: boolean;
	paths?: GatewayPaths;
	env?: NodeJS.ProcessEnv;
	skipSignalHandlers?: boolean;
	/**
	 * When true, skip loading `~/.config/athena/channels/*.json` sidecars on
	 * startup. Tests use this to keep the daemon adapter-free.
	 */
	skipChannelLoad?: boolean;
	/**
	 * Keep a runtime registration alive after its transport disconnects. Local
	 * UDS mode uses the historical immediate cleanup default; remote mode will
	 * set this to 60s when non-loopback listener support lands.
	 */
	disconnectGracePeriodMs?: number;
	listenSpec?: GatewayListenSpec;
};

export type DaemonHandle = {
	startedAt: number;
	pid: number;
	paths: GatewayPaths;
	registry: SessionRegistry;
	dispatcher: Dispatcher;
	channelManager: ChannelManager;
	relayCoordinator: RelayCoordinator;
	inboundQueue: InboundQueue;
	outbox: Outbox;
	outboundDispatcher: OutboundDispatcher;
	listener: {
		kind: GatewayListenSpec['kind'];
		socketPath?: string;
		url?: string;
		host?: string;
		port?: number;
	};
	stop: () => Promise<void>;
};

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
	const startedAt = Date.now();
	const pid = process.pid;
	const paths = opts.paths ?? resolveGatewayPaths(opts.env);

	fs.mkdirSync(paths.runDir, {recursive: true, mode: 0o700});
	fs.mkdirSync(paths.configDir, {recursive: true, mode: 0o700});
	if (process.platform !== 'win32') {
		try {
			fs.chmodSync(paths.runDir, 0o700);
			fs.chmodSync(paths.configDir, 0o700);
		} catch {
			// best-effort
		}
	}

	const lock: LockHandle = acquireLock(paths.lockPath);
	const token = loadOrCreateToken(paths.tokenPath);
	const listenSpec = opts.listenSpec ?? resolveListenSpec({paths});
	requireTokenForBind(listenSpec, token);

	const stateDb: GatewayStateDb = openGatewayState(paths.statePath);
	const inboundQueue = new InboundQueue(stateDb);
	const outbox = new Outbox(stateDb);

	const registry = new SessionRegistry();
	const channelManager = new ChannelManager();
	const relayCoordinator = new RelayCoordinator({
		adapters: () => channelManager.listAdapters(),
	});

	// Push frames target the connection that registered as the runtime. The
	// map is the only state the daemon keeps about active connections.
	const runtimeConnections = new Map<string, ConnectionContext>();
	const staleRuntimeTimers = new Map<string, NodeJS.Timeout>();
	const disconnectGracePeriodMs = opts.disconnectGracePeriodMs ?? 0;
	const pushDispatch = (
		payload: import('../shared/gateway-protocol').SessionDispatchTurnPushPayload,
	): void => {
		const current = registry.getCurrent();
		if (!current) return;
		const ctx = runtimeConnections.get(current.runtimeId);
		if (!ctx) return;
		ctx.push({
			push_id: crypto.randomUUID(),
			ts: Date.now(),
			kind: 'session.dispatch.turn',
			payload,
		});
	};
	const log = (
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
	): void => {
		if (opts.silent) return;
		const stream = level === 'error' || level === 'warn' ? 'stderr' : 'stdout';
		process[stream].write(`athena-gateway: [${level}] ${message}\n`);
	};

	const outboundDispatcher = new OutboundDispatcher({
		outbox,
		send: (channelId, msg) => channelManager.send(channelId, msg),
		log,
	});
	outboundDispatcher.start();

	const dispatcher = new Dispatcher({
		registry,
		pushDispatch,
		canDispatch: () => {
			const current = registry.getCurrent();
			return current ? registry.hasActiveBinding(current.runtimeId) : false;
		},
		sendOutbound: async (channelId, msg) => {
			const result = await outboundDispatcher.dispatch(channelId, msg);
			if (result.kind === 'sent') return result.result;
			// Queued: return a synthetic SendResult so the caller knows the
			// message has been accepted for eventual delivery. The real
			// providerMessageId is unknown until a retry succeeds.
			return {
				providerMessageId: `outbox:${result.outboxId}`,
				deliveredAt: Date.now(),
			};
		},
		inboundQueue,
		log,
	});
	channelManager.setInboundSink(inbound => {
		dispatcher.handleInbound(inbound);
	});

	if (!opts.skipChannelLoad) {
		const {sidecars, errors} = loadChannelSidecars();
		for (const err of errors) {
			process.stderr.write(
				`athena-gateway: skipping ${err.path}: ${err.reason}\n`,
			);
		}
		for (const sidecar of sidecars) {
			const built = instantiateAdapter(sidecar);
			if (!built.ok) {
				process.stderr.write(
					`athena-gateway: ${sidecar.name}: ${built.reason}\n`,
				);
				continue;
			}
			try {
				await channelManager.register(built.adapter);
				if (!opts.silent) {
					process.stdout.write(`athena-gateway: registered ${sidecar.name}\n`);
				}
			} catch (err) {
				process.stderr.write(
					`athena-gateway: register ${sidecar.name} failed: ${
						err instanceof Error ? err.message : String(err)
					}\n`,
				);
			}
		}
	}

	const handler = createDispatcher({
		startedAt,
		registry,
		dispatcher,
		channelManager,
		relayCoordinator,
		registerRuntimeConnection: (runtimeId, ctx) => {
			const timer = staleRuntimeTimers.get(runtimeId);
			if (timer) {
				clearTimeout(timer);
				staleRuntimeTimers.delete(runtimeId);
			}
			registry.bindConnection(runtimeId, ctx.connectionId);
			runtimeConnections.set(runtimeId, ctx);
			writeGatewayTrace(
				`daemon registered runtime runtimeId=${runtimeId} connectionId=${ctx.connectionId}`,
			);
		},
		unregisterRuntimeConnection: runtimeId => {
			const timer = staleRuntimeTimers.get(runtimeId);
			if (timer) {
				clearTimeout(timer);
				staleRuntimeTimers.delete(runtimeId);
			}
			runtimeConnections.delete(runtimeId);
			writeGatewayTrace(`daemon unregistered runtime runtimeId=${runtimeId}`);
		},
	});

	let server: ControlServer;
	let listener: DaemonHandle['listener'];
	try {
		const transport =
			listenSpec.kind === 'tcp'
				? createWsServerTransport({
						host: listenSpec.host,
						port: listenSpec.port,
						allowNonLoopback: listenSpec.insecure || Boolean(listenSpec.tls),
						...(listenSpec.tls ? {tls: listenSpec.tls} : {}),
					})
				: undefined;
		server = await startControlServer({
			socketPath: paths.socketPath,
			token,
			startedAt,
			handler,
			...(transport !== undefined ? {transport} : {}),
			onDisconnect: ctx => {
				// If the registered runtime's connection drops without unregister,
				// either clean up immediately (local default) or keep the registration
				// stale for a remote reconnect grace window.
				const current = registry.getCurrent();
				if (
					current &&
					runtimeConnections.get(current.runtimeId)?.connectionId ===
						ctx.connectionId
				) {
					writeGatewayTrace(
						`daemon runtime connection disconnected runtimeId=${current.runtimeId} connectionId=${ctx.connectionId}`,
					);
					runtimeConnections.delete(current.runtimeId);
					registry.markConnectionStale(ctx.connectionId);
					if (disconnectGracePeriodMs <= 0) {
						try {
							registry.unregister(current.runtimeId);
						} catch {
							// already unregistered
						}
						// Single-runtime v1: blanket dispose is safe. Multi-runtime
						// must scope this to the disconnecting runtime via
						// disposeAllForRuntime(runtimeId, reason).
						relayCoordinator.disposeAll('connection_lost');
						return;
					}
					const runtimeId = current.runtimeId;
					const timer = setTimeout(() => {
						staleRuntimeTimers.delete(runtimeId);
						const latest = registry.getCurrent();
						if (
							latest?.runtimeId === runtimeId &&
							!registry.hasActiveBinding(runtimeId)
						) {
							try {
								registry.unregister(runtimeId);
							} catch {
								// already unregistered
							}
							// Single-runtime v1: blanket dispose is safe. Multi-runtime
							// must scope this to runtimeId.
							relayCoordinator.disposeAll('connection_lost');
						}
					}, disconnectGracePeriodMs);
					staleRuntimeTimers.set(runtimeId, timer);
				}
			},
		});
		if (listenSpec.kind === 'tcp') {
			const endpoint = transport!.endpoint();
			listener = {
				kind: 'tcp',
				host: endpoint.host,
				port: endpoint.port,
				url: endpoint.url,
			};
		} else {
			listener = {kind: 'uds', socketPath: listenSpec.socketPath};
		}
	} catch (err) {
		lock.release();
		throw err;
	}

	if (!opts.silent) {
		const target =
			listener.kind === 'tcp' ? listener.url : `socket=${paths.socketPath}`;
		process.stdout.write(`athena-gateway: ok pid=${pid} ${target}\n`);
	}
	if (
		listenSpec.kind === 'tcp' &&
		listenSpec.insecure &&
		!listenSpec.tls &&
		!isLoopbackHost(listenSpec.host)
	) {
		process.stderr.write(
			`athena-gateway: WARNING --insecure is set on a non-loopback bind (${listenSpec.host}:${listenSpec.port}); ` +
				`token travels in plaintext. Use only behind TLS-terminating reverse proxy or Tailscale/WireGuard tunnel.\n`,
		);
	}

	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		try {
			outboundDispatcher.stop();
			for (const timer of staleRuntimeTimers.values()) {
				clearTimeout(timer);
			}
			staleRuntimeTimers.clear();
			relayCoordinator.disposeAll('auto_resolved');
			await channelManager.stop();
			await server.close();
		} finally {
			try {
				stateDb.close();
			} catch {
				// best-effort
			}
			lock.release();
		}
	};

	if (!opts.skipSignalHandlers) {
		const onSignal = (signal: NodeJS.Signals) => {
			process.stderr.write(`athena-gateway: received ${signal}, stopping\n`);
			void stop().then(() => process.exit(0));
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	}

	return {
		startedAt,
		pid,
		paths,
		registry,
		dispatcher,
		channelManager,
		relayCoordinator,
		inboundQueue,
		outbox,
		outboundDispatcher,
		listener,
		stop,
	};
}
