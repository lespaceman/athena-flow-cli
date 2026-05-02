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
import {loadOrCreateToken} from './auth';
import {ChannelManager} from './channelManager';
import {createDispatcher} from './control/handlers';
import {
	startControlServer,
	type ConnectionContext,
	type ControlServer,
} from './control/server';
import {Dispatcher} from './dispatcher';
import {acquireLock, type LockHandle} from './lock';
import {resolveGatewayPaths, type GatewayPaths} from './paths';
import {SessionRegistry} from './sessionRegistry';

export type DaemonOptions = {
	/** When true the daemon stays in foreground (no detach). */
	foreground: boolean;
	silent?: boolean;
	paths?: GatewayPaths;
	env?: NodeJS.ProcessEnv;
	skipSignalHandlers?: boolean;
};

export type DaemonHandle = {
	startedAt: number;
	pid: number;
	paths: GatewayPaths;
	registry: SessionRegistry;
	dispatcher: Dispatcher;
	channelManager: ChannelManager;
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

	const registry = new SessionRegistry();
	const channelManager = new ChannelManager();

	// Push frames target the connection that registered as the runtime. The
	// map is the only state the daemon keeps about active connections.
	const runtimeConnections = new Map<string, ConnectionContext>();
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
	const dispatcher = new Dispatcher({
		registry,
		pushDispatch,
		sendOutbound: (channelId, msg) => channelManager.send(channelId, msg),
	});
	channelManager.setInboundSink(inbound => {
		dispatcher.handleInbound(inbound);
	});

	const handler = createDispatcher({
		startedAt,
		registry,
		dispatcher,
		channelManager,
		registerRuntimeConnection: (runtimeId, ctx) => {
			runtimeConnections.set(runtimeId, ctx);
		},
		unregisterRuntimeConnection: runtimeId => {
			runtimeConnections.delete(runtimeId);
		},
	});

	let server: ControlServer;
	try {
		server = await startControlServer({
			socketPath: paths.socketPath,
			token,
			startedAt,
			handler,
			onDisconnect: ctx => {
				// If the registered runtime's connection drops without unregister,
				// clean up so a fresh runtime can take over.
				const current = registry.getCurrent();
				if (
					current &&
					runtimeConnections.get(current.runtimeId)?.connectionId ===
						ctx.connectionId
				) {
					try {
						registry.unregister(current.runtimeId);
					} catch {
						// already unregistered
					}
					runtimeConnections.delete(current.runtimeId);
				}
			},
		});
	} catch (err) {
		lock.release();
		throw err;
	}

	if (!opts.silent) {
		process.stdout.write(
			`athena-gateway: ok pid=${pid} socket=${paths.socketPath}\n`,
		);
	}

	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		try {
			await channelManager.stop();
			await server.close();
		} finally {
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

	return {startedAt, pid, paths, registry, dispatcher, channelManager, stop};
}
