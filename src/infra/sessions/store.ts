import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {FeedEvent} from '../../core/feed/types';
import type {MapperBootstrap} from '../../core/feed/bootstrap';
import type {RuntimeEvent} from '../../core/runtime/types';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import {initSchema} from './schema';
import type {
	AthenaSession,
	AdapterSessionRecord,
	StoredSession,
	WorkflowRunSnapshot,
	PersistedWorkflowRun,
} from './types';

export type SessionStoreOptions = {
	sessionId: string;
	projectDir: string;
	dbPath: string;
	label?: string;
};

type SessionRow = {
	id: string;
	project_dir: string;
	created_at: number;
	updated_at: number;
	label: string | null;
	event_count: number | null;
};

export type SessionStore = {
	/** Atomically records a runtime event and its derived feed events in a single transaction. */
	recordEvent(event: RuntimeEvent, feedEvents: FeedEvent[]): void;
	/** Persists feed-only events (e.g. decisions) with null runtime_event_id. */
	recordFeedEvents(feedEvents: FeedEvent[]): void;
	restore(): StoredSession;
	/** Returns the minimal bootstrap data the feed mapper needs, or undefined if no stored data. */
	toBootstrap(): MapperBootstrap | undefined;
	getAthenaSession(): AthenaSession;
	updateLabel(label: string): void;
	/** Persist final token usage for an adapter session. */
	recordTokens(adapterSessionId: string, tokens: TokenUsage): void;
	/** Sum token columns across all adapter sessions. contextSize comes from the most recent. */
	getRestoredTokens(): TokenUsage | null;
	close(): void;
	/** Whether persistence has failed and the session is running without storage. */
	isDegraded: boolean;
	/** Human-readable reason for degradation (undefined if not degraded). */
	degradedReason: string | undefined;
	/** Mark the session as degraded after a persistence failure. */
	markDegraded(reason: string): void;
	persistRun(snapshot: WorkflowRunSnapshot): void;
	getLatestRun(): PersistedWorkflowRun | null;
	linkAdapterSession(adapterSessionId: string, runId: string): void;
};

