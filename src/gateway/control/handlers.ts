/**
 * Request dispatcher for gateway control-plane envelopes.
 *
 * Each envelope kind is declared as a `ControlHandlerSpec`. The dispatcher
 * built by `createDispatcher` looks up the spec by kind, runs the uniform
 * preconditions (required dependencies, registered-runtime connection),
 * invokes the handler, and wraps the result in an `ok`/`error` envelope.
 */

import {createRequire} from 'node:module';
import type {
	ChannelSendRequestPayload,
	ChannelSendResponsePayload,
	ChannelsReloadResponsePayload,
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
	SessionRunEventRequestPayload,
	SessionTurnCompleteRequestPayload,
	SessionUnregisterRequestPayload,
	SessionUnregisterResponsePayload,
	ListenerStatusEntry,
	RuntimeStatusEntry,
	StatusResponsePayload,
	ChannelReloadResult,
} from '../../shared/gateway-protocol';
import type {ChannelManager} from '../channelManager';
import type {DispatchPipeline} from '../dispatchPipeline';
import type {RelayCoordinator} from '../relay/coordinator';
import {
	AlreadyRegisteredError,
	maybeLastRebindAt,
	NotRegisteredError,
} from '../runtimeBindingStore';
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
	pipeline?: DispatchPipeline;
	channelManager?: ChannelManager;
	relayCoordinator?: RelayCoordinator;
	/**
	 * Returns the daemon's effective listener at status-query time. Daemon
	 * sets it after the listener actually binds (port 0 resolves at listen);
	 * absent in tests that exercise the dispatcher directly.
	 */
	getListener?: () => ListenerStatusEntry;
	reloadChannels?: () => Promise<{results: ChannelReloadResult[]}>;
};

type HandlerContext = {
	deps: DispatcherDeps;
	connection: ConnectionContext;
	/**
	 * Runtime id resolved from the connection when the spec requires a
	 * registered runtime. Undefined when no pipeline is configured (test
	 * shape) or when the spec does not require runtime registration.
	 */
	callerRuntimeId: string | undefined;
	/** Wall-clock time captured at envelope receipt. */
	ts: number;
};

type ControlHandlerSpec = {
	kind: string;
	/**
	 * Names of `DispatcherDeps` fields that must be present (non-undefined)
	 * for this kind. If any are missing the dispatcher returns `unsupported`
	 * with `unsupportedMessage`.
	 */
	requires?: ReadonlyArray<keyof DispatcherDeps>;
	/** Message used in the `unsupported` error when a required dep is absent. */
	unsupportedMessage?: string;
	/**
	 * When true, the dispatcher refuses the request unless the connection is
	 * bound to a registered runtime (only checked when a registry is
	 * configured — tests without one bypass this check).
	 */
	requireRegisteredRuntime?: boolean;
	handle: (
		envelope: ControlEnvelope,
		ctx: HandlerContext,
	) => Promise<unknown> | unknown;
};

const PING: ControlHandlerSpec = {
	kind: 'ping',
	handle: (_envelope, {ts, deps}) => {
		const payload: PingResponsePayload = {
			pong: true,
			daemonPid: process.pid,
			uptimeMs: ts - deps.startedAt,
		};
		return payload;
	},
};

const STATUS: ControlHandlerSpec = {
	kind: 'status',
	handle: (_envelope, {ts, deps}) => {
		const channels = (deps.channelManager?.listChannels() ?? []).map(c => ({
			id: c.id,
			state:
				c.health?.transportOk === false
					? ('degraded' as const)
					: ('running' as const),
			...(c.health?.at !== undefined ? {lastHealthAt: c.health.at} : {}),
			...(c.health?.note !== undefined ? {note: c.health.note} : {}),
		}));
		const payload: StatusResponsePayload = {
			daemonPid: process.pid,
			startedAt: deps.startedAt,
			uptimeMs: ts - deps.startedAt,
			version: readVersion(),
			listener: deps.getListener?.() ?? {
				kind: 'uds',
				socketPath: '<unknown>',
			},
			channels,
			runtimes: runtimeStatusEntries(deps.pipeline),
		};
		return payload;
	},
};

const CHANNELS_RELOAD: ControlHandlerSpec = {
	kind: 'channels.reload',
	requires: ['reloadChannels'],
	unsupportedMessage: 'channel reload not configured',
	handle: async (_envelope, {deps}) => {
		const payload: ChannelsReloadResponsePayload = await deps.reloadChannels!();
		return payload;
	},
};

