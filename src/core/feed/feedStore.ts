import type {FeedEvent} from './types';
import type {MapperBootstrap} from './bootstrap';
import {buildPostByToolUseId} from './items';

type FeedStoreOptions = {
	bootstrap?: MapperBootstrap;
};

const EMPTY_EVENTS = Object.freeze([]) as ReadonlyArray<FeedEvent>;

export class FeedStore {
	private events: ReadonlyArray<FeedEvent>;
	private listeners = new Set<() => void>();
	private version = 0;
	private snapshot: ReadonlyArray<FeedEvent>;

	// Derived index maintained incrementally
	private postByToolUseIdMap: Map<string, FeedEvent>;
	private reasoningByKey = new Map<string, FeedEvent>();

	constructor(opts: FeedStoreOptions = {}) {
		// Bootstrap from stored session data
		const bootstrapEvents = opts.bootstrap?.feedEvents ?? [];
		this.events = Object.freeze([
			...bootstrapEvents,
		]) as ReadonlyArray<FeedEvent>;
		this.snapshot = this.events;

		// Seed postByToolUseId from historical events (critical for session restore)
		this.postByToolUseIdMap = buildPostByToolUseId(bootstrapEvents);
	}

	/**
	 * Single write entry point — eliminates the "two paths" bug.
	 * All event additions go through here.
	 */
	pushEvents(newEvents: FeedEvent[]): void {
		if (newEvents.length === 0) return;

		const nextEvents = [...this.events];
		let nextPostByToolUseIdMap = this.postByToolUseIdMap;
		let nextReasoningByKey = this.reasoningByKey;

		const ensurePostByToolUseIdMap = (): Map<string, FeedEvent> => {
			if (nextPostByToolUseIdMap === this.postByToolUseIdMap) {
				nextPostByToolUseIdMap = new Map(this.postByToolUseIdMap);
			}
			return nextPostByToolUseIdMap;
		};

		const ensureReasoningByKey = (): Map<string, FeedEvent> => {
			if (nextReasoningByKey === this.reasoningByKey) {
				nextReasoningByKey = new Map(this.reasoningByKey);
			}
			return nextReasoningByKey;
		};

		for (const event of newEvents) {
			// Handle tool.delta: update existing event in-place instead of appending
			// This prevents high-frequency deltas from bloating the event history
			if (event.kind === 'tool.delta' && event.data.tool_use_id) {
				const existing = nextPostByToolUseIdMap.get(event.data.tool_use_id);
				if (existing && existing.kind === 'tool.delta') {
					// Update in-place — find index and replace
					const idx = nextEvents.indexOf(existing);
					if (idx !== -1) {
						nextEvents[idx] = event;
						ensurePostByToolUseIdMap().set(event.data.tool_use_id, event);
						continue;
					}
				}
			}

			if (event.kind === 'reasoning.summary') {
				const reasoningKey = `${event.data.item_id ?? ''}:${event.data.summary_index ?? event.data.content_index ?? 0}`;
				const existing = nextReasoningByKey.get(reasoningKey);
				if (existing && existing.kind === 'reasoning.summary') {
					const idx = nextEvents.indexOf(existing);
					if (idx !== -1) {
						nextEvents[idx] = event;
						ensureReasoningByKey().set(reasoningKey, event);
						continue;
					}
				}
			}

			nextEvents.push(event);

			// Update postByToolUseId incrementally
			if (
				(event.kind === 'tool.delta' ||
					event.kind === 'tool.post' ||
					event.kind === 'tool.failure') &&
				event.data.tool_use_id
			) {
				ensurePostByToolUseIdMap().set(event.data.tool_use_id, event);
			}
			if (event.kind === 'reasoning.summary') {
				const reasoningKey = `${event.data.item_id ?? ''}:${event.data.summary_index ?? event.data.content_index ?? 0}`;
				ensureReasoningByKey().set(reasoningKey, event);
			}
		}

		// Bump version, invalidate snapshot, notify
		this.events = Object.freeze(nextEvents) as ReadonlyArray<FeedEvent>;
		this.snapshot = this.events;
		this.postByToolUseIdMap = nextPostByToolUseIdMap;
		this.reasoningByKey = nextReasoningByKey;
		this.version++;
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
		// CRITICAL: must return the same immutable reference between render and
		// commit phases for a given store version.
		return this.snapshot as FeedEvent[];
	};

	// ── Derived data ──────────────────────────────────────

	getPostByToolUseId(): Map<string, FeedEvent> {
		return this.postByToolUseIdMap;
	}

	// ── Lifecycle ─────────────────────────────────────────

	reset(): void {
		this.events = EMPTY_EVENTS;
		this.snapshot = EMPTY_EVENTS;
		this.postByToolUseIdMap = new Map();
		this.reasoningByKey = new Map();
		this.version++;
		this.notify();
	}

	clear(): void {
		this.events = EMPTY_EVENTS;
		this.snapshot = EMPTY_EVENTS;
		this.postByToolUseIdMap = new Map();
		this.reasoningByKey = new Map();
		this.version++;
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
