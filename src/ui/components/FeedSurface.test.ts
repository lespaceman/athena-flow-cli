import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resolveFeedBackend} from './FeedSurface';

describe('resolveFeedBackend', () => {
	let savedEnv: string | undefined;

	beforeEach(() => {
		savedEnv = process.env['ATHENA_FEED_BACKEND'];
		delete process.env['ATHENA_FEED_BACKEND'];
	});

	afterEach(() => {
		if (savedEnv === undefined) {
			delete process.env['ATHENA_FEED_BACKEND'];
		} else {
			process.env['ATHENA_FEED_BACKEND'] = savedEnv;
		}
	});

	// ── Explicit prop overrides ────────────────────────────────────

	it('returns ink-full when explicitly passed', () => {
		expect(resolveFeedBackend('ink-full')).toBe('ink-full');
	});

	it('returns incremental when explicitly passed', () => {
		expect(resolveFeedBackend('incremental')).toBe('incremental');
	});

	it('falls back to ink-full for an unrecognised explicit value', () => {
		expect(resolveFeedBackend('bogus')).toBe('ink-full');
	});

	it('falls back to ink-full for an empty explicit string', () => {
		expect(resolveFeedBackend('')).toBe('ink-full');
	});

	// ── Env-var driven selection ───────────────────────────────────

	it('reads ATHENA_FEED_BACKEND env var when no explicit value', () => {
		process.env['ATHENA_FEED_BACKEND'] = 'incremental';
		expect(resolveFeedBackend()).toBe('incremental');
	});

	it('defaults to ink-full when env var is missing', () => {
		delete process.env['ATHENA_FEED_BACKEND'];
		expect(resolveFeedBackend()).toBe('ink-full');
	});

	it('defaults to ink-full when env var is unrecognised', () => {
		process.env['ATHENA_FEED_BACKEND'] = 'turbo-mode';
		expect(resolveFeedBackend()).toBe('ink-full');
	});

	// ── Explicit prop takes precedence over env var ────────────────

	it('explicit prop overrides env var', () => {
		process.env['ATHENA_FEED_BACKEND'] = 'incremental';
		expect(resolveFeedBackend('ink-full')).toBe('ink-full');
	});

	// ── Determinism ────────────────────────────────────────────────

	it('is deterministic across repeated calls with same input', () => {
		process.env['ATHENA_FEED_BACKEND'] = 'incremental';
		const results = Array.from({length: 10}, () => resolveFeedBackend());
		expect(new Set(results).size).toBe(1);
		expect(results[0]).toBe('incremental');
	});
});
