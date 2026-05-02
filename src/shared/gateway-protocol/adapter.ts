/**
 * In-daemon `ChannelAdapter` contract — the interface every concrete
 * messaging-platform adapter implements (Telegram, Slack, …).
 *
 * Lives in `shared/` because both the gateway daemon (which hosts adapters
 * directly) and any test fixtures speak this contract; gateway/** cannot
 * import from channels/**, so the type belongs at the shared boundary.
 */

import type {
	HealthSample,
	NormalizedInbound,
	OutboundMessage,
	ProbeResult,
	SendResult,
} from './channel-events';
import type {
	PermissionRelayRequest,
	PermissionRelayResult,
	QuestionRelayRequest,
	QuestionRelayResult,
} from './relay';

export type ChannelCapabilities = {
	/** True if the adapter can deliver outbound chat messages. */
	chat: boolean;
	/** True if the adapter exposes per-thread routing (e.g. Telegram forum). */
	threads: boolean;
	/** True if the adapter implements `requestPermissionVerdict`. */
	relayPermission: boolean;
	/** True if the adapter implements `requestQuestionAnswer`. */
	relayQuestion: boolean;
	/** Maximum text bytes per outbound message; missing means adapter handles chunking. */
	maxMessageBytes?: number;
};

export type StopReason = 'shutdown' | 'parked' | 'error';

export type AdapterLogger = (
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
) => void;

/**
 * Context handed to an adapter on `start()`. The adapter receives just enough
 * to do its job (logger, signal); the manager wires inbound and health
 * subscriptions via `on(...)` instead of pushing them through the context.
 */
export type AdapterContext = {
	log: AdapterLogger;
	/** Aborted when the manager is shutting the adapter down. */
	signal: AbortSignal;
};

export type ChannelInboundListener = (msg: NormalizedInbound) => void;
export type ChannelHealthListener = (sample: HealthSample) => void;

export interface ChannelAdapter {
	readonly id: string;
	readonly capabilities: ChannelCapabilities;
	start(ctx: AdapterContext): Promise<void>;
	stop(reason: StopReason): Promise<void>;
	send(msg: OutboundMessage): Promise<SendResult>;
	probe(): Promise<ProbeResult>;
	on(event: 'inbound', cb: ChannelInboundListener): void;
	on(event: 'health', cb: ChannelHealthListener): void;
	off(event: 'inbound', cb: ChannelInboundListener): void;
	off(event: 'health', cb: ChannelHealthListener): void;
	/**
	 * Present iff `capabilities.relayPermission` is true. Resolves with the
	 * user's verdict, or — when `signal` aborts before a verdict arrives —
	 * with `{kind: 'cancelled'}`. Implementations are responsible for
	 * surfacing the prompt on the channel and tearing it down on abort.
	 */
	requestPermissionVerdict?(
		req: PermissionRelayRequest,
		signal: AbortSignal,
	): Promise<PermissionRelayResult>;
	/** Present iff `capabilities.relayQuestion` is true. Same shape contract. */
	requestQuestionAnswer?(
		req: QuestionRelayRequest,
		signal: AbortSignal,
	): Promise<QuestionRelayResult>;
}
