/**
 * DispatchPipeline — turn router.
 *
 * Orchestrates a dispatch turn end-to-end: channel inbound → registered
 * runtime → reply on the originating channel.
 *
 * Delegates to three focused collaborators:
 *  - RuntimeBindingStore — registered-runtime binding state machine
 *  - SessionRegistry — in-flight dispatch correlation (dispatchId ↔ location)
 *  - InboundQueue / Outbox / OutboundDispatcher — queuing and delivery
 */

import crypto from 'node:crypto';
import type {
	ChannelLocation,
	ControlPushEnvelope,
	NormalizedInbound,
	OutboundMessage,
	SendResult,
	SessionDispatchTurnPushPayload,
	SessionRunEventRequestPayload,
	SessionRunEventResponsePayload,
	SessionTurnCompleteRequestPayload,
	SessionTurnCompleteResponsePayload,
} from '../shared/gateway-protocol';
import {writeGatewayTrace} from '../infra/gatewayTrace';
import {OutboundDispatcher} from './outboundDispatcher';
import {deriveSessionKey} from './router/sessionKey';
import {
	RuntimeBindingStore,
	type RegisteredRuntime,
	type RuntimeBindingObservers,
} from './runtimeBindingStore';
import {SessionRegistry, UnknownDispatchError} from './sessionRegistry';
import type {GatewayStateDb} from './state/db';
import {InboundQueue, type InboundQueueOptions} from './state/inboundQueue';
import {Outbox} from './state/outbox';

export type AgentResolver = (input: {
	sessionKey: string;
	channelId: string;
	defaultAgentId: string;
}) => string;

export type DispatchResult =
	| {kind: 'dispatched'; dispatchId: string; sessionKey: string}
	| {kind: 'queued'; queueId: number}
	| {kind: 'dropped'; reason: 'no_runtime' | 'no_default_agent' | 'queue_full'};

export type DispatchPipelineObservers = RuntimeBindingObservers;

export type OutboxOptions = {
	backoffSchedule?: number[];
	maxAttempts?: number;
	tickIntervalMs?: number;
	drainBatchSize?: number;
};

export type DispatchPipelineOptions = {
	stateDb: GatewayStateDb;
	send: (channelId: string, msg: OutboundMessage) => Promise<SendResult>;
	/** 0 = unregister immediately on connection close (local UDS default). */
	gracePeriodMs?: number;
	resolveAgent?: AgentResolver;
	inboundQueue?: InboundQueueOptions;
	outbox?: OutboxOptions;
	observers?: DispatchPipelineObservers;
	log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	/** Override dispatchId source for tests. */
	idFactory?: () => string;
};

export type RegisterRuntimeInput = {
	runtimeId: string;
	defaultAgentId: string;
	pid: number;
	connectionId: string;
	push: (env: ControlPushEnvelope) => void;
	/**
	 * Optional dashboard-side **Attachment** key. When set, the runtime
	 * occupies the slot keyed by `attachmentId`; otherwise it occupies the
	 * single fallback slot used by frames that arrive without an attachmentId.
	 * See `docs/adr/0001-attachment-supervisor.md` (phase 4).
	 */
	attachmentId?: string;
};

type RuntimePushHandle = {
	connectionId: string;
	push: (env: ControlPushEnvelope) => void;
};

type AttachmentKey = string | undefined;

export {
	type RegisteredRuntime,
	type RuntimeConnectionBinding,
	AlreadyRegisteredError,
	NotRegisteredError,
	maybeLastRebindAt,
} from './runtimeBindingStore';

export class DispatchPipeline {
	private readonly bindingStore: RuntimeBindingStore;
	private readonly registry: SessionRegistry;
	private readonly inboundQueue: InboundQueue;
	private readonly outbox: Outbox;
	private readonly outboundDispatcher: OutboundDispatcher;
	private readonly resolveAgent: AgentResolver;
	private readonly log: DispatchPipelineOptions['log'];
	private readonly now: () => number;
	private readonly idFactory: () => string;
	private readonly pushes: Map<AttachmentKey, RuntimePushHandle> = new Map();
	private readonly connectionToKey: Map<string, AttachmentKey> = new Map();

	constructor(opts: DispatchPipelineOptions) {
		this.bindingStore = new RuntimeBindingStore({
			gracePeriodMs: opts.gracePeriodMs,
			observers: opts.observers,
			now: opts.now,
		});
		this.registry = new SessionRegistry({
			now: opts.now ?? Date.now,
			...(opts.idFactory ? {idFactory: opts.idFactory} : {}),
		});
		this.inboundQueue = new InboundQueue(opts.stateDb, opts.inboundQueue ?? {});
		this.outbox = new Outbox(opts.stateDb);
		this.outboundDispatcher = new OutboundDispatcher({
			outbox: this.outbox,
			send: opts.send,
			...(opts.outbox?.backoffSchedule
				? {backoffSchedule: opts.outbox.backoffSchedule}
				: {}),
			...(opts.outbox?.maxAttempts !== undefined
				? {maxAttempts: opts.outbox.maxAttempts}
				: {}),
			...(opts.outbox?.tickIntervalMs !== undefined
				? {tickIntervalMs: opts.outbox.tickIntervalMs}
				: {}),
			...(opts.outbox?.drainBatchSize !== undefined
				? {drainBatchSize: opts.outbox.drainBatchSize}
				: {}),
			...(opts.now ? {now: opts.now} : {}),
			...(opts.log ? {log: opts.log} : {}),
		});
		this.resolveAgent = opts.resolveAgent ?? (input => input.defaultAgentId);
		this.log = opts.log;
		this.now = opts.now ?? Date.now;
		this.idFactory = opts.idFactory ?? crypto.randomUUID;
	}

