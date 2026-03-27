import {describe, it, expect} from 'vitest';
import {createFeedMapper} from './mapper';
import type {MapperBootstrap} from './bootstrap';
import type {FeedEvent} from './types';
import type {RuntimeEvent} from '../runtime/types';
import {mapLegacyHookNameToRuntimeKind} from '../runtime/events';

function makeFeedEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
	return {
		event_id: 'R1:E1',
		seq: 1,
		ts: Date.now(),
		session_id: 'cs-1',
		run_id: 'R1',
		kind: 'session.start',
		level: 'info',
		actor_id: 'system',
		title: 'Session started',
		data: {source: 'startup'},
		...overrides,
	} as unknown as FeedEvent;
}

function makeRuntimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	const hookName = overrides.hookName ?? 'PreToolUse';
	const payload =
		typeof overrides.payload === 'object' && overrides.payload !== null
			? (overrides.payload as Record<string, unknown>)
			: {tool_name: 'Bash'};
	return {
		id: 'rt-1',
		timestamp: Date.now(),
		kind: mapLegacyHookNameToRuntimeKind(hookName),
		data: payload,
		hookName,
		sessionId: 'cs-1',
		context: {cwd: '/tmp', transcriptPath: '/tmp/t.jsonl'},
		interaction: {expectsDecision: false},
		payload,
		...overrides,
	};
}

describe('createFeedMapper', () => {
	it('works without stored session (default)', () => {
		const mapper = createFeedMapper();
		expect(mapper.getSession()).toBeNull();
		expect(mapper.getCurrentRun()).toBeNull();
	});

	describe('with stored session', () => {
		it('bootstraps session state from stored feed events', () => {
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'session.start',
						session_id: 'cs-1',
						data: {source: 'startup', model: 'opus'},
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E2',
						seq: 2,
						run_id: 'cs-1:R1',
						kind: 'tool.pre',
						actor_id: 'agent:root',
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E3',
						seq: 3,
						run_id: 'cs-1:R1',
						kind: 'session.end',
						data: {reason: 'completed'},
					}),
				],
			};

			const mapper = createFeedMapper(bootstrap);
			expect(mapper.getSession()).not.toBeNull();
			expect(mapper.getSession()!.session_id).toBe('cs-1');
		});

		it('continues run numbering from stored events', () => {
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({event_id: 'cs-1:R1:E1', seq: 1, run_id: 'cs-1:R1'}),
					makeFeedEvent({event_id: 'cs-1:R1:E2', seq: 2, run_id: 'cs-1:R1'}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E3',
						seq: 3,
						run_id: 'cs-1:R1',
						kind: 'session.end',
						data: {reason: 'completed'},
					}),
				],
			};

			const mapper = createFeedMapper(bootstrap);

			// Process a new SessionStart — runSeq should be 2 (R2), not R1
			const newEvents = mapper.mapEvent(
				makeRuntimeEvent({
					hookName: 'SessionStart',
					sessionId: 'cs-2',
					payload: {session_id: 'cs-2', source: 'resume'},
				}),
			);

			// New events should use R2 in their run_id (stored had 1 run)
			const runStartEvent = newEvents.find(e => e.kind === 'run.start');
			expect(runStartEvent).toBeDefined();
			expect(runStartEvent!.run_id).toContain('R2');
		});

		// NOTE: Subagent actor reconstruction from stored events is intentionally
		// NOT done during bootstrap. Actors are registered when SubagentStart
		// events arrive in the new adapter session.
	});

	describe('getTasks', () => {
		it('returns empty array by default', () => {
			const mapper = createFeedMapper();
			expect(mapper.getTasks()).toEqual([]);
		});

		it('captures tasks from root-level TodoWrite events', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-todo-1',
					kind: 'tool.pre',
					hookName: 'PreToolUse',
					toolName: 'TodoWrite',
					payload: {
						tool_name: 'TodoWrite',
						tool_input: {
							todos: [
								{content: 'Fix bug', status: 'in_progress'},
								{content: 'Add test', status: 'pending'},
							],
						},
					},
				}),
			);
			expect(mapper.getTasks()).toEqual([
				{content: 'Fix bug', status: 'in_progress'},
				{content: 'Add test', status: 'pending'},
			]);
		});

		it('updates tasks when a new TodoWrite arrives', () => {
			const mapper = createFeedMapper();
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-todo-1',
					kind: 'tool.pre',
					hookName: 'PreToolUse',
					toolName: 'TodoWrite',
					payload: {
						tool_name: 'TodoWrite',
						tool_input: {
							todos: [{content: 'Fix bug', status: 'in_progress'}],
						},
					},
				}),
			);
			mapper.mapEvent(
				makeRuntimeEvent({
					id: 'rt-todo-2',
					kind: 'tool.pre',
					hookName: 'PreToolUse',
					toolName: 'TodoWrite',
					payload: {
						tool_name: 'TodoWrite',
						tool_input: {
							todos: [{content: 'Fix bug', status: 'completed'}],
						},
					},
				}),
			);
			expect(mapper.getTasks()).toEqual([
				{content: 'Fix bug', status: 'completed'},
			]);
		});

		it('restores tasks from bootstrap', () => {
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'tool.pre',
						actor_id: 'agent:root',
						data: {
							tool_name: 'TodoWrite',
							tool_input: {
								todos: [{content: 'Deploy', status: 'pending'}],
							},
						},
					}),
				],
			};
			const mapper = createFeedMapper(bootstrap);
			expect(mapper.getTasks()).toEqual([
				{content: 'Deploy', status: 'pending'},
			]);
		});
	});
});
