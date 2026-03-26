import {describe, it, expect} from 'vitest';
import {RowCache} from './rowCache';

describe('RowCache', () => {
	it('returns undefined for cache miss', () => {
		const cache = new RowCache();
		expect(cache.get('nonexistent')).toBeUndefined();
	});

	it('returns cached value on hit', () => {
		const cache = new RowCache();
		cache.set('key1', 'rendered-row');
		expect(cache.get('key1')).toBe('rendered-row');
	});

	it('evicts oldest entry when maxSize is exceeded', () => {
		const cache = new RowCache(3);
		cache.set('a', '1');
		cache.set('b', '2');
		cache.set('c', '3');
		// Adding one more should evict 'a' (oldest)
		cache.set('d', '4');
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toBe('2');
		expect(cache.get('c')).toBe('3');
		expect(cache.get('d')).toBe('4');
		expect(cache.size).toBe(3);
	});

	it('refreshes LRU order on access so accessed entry survives eviction', () => {
		const cache = new RowCache(3);
		cache.set('a', '1');
		cache.set('b', '2');
		cache.set('c', '3');
		// Access 'a' to make it most recently used
		cache.get('a');
		// Now add 'd' — 'b' should be evicted (oldest after 'a' was refreshed)
		cache.set('d', '4');
		expect(cache.get('a')).toBe('1');
		expect(cache.get('b')).toBeUndefined();
		expect(cache.get('c')).toBe('3');
		expect(cache.get('d')).toBe('4');
	});

	it('bumpGeneration clears cache and increments generation counter', () => {
		const cache = new RowCache();
		cache.set('key1', 'value1');
		expect(cache.getGeneration()).toBe(0);
		cache.bumpGeneration();
		expect(cache.getGeneration()).toBe(1);
		expect(cache.size).toBe(0);
		expect(cache.get('key1')).toBeUndefined();
	});

	it('produces deterministic cache keys with all params encoded', () => {
		const key = RowCache.key('entry-42', true, false, true, 3);
		expect(key).toBe('entry-42:f_m:3:');
		const keyWithOutcome = RowCache.key('entry-42', true, false, true, 3, 'ok');
		expect(keyWithOutcome).toBe('entry-42:f_m:3:ok');
	});

	it('produces different keys for different focused/striped/matched flags', () => {
		const base = 'entry-1';
		const gen = 0;
		const k1 = RowCache.key(base, true, false, false, gen);
		const k2 = RowCache.key(base, false, true, false, gen);
		const k3 = RowCache.key(base, false, false, true, gen);
		const k4 = RowCache.key(base, true, true, true, gen);
		const keys = new Set([k1, k2, k3, k4]);
		expect(keys.size).toBe(4);
	});

	it('reports current cache size', () => {
		const cache = new RowCache();
		expect(cache.size).toBe(0);
		cache.set('a', '1');
		cache.set('b', '2');
		expect(cache.size).toBe(2);
	});

	it('clear empties the cache', () => {
		const cache = new RowCache();
		cache.set('a', '1');
		cache.set('b', '2');
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get('a')).toBeUndefined();
	});
});