	// ── lifecycle ────────────────────────────────────────────

	start(): void {
		this.outboundDispatcher.start();
	}

	async stop(): Promise<void> {
		this.outboundDispatcher.stop();
		this.bindingStore.stop();
	}

	// ── inbound (channel side) ───────────────────────────────

	handleInbound(
		inbound: NormalizedInbound,
		options: {attachmentId?: string} = {},
	): DispatchResult {
		const key: AttachmentKey = options.attachmentId;
		const current = this.bindingStore.getCurrentByAttachment(key);
		if (!current || !this.bindingStore.hasActiveBindingForAttachment(key)) {
			const result = this.inboundQueue.enqueue(inbound);
			if (result.kind === 'queued') {
				this.log?.(
					'info',
					`no runtime registered; parked inbound ${inbound.idempotencyKey} as queue#${result.id}`,
				);
				return {kind: 'queued', queueId: result.id};
			}
			if (result.kind === 'duplicate') {
				this.log?.(
					'debug',
					`inbound ${inbound.idempotencyKey} already parked; ignoring duplicate`,
				);
				return {kind: 'dropped', reason: 'no_runtime'};
			}
			this.log?.(
				'warn',
				`inbound queue full (>=${this.inboundQueue.size()}); dropping ${inbound.idempotencyKey}`,
			);
			return {kind: 'dropped', reason: 'queue_full'};
		}
		return this.dispatchInboundToRuntime(inbound, current, key);
	}

	private dispatchInboundToRuntime(
		inbound: NormalizedInbound,
		current: RegisteredRuntime,
		key: AttachmentKey,
	): DispatchResult {
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
		this.pushDispatch(key, {
			dispatchId: entry.dispatchId,
			sessionKey,
			agentId,
			inbound,
		});
		return {kind: 'dispatched', dispatchId: entry.dispatchId, sessionKey};
	}

	private pushDispatch(
		key: AttachmentKey,
		payload: SessionDispatchTurnPushPayload,
	): void {
		const handle = this.pushes.get(key);
		if (!handle) return;
		handle.push({
			push_id: this.idFactory(),
			ts: this.now(),
			kind: 'session.dispatch.turn',
			payload,
		});
	}

	// ── runtime side ─────────────────────────────────────────

	registerRuntime(input: RegisterRuntimeInput): {registeredAt: number} {
		const key: AttachmentKey = input.attachmentId;
		const result = this.bindingStore.bind({
			runtimeId: input.runtimeId,
			defaultAgentId: input.defaultAgentId,
			pid: input.pid,
			connectionId: input.connectionId,
			...(input.attachmentId !== undefined
				? {attachmentId: input.attachmentId}
				: {}),
		});
		const previous = this.pushes.get(key);
		if (previous && previous.connectionId !== input.connectionId) {
			this.connectionToKey.delete(previous.connectionId);
		}
		this.pushes.set(key, {
			connectionId: input.connectionId,
			push: input.push,
		});
		this.connectionToKey.set(input.connectionId, key);

		writeGatewayTrace(
			`pipeline registered runtime runtimeId=${input.runtimeId} connectionId=${input.connectionId}`,
		);

		this.drainPending(key);
		return {registeredAt: result.registeredAt};
	}

	unregisterRuntime(runtimeId: string): void {
		const slot = this.findSlotByRuntimeId(runtimeId);
		this.bindingStore.unbind(runtimeId);
		this.registry.clearDispatches();
		if (slot) {
			const handle = this.pushes.get(slot.key);
			this.pushes.delete(slot.key);
			if (handle) this.connectionToKey.delete(handle.connectionId);
		}
		writeGatewayTrace(`pipeline unregistered runtime runtimeId=${runtimeId}`);
	}

	notifyConnectionClosed(connectionId: string): void {
		const key = this.connectionToKey.get(connectionId);
		const runtimeId = this.bindingStore.notifyConnectionClosed(connectionId);
		if (runtimeId === null) return;
		writeGatewayTrace(
			`pipeline runtime connection closed runtimeId=${runtimeId} connectionId=${connectionId}`,
		);
		if (key !== undefined || this.pushes.has(key)) {
			this.pushes.delete(key);
			this.connectionToKey.delete(connectionId);
		}
	}

