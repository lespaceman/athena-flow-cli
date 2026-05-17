import Database from 'better-sqlite3';
import type {FeedEvent} from '../../core/feed/types';
import {ensureDaemonStateDir} from '../../infra/daemon/stateDir';

export type DashboardFeedOrigin = 'local' | 'dashboard';

export type DashboardFeedEnvelope = {
	instanceId: string;
	athenaSessionId: string;
	runId: string;
	origin: DashboardFeedOrigin;
	eventId: string;
	feedSeq: number;
	emittedAt: number;
	feedEvent: FeedEvent;
};

export type DashboardFeedOutboxRow = {
	deliverySeq: number;
	envelope: DashboardFeedEnvelope;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
};

export type DashboardFeedOutbox = {
	enqueue(input: {
		instanceId: string;
		athenaSessionId: string;
		origin: DashboardFeedOrigin;
		feedEvents: readonly FeedEvent[];
		emittedAt: number;
	}): void;
	pendingBatch(input: {limit: number; now: number}): DashboardFeedOutboxRow[];
	markAttempted(input: {
		deliverySeq: number;
		nextAttemptAt: number;
		lastError?: string;
	}): void;
	markAcked(input: {deliverySeq?: number; eventId?: string}): void;
	close(): void;
};

export type CreateDashboardFeedOutboxOptions = {
	dbPath?: string;
};

function dashboardFeedOutboxPath(): string {
	return `${ensureDaemonStateDir().dir}/dashboard-feed-outbox.db`;
}

function initOutboxSchema(db: Database.Database): void {
	db.exec(`
		PRAGMA journal_mode = WAL;

		CREATE TABLE IF NOT EXISTS dashboard_feed_outbox (
			delivery_seq INTEGER PRIMARY KEY AUTOINCREMENT,
			instance_id TEXT NOT NULL,
			athena_session_id TEXT NOT NULL,
			run_id TEXT NOT NULL,
			origin TEXT NOT NULL CHECK(origin IN ('local', 'dashboard')),
			event_id TEXT NOT NULL,
			emitted_at INTEGER NOT NULL,
			feed_event_json TEXT NOT NULL,
			attempt INTEGER NOT NULL DEFAULT 0,
			next_attempt_at INTEGER NOT NULL,
			last_error TEXT,
			acked_at INTEGER,
			UNIQUE(instance_id, event_id)
		);

		CREATE INDEX IF NOT EXISTS idx_dashboard_feed_outbox_pending
			ON dashboard_feed_outbox(acked_at, next_attempt_at, delivery_seq);
	`);
}

function makeEnvelope(input: {
	instanceId: string;
	athenaSessionId: string;
	origin: DashboardFeedOrigin;
	feedEvent: FeedEvent;
	deliverySeq: number;
	emittedAt: number;
}): DashboardFeedEnvelope {
	return {
		instanceId: input.instanceId,
		athenaSessionId: input.athenaSessionId,
		runId: input.feedEvent.run_id,
		origin: input.origin,
		eventId: `${input.athenaSessionId}:${input.feedEvent.event_id}`,
		feedSeq: input.deliverySeq,
		emittedAt: input.emittedAt,
		feedEvent: input.feedEvent,
	};
}

export function createDashboardFeedOutbox(
	options: CreateDashboardFeedOutboxOptions = {},
): DashboardFeedOutbox {
	const db = new Database(options.dbPath ?? dashboardFeedOutboxPath());
	initOutboxSchema(db);

	const insert = db.prepare(`
		INSERT OR IGNORE INTO dashboard_feed_outbox (
			instance_id,
			athena_session_id,
			run_id,
			origin,
			event_id,
			emitted_at,
			feed_event_json,
			next_attempt_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const selectPending = db.prepare(`
		SELECT
			delivery_seq,
			instance_id,
			athena_session_id,
			run_id,
			origin,
			event_id,
			emitted_at,
			feed_event_json,
			attempt,
			next_attempt_at,
			last_error
		FROM dashboard_feed_outbox
		WHERE acked_at IS NULL AND next_attempt_at <= ?
		ORDER BY delivery_seq ASC
		LIMIT ?
	`);

	const updateAttempt = db.prepare(`
		UPDATE dashboard_feed_outbox
		SET attempt = attempt + 1,
			next_attempt_at = ?,
			last_error = ?
		WHERE delivery_seq = ?
	`);

	const ackBySeq = db.prepare(`
		UPDATE dashboard_feed_outbox
		SET acked_at = ?
		WHERE delivery_seq = ?
	`);

	const ackByEventId = db.prepare(`
		UPDATE dashboard_feed_outbox
		SET acked_at = ?
		WHERE event_id = ?
	`);

	const enqueueTx = db.transaction(
		(input: {
			instanceId: string;
			athenaSessionId: string;
			origin: DashboardFeedOrigin;
			feedEvents: readonly FeedEvent[];
			emittedAt: number;
		}) => {
			for (const feedEvent of input.feedEvents) {
				const eventId = `${input.athenaSessionId}:${feedEvent.event_id}`;
				insert.run(
					input.instanceId,
					input.athenaSessionId,
					feedEvent.run_id,
					input.origin,
					eventId,
					input.emittedAt,
					JSON.stringify(feedEvent),
					input.emittedAt,
				);
			}
		},
	);

	return {
		enqueue(input) {
			if (input.feedEvents.length === 0) return;
			enqueueTx(input);
		},
		pendingBatch(input) {
			const rows = selectPending.all(input.now, input.limit) as Array<{
				delivery_seq: number;
				instance_id: string;
				athena_session_id: string;
				origin: DashboardFeedOrigin;
				emitted_at: number;
				feed_event_json: string;
				attempt: number;
				next_attempt_at: number;
				last_error: string | null;
			}>;
			return rows.map(row => {
				const feedEvent = JSON.parse(row.feed_event_json) as FeedEvent;
				return {
					deliverySeq: row.delivery_seq,
					envelope: makeEnvelope({
						instanceId: row.instance_id,
						athenaSessionId: row.athena_session_id,
						origin: row.origin,
						feedEvent,
						deliverySeq: row.delivery_seq,
						emittedAt: row.emitted_at,
					}),
					attempt: row.attempt,
					nextAttemptAt: row.next_attempt_at,
					...(row.last_error ? {lastError: row.last_error} : {}),
				};
			});
		},
		markAttempted(input) {
			updateAttempt.run(
				input.nextAttemptAt,
				input.lastError ?? null,
				input.deliverySeq,
			);
		},
		markAcked(input) {
			const now = Date.now();
			if (typeof input.deliverySeq === 'number') {
				ackBySeq.run(now, input.deliverySeq);
			}
			if (input.eventId) {
				ackByEventId.run(now, input.eventId);
			}
		},
		close() {
			db.close();
		},
	};
}
