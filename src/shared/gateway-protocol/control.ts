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
	| 'session.register'
	| 'session.unregister'
	| 'session.turn.complete'
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
};

export type RuntimeStatusEntry = {
	runtimeId: string;
	defaultAgentId: string;
	pid: number;
	registeredAt: number;
	binding:
		| {state: 'active'; boundAt: number}
		| {state: 'stale'; staleSince: number}
		| {state: 'none'};
	pendingDispatchCount: number;
};

export type StatusRequestPayload = Record<string, never>;
export type StatusResponsePayload = {
	daemonPid: number;
	startedAt: number;
	uptimeMs: number;
	version: string;
	channels: ChannelStatusEntry[];
	runtimes: RuntimeStatusEntry[];
};

/**
 * Identifies a single Athena interactive runtime that has registered with the
 * gateway. The gateway enforces one-runtime-at-a-time; duplicate registration
 * is rejected with code `already_registered`.
 */
export type SessionRegisterRequestPayload = {
	runtimeId: string;
	defaultAgentId: string;
	pid: number;
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
	ttlMs?: number;
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
	ttlMs?: number;
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
