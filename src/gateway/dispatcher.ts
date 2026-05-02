/**
 * Bridges inbound chat → registered runtime, and runtime turn-complete →
 * outbound channel send.
 *
 * The dispatcher is transport-agnostic: it speaks to the rest of the gateway
 * through three injected callables (push to runtime, send on channel, agent
 * resolution). The control-server wiring that turns these into UDS pushes
 * lands later in M5; this class is independently unit-testable.
 *
 * Flow:
 *   1. ChannelManager hands an inbound message to `handleInbound()`.
 *   2. We derive the session key (per the SessionKey ladder).
 *   3. If a runtime is registered, mint a dispatchId via SessionRegistry,
 *      park the originating ChannelLocation, and push `session.dispatch.turn`
 *      to the runtime.
 *   4. Runtime later issues `session.turn.complete` carrying the same
 *      dispatchId; we resolve the parked location and call `sendOutbound`.
 *
 * Inbound messages that arrive with no registered runtime are dropped (the
 * channel manager already absorbed the dedup retry hit). Future M8 outbox
 * work can park them durably.
 */

import type {
	NormalizedInbound,
	OutboundMessage,
	SendResult,
	SessionDispatchTurnPushPayload,
	SessionTurnCompleteRequestPayload,
	SessionTurnCompleteResponsePayload,
} from '../shared/gateway-protocol';
import {deriveSessionKey} from './router/sessionKey';
import {SessionRegistry, UnknownDispatchError} from './sessionRegistry';

export type AgentResolver = (input: {
	sessionKey: string;
	channelId: string;
	defaultAgentId: string;
}) => string;

export type DispatcherOptions = {
	registry: SessionRegistry;
	/** Push a `session.dispatch.turn` frame to the registered runtime. */
	pushDispatch: (payload: SessionDispatchTurnPushPayload) => void;
	/** Send an outbound message via the appropriate channel adapter. */
	sendOutbound: (
		channelId: string,
		msg: OutboundMessage,
	) => Promise<SendResult>;
	/** Resolve agentId; defaults to the registered runtime's `defaultAgentId`. */
	resolveAgent?: AgentResolver;
	log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
};

export type DispatchResult =
	| {kind: 'dispatched'; dispatchId: string; sessionKey: string}
	| {kind: 'dropped'; reason: 'no_runtime' | 'no_default_agent'};

export class Dispatcher {
	private readonly registry: SessionRegistry;
	private readonly pushDispatch: DispatcherOptions['pushDispatch'];
	private readonly sendOutbound: DispatcherOptions['sendOutbound'];
	private readonly resolveAgent: AgentResolver;
	private readonly log: DispatcherOptions['log'];

	constructor(opts: DispatcherOptions) {
		this.registry = opts.registry;
		this.pushDispatch = opts.pushDispatch;
		this.sendOutbound = opts.sendOutbound;
		this.resolveAgent = opts.resolveAgent ?? (input => input.defaultAgentId);
		this.log = opts.log;
	}

	handleInbound(inbound: NormalizedInbound): DispatchResult {
		const current = this.registry.getCurrent();
		if (!current) {
			this.log?.(
				'debug',
				`no runtime registered; dropping inbound ${inbound.idempotencyKey}`,
			);
			return {kind: 'dropped', reason: 'no_runtime'};
		}
		const sessionKey = deriveSessionKey(inbound.location);
		const agentId = this.resolveAgent({
			sessionKey,
			channelId: inbound.location.channelId,
			defaultAgentId: current.defaultAgentId,
		});
		if (!agentId) {
			this.log?.(
				'warn',
				`agent resolution returned empty for sessionKey=${sessionKey}`,
			);
			return {kind: 'dropped', reason: 'no_default_agent'};
		}
		const entry = this.registry.beginDispatch({
			sessionKey,
			agentId,
			location: inbound.location,
		});
		this.pushDispatch({
			dispatchId: entry.dispatchId,
			sessionKey,
			agentId,
			inbound,
		});
		return {
			kind: 'dispatched',
			dispatchId: entry.dispatchId,
			sessionKey,
		};
	}

	async handleTurnComplete(
		payload: SessionTurnCompleteRequestPayload,
	): Promise<SessionTurnCompleteResponsePayload> {
		const current = this.registry.getCurrent();
		if (!current || current.runtimeId !== payload.runtimeId) {
			throw new Error('runtime mismatch on session.turn.complete');
		}
		let entry;
		try {
			entry = this.registry.completeDispatch(payload.dispatchId);
		} catch (err) {
			if (err instanceof UnknownDispatchError) {
				return {delivered: false};
			}
			throw err;
		}
		const result = await this.sendOutbound(entry.location.channelId, {
			location: payload.location,
			text: payload.text,
			idempotencyKey: payload.idempotencyKey,
		});
		return {
			delivered: true,
			providerMessageId: result.providerMessageId,
		};
	}
}
