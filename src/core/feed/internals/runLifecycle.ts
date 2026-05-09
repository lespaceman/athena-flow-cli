// src/core/feed/internals/runLifecycle.ts

import type {Session, Run} from '../entities';
import type {MapperBootstrap} from '../bootstrap';
import type {FeedEvent} from '../types';

/**
 * Owns Session and Run identity, sequence allocation, and per-run counters.
 *
 * Sequence semantics:
 *   - `seq` is a monotonic counter across the entire mapper lifetime; allocateSeq()
 *     is the only thing that increments it.
 *   - `runSeq` is the run number within the session, used to build run_id strings
 *     of the form `{session_id}:R{runSeq}`.
 *   - On bootstrap restore, both counters resume from the highest value observed
 *     in stored events.
 *
 * The orchestrator drives lifecycle through closeRun / openNewRun. Counters are
 * derived from emitted-event kinds in the orchestrator and pushed in via
 * incrementCounter — RunLifecycle does not know about FeedEvent kinds.
 */
export type RunLifecycleCounter =
	| 'tool_uses'
	| 'tool_failures'
	| 'permission_requests'
	| 'blocks';

export type RunLifecycle = {
	allocateSeq(): number;
	getRunId(): string;
	getSession(): Session | null;
	getCurrentRun(): Run | null;
	setSession(session: Session): void;
	endSession(ts: number): void;
	clearSession(): void;
	incrementCounter(name: RunLifecycleCounter): void;
	closeRun(ts: number, status: 'completed' | 'failed' | 'aborted'): Run | null;
	openNewRun(
		ts: number,
		sessionId: string,
		triggerType: Run['trigger']['type'],
		promptPreview: string | undefined,
	): Run;
	restoreFrom(bootstrap: MapperBootstrap): void;
};

export function createRunLifecycle(): RunLifecycle {
	let currentSession: Session | null = null;
	let currentRun: Run | null = null;
	let seq = 0;
	let runSeq = 0;

	function getRunId(): string {
		const sessId = currentSession?.session_id ?? 'unknown';
		return `${sessId}:R${runSeq}`;
	}

	return {
		allocateSeq() {
			return ++seq;
		},
		getRunId,
		getSession() {
			return currentSession;
		},
		getCurrentRun() {
			return currentRun;
		},
		setSession(session) {
			currentSession = session;
		},
		endSession(ts) {
			if (currentSession) currentSession.ended_at = ts;
		},
		clearSession() {
			currentSession = null;
		},
		incrementCounter(name) {
			if (currentRun) currentRun.counters[name]++;
		},
		closeRun(ts, status) {
			if (!currentRun) return null;
			currentRun.status = status;
			currentRun.ended_at = ts;
			const closed = currentRun;
			currentRun = null;
			return closed;
		},
		openNewRun(ts, sessionId, triggerType, promptPreview) {
			runSeq++;
			currentRun = {
				run_id: getRunId(),
				session_id: sessionId,
				started_at: ts,
				trigger: {type: triggerType, prompt_preview: promptPreview},
				status: 'running',
				actors: {root_agent_id: 'agent:root', subagent_ids: []},
				counters: {
					tool_uses: 0,
					tool_failures: 0,
					permission_requests: 0,
					blocks: 0,
				},
			};
			return currentRun;
		},
		restoreFrom(bootstrap) {
			for (const e of bootstrap.feedEvents) {
				if (e.seq > seq) seq = e.seq;
				const m = e.run_id.match(/:R(\d+)$/);
				if (m) {
					const n = parseInt(m[1]!, 10);
					if (n > runSeq) runSeq = n;
				}
			}

			const lastAdapterId = bootstrap.adapterSessionIds.at(-1);
			if (lastAdapterId) {
				currentSession = {
					session_id: lastAdapterId,
					started_at: bootstrap.createdAt,
					source: 'resume',
				};
			}

			let lastRunStart: FeedEvent | undefined;
			let lastRunEnd: FeedEvent | undefined;
			for (const e of bootstrap.feedEvents) {
				if (e.kind === 'run.start') lastRunStart = e;
				if (e.kind === 'run.end') lastRunEnd = e;
			}
			if (lastRunStart && (!lastRunEnd || lastRunEnd.seq < lastRunStart.seq)) {
				const triggerData = lastRunStart.data as {
					trigger: {type: string; prompt_preview?: string};
				};
				currentRun = {
					run_id: lastRunStart.run_id,
					session_id: lastRunStart.session_id,
					started_at: lastRunStart.ts,
					trigger: triggerData.trigger as Run['trigger'],
					status: 'running',
					actors: {root_agent_id: 'agent:root', subagent_ids: []},
					counters: {
						tool_uses: 0,
						tool_failures: 0,
						permission_requests: 0,
						blocks: 0,
					},
				};
				for (const e of bootstrap.feedEvents) {
					if (e.run_id !== currentRun.run_id) continue;
					if (e.kind === 'tool.pre') currentRun.counters.tool_uses++;
					if (e.kind === 'tool.failure') currentRun.counters.tool_failures++;
					if (e.kind === 'permission.request')
						currentRun.counters.permission_requests++;
				}
			}
		},
	};
}