const SESSION_REGISTER: ControlHandlerSpec = {
	kind: 'session.register',
	requires: ['pipeline'],
	unsupportedMessage: 'session.register not configured',
	handle: (envelope, {deps, connection}) => {
		const req = envelope.payload as SessionRegisterRequestPayload;
		const reg = deps.pipeline!.registerRuntime({
			runtimeId: req.runtimeId,
			defaultAgentId: req.defaultAgentId,
			pid: req.pid,
			connectionId: connection.connectionId,
			push: connection.push,
			...(req.attachmentId !== undefined
				? {attachmentId: req.attachmentId}
				: {}),
		});
		const payload: SessionRegisterResponsePayload = {
			registeredAt: reg.registeredAt,
			gatewayStartedAt: deps.startedAt,
		};
		return payload;
	},
};

const SESSION_UNREGISTER: ControlHandlerSpec = {
	kind: 'session.unregister',
	requires: ['pipeline'],
	unsupportedMessage: 'session.unregister not configured',
	handle: (envelope, {deps, ts}) => {
		const req = envelope.payload as SessionUnregisterRequestPayload;
		deps.pipeline!.unregisterRuntime(req.runtimeId);
		const payload: SessionUnregisterResponsePayload = {
			unregisteredAt: ts,
		};
		return payload;
	},
};

const SESSION_TURN_COMPLETE: ControlHandlerSpec = {
	kind: 'session.turn.complete',
	requires: ['pipeline'],
	unsupportedMessage: 'pipeline not configured',
	handle: async (envelope, {deps}) => {
		const req = envelope.payload as SessionTurnCompleteRequestPayload;
		return await deps.pipeline!.handleTurnComplete(req);
	},
};

const SESSION_RUN_EVENT: ControlHandlerSpec = {
	kind: 'session.run.event',
	requires: ['pipeline'],
	unsupportedMessage: 'pipeline not configured',
	handle: async (envelope, {deps}) => {
		const req = envelope.payload as SessionRunEventRequestPayload;
		return await deps.pipeline!.handleRunEvent(req);
	},
};

const CHANNEL_SEND: ControlHandlerSpec = {
	kind: 'channel.send',
	requires: ['channelManager'],
	unsupportedMessage: 'channel manager not configured',
	handle: async (envelope, {deps}) => {
		const req = envelope.payload as ChannelSendRequestPayload;
		const result = await deps.channelManager!.send(
			req.message.location.channelId,
			req.message,
		);
		const payload: ChannelSendResponsePayload = {
			providerMessageId: result.providerMessageId,
			deliveredAt: result.deliveredAt,
		};
		return payload;
	},
};

const RELAY_PERMISSION_REQUEST: ControlHandlerSpec = {
	kind: 'relay.permission.request',
	requires: ['relayCoordinator'],
	unsupportedMessage: 'relay coordinator not configured',
	requireRegisteredRuntime: true,
	handle: async (envelope, {deps, callerRuntimeId}) => {
		const req = envelope.payload as RelayPermissionRequestPayload;
		const broadcast = deps.relayCoordinator!.requestPermission({
			...(req.channelRequestId !== undefined
				? {channelRequestId: req.channelRequestId}
				: {}),
			toolName: req.toolName,
			description: req.description,
			inputPreview: req.inputPreview,
			...(req.ttlMs !== undefined ? {ttlMs: req.ttlMs} : {}),
			...(callerRuntimeId !== undefined ? {runtimeId: callerRuntimeId} : {}),
		});
		const result = await broadcast.result;
		const payload: RelayPermissionResponsePayload = {
			channelRequestId: broadcast.channelRequestId,
			result,
		};
		return payload;
	},
};

const RELAY_PERMISSION_CANCEL: ControlHandlerSpec = {
	kind: 'relay.permission.cancel',
	requires: ['relayCoordinator'],
	unsupportedMessage: 'relay coordinator not configured',
	requireRegisteredRuntime: true,
	handle: (envelope, {deps, callerRuntimeId}) => {
		const req = envelope.payload as RelayPermissionCancelRequestPayload;
		const cancelled = deps.relayCoordinator!.cancel(
			req.channelRequestId,
			req.reason,
			callerRuntimeId,
		);
		const payload: RelayPermissionCancelResponsePayload = {cancelled};
		return payload;
	},
};

