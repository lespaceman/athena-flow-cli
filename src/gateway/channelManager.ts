/**
 * Owns the set of running `ChannelAdapter`s on behalf of the gateway daemon.
 *
 * Responsibilities:
 *   1. Start/stop adapters with a per-adapter `AbortController` so shutdown
 *      can be propagated via the standard `AdapterContext.signal`.
 *   2. Fan inbound messages out to a single registered listener (the future
 *      session router; until M5 lands, tests register a direct sink).
 *   3. Track an in-memory de-dup window keyed on `idempotencyKey` so
 *      repeated long-poll deliveries (Telegram retransmits on transient
 *      failures) don't dispatch twice.
 *   4. Surface health samples to a single registered listener (M8 wires
 *      these into the parking policy).
 *
 * Persistence of `channel_messages` rows is owned by the session bridge
 * (M5+), since the row's `session_id` is only known after routing.
 */

import type {
	ChannelAdapter,
	ChannelHealthListener,
	ChannelInboundListener,
	HealthSample,
	NormalizedInbound,
	OutboundMessage,
	ProbeResult,
	SendResult,
	StopReason,
} from '../shared/gateway-protocol';

export type ChannelManagerOptions = {
	/** Maximum number of recent idempotency keys retained for de-dup. */
	dedupWindow?: number;
	/** Stderr-style logger. */
	log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
};

type Entry = {
	adapter: ChannelAdapter;
	abort: AbortController;
	startPromise: Promise<void>;
	healthListener: ChannelHealthListener;
	inboundListener: ChannelInboundListener;
	lastHealth?: HealthSample;
};

const DEFAULT_DEDUP_WINDOW = 1024;

export class DuplicateChannelError extends Error {
	constructor(id: string) {
		super(`channel ${id} already registered`);
		this.name = 'DuplicateChannelError';
	}
}

export class UnknownChannelError extends Error {
	constructor(id: string) {
		super(`channel ${id} not registered`);
		this.name = 'UnknownChannelError';
	}
}

export class ChannelManager {
	private readonly entries = new Map<string, Entry>();
	private readonly dedup: string[] = [];
	private readonly dedupSet = new Set<string>();
	private readonly dedupMax: number;
	private readonly log: ChannelManagerOptions['log'];
	private inboundSink: ChannelInboundListener | null = null;
	private healthSink: ChannelHealthListener | null = null;
	private stopped = false;

	constructor(opts: ChannelManagerOptions = {}) {
		this.dedupMax = opts.dedupWindow ?? DEFAULT_DEDUP_WINDOW;
		this.log = opts.log;
	}

	/** Register the single inbound dispatch target. M5 wires the router here. */
	setInboundSink(sink: ChannelInboundListener | null): void {
		this.inboundSink = sink;
	}

	setHealthSink(sink: ChannelHealthListener | null): void {
		this.healthSink = sink;
	}

	listChannels(): ReadonlyArray<{
		id: string;
		health: HealthSample | undefined;
	}> {
		return [...this.entries.values()].map(e => ({
			id: e.adapter.id,
			health: e.lastHealth,
		}));
	}

	/** Snapshot of currently registered adapters; used by the relay coordinator. */
	listAdapters(): ReadonlyArray<ChannelAdapter> {
		return [...this.entries.values()].map(e => e.adapter);
	}

	async register(adapter: ChannelAdapter): Promise<void> {
		if (this.stopped) {
			throw new Error('channel manager already stopped');
		}
		if (this.entries.has(adapter.id)) {
			throw new DuplicateChannelError(adapter.id);
		}
		const abort = new AbortController();
		const inboundListener: ChannelInboundListener = msg =>
			this.handleInbound(msg);
		const healthListener: ChannelHealthListener = sample => {
			const entry = this.entries.get(adapter.id);
			if (entry) entry.lastHealth = sample;
			this.healthSink?.(sample);
		};
		adapter.on('inbound', inboundListener);
		adapter.on('health', healthListener);

		const startPromise = adapter.start({
			log: (level, msg) => this.log?.(level, `[${adapter.id}] ${msg}`),
			signal: abort.signal,
		});
		this.entries.set(adapter.id, {
			adapter,
			abort,
			startPromise,
			healthListener,
			inboundListener,
		});
		try {
			await startPromise;
		} catch (err) {
			adapter.off('inbound', inboundListener);
			adapter.off('health', healthListener);
			this.entries.delete(adapter.id);
			throw err;
		}
	}

	async unregister(id: string, reason: StopReason): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry) {
			throw new UnknownChannelError(id);
		}
		this.entries.delete(id);
		entry.abort.abort();
		entry.adapter.off('inbound', entry.inboundListener);
		entry.adapter.off('health', entry.healthListener);
		await entry.adapter.stop(reason);
	}

	async send(channelId: string, msg: OutboundMessage): Promise<SendResult> {
		const entry = this.entries.get(channelId);
		if (!entry) {
			throw new UnknownChannelError(channelId);
		}
		return entry.adapter.send(msg);
	}

	async probe(channelId: string): Promise<ProbeResult> {
		const entry = this.entries.get(channelId);
		if (!entry) {
			throw new UnknownChannelError(channelId);
		}
		return entry.adapter.probe();
	}

	async stop(reason: StopReason = 'shutdown'): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		const ids = [...this.entries.keys()];
		// Stop in reverse-registration order so later adapters that depend on
		// earlier ones (none today, but reserve the contract) wind down first.
		for (const id of ids.reverse()) {
			try {
				await this.unregister(id, reason);
			} catch (err) {
				this.log?.(
					'warn',
					`channel ${id} stop failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
	}

	private handleInbound(msg: NormalizedInbound): void {
		if (this.dedupSet.has(msg.idempotencyKey)) {
			this.log?.('debug', `dropping duplicate inbound ${msg.idempotencyKey}`);
			return;
		}
		this.dedupSet.add(msg.idempotencyKey);
		this.dedup.push(msg.idempotencyKey);
		while (this.dedup.length > this.dedupMax) {
			const evicted = this.dedup.shift();
			if (evicted !== undefined) this.dedupSet.delete(evicted);
		}
		const sink = this.inboundSink;
		if (!sink) {
			this.log?.(
				'debug',
				`no inbound sink registered; dropping ${msg.idempotencyKey}`,
			);
			return;
		}
		try {
			sink(msg);
		} catch (err) {
			this.log?.(
				'warn',
				`inbound sink threw: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
}
