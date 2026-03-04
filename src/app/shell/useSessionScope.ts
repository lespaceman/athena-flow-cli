import {useMemo} from 'react';
import {getSessionMeta} from '../../infra/sessions/registry';

export type SessionScope = {
	current: number | null;
	total: number;
};

export function computeSessionScope(
	athenaSessionId: string,
	currentSessionId: string | null,
): SessionScope {
	const persisted = getSessionMeta(athenaSessionId)?.adapterSessionIds ?? [];
	const ids = [...persisted];
	if (currentSessionId && !ids.includes(currentSessionId)) {
		ids.push(currentSessionId);
	}
	const total = ids.length;
	const index =
		currentSessionId !== null ? ids.indexOf(currentSessionId) + 1 : null;
	return {
		current: index !== null && index > 0 ? index : null,
		total,
	};
}

export type TimelineCurrentRun = {
	run_id: string;
	trigger: {prompt_preview?: string};
	started_at: number;
};

export function buildTimelineCurrentRun(input: {
	runId: string | null;
	startedAt: number | null;
	promptPreview?: string;
}): TimelineCurrentRun | null {
	if (!input.runId || input.startedAt === null) return null;
	return {
		run_id: input.runId,
		trigger: {prompt_preview: input.promptPreview},
		started_at: input.startedAt,
	};
}

export function useSessionScope(
	athenaSessionId: string,
	currentSessionId: string | null,
): SessionScope {
	return useMemo(
		() => computeSessionScope(athenaSessionId, currentSessionId),
		[athenaSessionId, currentSessionId],
	);
}

export function useTimelineCurrentRun(
	currentRun: {
		run_id?: string;
		started_at?: number;
		trigger: {prompt_preview?: string};
	} | null,
): TimelineCurrentRun | null {
	const runId = currentRun?.run_id ?? null;
	const startedAt = currentRun?.started_at ?? null;
	const promptPreview = currentRun?.trigger.prompt_preview;
	return useMemo(
		() => buildTimelineCurrentRun({runId, startedAt, promptPreview}),
		[runId, startedAt, promptPreview],
	);
}
