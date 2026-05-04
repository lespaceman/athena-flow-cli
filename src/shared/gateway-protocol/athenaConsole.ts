/**
 * Athena console protocol: transport-neutral frame shapes shared between
 * the gateway-side `console` channel adapter and any rich-client broker
 * (browser, mobile, desktop, partner-hosted UI). These are types only;
 * the wire transport (WS, HTTP/2, custom) is broker-specific.
 *
 * This is a placeholder home — the adapter implementation lands in a
 * separate plan. Adding it here now keeps frame shapes in the shared
 * boundary leaf instead of an adapter-private module.
 */

import type {RelayQuestion, RelayQuestionOption} from './relay';

export type AthenaConsoleFrameKind =
	| 'console.hello'
	| 'console.ready'
	| 'console.message.in'
	| 'console.message.out'
	| 'console.permission.request'
	| 'console.permission.response'
	| 'console.permission.cancel'
	| 'console.question.request'
	| 'console.question.response'
	| 'console.question.cancel'
	| 'console.ack'
	| 'console.error';

export type AthenaConsoleAddress = {
	runnerId: string;
	workspaceId?: string;
	conversationId?: string;
	threadId?: string;
	userId?: string;
};

export type AthenaConsoleFrameBase = {
	kind: AthenaConsoleFrameKind;
	/** Monotonic per-connection frame id; used for ack/error refs. */
	frameId: string;
	/** Unix epoch milliseconds. */
	sentAt: number;
};

export type AthenaConsoleHelloFrame = AthenaConsoleFrameBase & {
	kind: 'console.hello';
	protocolVersion: number;
	clientName: string;
	clientVersion: string;
	/**
	 * Runner identity claimed by the adapter. The broker MUST verify this
	 * against the credentials presented on the WSS upgrade and reject the
	 * connection if they don't match. The adapter MUST cross-check the
	 * `runnerId` echoed back in `console.ready.address`.
	 */
	address: AthenaConsoleAddress;
};

export type AthenaConsoleReadyFrame = AthenaConsoleFrameBase & {
	kind: 'console.ready';
	protocolVersion: number;
	brokerName: string;
	address: AthenaConsoleAddress;
};

export type AthenaConsoleInboundMessageFrame = AthenaConsoleFrameBase & {
	kind: 'console.message.in';
	address: AthenaConsoleAddress;
	messageId: string;
	/** Broker-generated idempotency key for at-least-once delivery dedupe. */
	idempotencyKey: string;
	text: string;
};

export type AthenaConsoleOutboundMessageFrame = AthenaConsoleFrameBase & {
	kind: 'console.message.out';
	address: AthenaConsoleAddress;
	messageId: string;
	/** Runtime-generated idempotency key; stable across redeliveries. */
	idempotencyKey: string;
	text: string;
};

export type AthenaConsolePermissionRequestFrame = AthenaConsoleFrameBase & {
	kind: 'console.permission.request';
	address: AthenaConsoleAddress;
	channelRequestId: string;
	toolName: string;
	description: string;
	inputPreview: string;
	ttlMs?: number;
};

export type AthenaConsolePermissionResponseFrame = AthenaConsoleFrameBase & {
	kind: 'console.permission.response';
	channelRequestId: string;
	decision: 'allow' | 'deny';
};

export type AthenaConsolePermissionCancelFrame = AthenaConsoleFrameBase & {
	kind: 'console.permission.cancel';
	channelRequestId: string;
	/** Free-form short reason (e.g. 'resolved_locally', 'shutdown'). */
	reason?: string;
};

export type AthenaConsoleQuestionRequestFrame = AthenaConsoleFrameBase & {
	kind: 'console.question.request';
	address: AthenaConsoleAddress;
	channelRequestId: string;
	title: string;
	questions: readonly RelayQuestion[];
	ttlMs?: number;
};

export type AthenaConsoleQuestionResponseFrame = AthenaConsoleFrameBase & {
	kind: 'console.question.response';
	channelRequestId: string;
	/**
	 * Mirrors `QuestionRelayResult.answers`: keyed by `RelayQuestion.key`,
	 * value is the chosen option label. Multi-select encoding can be
	 * layered on later if needed (current relay shape is single string per
	 * key).
	 */
	answers: Record<string, string>;
};

export type AthenaConsoleQuestionCancelFrame = AthenaConsoleFrameBase & {
	kind: 'console.question.cancel';
	channelRequestId: string;
	reason?: string;
};

export type AthenaConsoleAckFrame = AthenaConsoleFrameBase & {
	kind: 'console.ack';
	refFrameId: string;
};

export type AthenaConsoleErrorFrame = AthenaConsoleFrameBase & {
	kind: 'console.error';
	refFrameId?: string;
	code: string;
	message: string;
};

export type AthenaConsoleFrame =
	| AthenaConsoleHelloFrame
	| AthenaConsoleReadyFrame
	| AthenaConsoleInboundMessageFrame
	| AthenaConsoleOutboundMessageFrame
	| AthenaConsolePermissionRequestFrame
	| AthenaConsolePermissionResponseFrame
	| AthenaConsolePermissionCancelFrame
	| AthenaConsoleQuestionRequestFrame
	| AthenaConsoleQuestionResponseFrame
	| AthenaConsoleQuestionCancelFrame
	| AthenaConsoleAckFrame
	| AthenaConsoleErrorFrame;

export type {RelayQuestion, RelayQuestionOption};
