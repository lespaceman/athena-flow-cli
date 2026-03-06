/**
 * ARCHITECTURAL SENTINEL
 *
 * Protects: Persistence failure marks session degraded with reason (sticky, never clears)
 * Risk weight: 5
 *
 * If this test fails, investigate pipeline integrity before touching assertions.
 *
 * This tests the degradation contract at the store boundary:
 * - recordEvent/recordFeedEvents throw on SQLite errors (no silent swallowing)
 * - markDegraded sets isDegraded=true with a reason
 * - Degraded state is sticky (never clears)
 * - Reads still work after degradation
 *
 * The store itself does NOT auto-degrade. The caller (useFeed) is responsible for
 * catching throws and calling markDegraded. This test verifies the store's half
 * of the contract: throws on failure + markDegraded API behaves correctly.
 */
import {describe, it, expect, afterEach, beforeEach, vi} from 'vitest';
import {createSessionStore, type SessionStore} from '../infra/sessions/store';
import {createFeedMapper} from '../core/feed/mapper';
import {makeEvent, resetCounter} from './helpers';

describe('Sentinel: degraded mode on persistence failure', () => {
	let store: SessionStore;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// markDegraded intentionally logs; suppress expected stderr in test output.
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
		resetCounter();
	});

	it('write after close throws (store does not silently swallow)', () => {
		store = createSessionStore({
			sessionId: 'degraded-1',
			projectDir: '/tmp/proj',
			dbPath: ':memory:',
		});
		const mapper = createFeedMapper();

		// Record valid event first
		const start = makeEvent('SessionStart');
		store.recordEvent(start, mapper.mapEvent(start));
		expect(store.isDegraded).toBe(false);

		// Close DB, then attempt write — must throw
		store.close();

		const evt = makeEvent('UserPromptSubmit');
		const feed = mapper.mapEvent(evt);
		expect(() => store.recordEvent(evt, feed)).toThrow();
	});

	it('markDegraded sets sticky degraded state with reason', () => {
		store = createSessionStore({
			sessionId: 'degraded-2',
			projectDir: '/tmp/proj',
			dbPath: ':memory:',
		});

		expect(store.isDegraded).toBe(false);
		expect(store.degradedReason).toBeUndefined();

		store.markDegraded('recordEvent failed: SQLITE_FULL');

		expect(store.isDegraded).toBe(true);
		expect(store.degradedReason).toBe('recordEvent failed: SQLITE_FULL');

		// Sticky: cannot un-degrade
		// (no API exists to clear it — verify it stays true)
		expect(store.isDegraded).toBe(true);

		store.close();
	});

	it('reads still work after degradation', () => {
		store = createSessionStore({
			sessionId: 'degraded-3',
			projectDir: '/tmp/proj',
			dbPath: ':memory:',
		});
		const mapper = createFeedMapper();

		// Persist some events
		const start = makeEvent('SessionStart');
		store.recordEvent(start, mapper.mapEvent(start));
		const prompt = makeEvent('UserPromptSubmit');
		store.recordEvent(prompt, mapper.mapEvent(prompt));

		// Mark degraded
		store.markDegraded('simulated failure');
		expect(store.isDegraded).toBe(true);

		// Reads still work
		const restored = store.restore();
		expect(restored.feedEvents.length).toBeGreaterThan(0);

		store.close();
	});
});
