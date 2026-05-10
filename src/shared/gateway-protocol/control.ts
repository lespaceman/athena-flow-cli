/**
 * Gateway control-plane message kinds and payload shapes.
 *
 * The gateway daemon accepts these requests from in-process Athena clients
 * (interactive runtime, MCP server, hook helper) and sends pushes back. M1
 * defines only the lifecycle surface (`ping`, `status`); session/relay/chat
 * kinds are added in M3–M6, function invoke in M7.
 */

import type {
	ChannelLocation,
	NormalizedInbound,
	OutboundMessage,
} from './channel-events';
import type {
	PermissionRelayResult,
	QuestionRelayResult,
	RelayCancelReason,
	RelayQuestion,
} from './relay';

/**
 * Request kinds — sent from client to gateway. Each kind has a corresponding
 * response payload returned via `ControlResponseEnvelope`.
 */
export type ControlRequestKind =
	| 'ping'
	| 'status'
	| 'channels.reload'
	| 'session.register'
	| 'session.unregister'
	| 'session.turn.complete'
	| 'session.run.event'
	| 'channel.send'
	| 'relay.permission.request'
	| 'relay.permission.cancel'
	| 'relay.question.request'
	| 'relay.question.cancel';

export type PingRequestPayload = Record<string, never>;
export type PingResponsePayload = {
	pong: true;
	daemonPid: number;
	uptimeMs: number;
};

export type ChannelStatusEntry = {
	id: string;
	state: 'starting' | 'running' | 'degraded' | 'stopped' | 'parked';
	lastHealthAt?: number;
	note?: string;
};

export type RuntimeStatusEntry = {
	runtimeId: string;
	defaultAgentId: string;
	pid: number;
	registeredAt: number;
	binding:
		| {state: 'active'; boundAt: number; epoch: number; lastRebindAt?: number}
		| {state: 'stale'; staleSince: number; epoch: number; lastRebindAt?: number}
		| {state: 'none'};
	pendingDispatchCount: number;
};

export type ListenerStatusEntry =
	| {kind: 'uds'; socketPath: string}
	| {
			kind: 'tcp';
			host: string;
			port: number;
			url: string;
			tls: boolean;
			insecure: boolean;
			loopback: boolean;
	  };

export type StatusRequestPayload = Record<string, never>;
export type StatusResponsePayload = {
	daemonPid: number;
	startedAt: number;
	uptimeMs: number;
	version: string;
	listener: ListenerStatusEntry;
	channels: ChannelStatusEntry[];
	runtimes: RuntimeStatusEntry[];
};

export type ChannelReloadResult = {
	id: string;
	ok: boolean;
	action: 'registered' | 'replaced' | 'unchanged' | 'unregistered' | 'failed';
	reason?: string;
};

export type ChannelsReloadRequestPayload = Record<string, never>;
export type ChannelsReloadResponsePayload = {
	results: ChannelReloadResult[];
};

/**
 * Identifies a single Athena interactive runtime that has registered with the
 * gateway. The gateway hosts at most one runtime per **attachment slot**: a
 * register that targets the same `attachmentId` (or both omit it, hitting the
 * single legacy slot) as an existing registration is rejected with code
 * `already_registered`.
 *
 * `attachmentId` is the dashboard-side runner key. Harnesses launched without
 * an attachment context omit it and occupy the legacy slot; future
 * supervisor-spawned children pass their attachmentId so the gateway can
 * route inbound by attachment. See `docs/adr/0001-attachment-supervisor.md`.
 */
export type SessionRegisterRequestPayload = {
	runtimeId: string;
	defaultAgentId: string;
	pid: number;
	attachmentId?: string;
};
export type SessionRegisterResponsePayload = {
	registeredAt: number;
	gatewayStartedAt: number;
};

export type SessionUnregisterRequestPayload = {
	runtimeId: string;
};
export type SessionUnregisterResponsePayload = {
	unregisteredAt: number;
};

