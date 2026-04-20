import {describe, it, expect, vi} from 'vitest';
import {FeedStore} from './feedStore';
import type {FeedEvent} from './types';

// Helper to create a minimal FeedEvent for testing
function makeFeedEvent(
	overrides: Partial<FeedEvent> & {kind: FeedEvent['kind']},
): FeedEvent {
	const base = {
		event_id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		seq: 0,
		ts: Date.now(),
		session_id: 'test-session',
		run_id: 'test-run',
		level: 'info' as const,
		actor_id: 'agent:root',
		title: 'Test event',
	};

	switch (overrides.kind) {
		case 'tool.delta':
			return {
				...base,
				...overrides,
				kind: 'tool.delta',
				data: {
					tool_name: 'TestTool',
					tool_input: {},
					tool_use_id: undefined,
					delta: '',
					...(overrides as {data?: Record<string, unknown>}).data,
				},
			} as FeedEvent;
		case 'tool.post':
			return {
				...base,
				...overrides,
				kind: 'tool.post',
				data: {
					tool_name: 'TestTool',
					tool_input: {},
					tool_use_id: undefined,
					tool_response: null,
					...(overrides as {data?: Record<string, unknown>}).data,
				},
			} as FeedEvent;
		case 'tool.failure':
			return {
				...base,
				...overrides,
				kind: 'tool.failure',
				data: {
					tool_name: 'TestTool',
					tool_input: {},
					tool_use_id: undefined,
					error: 'test error',
					...(overrides as {data?: Record<string, unknown>}).data,
				},
			} as FeedEvent;
		case 'tool.pre':
			return {
				...base,
				...overrides,
				kind: 'tool.pre',
				data: {
					tool_name: 'TestTool',
					tool_input: {},
					tool_use_id: undefined,
					...(overrides as {data?: Record<string, unknown>}).data,
				},
			} as FeedEvent;
		case 'notification':
			return {
				...base,
				...overrides,
				kind: 'notification',
				data: {
					message: 'test notification',
					...(overrides as {data?: Record<string, unknown>}).data,
				},
			} as FeedEvent;
		default:
			return {
				...base,
				...overrides,
				data: {
					...(overrides as {data?: Record<string, unknown>}).data,
				},
			} as FeedEvent;
	}
}

