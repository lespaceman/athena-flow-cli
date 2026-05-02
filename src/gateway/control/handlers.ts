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
	RelayPermissionCancelRequestPayload,
	RelayPermissionCancelResponsePayload,
	RelayPermissionRequestPayload,
	RelayPermissionResponsePayload,
	RelayQuestionCancelRequestPayload,
	RelayQuestionCancelResponsePayload,
	RelayQuestionRequestPayload,
	RelayQuestionResponsePayload,
	SessionRegisterRequestPayload,
	SessionRegisterResponsePayload,
	SessionTurnCompleteRequestPayload,
	SessionUnregisterRequestPayload,
	SessionUnregisterResponsePayload,
	RuntimeStatusEntry,
	StatusResponsePayload,
} from '../../shared/gateway-protocol';
import type {ChannelManager} from '../channelManager';
import type {Dispatcher} from '../dispatcher';
import type {RelayCoordinator} from '../relay/coordinator';
import {
	AlreadyRegisteredError,
	NotRegisteredError,
	type SessionRegistry,
} from '../sessionRegistry';
import type {ConnectionContext, RequestHandler} from './server';

// Build-time inject from tsup `define`. Replaced literally with the
// stringified version. Falls back to a createRequire-based runtime lookup
// in vitest where the define isn't applied.
declare const __ATHENA_VERSION__: string;
const require_ = createRequire(import.meta.url);

let cachedVersion: string | null = null;
function readVersion(): string {
	if (cachedVersion !== null) return cachedVersion;
	try {
		// `__ATHENA_VERSION__` is a literal post-bundle. Wrapping in a try
		// guards against the source-path (vitest) where the identifier is
		// undeclared and the ReferenceError must be swallowed.
		const injected: unknown = __ATHENA_VERSION__;
		if (typeof injected === 'string' && injected.length > 0) {
			cachedVersion = injected;
			return cachedVersion;
		}
	} catch {
		// fall through to require-based read
	}
	try {
		const pkg = require_('../../../package.json') as {version?: string};
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
	relayCoordinator?: RelayCoordinator;
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
					runtimes: runtimeStatusEntries(deps.registry),
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
					// Drain inbound parked while no runtime was registered. Order is
					// FIFO, but the runtime's single-slot queue (AppShell) handles
					// concurrency: extras are buffered.
					try {
						deps.dispatcher?.drainPending();
					} catch (err) {
						process.stderr.write(
							`gateway: drainPending failed: ${
								err instanceof Error ? err.message : String(err)
							}\n`,
						);
					}
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
			case 'relay.permission.request': {
				if (!deps.relayCoordinator)
					return error(
						envelope,
						ts,
						'unsupported',
						'relay coordinator not configured',
					);
				const req = envelope.payload as RelayPermissionRequestPayload;
				const broadcast = deps.relayCoordinator.requestPermission({
					...(req.channelRequestId !== undefined
						? {channelRequestId: req.channelRequestId}
						: {}),
					toolName: req.toolName,
					description: req.description,
					inputPreview: req.inputPreview,
					...(req.ttlMs !== undefined ? {ttlMs: req.ttlMs} : {}),
				});
				const result = await broadcast.result;
				const payload: RelayPermissionResponsePayload = {
					channelRequestId: broadcast.channelRequestId,
					result,
				};
				return ok(envelope, Date.now(), payload);
			}
			case 'relay.permission.cancel': {
				if (!deps.relayCoordinator)
					return error(
						envelope,
						ts,
						'unsupported',
						'relay coordinator not configured',
					);
				const req = envelope.payload as RelayPermissionCancelRequestPayload;
				const cancelled = deps.relayCoordinator.cancel(
					req.channelRequestId,
					req.reason,
				);
				const payload: RelayPermissionCancelResponsePayload = {cancelled};
				return ok(envelope, ts, payload);
			}
			case 'relay.question.request': {
				if (!deps.relayCoordinator)
					return error(
						envelope,
						ts,
						'unsupported',
						'relay coordinator not configured',
					);
				const req = envelope.payload as RelayQuestionRequestPayload;
				const broadcast = deps.relayCoordinator.requestQuestion({
					...(req.channelRequestId !== undefined
						? {channelRequestId: req.channelRequestId}
						: {}),
					title: req.title,
					questions: req.questions,
					...(req.ttlMs !== undefined ? {ttlMs: req.ttlMs} : {}),
				});
				const result = await broadcast.result;
				const payload: RelayQuestionResponsePayload = {
					channelRequestId: broadcast.channelRequestId,
					result,
				};
				return ok(envelope, Date.now(), payload);
			}
			case 'relay.question.cancel': {
				if (!deps.relayCoordinator)
					return error(
						envelope,
						ts,
						'unsupported',
						'relay coordinator not configured',
					);
				const req = envelope.payload as RelayQuestionCancelRequestPayload;
				const cancelled = deps.relayCoordinator.cancel(
					req.channelRequestId,
					req.reason,
				);
				const payload: RelayQuestionCancelResponsePayload = {cancelled};
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

function runtimeStatusEntries(
	registry: SessionRegistry | undefined,
): RuntimeStatusEntry[] {
	const runtime = registry?.getCurrent();
	if (!runtime || !registry) return [];
	const binding = registry.getBinding();
	return [
		{
			runtimeId: runtime.runtimeId,
			defaultAgentId: runtime.defaultAgentId,
			pid: runtime.pid,
			registeredAt: runtime.registeredAt,
			binding:
				binding?.state === 'active'
					? {state: 'active', boundAt: binding.boundAt}
					: binding?.state === 'stale'
						? {state: 'stale', staleSince: binding.staleSince}
						: {state: 'none'},
			pendingDispatchCount: registry.pendingDispatchCount(),
		},
	];
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
