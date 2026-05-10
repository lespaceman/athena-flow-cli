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

import fs from 'node:fs';
import {loadChannelSidecars} from '../infra/config/channels';
import {instantiateAdapter} from './adapters/factory';
import {loadOrCreateToken, requireTokenForBind} from './auth';
import {ChannelManager} from './channelManager';
import {createDispatcher} from './control/handlers';
import {startControlServer, type ControlServer} from './control/server';
import {DispatchPipeline} from './dispatchPipeline';
import {acquireLock, type LockHandle} from './lock';
import {
	isLoopbackHost,
	resolveGatewayPaths,
	resolveListenSpec,
	type GatewayListenSpec,
	type GatewayPaths,
} from './paths';
import {RelayCoordinator} from './relay/coordinator';
import {openGatewayState, type GatewayStateDb} from './state/db';
import {createWsServerTransport} from './transport/tlsWs';
import {
	trackGatewayRuntimeExpired,
	trackGatewayRuntimeRebind,
	trackGatewayTransportConnect,
	trackGatewayTransportDisconnect,
} from '../infra/telemetry/events';
import type {
	ChannelReloadResult,
	ListenerStatusEntry,
} from '../shared/gateway-protocol';

function buildListenerStatus(
	spec: GatewayListenSpec,
	resolvedPort: number | null,
): ListenerStatusEntry {
	if (spec.kind === 'uds') {
		return {kind: 'uds', socketPath: spec.socketPath};
	}
	const port = resolvedPort ?? spec.port;
	const tls = Boolean(spec.tls);
	const scheme = tls ? 'wss' : 'ws';
	return {
		kind: 'tcp',
		host: spec.host,
		port,
		url: `${scheme}://${spec.host}:${port}`,
		tls,
		insecure: spec.insecure,
		loopback: isLoopbackHost(spec.host),
	};
}