describe('FeedStore', () => {
	it('empty store has getSnapshot() return empty frozen array', () => {
		const store = new FeedStore();
		const snapshot = store.getSnapshot();
		expect(snapshot).toEqual([]);
		expect(Object.isFrozen(snapshot)).toBe(true);
	});

	it('bootstraps with seed events and populates postByToolUseId', () => {
		const bootstrapEvents: FeedEvent[] = [
			makeFeedEvent({
				kind: 'tool.post',
				data: {
					tool_name: 'Read',
					tool_input: {},
					tool_use_id: 'tu-1',
					tool_response: 'content',
				},
			} as Partial<FeedEvent> & {kind: 'tool.post'}),
			makeFeedEvent({
				kind: 'tool.post',
				data: {
					tool_name: 'Write',
					tool_input: {},
					tool_use_id: 'tu-2',
					tool_response: 'ok',
				},
			} as Partial<FeedEvent> & {kind: 'tool.post'}),
		];

		const store = new FeedStore({
			bootstrap: {
				feedEvents: bootstrapEvents,
				adapterSessionIds: ['s1'],
				createdAt: Date.now(),
			},
		});

		const snapshot = store.getSnapshot();
		expect(snapshot).toHaveLength(2);
		expect(store.getPostByToolUseId().has('tu-1')).toBe(true);
		expect(store.getPostByToolUseId().has('tu-2')).toBe(true);
	});

	it('pushEvents adds events, increments version, notifies listeners', () => {
		const store = new FeedStore();
		const listener = vi.fn();
		store.subscribe(listener);

		const event = makeFeedEvent({kind: 'notification'});
		store.pushEvents([event]);

		expect(store.getSnapshot()).toHaveLength(1);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('pushEvents with empty array does not notify', () => {
		const store = new FeedStore();
		const listener = vi.fn();
		store.subscribe(listener);

		store.pushEvents([]);

		expect(listener).not.toHaveBeenCalled();
	});

	it('retains full event history instead of trimming old entries', () => {
		const store = new FeedStore();

		const events: FeedEvent[] = [];
		for (let i = 0; i < 250; i++) {
			events.push(
				makeFeedEvent({
					kind: 'notification',
					event_id: `evt-${i}`,
				}),
			);
		}
		store.pushEvents(events);

		const snapshot = store.getSnapshot();
		expect(snapshot).toHaveLength(250);
		expect(snapshot[0]!.event_id).toBe('evt-0');
		expect(snapshot[249]!.event_id).toBe('evt-249');
	});

	it('getSnapshot returns same reference between calls without pushEvents', () => {
		const store = new FeedStore();
		store.pushEvents([makeFeedEvent({kind: 'notification'})]);

		const snap1 = store.getSnapshot();
		const snap2 = store.getSnapshot();
		expect(snap1).toBe(snap2); // same reference
	});

	it('getSnapshot returns new reference after pushEvents', () => {
		const store = new FeedStore();
		store.pushEvents([makeFeedEvent({kind: 'notification'})]);

		const snap1 = store.getSnapshot();
		store.pushEvents([makeFeedEvent({kind: 'notification'})]);
		const snap2 = store.getSnapshot();

		expect(snap1).not.toBe(snap2);
	});

	it('subscribe/notify: listener called on pushEvents, not called after unsubscribe', () => {
		const store = new FeedStore();
		const listener = vi.fn();
		const unsub = store.subscribe(listener);

		store.pushEvents([makeFeedEvent({kind: 'notification'})]);
		expect(listener).toHaveBeenCalledTimes(1);

		unsub();
		store.pushEvents([makeFeedEvent({kind: 'notification'})]);
		expect(listener).toHaveBeenCalledTimes(1); // not called again
	});

	it('incremental postByToolUseId: pushing tool.post updates the map', () => {
		const store = new FeedStore();

		const event = makeFeedEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Bash',
				tool_input: {},
				tool_use_id: 'tu-abc',
				tool_response: 'output',
			},
		} as Partial<FeedEvent> & {kind: 'tool.post'});

		store.pushEvents([event]);

		const map = store.getPostByToolUseId();
		expect(map.has('tu-abc')).toBe(true);
		expect(map.get('tu-abc')).toBe(event);
	});

	it('tool.delta in-place update: same tool_use_id replaces without growing array', () => {
		const store = new FeedStore();

		const delta1 = makeFeedEvent({
			kind: 'tool.delta',
			event_id: 'delta-1',
			data: {
				tool_name: 'Bash',
				tool_input: {},
				tool_use_id: 'tu-stream',
				delta: 'chunk1',
			},
		} as Partial<FeedEvent> & {kind: 'tool.delta'});

		store.pushEvents([delta1]);
		expect(store.getSnapshot()).toHaveLength(1);

		const delta2 = makeFeedEvent({
			kind: 'tool.delta',
			event_id: 'delta-2',
			data: {
				tool_name: 'Bash',
				tool_input: {},
				tool_use_id: 'tu-stream',
				delta: 'chunk1chunk2',
			},
		} as Partial<FeedEvent> & {kind: 'tool.delta'});

		store.pushEvents([delta2]);
		// Should still be length 1 — replaced in-place
		expect(store.getSnapshot()).toHaveLength(1);
		expect(store.getSnapshot()[0]!.event_id).toBe('delta-2');
	});

	it('clear() resets events, bumps version, notifies', () => {
		const store = new FeedStore();
		store.pushEvents([makeFeedEvent({kind: 'notification'})]);

		const listener = vi.fn();
		store.subscribe(listener);

		store.clear();

		expect(store.getSnapshot()).toHaveLength(0);
		expect(store.getPostByToolUseId().size).toBe(0);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('reset() clears events and notifies', () => {
		const store = new FeedStore();
		store.pushEvents([makeFeedEvent({kind: 'notification'})]);

		const listener = vi.fn();
		store.subscribe(listener);

		store.reset();

		expect(store.getSnapshot()).toHaveLength(0);
		expect(store.getPostByToolUseId().size).toBe(0);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('bootstrap seeds postByToolUseId from historical events', () => {
		const toolPost = makeFeedEvent({
			kind: 'tool.post',
			data: {
				tool_name: 'Grep',
				tool_input: {},
				tool_use_id: 'historical-tu',
				tool_response: 'found',
			},
		} as Partial<FeedEvent> & {kind: 'tool.post'});

		const toolFailure = makeFeedEvent({
			kind: 'tool.failure',
			data: {
				tool_name: 'Bash',
				tool_input: {},
				tool_use_id: 'historical-fail',
				error: 'command failed',
			},
		} as Partial<FeedEvent> & {kind: 'tool.failure'});

		const store = new FeedStore({
			bootstrap: {
				feedEvents: [toolPost, toolFailure],
				adapterSessionIds: ['s1'],
				createdAt: Date.now(),
			},
		});

		const map = store.getPostByToolUseId();
		expect(map.has('historical-tu')).toBe(true);
		expect(map.get('historical-tu')).toBe(toolPost);
		expect(map.has('historical-fail')).toBe(true);
		expect(map.get('historical-fail')).toBe(toolFailure);
	});
});
