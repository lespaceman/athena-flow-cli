import Database from 'better-sqlite3';
import type {RuntimeDecision} from '../../core/runtime/types';
import {ensureDaemonStateDir} from '../../infra/daemon/stateDir';

export type DashboardDecisionInboxRow = {
	id: number;
	athenaSessionId: string;
	requestId: string;
	decision: RuntimeDecision;
	receivedAt: number;
};

export type DashboardDecisionInbox = {
	enqueue(input: {
		athenaSessionId: string;
		requestId: string;
		decision: RuntimeDecision;
		receivedAt: number;
	}): void;
	pendingForSession(input: {
		athenaSessionId: string;
		limit: number;
	}): DashboardDecisionInboxRow[];
	markConsumed(input: {id: number}): void;
	close(): void;
};

export type CreateDashboardDecisionInboxOptions = {
	dbPath?: string;
};

function dashboardDecisionInboxPath(): string {
	return `${ensureDaemonStateDir().dir}/dashboard-decision-inbox.db`;
}

function initInboxSchema(db: Database.Database): void {
	db.exec(`
		PRAGMA journal_mode = WAL;

		CREATE TABLE IF NOT EXISTS dashboard_decision_inbox (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			athena_session_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			decision_json TEXT NOT NULL,
			received_at INTEGER NOT NULL,
			consumed_at INTEGER,
			UNIQUE(athena_session_id, request_id)
		);

		CREATE INDEX IF NOT EXISTS idx_dashboard_decision_pending
			ON dashboard_decision_inbox(athena_session_id, consumed_at, id);
	`);
}

export function createDashboardDecisionInbox(
	options: CreateDashboardDecisionInboxOptions = {},
): DashboardDecisionInbox {
	const db = new Database(options.dbPath ?? dashboardDecisionInboxPath());
	initInboxSchema(db);

	const insert = db.prepare(`
		INSERT OR IGNORE INTO dashboard_decision_inbox (
			athena_session_id,
			request_id,
			decision_json,
			received_at
		)
		VALUES (?, ?, ?, ?)
	`);
	const selectPending = db.prepare(`
		SELECT id, athena_session_id, request_id, decision_json, received_at
		FROM dashboard_decision_inbox
		WHERE athena_session_id = ? AND consumed_at IS NULL
		ORDER BY id ASC
		LIMIT ?
	`);
	const consume = db.prepare(`
		UPDATE dashboard_decision_inbox
		SET consumed_at = ?
		WHERE id = ?
	`);

	return {
		enqueue(input) {
			insert.run(
				input.athenaSessionId,
				input.requestId,
				JSON.stringify(input.decision),
				input.receivedAt,
			);
		},
		pendingForSession(input) {
			const rows = selectPending.all(
				input.athenaSessionId,
				input.limit,
			) as Array<{
				id: number;
				athena_session_id: string;
				request_id: string;
				decision_json: string;
				received_at: number;
			}>;
			return rows.map(row => ({
				id: row.id,
				athenaSessionId: row.athena_session_id,
				requestId: row.request_id,
				decision: JSON.parse(row.decision_json) as RuntimeDecision,
				receivedAt: row.received_at,
			}));
		},
		markConsumed(input) {
			consume.run(Date.now(), input.id);
		},
		close() {
			db.close();
		},
	};
}
