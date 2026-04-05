import {describe, it, expect, afterEach} from 'vitest';
import {createSessionStore} from './store';
import type {RuntimeEvent} from '../../core/runtime/types';
import type {FeedEvent} from '../../core/feed/types';
import {mapLegacyHookNameToRuntimeKind} from '../../core/runtime/events';

// Helper: minimal RuntimeEvent
function makeRuntimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	const hookName = overrides.hookName ?? 'PreToolUse';
	const payload =
		typeof overrides.payload === 'object' && overrides.payload !== null
			? (overrides.payload as Record<string, unknown>)
			: {tool_name: 'Bash'};
	return {
		id: 'rt-1',
		timestamp: Date.now(),
		kind: overrides.kind ?? mapLegacyHookNameToRuntimeKind(hookName),
		data: overrides.data ?? payload,
		hookName,
		sessionId: 'claude-session-1',
		context: {cwd: '/tmp', transcriptPath: '/tmp/t.jsonl'},
		interaction: {expectsDecision: false},
		payload,
		...overrides,
	};
}

// Helper: minimal FeedEvent
function makeFeedEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
	return {
		event_id: 'run1:E1',
		seq: 1,
		ts: Date.now(),
		session_id: 'claude-session-1',
		run_id: 'run1',
		kind: 'tool.pre',
		level: 'info',
		actor_id: 'agent:root',
		title: 'Bash',
		data: {},
		...overrides,
	} as unknown as FeedEvent;
}