const RELAY_QUESTION_REQUEST: ControlHandlerSpec = {
	kind: 'relay.question.request',
	requires: ['relayCoordinator'],
	unsupportedMessage: 'relay coordinator not configured',
	requireRegisteredRuntime: true,
	handle: async (envelope, {deps, callerRuntimeId}) => {
		const req = envelope.payload as RelayQuestionRequestPayload;
		const broadcast = deps.relayCoordinator!.requestQuestion({
			...(req.channelRequestId !== undefined
				? {channelRequestId: req.channelRequestId}
				: {}),
			title: req.title,
			questions: req.questions,
			...(req.ttlMs !== undefined ? {ttlMs: req.ttlMs} : {}),
			...(callerRuntimeId !== undefined ? {runtimeId: callerRuntimeId} : {}),
		});
		const result = await broadcast.result;
		const payload: RelayQuestionResponsePayload = {
			channelRequestId: broadcast.channelRequestId,
			result,
		};
		return payload;
	},
};

const RELAY_QUESTION_CANCEL: ControlHandlerSpec = {
	kind: 'relay.question.cancel',
	requires: ['relayCoordinator'],
	unsupportedMessage: 'relay coordinator not configured',
	requireRegisteredRuntime: true,
	handle: (envelope, {deps, callerRuntimeId}) => {
		const req = envelope.payload as RelayQuestionCancelRequestPayload;
		const cancelled = deps.relayCoordinator!.cancel(
			req.channelRequestId,
			req.reason,
			callerRuntimeId,
		);
		const payload: RelayQuestionCancelResponsePayload = {cancelled};
		return payload;
	},
};

const HANDLERS: ReadonlyMap<string, ControlHandlerSpec> = new Map(
	[
		PING,
		STATUS,
		CHANNELS_RELOAD,
		SESSION_REGISTER,
		SESSION_UNREGISTER,
		SESSION_TURN_COMPLETE,
		SESSION_RUN_EVENT,
		CHANNEL_SEND,
		RELAY_PERMISSION_REQUEST,
		RELAY_PERMISSION_CANCEL,
		RELAY_QUESTION_REQUEST,
		RELAY_QUESTION_CANCEL,
	].map(spec => [spec.kind, spec]),
);

export function createDispatcher(deps: DispatcherDeps): RequestHandler {
	const handle: RequestHandler = async (envelope, connection) => {
		const ts = Date.now();
		const spec = HANDLERS.get(envelope.kind);
		if (!spec) {
			return error(
				envelope,
				ts,
				'unknown_kind',
				`unknown kind: ${envelope.kind}`,
			);
		}

		if (spec.requires) {
			for (const name of spec.requires) {
				if (deps[name] === undefined) {
					return error(
						envelope,
						ts,
						'unsupported',
						spec.unsupportedMessage ?? `${spec.kind} not configured`,
					);
				}
			}
		}

		let callerRuntimeId: string | undefined;
		if (spec.requireRegisteredRuntime) {
			callerRuntimeId =
				deps.pipeline?.getRuntimeIdByConnection(connection.connectionId) ??
				undefined;
			if (deps.pipeline && callerRuntimeId === undefined) {
				return error(
					envelope,
					ts,
					'not_registered',
					`${spec.kind} requires a registered runtime connection`,
				);
			}
		}

		try {
			const payload = await spec.handle(envelope, {
				deps,
				connection,
				callerRuntimeId,
				ts,
			});
			return ok(envelope, Date.now(), payload);
		} catch (err) {
			if (
				err instanceof AlreadyRegisteredError ||
				err instanceof NotRegisteredError
			) {
				return error(envelope, ts, err.code, err.message);
			}
			throw err;
		}
	};
	return handle;
}

function runtimeStatusEntries(
	pipeline: DispatchPipeline | undefined,
): RuntimeStatusEntry[] {
	const runtime = pipeline?.getCurrentRuntime();
	if (!runtime || !pipeline) return [];
	const binding = pipeline.getBinding();
	return [
		{
			runtimeId: runtime.runtimeId,
			defaultAgentId: runtime.defaultAgentId,
			pid: runtime.pid,
			registeredAt: runtime.registeredAt,
			binding:
				binding?.state === 'active'
					? {
							state: 'active',
							boundAt: binding.boundAt,
							epoch: binding.epoch,
							...maybeLastRebindAt(binding.lastRebindAt),
						}
					: binding?.state === 'stale'
						? {
								state: 'stale',
								staleSince: binding.staleSince,
								epoch: binding.epoch,
								...maybeLastRebindAt(binding.lastRebindAt),
							}
						: {state: 'none'},
			pendingDispatchCount: pipeline.pendingDispatchCount(),
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