export function createSessionStore(opts: SessionStoreOptions): SessionStore {
	// Ensure parent directory exists for file-based databases
	if (opts.dbPath !== ':memory:') {
		fs.mkdirSync(path.dirname(opts.dbPath), {recursive: true});
	}

	// Acquire exclusive write lock via SQLite's locking_mode.
	// This prevents a second process from accidentally writing to the same DB
	// and colliding on seq allocation. Read-only consumers (registry) use
	// separate readonly connections and are unaffected.
	const db = new Database(opts.dbPath);
	initSchema(db);
	if (opts.dbPath !== ':memory:') {
		db.pragma('locking_mode = EXCLUSIVE');
		// Force SQLite to acquire the lock immediately by starting a write
		db.exec('BEGIN IMMEDIATE; COMMIT');
	}

	let runtimeSeq = 0;
	let degraded = false;
	let degradedReason: string | undefined;

	// Track known adapter session IDs to avoid duplicate inserts
	const knownAdapterSessions = new Set<string>();

	// Initialize session row
	const now = Date.now();
	db.prepare(
		`INSERT OR IGNORE INTO session (id, project_dir, created_at, updated_at, label)
		 VALUES (?, ?, ?, ?, ?)`,
	).run(opts.sessionId, opts.projectDir, now, now, opts.label ?? null);

	// If resuming, load existing state
	const existingMaxSeq = db
		.prepare('SELECT MAX(seq) as maxSeq FROM runtime_events')
		.get() as {maxSeq: number | null};
	if (existingMaxSeq.maxSeq !== null) {
		runtimeSeq = existingMaxSeq.maxSeq;
	}

	// Load known adapter sessions
	const existingAdapters = db
		.prepare('SELECT session_id FROM adapter_sessions')
		.all() as {session_id: string}[];
	for (const row of existingAdapters) {
		knownAdapterSessions.add(row.session_id);
	}

	// Prepared statements
	const insertRuntimeEvent = db.prepare(
		`INSERT OR IGNORE INTO runtime_events (id, seq, timestamp, hook_name, adapter_session_id, payload)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);

	const insertFeedEvent = db.prepare(
		`INSERT OR IGNORE INTO feed_events (event_id, runtime_event_id, seq, kind, run_id, actor_id, timestamp, data)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	const insertAdapterSession = db.prepare(
		`INSERT OR IGNORE INTO adapter_sessions (session_id, started_at)
		 VALUES (?, ?)`,
	);

	const updateSessionTimestamp = db.prepare(
		`UPDATE session SET updated_at = ? WHERE id = ?`,
	);

	const updateEventCount = db.prepare(
		'UPDATE session SET event_count = event_count + ? WHERE id = ?',
	);

	const upsertRun = db.prepare(
		`INSERT INTO workflow_runs (id, session_id, workflow_name, started_at, iteration, max_iterations, status, stop_reason, tracker_path)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   iteration = excluded.iteration,
		   status = excluded.status,
		   stop_reason = excluded.stop_reason,
		   ended_at = CASE WHEN excluded.status != 'running' THEN ? ELSE ended_at END`,
	);

	const selectLatestRun = db.prepare(
		`SELECT * FROM workflow_runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
	);

	const updateAdapterRunId = db.prepare(
		`UPDATE adapter_sessions SET run_id = ? WHERE session_id = ?`,
	);

	function recordRuntimeEvent(event: RuntimeEvent): void {
		runtimeSeq++;
		insertRuntimeEvent.run(
			event.id,
			runtimeSeq,
			event.timestamp,
			event.hookName,
			event.sessionId,
			JSON.stringify(event),
		);

		// Track adapter session
		if (event.sessionId && !knownAdapterSessions.has(event.sessionId)) {
			knownAdapterSessions.add(event.sessionId);
			insertAdapterSession.run(event.sessionId, event.timestamp);
		}

		// Update session timestamp
		updateSessionTimestamp.run(event.timestamp, opts.sessionId);
	}

	const recordEvent = db.transaction(
		(event: RuntimeEvent, feedEvents: FeedEvent[]) => {
			recordRuntimeEvent(event);
			for (const fe of feedEvents) {
				insertFeedEvent.run(
					fe.event_id,
					event.id,
					fe.seq,
					fe.kind,
					fe.run_id,
					fe.actor_id,
					fe.ts,
					JSON.stringify(fe),
				);
			}
			updateEventCount.run(feedEvents.length, opts.sessionId);
		},
	);

	const recordFeedEvents = db.transaction((feedEvents: FeedEvent[]) => {
		for (const fe of feedEvents) {
			insertFeedEvent.run(
				fe.event_id,
				null,
				fe.seq,
				fe.kind,
				fe.run_id,
				fe.actor_id,
				fe.ts,
				JSON.stringify(fe),
			);
		}
		updateEventCount.run(feedEvents.length, opts.sessionId);
		updateSessionTimestamp.run(Date.now(), opts.sessionId);
	});

	function restore(): StoredSession {
		const sessionRow = db
			.prepare('SELECT * FROM session WHERE id = ?')
			.get(opts.sessionId) as SessionRow | undefined;

		const adapterRows = db
			.prepare('SELECT * FROM adapter_sessions ORDER BY started_at')
			.all() as Array<{
			session_id: string;
			started_at: number;
			ended_at: number | null;
			model: string | null;
			source: string | null;
		}>;

		const feedRows = db
			.prepare('SELECT data FROM feed_events ORDER BY seq')
			.all() as Array<{data: string}>;

		const adapterSessionIds = adapterRows.map(r => r.session_id);

		const session: AthenaSession = sessionRow
			? {
					id: sessionRow.id,
					projectDir: sessionRow.project_dir,
					createdAt: sessionRow.created_at,
					updatedAt: sessionRow.updated_at,
					label: sessionRow.label ?? undefined,
					eventCount: sessionRow.event_count ?? 0,
					adapterSessionIds,
				}
			: {
					id: opts.sessionId,
					projectDir: opts.projectDir,
					createdAt: now,
					updatedAt: now,
					adapterSessionIds,
				};

		const adapterSessions: AdapterSessionRecord[] = adapterRows.map(r => ({
			sessionId: r.session_id,
			startedAt: r.started_at,
			endedAt: r.ended_at ?? undefined,
			model: r.model ?? undefined,
			source: r.source ?? undefined,
		}));

		const feedEvents: FeedEvent[] = feedRows.map(
			r => JSON.parse(r.data) as FeedEvent,
		);

		return {session, feedEvents, adapterSessions};
	}

	function toBootstrap(): MapperBootstrap | undefined {
		const stored = restore();
		return {
			feedEvents: stored.feedEvents,
			adapterSessionIds: stored.session.adapterSessionIds,
			createdAt: stored.session.createdAt,
		};
	}

	function getAthenaSession(): AthenaSession {
		const sessionRow = db
			.prepare('SELECT * FROM session WHERE id = ?')
			.get(opts.sessionId) as SessionRow | undefined;

		const adapterRows = db
			.prepare('SELECT session_id FROM adapter_sessions ORDER BY started_at')
			.all() as {session_id: string}[];

		if (!sessionRow) {
			return {
				id: opts.sessionId,
				projectDir: opts.projectDir,
				createdAt: now,
				updatedAt: now,
				adapterSessionIds: adapterRows.map(r => r.session_id),
			};
		}

		return {
			id: sessionRow.id,
			projectDir: sessionRow.project_dir,
			createdAt: sessionRow.created_at,
			updatedAt: sessionRow.updated_at,
			label: sessionRow.label ?? undefined,
			eventCount: sessionRow.event_count ?? 0,
			adapterSessionIds: adapterRows.map(r => r.session_id),
		};
	}

	const updateTokens = db.prepare(
		`UPDATE adapter_sessions SET
			tokens_input = ?, tokens_output = ?,
			tokens_cache_read = ?, tokens_cache_write = ?,
			tokens_context_size = ?, tokens_context_window_size = ?
		 WHERE session_id = ?`,
	);

	function recordTokens(adapterSessionId: string, tokens: TokenUsage): void {
		updateTokens.run(
			tokens.input,
			tokens.output,
			tokens.cacheRead,
			tokens.cacheWrite,
			tokens.contextSize,
			tokens.contextWindowSize,
			adapterSessionId,
		);
	}

	function getRestoredTokens(): TokenUsage | null {
		const row = db
			.prepare(
				`SELECT
					SUM(tokens_input) as input,
					SUM(tokens_output) as output,
					SUM(tokens_cache_read) as cache_read,
					SUM(tokens_cache_write) as cache_write
				 FROM adapter_sessions`,
			)
			.get() as {
			input: number | null;
			output: number | null;
			cache_read: number | null;
			cache_write: number | null;
		};

		if (
			row.input === null &&
			row.output === null &&
			row.cache_read === null &&
			row.cache_write === null
		) {
			return null;
		}

		// contextSize from the most recent adapter session
		const ctxRow = db
			.prepare(
				`SELECT tokens_context_size, tokens_context_window_size FROM adapter_sessions
				 ORDER BY started_at DESC LIMIT 1`,
			)
			.get() as
			| {
					tokens_context_size: number | null;
					tokens_context_window_size: number | null;
			  }
			| undefined;

		const input = row.input ?? 0;
		const output = row.output ?? 0;
		const cacheRead = row.cache_read ?? 0;
		const cacheWrite = row.cache_write ?? 0;

		return {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: input + output,
			contextSize: ctxRow?.tokens_context_size ?? null,
			contextWindowSize: ctxRow?.tokens_context_window_size ?? null,
		};
	}

	function updateLabel(label: string): void {
		db.prepare('UPDATE session SET label = ? WHERE id = ?').run(
			label,
			opts.sessionId,
		);
	}

	function close(): void {
		db.close();
	}

	function persistRun(snapshot: WorkflowRunSnapshot): void {
		const now = Date.now();
		const endedAt = snapshot.status !== 'running' ? now : null;
		upsertRun.run(
			snapshot.runId,
			snapshot.sessionId,
			snapshot.workflowName ?? null,
			now,
			snapshot.iteration,
			snapshot.maxIterations ?? 1,
			snapshot.status,
			snapshot.stopReason ?? null,
			snapshot.trackerPath ?? null,
			endedAt,
		);
	}

	function getLatestRun(): PersistedWorkflowRun | null {
		const row = selectLatestRun.get(opts.sessionId) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return {
			id: row.id as string,
			sessionId: row.session_id as string,
			workflowName: (row.workflow_name as string) ?? undefined,
			startedAt: row.started_at as number,
			endedAt: (row.ended_at as number) ?? undefined,
			iteration: row.iteration as number,
			maxIterations: row.max_iterations as number,
			status: row.status as PersistedWorkflowRun['status'],
			stopReason: (row.stop_reason as string) ?? undefined,
			trackerPath: (row.tracker_path as string) ?? undefined,
		};
	}

	function linkAdapterSession(adapterSessionId: string, runId: string): void {
		updateAdapterRunId.run(runId, adapterSessionId);
	}

	return {
		recordEvent,
		recordFeedEvents,
		restore,
		toBootstrap,
		getAthenaSession,
		updateLabel,
		recordTokens,
		getRestoredTokens,
		close,
		get isDegraded() {
			return degraded;
		},
		get degradedReason() {
			return degradedReason;
		},
		markDegraded(reason: string) {
			degraded = true;
			degradedReason = reason;
			console.error(`[athena] session degraded: ${reason}`);
		},
		persistRun,
		getLatestRun,
		linkAdapterSession,
	};
}
