/**
 * LRU row cache for feed surface rendering.
 *
 * Caches formatted ANSI strings by entry identity + rendering context.
 * Uses a generation counter for global params (width, theme, ascii, cols) —
 * bumping generation clears the cache so stale rows are never served.
 */

const DEFAULT_MAX_SIZE = 100;

export class RowCache {
	private cache = new Map<string, string>();
	private maxSize: number;
	private generation = 0;

	constructor(maxSize = DEFAULT_MAX_SIZE) {
		this.maxSize = maxSize;
	}

	get(key: string): string | undefined {
		const value = this.cache.get(key);
		if (value === undefined) return undefined;
		// LRU: move to end (most recently used)
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}

	set(key: string, rendered: string): void {
		// If already present, delete to refresh insertion order
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}
		this.cache.set(key, rendered);
		// Evict oldest if over capacity
		if (this.cache.size > this.maxSize) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) {
				this.cache.delete(oldest);
			}
		}
	}

	/** Bump generation counter — implicitly invalidates all cached entries
	 * because new keys won't match old generation. Cache naturally refills. */
	bumpGeneration(): void {
		this.generation++;
		this.cache.clear();
	}

	getGeneration(): number {
		return this.generation;
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}

	static key(
		entryId: string,
		focused: boolean,
		striped: boolean,
		matched: boolean,
		generation: number,
		outcome = '',
	): string {
		return `${entryId}:${focused ? 'f' : '_'}${striped ? 's' : '_'}${matched ? 'm' : '_'}:${generation}:${outcome}`;
	}
}
