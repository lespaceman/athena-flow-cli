/**
 * Request dispatcher for gateway control-plane envelopes.
 *
 * M3 implements `ping` and `status`. M5 adds session lifecycle
 * (`session.register`, `session.unregister`, `session.turn.complete`) and
 * direct `channel.send`. Cloud function and relay kinds land in M6/M7.
 */

import {createRequire} from 'node:module';
import type {
	ChannelSendRequestPayload,
	ChannelSendResponsePayload,
	ControlEnvelope,
	ControlPushEnvelope,
	ControlResponseEnvelope,
	PingResponsePayload,
	SessionRegisterRequestPayload,
	SessionRegisterResponsePayload,
	SessionTurnCompleteRequestPayload,
	SessionUnregisterRequestPayload,
	SessionUnregisterResponsePayload,
	StatusResponsePayload,
} from '../../shared/gateway-protocol';
import type {ChannelManager} from '../channelManager';
import type {Dispatcher} from '../dispatcher';
import {
	AlreadyRegisteredError,
	NotRegisteredError,
	type SessionRegistry,
} from '../sessionRegistry';
import type {ConnectionContext, RequestHandler} from './server';

const require = createRequire(import.meta.url);

let cachedVersion: string | null = null;
function readVersion(): string {
	if (cachedVersion !== null) return cachedVersion;
	try {
		const pkg = require('../../../package.json') as {version?: string};
		cachedVersion = pkg.version ?? '0.0.0';
	} catch {
		cachedVersion = '0.0.0';
	}
	return cachedVersion;
}

export type DispatcherDeps = {
	startedAt: number;
	registry?: SessionRegistry;
	dispatcher?: Dispatcher;
	channelManager?: ChannelManager;
	/**
	 * Registers a connection-scoped push function under the runtime's id so
	 * the dispatcher can reach the right socket. Wired by daemon.ts; absent
	 * in tests that don't need session.* round-trips.
	 */
	registerRuntimeConnection?: (
		runtimeId: string,
		ctx: ConnectionContext,
	) => void;
	unregisterRuntimeConnection?: (runtimeId: string) => void;
};

export function createDispatcher(deps: DispatcherDeps): RequestHandler {
	const handle: RequestHandler = async (envelope, connection) => {
		const ts = Date.now();
		switch (envelope.kind) {
			case 'ping': {
				const payload: PingResponsePayload = {
					pong: true,
					daemonPid: process.pid,
					uptimeMs: ts - deps.startedAt,
				};
				return ok(envelope, ts, payload);
			}
			case 'status': {
				const channels = (deps.channelManager?.listChannels() ?? []).map(c => ({
					id: c.id,
					state:
						c.health?.transportOk === false
							? ('degraded' as const)
							: ('running' as const),
					...(c.health?.at !== undefined ? {lastHealthAt: c.health.at} : {}),
				}));
				const payload: StatusResponsePayload = {
					daemonPid: process.pid,
					startedAt: deps.startedAt,
					uptimeMs: ts - deps.startedAt,
					version: readVersion(),
					channels,
				};
				return ok(envelope, ts, payload);
			}
			case 'session.register': {
				if (!deps.registry)
					return error(
						envelope,
						ts,
						'unsupported',
						'session.register not configured',
					);
				const req = envelope.payload as SessionRegisterRequestPayload;
				try {
					const reg = deps.registry.register({
						runtimeId: req.runtimeId,
						defaultAgentId: req.defaultAgentId,
						pid: req.pid,
					});
					deps.registerRuntimeConnection?.(req.runtimeId, connection);
					const payload: SessionRegisterResponsePayload = {
						registeredAt: reg.registeredAt,
						gatewayStartedAt: deps.startedAt,
					};
					return ok(envelope, ts, payload);
				} catch (err) {
					if (err instanceof AlreadyRegisteredError) {
						return error(envelope, ts, err.code, err.message);
					}
					throw err;
				}
			}
			case 'session.unregister': {
				if (!deps.registry)
					return error(
						envelope,
						ts,
						'unsupported',
						'session.unregister not configured',
					);
				const req = envelope.payload as SessionUnregisterRequestPayload;
				try {
					deps.registry.unregister(req.runtimeId);
					deps.unregisterRuntimeConnection?.(req.runtimeId);
					const payload: SessionUnregisterResponsePayload = {
						unregisteredAt: ts,
					};
					return ok(envelope, ts, payload);
				} catch (err) {
					if (err instanceof NotRegisteredError) {
						return error(envelope, ts, err.code, err.message);
					}
					throw err;
				}
			}
			case 'session.turn.complete': {
				if (!deps.dispatcher)
					return error(
						envelope,
						ts,
						'unsupported',
						'dispatcher not configured',
					);
				const req = envelope.payload as SessionTurnCompleteRequestPayload;
				const result = await deps.dispatcher.handleTurnComplete(req);
				return ok(envelope, ts, result);
			}
			case 'channel.send': {
				if (!deps.channelManager)
					return error(
						envelope,
						ts,
						'unsupported',
						'channel manager not configured',
					);
				const req = envelope.payload as ChannelSendRequestPayload;
				const result = await deps.channelManager.send(
					req.message.location.channelId,
					req.message,
				);
				const payload: ChannelSendResponsePayload = {
					providerMessageId: result.providerMessageId,
					deliveredAt: result.deliveredAt,
				};
				return ok(envelope, ts, payload);
			}
			default:
				return error(
					envelope,
					ts,
					'unknown_kind',
					`unknown kind: ${envelope.kind}`,
				);
		}
	};
	return handle;
}

function ok<T>(
	envelope: ControlEnvelope,
	ts: number,
	payload: T,
): ControlResponseEnvelope {
	return {request_id: envelope.request_id, ts, ok: true, payload};
}

function error(
	envelope: ControlEnvelope,
	ts: number,
	code: string,
	message: string,
): ControlResponseEnvelope {
	return {
		request_id: envelope.request_id,
		ts,
		ok: false,
		error: {code, message},
	};
}

export type {ControlPushEnvelope};
