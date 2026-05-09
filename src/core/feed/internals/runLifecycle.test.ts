import {describe, it, expect} from 'vitest';
import {createRunLifecycle} from './runLifecycle';
import type {MapperBootstrap} from '../bootstrap';
import type {FeedEvent} from '../types';

function makeFeedEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
	return {
		event_id: 'cs-1:R1:E1',
		seq: 1,
		ts: 1000,
		session_id: 'cs-1',
		run_id: 'cs-1:R1',
		kind: 'tool.pre',
		level: 'info',
		actor_id: 'agent:root',
		title: '',
		data: {tool_name: 'Bash'},
		...overrides,
	} as unknown as FeedEvent;
}

describe('runLifecycle', () => {
	it('starts with no session and no run', () => {
		const rl = createRunLifecycle();
		expect(rl.getSession()).toBeNull();
		expect(rl.getCurrentRun()).toBeNull();
	});

	it('allocateSeq is monotonic', () => {
		const rl = createRunLifecycle();
		expect(rl.allocateSeq()).toBe(1);
		expect(rl.allocateSeq()).toBe(2);
		expect(rl.allocateSeq()).toBe(3);
	});

	it('getRunId before any run uses unknown:R0', () => {
		const rl = createRunLifecycle();
		expect(rl.getRunId()).toBe('unknown:R0');
	});

	it('setSession + openNewRun produces session-scoped run_id with increasing R index', () => {
		const rl = createRunLifecycle();
		rl.setSession({session_id: 'cs-1', started_at: 100});
		rl.openNewRun(200, 'cs-1', 'user_prompt_submit', 'hello');
		expect(rl.getRunId()).toBe('cs-1:R1');
		rl.closeRun(300, 'completed');
		rl.openNewRun(400, 'cs-1', 'user_prompt_submit', 'hi');
		expect(rl.getRunId()).toBe('cs-1:R2');
	});

	it('closeRun returns the closed run with its final status, then clears currentRun', () => {
		const rl = createRunLifecycle();
		rl.setSession({session_id: 'cs-1', started_at: 100});
		rl.openNewRun(200, 'cs-1', 'user_prompt_submit', undefined);
		const closed = rl.closeRun(300, 'failed');
		expect(closed?.status).toBe('failed');
		expect(closed?.ended_at).toBe(300);
		expect(rl.getCurrentRun()).toBeNull();
	});

	it('closeRun with no current run returns null', () => {
		const rl = createRunLifecycle();
		expect(rl.closeRun(100, 'completed')).toBeNull();
	});

	it('incrementCounter only mutates when there is a current run (no-op otherwise)', () => {
		const rl = createRunLifecycle();
		rl.incrementCounter('tool_uses');
		expect(rl.getCurrentRun()).toBeNull();
		rl.setSession({session_id: 'cs-1', started_at: 100});
		rl.openNewRun(200, 'cs-1', 'user_prompt_submit', undefined);
		rl.incrementCounter('tool_uses');
		rl.incrementCounter('tool_uses');
		rl.incrementCounter('permission_requests');
		expect(rl.getCurrentRun()?.counters).toEqual({
			tool_uses: 2,
			tool_failures: 0,
			permission_requests: 1,
			blocks: 0,
		});
	});

	it('endSession sets ended_at on the current session', () => {
		const rl = createRunLifecycle();
		rl.setSession({session_id: 'cs-1', started_at: 100});
		rl.endSession(500);
		expect(rl.getSession()?.ended_at).toBe(500);
	});

	describe('restoreFrom bootstrap', () => {
		it('resumes seq and runSeq from the highest values in stored events', () => {
			const rl = createRunLifecycle();
			const bootstrap: MapperBootstrap = {
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({event_id: 'cs-1:R1:E1', seq: 1, run_id: 'cs-1:R1'}),
					makeFeedEvent({event_id: 'cs-1:R1:E5', seq: 5, run_id: 'cs-1:R1'}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E6',
						seq: 6,
						run_id: 'cs-1:R1',
						kind: 'run.end',
						data: {status: 'completed', counters: {}},
					}),
				],
			};
			rl.restoreFrom(bootstrap);
			expect(rl.allocateSeq()).toBe(7);
			rl.openNewRun(2000, 'cs-1', 'user_prompt_submit', undefined);
			expect(rl.getRunId()).toBe('cs-1:R2');
		});

		it('restores session identity from the last adapter session id', () => {
			const rl = createRunLifecycle();
			rl.restoreFrom({
				adapterSessionIds: ['cs-old', 'cs-new'],
				createdAt: 1000,
				feedEvents: [],
			});
			expect(rl.getSession()?.session_id).toBe('cs-new');
			expect(rl.getSession()?.source).toBe('resume');
		});

		it('reopens an in-progress run when run.start has no matching run.end', () => {
			const rl = createRunLifecycle();
			rl.restoreFrom({
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'run.start',
						actor_id: 'system',
						data: {trigger: {type: 'user_prompt_submit'}},
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E2',
						seq: 2,
						run_id: 'cs-1:R1',
						kind: 'tool.pre',
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E3',
						seq: 3,
						run_id: 'cs-1:R1',
						kind: 'tool.failure',
						data: {tool_name: 'Bash', error: 'boom'},
					}),
				],
			});
			const run = rl.getCurrentRun();
			expect(run).not.toBeNull();
			expect(run?.status).toBe('running');
			expect(run?.counters.tool_uses).toBe(1);
			expect(run?.counters.tool_failures).toBe(1);
		});

		it('does not reopen a run when the latest run.end follows the latest run.start', () => {
			const rl = createRunLifecycle();
			rl.restoreFrom({
				adapterSessionIds: ['cs-1'],
				createdAt: 1000,
				feedEvents: [
					makeFeedEvent({
						event_id: 'cs-1:R1:E1',
						seq: 1,
						run_id: 'cs-1:R1',
						kind: 'run.start',
						actor_id: 'system',
						data: {trigger: {type: 'user_prompt_submit'}},
					}),
					makeFeedEvent({
						event_id: 'cs-1:R1:E2',
						seq: 2,
						run_id: 'cs-1:R1',
						kind: 'run.end',
						actor_id: 'system',
						data: {status: 'completed', counters: {}},
					}),
				],
			});
			expect(rl.getCurrentRun()).toBeNull();
		});
	});
});
