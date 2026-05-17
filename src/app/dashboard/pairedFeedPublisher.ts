import type {FeedEvent} from '../../core/feed/types';
import {
	readDashboardClientConfig,
	type DashboardClientConfig,
} from '../../infra/config/dashboardClient';
import {
	createDashboardFeedOutbox,
	type DashboardFeedEnvelope,
	type DashboardFeedOrigin,
	type DashboardFeedOutbox,
} from './dashboardFeedPublisher';

type FeedAckFrame = {type: 'feed_ack'; deliverySeq?: number; eventId?: string};

export type PairedFeedTransport = {
	sendFeedEvent(frame: {
		deliverySeq: number;
		envelope: DashboardFeedEnvelope;
	}): void;
};

export type PairedFeedPublisher = {
	publish(input: {
		origin: DashboardFeedOrigin;
		athenaSessionId: string;
		feedEvents: readonly FeedEvent[];
	}): void;
	attachTransport(transport: PairedFeedTransport): void;
	detachTransport(): void;
	handleAck(frame: FeedAckFrame): void;
	close(): void;
};

export type CreatePairedFeedPublisherOptions = {
	readConfig?: () => DashboardClientConfig | null;
	outbox?: DashboardFeedOutbox;
	now?: () => number;
	onError?: (message: string) => void;
	drainIntervalMs?: number;
};

const DEFAULT_DRAIN_INTERVAL_MS = 1_000;

export function createPairedFeedPublisher(
	options: CreatePairedFeedPublisherOptions = {},
): PairedFeedPublisher {
	const readConfig = options.readConfig ?? (() => readDashboardClientConfig());
	const now = options.now ?? (() => Date.now());
	const onError = options.onError ?? (() => {});
	const drainIntervalMs = options.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
	let ownedOutbox: DashboardFeedOutbox | null = null;
	let transport: PairedFeedTransport | null = null;
	let drainTimer: NodeJS.Timeout | null = null;

	function getOutbox(): DashboardFeedOutbox {
		if (options.outbox) return options.outbox;
		ownedOutbox ??= createDashboardFeedOutbox();
		return ownedOutbox;
	}

	function clearDrainTimer(): void {
		if (!drainTimer) return;
		clearInterval(drainTimer);
		drainTimer = null;
	}

	function drain(force = false): void {
		if (!transport) return;
		const rows = getOutbox().pendingBatch({
			limit: 100,
			now: force ? Number.POSITIVE_INFINITY : now(),
		});
		for (const row of rows) {
			transport.sendFeedEvent({
				deliverySeq: row.deliverySeq,
				envelope: row.envelope,
			});
			getOutbox().markAttempted({
				deliverySeq: row.deliverySeq,
				nextAttemptAt: now() + Math.min(30_000, (row.attempt + 1) * 1_000),
			});
		}
	}

	function startDrainTimer(): void {
		clearDrainTimer();
		const timer = setInterval(drain, drainIntervalMs);
		timer.unref();
		drainTimer = timer;
		drain(true);
	}

	return {
		publish(input) {
			if (input.feedEvents.length === 0) return;
			try {
				const config = readConfig();
				if (!config) return;
				getOutbox().enqueue({
					instanceId: config.instanceId,
					athenaSessionId: input.athenaSessionId,
					origin: input.origin,
					feedEvents: input.feedEvents,
					emittedAt: now(),
				});
				drain();
			} catch (err) {
				onError(
					`paired feed publish failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		},
		attachTransport(nextTransport) {
			transport = nextTransport;
			startDrainTimer();
		},
		detachTransport() {
			transport = null;
			clearDrainTimer();
		},
		handleAck(frame) {
			getOutbox().markAcked({
				...(typeof frame.deliverySeq === 'number'
					? {deliverySeq: frame.deliverySeq}
					: {}),
				...(typeof frame.eventId === 'string' ? {eventId: frame.eventId} : {}),
			});
		},
		close() {
			this.detachTransport();
			ownedOutbox?.close();
		},
	};
}