function pathIdFromSidecarPath(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

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
	pipeline: DispatchPipeline;
	channelManager: ChannelManager;
	relayCoordinator: RelayCoordinator;
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

	const listenerHints = {
		transport: (listenSpec.kind === 'tcp' ? 'ws' : 'uds') as 'ws' | 'uds',
		tls: listenSpec.kind === 'tcp' && Boolean(listenSpec.tls),
		loopback: listenSpec.kind === 'uds' || isLoopbackHost(listenSpec.host),
	};

	const stateDb: GatewayStateDb = openGatewayState(paths.statePath);

	const channelManager = new ChannelManager();
	const relayCoordinator = new RelayCoordinator({
		adapters: () => channelManager.listAdapters(),
	});

	const connectionOpenedAt = new Map<string, number>();
	const disconnectGracePeriodMs = opts.disconnectGracePeriodMs ?? 0;
	let listenerStatus: ListenerStatusEntry | null = null;
	const log = (
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
	): void => {
		if (opts.silent) return;
		const stream = level === 'error' || level === 'warn' ? 'stderr' : 'stdout';
		process[stream].write(`athena-gateway: [${level}] ${message}\n`);
	};

	const pipeline = new DispatchPipeline({
		stateDb,
		send: (channelId, msg) => channelManager.send(channelId, msg),
		gracePeriodMs: disconnectGracePeriodMs,
		log,
		observers: {
			onRuntimeRebind: ({gapMs, epoch}) =>
				trackGatewayRuntimeRebind({gapMs, epoch}),
			onRuntimeExpired: ({gapMs}) => trackGatewayRuntimeExpired({gapMs}),
			// Single-runtime v1: blanket dispose is safe. Multi-runtime must
			// scope to the disconnecting runtime via disposeAllForRuntime.
			onRuntimeConnectionLost: () =>
				relayCoordinator.disposeAll('connection_lost'),
		},
	});
	pipeline.start();

	channelManager.setInboundSink((inbound, ctx) => {
		pipeline.handleInbound(inbound, ctx);
	});

	const channelConfigHome = opts.env?.HOME;
	const reloadChannels = async (): Promise<{
		results: ChannelReloadResult[];
	}> => {
		const results: ChannelReloadResult[] = [];
		const {sidecars, errors} = loadChannelSidecars(channelConfigHome);
		for (const err of errors) {
			const id = pathIdFromSidecarPath(err.path);
			results.push({
				id,
				ok: false,
				action: 'failed',
				reason: err.reason,
			});
		}

		const sidecarIds = new Set(sidecars.map(s => s.instanceId));
		for (const channel of channelManager.listChannels()) {
			if (sidecarIds.has(channel.id)) continue;
			try {
				await channelManager.unregister(channel.id, 'shutdown');
				results.push({
					id: channel.id,
					ok: true,
					action: 'unregistered',
				});
			} catch (err) {
				results.push({
					id: channel.id,
					ok: false,
					action: 'failed',
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		}

		for (const sidecar of sidecars) {
			const existed = channelManager
				.listChannels()
				.some(channel => channel.id === sidecar.instanceId);
			if (existed) {
				try {
					await channelManager.unregister(sidecar.instanceId, 'shutdown');
				} catch (err) {
					results.push({
						id: sidecar.instanceId,
						ok: false,
						action: 'failed',
						reason: err instanceof Error ? err.message : String(err),
					});
					continue;
				}
			}
			const built = instantiateAdapter(sidecar);
			if (!built.ok) {
				results.push({
					id: sidecar.instanceId,
					ok: false,
					action: 'failed',
					reason: built.reason,
				});
				continue;
			}
			try {
				await channelManager.register(
					built.adapter,
					sidecar.attachmentId !== undefined
						? {attachmentId: sidecar.attachmentId}
						: {},
				);
				results.push({
					id: sidecar.instanceId,
					ok: true,
					action: existed ? 'replaced' : 'registered',
				});
				if (!opts.silent) {
					process.stdout.write(
						`athena-gateway: registered ${sidecar.instanceId}\n`,
					);
				}
			} catch (err) {
				results.push({
					id: sidecar.instanceId,
					ok: false,
					action: 'failed',
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return {results};
	};

	if (!opts.skipChannelLoad) {
		const {sidecars, errors} = loadChannelSidecars(channelConfigHome);
		for (const err of errors) {
			process.stderr.write(
				`athena-gateway: skipping ${err.path}: ${err.reason}\n`,
			);
		}
		for (const sidecar of sidecars) {
			const built = instantiateAdapter(sidecar);
			if (!built.ok) {
				process.stderr.write(
					`athena-gateway: ${sidecar.instanceId}: ${built.reason}\n`,
				);
				continue;
			}
			try {
				await channelManager.register(
					built.adapter,
					sidecar.attachmentId !== undefined
						? {attachmentId: sidecar.attachmentId}
						: {},
				);
				if (!opts.silent) {
					process.stdout.write(
						`athena-gateway: registered ${sidecar.instanceId}\n`,
					);
				}
			} catch (err) {
				process.stderr.write(
					`athena-gateway: register ${sidecar.instanceId} failed: ${
						err instanceof Error ? err.message : String(err)
					}\n`,
				);
			}
		}
	}

	const handler = createDispatcher({
		startedAt,
		pipeline,
		channelManager,
		relayCoordinator,
		getListener: () => listenerStatus ?? buildListenerStatus(listenSpec, null),
		reloadChannels,
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
			onConnect: ctx => {
				connectionOpenedAt.set(ctx.connectionId, Date.now());
				trackGatewayTransportConnect({
					transport: listenerHints.transport,
					tls: listenerHints.tls,
					loopback: listenerHints.loopback,
				});
			},
			onDisconnect: ctx => {
				const openedAt = connectionOpenedAt.get(ctx.connectionId);
				connectionOpenedAt.delete(ctx.connectionId);
				const durationMs = openedAt !== undefined ? Date.now() - openedAt : 0;
				trackGatewayTransportDisconnect({
					transport: listenerHints.transport,
					reason: 'closed',
					durationMs,
				});
				pipeline.notifyConnectionClosed(ctx.connectionId);
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
			listenerStatus = buildListenerStatus(listenSpec, endpoint.port);
		} else {
			listener = {kind: 'uds', socketPath: listenSpec.socketPath};
			listenerStatus = buildListenerStatus(listenSpec, null);
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
			await pipeline.stop();
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
		pipeline,
		channelManager,
		relayCoordinator,
		listener,
		stop,
	};
}
