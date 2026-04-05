import {describe, it, expect} from 'vitest';
import Database from 'better-sqlite3';
import {initSchema} from './schema';

describe('schema migrations', () => {
	it('rejects duplicate global seq (different runs)', () => {
		const db = new Database(':memory:');
		initSchema(db);

		db.prepare(
			'INSERT INTO session (id, project_dir, created_at, updated_at) VALUES (?, ?, ?, ?)',
		).run('s1', '/tmp', Date.now(), Date.now());
		db.prepare(
			'INSERT INTO runtime_events (id, seq, timestamp, hook_name, payload) VALUES (?, ?, ?, ?, ?)',
		).run('re1', 1, Date.now(), 'PreToolUse', '{}');

		db.prepare(
			'INSERT INTO feed_events (event_id, runtime_event_id, seq, kind, run_id, actor_id, timestamp, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		).run('fe1', 're1', 1, 'tool.pre', 'run-A', 'agent:root', Date.now(), '{}');

		expect(() => {
			db.prepare(
				'INSERT INTO feed_events (event_id, runtime_event_id, seq, kind, run_id, actor_id, timestamp, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			).run(
				'fe2',
				're1',
				1,
				'tool.pre',
				'run-B',
				'agent:root',
				Date.now(),
				'{}',
			);
		}).toThrow();
		db.close();
	});

	it('rejects pre-release v1 databases', () => {
		const db = new Database(':memory:');
		db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
		db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
		// Minimal tables so initSchema doesn't fail on CREATE TABLE IF NOT EXISTS
		db.exec(
			'CREATE TABLE session (id TEXT PRIMARY KEY, project_dir TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, label TEXT, event_count INTEGER DEFAULT 0)',
		);
		db.exec(
			'CREATE TABLE runtime_events (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, timestamp INTEGER NOT NULL, hook_name TEXT NOT NULL, adapter_session_id TEXT, payload JSON NOT NULL)',
		);
		db.exec(
			'CREATE TABLE feed_events (event_id TEXT PRIMARY KEY, runtime_event_id TEXT, seq INTEGER NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, actor_id TEXT NOT NULL, timestamp INTEGER NOT NULL, data JSON NOT NULL, FOREIGN KEY (runtime_event_id) REFERENCES runtime_events(id))',
		);
		db.exec(
			'CREATE TABLE adapter_sessions (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, model TEXT, source TEXT)',
		);

		expect(() => initSchema(db)).toThrow(/predates the first release/);
		db.close();
	});

	it('migrates v2 → v4 by adding token columns', () => {
		const db = new Database(':memory:');
		// Set up a v2 database manually
		db.exec('PRAGMA foreign_keys = ON');
		db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
		db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);
		db.exec(
			'CREATE TABLE session (id TEXT PRIMARY KEY, project_dir TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, label TEXT, event_count INTEGER DEFAULT 0)',
		);
		db.exec(
			'CREATE TABLE runtime_events (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, timestamp INTEGER NOT NULL, hook_name TEXT NOT NULL, adapter_session_id TEXT, payload JSON NOT NULL)',
		);
		db.exec(
			'CREATE TABLE feed_events (event_id TEXT PRIMARY KEY, runtime_event_id TEXT, seq INTEGER NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, actor_id TEXT NOT NULL, timestamp INTEGER NOT NULL, data JSON NOT NULL, FOREIGN KEY (runtime_event_id) REFERENCES runtime_events(id))',
		);
		db.exec(
			'CREATE TABLE adapter_sessions (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, model TEXT, source TEXT)',
		);

		// Insert an adapter session before migration
		db.prepare(
			'INSERT INTO adapter_sessions (session_id, started_at) VALUES (?, ?)',
		).run('as1', Date.now());

		// Run migration
		initSchema(db);

		// Verify version bumped (chains through v4→v5)
		const row = db.prepare('SELECT version FROM schema_version').get() as {
			version: number;
		};
		expect(row.version).toBe(5);

		// Verify token columns exist and can be updated
		db.prepare(
			'UPDATE adapter_sessions SET tokens_input = 100 WHERE session_id = ?',
		).run('as1');
		const updated = db
			.prepare(
				'SELECT tokens_input, tokens_context_window_size FROM adapter_sessions WHERE session_id = ?',
			)
			.get('as1') as {tokens_input: number};
		expect(updated.tokens_input).toBe(100);
		expect(updated.tokens_context_window_size ?? null).toBeNull();

		db.prepare(
			'UPDATE adapter_sessions SET tokens_context_window_size = 200000 WHERE session_id = ?',
		).run('as1');
		const withWindow = db
			.prepare(
				'SELECT tokens_context_window_size FROM adapter_sessions WHERE session_id = ?',
			)
			.get('as1') as {tokens_context_window_size: number};
		expect(withWindow.tokens_context_window_size).toBe(200000);

		db.close();
	});

	it('migrates v3 → v4 by adding context window size column', () => {
		const db = new Database(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
		db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3);
		db.exec(
			'CREATE TABLE session (id TEXT PRIMARY KEY, project_dir TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, label TEXT, event_count INTEGER DEFAULT 0)',
		);
		db.exec(
			'CREATE TABLE runtime_events (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, timestamp INTEGER NOT NULL, hook_name TEXT NOT NULL, adapter_session_id TEXT, payload JSON NOT NULL)',
		);
		db.exec(
			'CREATE TABLE feed_events (event_id TEXT PRIMARY KEY, runtime_event_id TEXT, seq INTEGER NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, actor_id TEXT NOT NULL, timestamp INTEGER NOT NULL, data JSON NOT NULL, FOREIGN KEY (runtime_event_id) REFERENCES runtime_events(id))',
		);
		db.exec(
			'CREATE TABLE adapter_sessions (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, model TEXT, source TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, tokens_context_size INTEGER)',
		);

		initSchema(db);

		const row = db.prepare('SELECT version FROM schema_version').get() as {
			version: number;
		};
		expect(row.version).toBe(5);

		db.prepare(
			'INSERT INTO adapter_sessions (session_id, started_at, tokens_context_window_size) VALUES (?, ?, ?)',
		).run('as2', Date.now(), 400000);
		const updated = db
			.prepare(
				'SELECT tokens_context_window_size FROM adapter_sessions WHERE session_id = ?',
			)
			.get('as2') as {tokens_context_window_size: number};
		expect(updated.tokens_context_window_size).toBe(400000);

		db.close();
	});

	it('migrates v4 → v5 by adding workflow_runs table and run_id column', () => {
		const db = new Database(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
		db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(4);
		db.exec(
			'CREATE TABLE session (id TEXT PRIMARY KEY, project_dir TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, label TEXT, event_count INTEGER DEFAULT 0)',
		);
		db.exec(
			'CREATE TABLE runtime_events (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, timestamp INTEGER NOT NULL, hook_name TEXT NOT NULL, adapter_session_id TEXT, payload JSON NOT NULL)',
		);
		db.exec(
			'CREATE TABLE feed_events (event_id TEXT PRIMARY KEY, runtime_event_id TEXT, seq INTEGER NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, actor_id TEXT NOT NULL, timestamp INTEGER NOT NULL, data JSON NOT NULL, FOREIGN KEY (runtime_event_id) REFERENCES runtime_events(id))',
		);
		db.exec(
			'CREATE TABLE adapter_sessions (session_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, model TEXT, source TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, tokens_context_size INTEGER, tokens_context_window_size INTEGER)',
		);

		db.prepare(
			'INSERT INTO session (id, project_dir, created_at, updated_at) VALUES (?, ?, ?, ?)',
		).run('s1', '/tmp', Date.now(), Date.now());
		db.prepare(
			'INSERT INTO adapter_sessions (session_id, started_at) VALUES (?, ?)',
		).run('as1', Date.now());

		initSchema(db);

		const row = db.prepare('SELECT version FROM schema_version').get() as {
			version: number;
		};
		expect(row.version).toBe(5);

		db.prepare(
			`INSERT INTO workflow_runs (id, session_id, started_at, iteration, max_iterations, status)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run('wr1', 's1', Date.now(), 0, 5, 'running');

		const wr = db
			.prepare('SELECT * FROM workflow_runs WHERE id = ?')
			.get('wr1') as Record<string, unknown>;
		expect(wr.session_id).toBe('s1');
		expect(wr.iteration).toBe(0);
		expect(wr.status).toBe('running');

		db.prepare(
			'UPDATE adapter_sessions SET run_id = ? WHERE session_id = ?',
		).run('wr1', 'as1');
		const as = db
			.prepare('SELECT run_id FROM adapter_sessions WHERE session_id = ?')
			.get('as1') as {run_id: string};
		expect(as.run_id).toBe('wr1');

		db.prepare(
			'INSERT INTO adapter_sessions (session_id, started_at) VALUES (?, ?)',
		).run('as2', Date.now());
		const as2 = db
			.prepare('SELECT run_id FROM adapter_sessions WHERE session_id = ?')
			.get('as2') as {run_id: string | null};
		expect(as2.run_id).toBeNull();

		db.close();
	});

	it('throws on forward-incompatible schema', () => {
		const db = new Database(':memory:');
		db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
		db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(999);

		expect(() => initSchema(db)).toThrow(/newer schema/i);
		db.close();
	});
});