describe('SessionStore', () => {
	let store: ReturnType<typeof createSessionStore>;

	afterEach(() => {
		store?.close();
	});

	it('records a runtime event and retrieves it', () => {
		store = createSessionStore({
			sessionId: 's1',
			projectDir: '/home/user/proj',
			dbPath: ':memory:',
		});

		const rtEvent = makeRuntimeEvent({id: 'rt-1', sessionId: 'cs-1'});
		store.recordEvent(rtEvent, []);

		const restored = store.restore();
		expect(restored.session.id).toBe('s1');
		expect(restored.session.adapterSessionIds).toContain('cs-1');
	});

	it('records feed events linked to a runtime event', () => {
		store = createSessionStore({
			sessionId: 's2',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		const rtEvent = makeRuntimeEvent({id: 'rt-2'});
		const fe1 = makeFeedEvent({event_id: 'run1:E1', seq: 1});
		const fe2 = makeFeedEvent({event_id: 'run1:E2', seq: 2});
		store.recordEvent(rtEvent, [fe1, fe2]);

		const restored = store.restore();
		expect(restored.feedEvents).toHaveLength(2);
		expect(restored.feedEvents[0]!.event_id).toBe('run1:E1');
		expect(restored.feedEvents[1]!.event_id).toBe('run1:E2');
	});

	it('tracks adapter sessions from runtime events', () => {
		store = createSessionStore({
			sessionId: 's3',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		store.recordEvent(
			makeRuntimeEvent({id: 'rt-a', sessionId: 'adapter-1'}),
			[],
		);
		store.recordEvent(
			makeRuntimeEvent({id: 'rt-b', sessionId: 'adapter-1'}),
			[],
		);
		store.recordEvent(
			makeRuntimeEvent({id: 'rt-c', sessionId: 'adapter-2'}),
			[],
		);

		const restored = store.restore();
		expect(restored.session.adapterSessionIds).toEqual([
			'adapter-1',
			'adapter-2',
		]);
		expect(restored.adapterSessions).toHaveLength(2);
	});

	it('updates session updatedAt on each runtime event', () => {
		store = createSessionStore({
			sessionId: 's4',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		const t1 = 1000;
		const t2 = 2000;
		store.recordEvent(makeRuntimeEvent({id: 'r1', timestamp: t1}), []);
		store.recordEvent(makeRuntimeEvent({id: 'r2', timestamp: t2}), []);

		const restored = store.restore();
		expect(restored.session.updatedAt).toBe(t2);
	});

	it('recordEvent atomically writes runtime and feed events', () => {
		store = createSessionStore({
			sessionId: 's-atomic',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		const rtEvent = makeRuntimeEvent({id: 'rt-atomic'});
		const fe1 = makeFeedEvent({event_id: 'run1:E1', seq: 1});
		const fe2 = makeFeedEvent({event_id: 'run1:E2', seq: 2});
		store.recordEvent(rtEvent, [fe1, fe2]);

		const restored = store.restore();
		expect(restored.feedEvents).toHaveLength(2);
		expect(restored.session.adapterSessionIds).toContain('claude-session-1');
	});

	it('returns empty feedEvents when nothing recorded', () => {
		store = createSessionStore({
			sessionId: 's5',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		const restored = store.restore();
		expect(restored.feedEvents).toEqual([]);
		expect(restored.adapterSessions).toEqual([]);
	});

	it('recordFeedEvents persists feed-only events with null runtime_event_id', () => {
		store = createSessionStore({
			sessionId: 'test-session',
			projectDir: '/tmp/test',
			dbPath: ':memory:',
		});

		const fe = makeFeedEvent({
			event_id: 'decision-1',
			kind: 'permission.decision',
		});
		store.recordFeedEvents([fe]);

		const restored = store.restore();
		const found = restored.feedEvents.find(e => e.event_id === 'decision-1');
		expect(found).toBeDefined();
		expect(found!.kind).toBe('permission.decision');
	});

	it('recordFeedEvents increments event_count atomically', () => {
		store = createSessionStore({
			sessionId: 'test-session',
			projectDir: '/tmp/test',
			dbPath: ':memory:',
		});

		store.recordFeedEvents([makeFeedEvent(), makeFeedEvent({event_id: 'e2'})]);
		const session = store.getAthenaSession();
		expect(session.eventCount).toBe(2);

		store.recordFeedEvents([makeFeedEvent({event_id: 'e3'})]);
		const session2 = store.getAthenaSession();
		expect(session2.eventCount).toBe(3);
	});

	it('recordTokens persists and getRestoredTokens sums across adapter sessions', () => {
		store = createSessionStore({
			sessionId: 'sess-tok',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		// Record two adapter sessions via runtime events (distinct timestamps for ordering)
		const now = Date.now();
		const rt1 = makeRuntimeEvent({
			id: 'rt-tok-1',
			sessionId: 'adapter-1',
			timestamp: now - 1000,
		});
		const rt2 = makeRuntimeEvent({
			id: 'rt-tok-2',
			sessionId: 'adapter-2',
			timestamp: now,
		});
		store.recordEvent(rt1, [makeFeedEvent({event_id: 'fe-tok-1', seq: 1})]);
		store.recordEvent(rt2, [makeFeedEvent({event_id: 'fe-tok-2', seq: 2})]);

		// Record tokens for adapter-1
		store.recordTokens('adapter-1', {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			total: 150,
			contextSize: 1000,
		});

		// Record tokens for adapter-2
		store.recordTokens('adapter-2', {
			input: 200,
			output: 80,
			cacheRead: 20,
			cacheWrite: 8,
			total: 280,
			contextSize: 2000,
		});

		const restored = store.getRestoredTokens();
		expect(restored).not.toBeNull();
		expect(restored!.input).toBe(300);
		expect(restored!.output).toBe(130);
		expect(restored!.cacheRead).toBe(30);
		expect(restored!.cacheWrite).toBe(13);
		expect(restored!.total).toBe(430);
		// contextSize comes from most recent (adapter-2)
		expect(restored!.contextSize).toBe(2000);
	});

	it('getRestoredTokens returns null when no tokens recorded', () => {
		store = createSessionStore({
			sessionId: 'sess-no-tok',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		expect(store.getRestoredTokens()).toBeNull();
	});

	it('persists a workflow run via upsert', () => {
		store = createSessionStore({
			sessionId: 's1',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		store.persistRun({
			runId: 'run-1',
			sessionId: 's1',
			workflowName: 'test-wf',
			iteration: 0,
			status: 'running',
			trackerPath: '.athena/s1/tracker.md',
		});

		const run1 = store.getLatestRun();
		expect(run1).not.toBeNull();
		expect(run1!.id).toBe('run-1');
		expect(run1!.workflowName).toBe('test-wf');
		expect(run1!.iteration).toBe(0);
		expect(run1!.status).toBe('running');
		expect(run1!.trackerPath).toBe('.athena/s1/tracker.md');
		expect(run1!.endedAt).toBeUndefined();

		store.persistRun({
			runId: 'run-1',
			sessionId: 's1',
			workflowName: 'test-wf',
			iteration: 3,
			status: 'completed',
			stopReason: 'Tracker has completion marker',
			trackerPath: '.athena/s1/tracker.md',
		});

		const run2 = store.getLatestRun();
		expect(run2!.iteration).toBe(3);
		expect(run2!.status).toBe('completed');
		expect(run2!.stopReason).toBe('Tracker has completion marker');
		expect(run2!.endedAt).toBeDefined();
	});

	it('getLatestRun returns the most recent run', () => {
		store = createSessionStore({
			sessionId: 's1',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		store.persistRun({
			runId: 'run-1',
			sessionId: 's1',
			iteration: 0,
			status: 'completed',
		});

		store.persistRun({
			runId: 'run-2',
			sessionId: 's1',
			iteration: 0,
			status: 'running',
		});

		const latest = store.getLatestRun();
		expect(latest!.id).toBe('run-2');
	});

	it('links an adapter session to a workflow run', () => {
		store = createSessionStore({
			sessionId: 's1',
			projectDir: '/tmp',
			dbPath: ':memory:',
		});

		store.persistRun({
			runId: 'run-1',
			sessionId: 's1',
			iteration: 0,
			status: 'running',
		});

		const rtEvent = makeRuntimeEvent({id: 'rt-1', sessionId: 'adapter-1'});
		store.recordEvent(rtEvent, []);

		store.linkAdapterSession('adapter-1', 'run-1');

		const run = store.getLatestRun();
		expect(run!.id).toBe('run-1');
	});
});
