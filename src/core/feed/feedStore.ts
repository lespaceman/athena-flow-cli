import type {FeedEvent} from './types';
import type {MapperBootstrap} from './bootstrap';
import {buildPostByToolUseId} from './items';

const MAX_EVENTS = 200;

type FeedStoreOptions = {
	bootstrap?: MapperBootstrap;
};

export class FeedStore {
	private events: FeedEvent[];
	private listeners = new Set<() => void>();
	private version = 0;
	private snapshot: FeedEvent[] | null = null;

	// Derived index maintained incrementally
	private postByToolUseIdMap: Map<string, FeedEvent>;

	constructor(opts: FeedStoreOptions = {}) {
		// Bootstrap from stored session data
		const bootstrapEvents = opts.bootstrap?.feedEvents ?? [];
		this.events = [...bootstrapEvents];

		// Seed postByToolUseId from historical events (critical for session restore)
		this.postByToolUseIdMap = buildPostByToolUseId(this.events);
	}

	/**
	 * Single write entry point — eliminates the "two paths" bug.
	 * All event additions go through here.
	 */
	pushEvents(newEvents: FeedEvent[]): void {
		if (newEvents.length === 0) return;

		for (const event of newEvents) {
			// Handle tool.delta: update existing event in-place instead of appending
			// This prevents high-frequency deltas from evicting important events
			if (event.kind === 'tool.delta' && event.data.tool_use_id) {
				const existing = this.postByToolUseIdMap.get(event.data.tool_use_id);
				if (existing && existing.kind === 'tool.delta') {
					// Update in-place — find index and replace
					const idx = this.events.indexOf(existing);
					if (idx !== -1) {
						this.events[idx] = event;
						this.postByToolUseIdMap.set(event.data.tool_use_id, event);
						continue;
					}
				}
			}

			this.events.push(event);

			// Update postByToolUseId incrementally
			if (
				(event.kind === 'tool.delta' ||
					event.kind === 'tool.post' ||
					event.kind === 'tool.failure') &&
				event.data.tool_use_id
			) {
				this.postByToolUseIdMap.set(event.data.tool_use_id, event);
			}
		}

		// Apply MAX_EVENTS cap
		if (this.events.length > MAX_EVENTS) {
			this.events = this.events.slice(-MAX_EVENTS);
		}

		// Bump version, invalidate snapshot, notify
		this.version++;
		this.snapshot = null;
		this.notify();
	}

	// ── useSyncExternalStore contract ─────────────────────

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): FeedEvent[] => {
		// CRITICAL: must return same reference between render and commit phases.
		// Only rebuild when version changes (snapshot is null).
		if (this.snapshot === null) {
			this.snapshot = Object.freeze([...this.events]) as FeedEvent[];
		}
		return this.snapshot;
	};

	// ── Derived data ──────────────────────────────────────

	getPostByToolUseId(): Map<string, FeedEvent> {
		return this.postByToolUseIdMap;
	}

	// ── Lifecycle ─────────────────────────────────────────

	reset(): void {
		this.events = [];
		this.postByToolUseIdMap = new Map();
		this.version++;
		this.snapshot = null;
		this.notify();
	}

	clear(): void {
		this.events = [];
		this.postByToolUseIdMap = new Map();
		this.version++;
		this.snapshot = null;
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
