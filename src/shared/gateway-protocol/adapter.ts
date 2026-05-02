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

export type ChannelCapabilities = {
	/** True if the adapter can deliver outbound chat messages. */
	chat: boolean;
	/** True if the adapter exposes per-thread routing (e.g. Telegram forum). */
	threads: boolean;
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
}