	/**
	 * Streaming run-event from a runner harness child to its outbound
	 * adapter. Independent of dispatch state — `runId`/`seq` are the runner
	 * protocol's own correlation, not the gateway's `dispatchId`. The
	 * outbound text is the wire envelope shape RunnerAdapter expects on
	 * `OutboundMessage.text`.
	 */
	async handleRunEvent(
		payload: SessionRunEventRequestPayload,
	): Promise<SessionRunEventResponsePayload> {
		const slot = this.findSlotByRuntimeId(payload.runtimeId);
		if (!slot) {
			throw new Error('runtime mismatch on session.run.event');
		}
		const envelopeText = JSON.stringify({
			kind: 'run_event',
			runId: payload.runId,
			seq: payload.seq,
			ts: payload.ts,
			eventKind: payload.kind,
			...(payload.payload !== undefined ? {payload: payload.payload} : {}),
		});
		const out: OutboundMessage = {
			location: payload.location,
			text: envelopeText,
			idempotencyKey: `run_event:${payload.runId}:${payload.seq}`,
		};
		try {
			await this.outboundDispatcher.dispatch(payload.location.channelId, out);
		} catch {
			return {delivered: false};
		}
		return {delivered: true};
	}

	async handleTurnComplete(
		payload: SessionTurnCompleteRequestPayload,
	): Promise<SessionTurnCompleteResponsePayload> {
		const slot = this.findSlotByRuntimeId(payload.runtimeId);
		writeGatewayTrace(
			`pipeline turn.complete received runtimeId=${payload.runtimeId} dispatchId=${payload.dispatchId} channel=${payload.location.channelId} account=${payload.location.accountId} thread=${payload.location.thread?.id ?? ''} textLength=${payload.text.length}`,
		);
		if (!slot) {
			throw new Error('runtime mismatch on session.turn.complete');
		}
		let entry;
		try {
			entry = this.registry.completeDispatch(payload.dispatchId);
		} catch (err) {
			if (err instanceof UnknownDispatchError) {
				writeGatewayTrace(
					`pipeline turn.complete unknown dispatchId=${payload.dispatchId}`,
				);
				return {delivered: false};
			}
			throw err;
		}
		const result = await this.sendOutbound(entry.location, payload);
		writeGatewayTrace(
			`pipeline sendOutbound delivered dispatchId=${payload.dispatchId} providerMessageId=${result.providerMessageId}`,
		);
		return {delivered: true, providerMessageId: result.providerMessageId};
	}

	private async sendOutbound(
		_parkedLocation: ChannelLocation,
		payload: SessionTurnCompleteRequestPayload,
	): Promise<SendResult> {
		const out: OutboundMessage = {
			location: payload.location,
			text: payload.text,
			idempotencyKey: payload.idempotencyKey,
		};
		const result = await this.outboundDispatcher.dispatch(
			payload.location.channelId,
			out,
		);
		if (result.kind === 'sent') return result.result;
		return {
			providerMessageId: `outbox:${result.outboxId}`,
			deliveredAt: this.now(),
		};
	}

	private findSlotByRuntimeId(
		runtimeId: string,
	): {key: AttachmentKey; runtime: RegisteredRuntime} | null {
		return this.bindingStore.getAttachmentKeyByRuntimeId(runtimeId);
	}

	private drainPending(key: AttachmentKey): void {
		const current = this.bindingStore.getCurrentByAttachment(key);
		if (!current || !this.bindingStore.hasActiveBinding(current.runtimeId))
			return;
		const parked = this.inboundQueue.drain();
		let dispatched = 0;
		let dropped = 0;
		for (const {inbound} of parked) {
			const result = this.dispatchInboundToRuntime(inbound, current, key);
			if (result.kind === 'dispatched') dispatched += 1;
			else dropped += 1;
		}
		if (dispatched > 0 || dropped > 0) {
			this.log?.(
				'info',
				`drainPending: dispatched=${dispatched} dropped=${dropped}`,
			);
		}
	}

	// ── reads ────────────────────────────────────────────────

	getCurrentRuntime(): RegisteredRuntime | null {
		return this.bindingStore.getCurrent();
	}

	getCurrentRuntimeByAttachment(
		attachmentId: string | undefined,
	): RegisteredRuntime | null {
		return this.bindingStore.getCurrentByAttachment(attachmentId);
	}

	getBinding() {
		return this.bindingStore.getBinding();
	}

	hasActiveBinding(runtimeId?: string): boolean {
		return this.bindingStore.hasActiveBinding(runtimeId);
	}

	getRuntimeIdByConnection(connectionId: string): string | null {
		return this.bindingStore.getRuntimeIdByConnection(connectionId);
	}

	pendingDispatchCount(): number {
		return this.registry.pendingDispatchCount();
	}

	pendingInboundCount(): number {
		return this.inboundQueue.size();
	}

	pendingOutboxCount(): number {
		return this.outbox.size();
	}
}
