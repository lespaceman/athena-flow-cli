/** @vitest-environment jsdom */
import {describe, it, expect, vi} from 'vitest';
import {renderHook} from '@testing-library/react';
import {useHeaderMetrics} from './useHeaderMetrics';
import type {FeedEvent} from '../../core/feed/types';

let seqCounter = 0;

function makeFeedEvent(
	overrides: Partial<FeedEvent> & {kind: FeedEvent['kind']; data: unknown},
): FeedEvent {
	seqCounter++;
	return {
		event_id: overrides.event_id ?? `e${seqCounter}`,
		seq: overrides.seq ?? seqCounter,
		ts: overrides.ts ?? new Date('2024-01-15T10:00:00Z').getTime(),
		session_id: overrides.session_id ?? 's1',
		run_id: overrides.run_id ?? 's1:R1',
		kind: overrides.kind,
		level: overrides.level ?? 'info',
		actor_id: overrides.actor_id ?? 'agent:root',
		title: overrides.title ?? '',
		data: overrides.data,
	} as FeedEvent;
}

describe('useHeaderMetrics', () => {
	it('returns default values for empty events', () => {
		const {result} = renderHook(() => useHeaderMetrics([]));
		expect(result.current).toEqual({
			modelName: null,
			toolCallCount: 0,
			totalToolCallCount: 0,
			subagentCount: 0,
			subagentMetrics: [],
			permissions: {allowed: 0, denied: 0},
			sessionStartTime: null,
			tokens: {
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				total: null,
				contextSize: null,
				contextWindowSize: null,
			},
			failures: 0,
			blocks: 0,
		});
	});

	it('extracts model name from session.start event', () => {
		const events = [
			makeFeedEvent({
				kind: 'session.start',
				title: 'Session started',
				data: {source: 'startup', model: 'claude-opus-4-6'},
			}),
		];

		const {result} = renderHook(() => useHeaderMetrics(events));
		expect(result.current.modelName).toBe('claude-opus-4-6');
		expect(result.current.sessionStartTime).toEqual(
			new Date('2024-01-15T10:00:00Z'),
		);
	});

	it('counts top-level tool.pre events', () => {
		const events = [
			makeFeedEvent({
				event_id: 't1',
				kind: 'tool.pre',
				title: '● Bash',
				data: {tool_name: 'Bash', tool_input: {}},
			}),
			makeFeedEvent({
				event_id: 't2',
				kind: 'tool.pre',
				title: '● Read',
				data: {tool_name: 'Read', tool_input: {}},
			}),
			makeFeedEvent({
				event_id: 't3',
				kind: 'tool.pre',
				title: '● Grep',
				actor_id: 'subagent:agent-1',
				data: {tool_name: 'Grep', tool_input: {}},
			}),
		];

		const {result} = renderHook(() => useHeaderMetrics(events));
		// Only top-level (t1, t2) — t3 is a child
		expect(result.current.toolCallCount).toBe(2);
		// agent-1 isn't tracked via subagent.start, so totalToolCallCount
		// only includes tracked subagent tools
		expect(result.current.totalToolCallCount).toBe(2);
	});

	it('tracks subagent metrics', () => {
		const events = [
			makeFeedEvent({
				event_id: 'sub-1',
				kind: 'subagent.start',
				title: 'Subagent started',
				data: {agent_id: 'a1', agent_type: 'Explore'},
			}),
			makeFeedEvent({
				event_id: 'child-1',
				kind: 'tool.pre',
				title: '● Bash',
				actor_id: 'subagent:a1',
				data: {tool_name: 'Bash', tool_input: {}},
			}),
			makeFeedEvent({
				event_id: 'child-2',
				kind: 'tool.pre',
				title: '● Read',
				actor_id: 'subagent:a1',
				data: {tool_name: 'Read', tool_input: {}},
			}),
		];

		const {result} = renderHook(() => useHeaderMetrics(events));
		expect(result.current.subagentCount).toBe(1);
		expect(result.current.subagentMetrics).toEqual([
			{
				agentId: 'a1',
				agentType: 'Explore',
				toolCallCount: 2,
				tokenCount: null,
			},
		]);
		// 0 main + 2 subagent = 2 total
		expect(result.current.totalToolCallCount).toBe(2);
	});

	it('counts subagent-attributed tool events separately from root', () => {
		const events = [
			makeFeedEvent({
				event_id: 'sub-start',
				kind: 'subagent.start',
				title: 'Subagent started',
				actor_id: 'agent:root',
				data: {agent_id: 'sa-1', agent_type: 'Explore'},
			}),
			makeFeedEvent({
				event_id: 'sa-tool-1',
				kind: 'tool.pre',
				title: '● Bash',
				actor_id: 'subagent:sa-1',
				data: {tool_name: 'Bash', tool_input: {}},
			}),
			makeFeedEvent({
				event_id: 'sa-tool-2',
				kind: 'tool.pre',
				title: '● Read',
				actor_id: 'subagent:sa-1',
				data: {tool_name: 'Read', tool_input: {}},
			}),
			makeFeedEvent({
				event_id: 'root-tool-1',
				kind: 'tool.pre',
				title: '● Grep',
				actor_id: 'agent:root',
				data: {tool_name: 'Grep', tool_input: {}},
			}),
		];

		const {result} = renderHook(() => useHeaderMetrics(events));
		expect(result.current.toolCallCount).toBe(1);
		expect(result.current.subagentMetrics).toEqual([
			{
				agentId: 'sa-1',
				agentType: 'Explore',
				toolCallCount: 2,
				tokenCount: null,
			},
		]);
		expect(result.current.totalToolCallCount).toBe(3);
	});

	it('counts permission decision outcomes', () => {
		const events = [
			makeFeedEvent({
				event_id: 'p1',
				kind: 'permission.decision',
				title: 'Permission allowed',
				data: {decision_type: 'no_opinion'},
			}),
			makeFeedEvent({
				event_id: 'p2',
				kind: 'permission.decision',
				title: 'Permission denied',
				data: {decision_type: 'deny', message: 'Not allowed'},
			}),
			makeFeedEvent({
				event_id: 'p3',
				kind: 'permission.decision',
				title: 'Permission allowed',
				data: {decision_type: 'allow'},
			}),
			makeFeedEvent({
				event_id: 'p4',
				kind: 'permission.decision',
				title: 'Permission ask',
				data: {decision_type: 'ask'},
			}),
		];

		const {result} = renderHook(() => useHeaderMetrics(events));
		// p1 = allowed (no_opinion), p2 = denied, p3 = allowed, p4 = ask (not counted)
		expect(result.current.permissions).toEqual({allowed: 2, denied: 1});
	});

	it('ignores child subagent.start events', () => {
		const events = [
			makeFeedEvent({
				event_id: 'nested-sub',
				kind: 'subagent.start',
				title: 'Subagent started',
				actor_id: 'subagent:parent-agent',
				data: {agent_id: 'nested-1', agent_type: 'Plan'},
			}),
		];

		const {result} = renderHook(() => useHeaderMetrics(events));
		expect(result.current.subagentCount).toBe(0);
	});

	it('sets sessionStartTime even when session.start has no model field', () => {
		const ts = new Date('2024-01-15T10:00:00Z');
		const events = [
			makeFeedEvent({
				kind: 'session.start',
				ts: ts.getTime(),
				title: 'Session started',
				data: {source: 'startup'},
			}),
		];

		const {result} = renderHook(() => useHeaderMetrics(events));
		expect(result.current.sessionStartTime).toEqual(ts);
		expect(result.current.modelName).toBeNull();
	});

	it('throttles recomputation within 1s window', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

		const events1 = [
			makeFeedEvent({
				kind: 'session.start',
				title: 'Session started',
				data: {source: 'startup'},
			}),
		];
		const events2 = [
			...events1,
			makeFeedEvent({
				event_id: 't1',
				kind: 'tool.pre',
				title: '● Bash',
				data: {tool_name: 'Bash', tool_input: {}},
			}),
		];

		const {result, rerender} = renderHook(
			({events}) => useHeaderMetrics(events),
			{initialProps: {events: events1}},
		);

		const first = result.current;

		// Advance only 500ms (within throttle window)
		vi.advanceTimersByTime(500);
		rerender({events: events2});
		expect(result.current).toBe(first);

		// Advance past throttle window, pass new array reference to trigger useMemo
		vi.advanceTimersByTime(600);
		rerender({events: [...events2]});
		expect(result.current).not.toBe(first);
		expect(result.current.toolCallCount).toBe(1);

		vi.useRealTimers();
	});

	it('counts failures from tool.failure events', () => {
		const events = [
			makeFeedEvent({
				kind: 'tool.failure',
				data: {tool_name: 'Bash', tool_input: {}, error: 'fail1'},
			}),
			makeFeedEvent({
				kind: 'tool.failure',
				data: {tool_name: 'Bash', tool_input: {}, error: 'fail2'},
			}),
		];
		const {result} = renderHook(() => useHeaderMetrics(events));
		expect(result.current.failures).toBe(2);
	});

	it('counts blocks from permission deny and stop block', () => {
		const events = [
			makeFeedEvent({
				kind: 'permission.decision',
				data: {decision_type: 'deny'},
			}),
			makeFeedEvent({
				kind: 'stop.decision',
				data: {decision_type: 'block', reason: 'blocked'},
			}),
		];
		const {result} = renderHook(() => useHeaderMetrics(events));
		expect(result.current.blocks).toBe(2);
	});

	it('all token fields are null (data not yet available)', () => {
		const events = [
			makeFeedEvent({
				kind: 'tool.pre',
				title: '● Bash',
				data: {tool_name: 'Bash', tool_input: {}},
			}),
		];

		const {result} = renderHook(() => useHeaderMetrics(events));
		expect(result.current.tokens.input).toBeNull();
		expect(result.current.tokens.output).toBeNull();
		expect(result.current.tokens.total).toBeNull();
		expect(result.current.tokens.contextSize).toBeNull();
	});
});