/**
 * Reported by the runtime when an inbound-driven turn finishes. Triggers the
 * gateway to relay the assistant's reply outbound on the originating channel.
 * The runtime echoes the `dispatchId` from the inbound push so the gateway
 * can correlate to the originating chat surface without keeping per-turn
 * state on the client.
 */
export type SessionTurnCompleteRequestPayload = {
	runtimeId: string;
	dispatchId: string;
	location: ChannelLocation;
	text: string;
	idempotencyKey: string;
};
export type SessionTurnCompleteResponsePayload = {
	delivered: boolean;
	providerMessageId?: string;
};

/**
 * Streaming run-event from a runner harness child to the dashboard.
 *
 * Routed by the gateway to the registered slot's outbound adapter (in
 * production: `RunnerAdapter`) which encodes it as a `run_event` wire frame.
 * Independent of `session.turn.complete` — turn-complete is one-shot per
 * dispatch, run events are many-per-assignment, and only the terminal one
 * coincides with a turn-complete carrying the same envelope text.
 */
export type SessionRunEventRequestPayload = {
	runtimeId: string;
	location: ChannelLocation;
	runId: string;
	seq: number;
	ts: number;
	kind: string;
	payload?: unknown;
};
export type SessionRunEventResponsePayload = {
	delivered: boolean;
};

/**
 * Direct send-on-channel RPC for callers that aren't the registered runtime
 * (e.g. cloud-function callers in M7 echoing replies back).
 */
export type ChannelSendRequestPayload = {
	message: OutboundMessage;
};
export type ChannelSendResponsePayload = {
	providerMessageId: string;
	deliveredAt: number;
};

/**
 * Relay request/response payloads.
 *
 * The request RPC blocks until the coordinator resolves: a verdict/answer
 * arrives from a channel, the caller cancels via `relay.*.cancel`, the TTL
 * elapses, or no relay-capable adapter is registered. There is no separate
 * `relay.*.timeout` push — the response carries `{kind: 'cancelled',
 * reason: 'timeout'}` directly. The plan originally proposed a push for
 * timeouts; collapsing it into the response keeps the client API uniform
 * and removes a needless out-of-band channel.
 */
export type RelayPermissionRequestPayload = {
	channelRequestId?: string;
	toolName: string;
	description: string;
	inputPreview: string;
	// null = no broadcast timeout (human-in-the-loop).
	ttlMs?: number | null;
};
export type RelayPermissionResponsePayload = {
	channelRequestId: string;
	result: PermissionRelayResult;
};

export type RelayPermissionCancelRequestPayload = {
	channelRequestId: string;
	reason: RelayCancelReason;
};
export type RelayPermissionCancelResponsePayload = {
	cancelled: boolean;
};

export type RelayQuestionRequestPayload = {
	channelRequestId?: string;
	title: string;
	questions: RelayQuestion[];
	// null = no broadcast timeout (human-in-the-loop).
	ttlMs?: number | null;
};
export type RelayQuestionResponsePayload = {
	channelRequestId: string;
	result: QuestionRelayResult;
};

export type RelayQuestionCancelRequestPayload = {
	channelRequestId: string;
	reason: RelayCancelReason;
};
export type RelayQuestionCancelResponsePayload = {
	cancelled: boolean;
};

/**
 * Push kinds — sent from gateway to client without a request. Defined here so
 * the type list stays in one place; payload shapes for chat/relay/function
 * pushes are filled in by their respective milestones.
 */
export type ControlPushKind =
	| 'channel.health'
	| 'chat.inbound'
	| 'session.dispatch.turn'
	| 'function.progress';

/**
 * Pushed to the registered runtime when a chat surface produces an inbound
 * message that routes to a session it owns. The runtime is expected to start
 * a turn and reply with `session.turn.complete` carrying the same
 * `dispatchId`.
 */
export type SessionDispatchTurnPushPayload = {
	dispatchId: string;
	sessionKey: string;
	agentId: string;
	inbound: NormalizedInbound;
};
