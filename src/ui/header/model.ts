import type {HeaderStatus} from './statusBadge';
import {detectHarness} from '../../shared/utils/detectHarness';

export type {HeaderStatus} from './statusBadge';

export interface HeaderModel {
	session_id: string;
	session_index: number | null;
	session_total: number;
	workflow: string;
	harness: string;
	model_name: string | null;
	context: {used: number | null; max: number | null};
	total_tokens: number | null;
	run_count: number;
	engine?: string;
	progress?: {done: number; total: number};
	status: HeaderStatus;
	error_reason?: string;
	tail_mode: boolean;
}

export interface HeaderModelInput {
	session: {session_id?: string; agent_type?: string} | null;
	currentRun: {
		run_id: string;
		trigger: {prompt_preview?: string};
		started_at: number;
	} | null;
	runSummaries: {status: string; endedAt?: number}[];
	metrics: {failures: number; blocks: number};
	todoPanel: {
		doneCount: number;
		doingCount: number;
		todoItems: {length: number};
	};
	tailFollow: boolean;
	now: number;
	workflowRef?: string;
	harness?: string;
	modelName?: string | null;
	contextUsed?: number | null;
	contextMax?: number | null;
	totalTokens?: number | null;
	runCount?: number;
	sessionIndex?: number | null;
	sessionTotal?: number;
	errorReason?: string;
}

function deriveStatus(
	currentRun: HeaderModelInput['currentRun'],
	runSummaries: HeaderModelInput['runSummaries'],
	errorReason?: string,
): HeaderStatus {
	if (errorReason) return 'error';
	if (currentRun) return 'active';
	const last = runSummaries.at(-1);
	if (!last) return 'idle';
	if (last.status === 'FAILED') return 'error';
	if (last.status === 'CANCELLED') return 'stopped';
	if (last.status === 'SUCCEEDED') return 'idle';
	return 'idle';
}

export function buildHeaderModel(input: HeaderModelInput): HeaderModel {
	const {
		session,
		currentRun,
		runSummaries,
		todoPanel,
		tailFollow,
		workflowRef,
	} = input;

	const status = deriveStatus(currentRun, runSummaries, input.errorReason);
	const sessionTotal = Math.max(
		0,
		Math.trunc(input.sessionTotal ?? (session?.session_id ? 1 : 0)),
	);
	const sessionIndex =
		sessionTotal > 0 && session?.session_id
			? Math.min(
					Math.max(1, Math.trunc(input.sessionIndex ?? sessionTotal)),
					sessionTotal,
				)
			: null;

	return {
		session_id: session?.session_id ?? '–',
		session_index: sessionIndex,
		session_total: sessionTotal,
		workflow: workflowRef ?? 'default',
		harness: detectHarness(input.harness),
		model_name: input.modelName ?? null,
		context: {used: input.contextUsed ?? null, max: input.contextMax ?? null},
		total_tokens: input.totalTokens ?? null,
		run_count: input.runCount ?? 0,
		engine: session?.agent_type,
		progress:
			todoPanel.todoItems.length > 0
				? {done: todoPanel.doneCount, total: todoPanel.todoItems.length}
				: undefined,
		status,
		error_reason: status === 'error' ? input.errorReason : undefined,
		tail_mode: tailFollow,
	};
}
