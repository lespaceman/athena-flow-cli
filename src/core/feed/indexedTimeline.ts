import type {FeedItem} from './items';
import type {FeedEvent} from './types';
import type {TimelineEntry} from './timeline';
import {isEventExpandable, expansionForEvent} from './timeline';
import {
	buildTimelineCache,
	appendTimelineCache,
	canAppendIncrementally,
	type TimelineBuildCache,
} from '../../ui/hooks/useTimeline';

type SearchCacheEntry = {
	matches: number[];
	lastScanned: number;
};

const MAX_SEARCH_CACHE_SIZE = 8;

export class IndexedTimeline {
	// Underlying build cache (reuses existing logic from useTimeline.ts)
	private cache: TimelineBuildCache | null = null;

	// Secondary indexes (maintained on every update)
	private runIndex = new Map<string, number[]>();
	private errorPositions = new Set<number>();

	// Search cache
	private searchCache = new Map<string, SearchCacheEntry>();
	private lastFilteredRef: TimelineEntry[] | null = null;

	// Instance-level caches (avoid cross-instance leaks in tests)
	readonly detailCache = new WeakMap<TimelineEntry, string>();
	readonly searchTextCache = new WeakMap<TimelineEntry, string>();

	private verbose = false;

	constructor() {}

	/**
	 * Main update — determines if incremental append is possible,
	 * delegates to existing build/append logic, then updates indexes.
	 */
	update(
		feedItems: FeedItem[],
		feedEvents: FeedEvent[],
		postByToolUseId: Map<string, FeedEvent> | undefined,
		verbose: boolean,
	): void {
		this.verbose = verbose;
		const incremental = canAppendIncrementally(
			this.cache,
			feedItems,
			feedEvents,
			this.verbose,
		);

		if (incremental) {
			this.cache = appendTimelineCache(
				this.cache!,
				feedItems,
				feedEvents,
				postByToolUseId,
			);
		} else {
			this.cache = buildTimelineCache(
				feedItems,
				feedEvents,
				postByToolUseId,
				this.verbose,
			);
		}

		// Rebuild indexes after every update.
		// At typical timeline sizes (< 500 entries), this is microseconds.
		this.rebuildIndexes();
	}

	getEntries(): TimelineEntry[] {
		return this.cache?.entries ?? [];
	}

	/**
	 * Index-based filtering — O(k) where k = matching entries.
	 * Replaces Array.filter() O(n) on every render.
	 */
	getFilteredView(runFilter?: string, errorsOnly?: boolean): TimelineEntry[] {
		const entries = this.getEntries();

		// Fast path: no filters
		if ((!runFilter || runFilter === 'all') && !errorsOnly) {
			return entries;
		}

		// Use indexes for filtering
		let candidateIndices: number[];

		if (runFilter && runFilter !== 'all') {
			candidateIndices = this.runIndex.get(runFilter) ?? [];
		} else {
			candidateIndices = Array.from({length: entries.length}, (_, i) => i);
		}

		if (errorsOnly) {
			candidateIndices = candidateIndices.filter(i =>
				this.errorPositions.has(i),
			);
		}

		return candidateIndices.map(i => entries[i]!);
	}

	/**
	 * Incremental search — only scans new entries since last call with same query.
	 * Returns indices into filteredEntries (not this.entries).
	 */
	getSearchMatches(filteredEntries: TimelineEntry[], query: string): number[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];

		// Invalidate search cache when filtered view changes (different filter or new entries)
		if (filteredEntries !== this.lastFilteredRef) {
			this.searchCache.clear();
			this.lastFilteredRef = filteredEntries;
		}

		const cached = this.searchCache.get(q);
		if (cached && cached.lastScanned === filteredEntries.length) {
			return cached.matches;
		}

		const startFrom = cached ? cached.lastScanned : 0;
		const matches = cached ? [...cached.matches] : [];

		for (let i = startFrom; i < filteredEntries.length; i++) {
			const searchText = this.getEntrySearchText(filteredEntries[i]!);
			if (searchText.toLowerCase().includes(q)) {
				matches.push(i);
			}
		}

		this.searchCache.set(q, {matches, lastScanned: filteredEntries.length});

		// LRU eviction for search cache
		if (this.searchCache.size > MAX_SEARCH_CACHE_SIZE) {
			const oldest = this.searchCache.keys().next().value;
			if (oldest !== undefined) {
				this.searchCache.delete(oldest);
			}
		}

		return matches;
	}

	// ── Search text helpers ─────────────────────────────────

	private getEntrySearchText(entry: TimelineEntry): string {
		const cached = this.searchTextCache.get(entry);
		if (cached !== undefined) return cached;
		if (!entry.feedEvent) {
			this.searchTextCache.set(entry, entry.searchText);
			return entry.searchText;
		}
		const details = this.getEntryDetails(entry);
		const searchText = details ? `${entry.summary}\n${details}` : entry.summary;
		this.searchTextCache.set(entry, searchText);
		return searchText;
	}

	private getEntryDetails(entry: TimelineEntry): string {
		if (entry.details) return entry.details;
		if (!entry.feedEvent) return entry.summary;
		const cached = this.detailCache.get(entry);
		if (cached !== undefined) return cached;
		const details = isEventExpandable(entry.feedEvent)
			? expansionForEvent(entry.feedEvent)
			: '';
		this.detailCache.set(entry, details);
		return details;
	}

	// ── Index maintenance ─────────────────────────────────

	private addToIndex(entry: TimelineEntry, index: number): void {
		const runId = entry.runId ?? '__none__';
		let indices = this.runIndex.get(runId);
		if (!indices) {
			indices = [];
			this.runIndex.set(runId, indices);
		}
		indices.push(index);

		if (entry.error) {
			this.errorPositions.add(index);
		}
	}

	private rebuildIndexes(): void {
		this.runIndex.clear();
		this.errorPositions.clear();
		this.searchCache.clear();
		const entries = this.getEntries();
		for (let i = 0; i < entries.length; i++) {
			this.addToIndex(entries[i]!, i);
		}
	}
}
