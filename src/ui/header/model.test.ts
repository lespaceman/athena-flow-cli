import {describe, it, expect, vi} from 'vitest';
import {buildHeaderModel} from './model';

vi.mock('../../shared/utils/detectHarness', () => ({
	detectHarness: () => 'Claude Code',
}));

const baseInput = {
	session: {session_id: 'abc123', agent_type: 'claude-code'},
	currentRun: null as {
		run_id: string;
		trigger: {prompt_preview?: string};
		started_at: number;
	} | null,
	runSummaries: [] as {status: string; endedAt?: number}[],
	metrics: {failures: 0, blocks: 0},
	todoPanel: {doneCount: 0, doingCount: 0, todoItems: {length: 0}},
	tailFollow: false,
	now: 1000000,
};

describe('buildHeaderModel', () => {
	it('returns idle status when no run exists', () => {
		const model = buildHeaderModel(baseInput);
		expect(model.status).toBe('idle');
		expect(model.session_id).toBe('abc123');
		expect(model.session_index).toBe(1);
		expect(model.session_total).toBe(1);
	});

	it('uses provided session scope values', () => {
		const model = buildHeaderModel({
			...baseInput,
			sessionIndex: 2,
			sessionTotal: 5,
		});
		expect(model.session_index).toBe(2);
		expect(model.session_total).toBe(5);
	});

	it('returns active status with active run', () => {
		const model = buildHeaderModel({
			...baseInput,
			currentRun: {
				run_id: 'run1',
				trigger: {prompt_preview: 'Fix the bug'},
				started_at: 999000,
			},
		});
		expect(model.status).toBe('active');
	});

	it('defaults workflow to "default" when workflowRef is undefined', () => {
		const model = buildHeaderModel(baseInput);
		expect(model.workflow).toBe('default');
	});

	it('uses workflowRef for workflow when provided', () => {
		const model = buildHeaderModel({
			...baseInput,
			workflowRef: 'web.login.smoke@7c91f2',
		});
		expect(model.workflow).toBe('web.login.smoke@7c91f2');
	});

	it('includes harness field', () => {
		const model = buildHeaderModel(baseInput);
		expect(model.harness).toBe('Claude Code');
	});

	it('includes context with null used and default max', () => {
		const model = buildHeaderModel(baseInput);
		expect(model.context).toEqual({used: null, max: null});
	});

	it('includes context with provided values', () => {
		const model = buildHeaderModel({
			...baseInput,
			contextUsed: 50000,
			contextMax: 100000,
		});
		expect(model.context).toEqual({used: 50000, max: 100000});
	});

	it('derives error status from FAILED runSummary', () => {
		const model = buildHeaderModel({
			...baseInput,
			runSummaries: [{status: 'FAILED', endedAt: 998000}],
		});
		expect(model.status).toBe('error');
	});

	it('maps CANCELLED to stopped', () => {
		const model = buildHeaderModel({
			...baseInput,
			runSummaries: [{status: 'CANCELLED'}],
		});
		expect(model.status).toBe('stopped');
	});

	it('maps SUCCEEDED to idle', () => {
		const model = buildHeaderModel({
			...baseInput,
			runSummaries: [{status: 'SUCCEEDED', endedAt: 998000}],
		});
		expect(model.status).toBe('idle');
	});

	it('includes error_reason only when status is error', () => {
		const errorModel = buildHeaderModel({
			...baseInput,
			errorReason: 'Permission denied',
		});
		expect(errorModel.error_reason).toBe('Permission denied');
		expect(errorModel.status).toBe('error');

		const idleModel = buildHeaderModel({
			...baseInput,
			runSummaries: [{status: 'SUCCEEDED'}],
		});
		expect(idleModel.error_reason).toBeUndefined();
	});

	it('includes progress only when total > 0', () => {
		const noProgress = buildHeaderModel(baseInput);
		expect(noProgress.progress).toBeUndefined();

		const withProgress = buildHeaderModel({
			...baseInput,
			todoPanel: {doneCount: 3, doingCount: 1, todoItems: {length: 10}},
		});
		expect(withProgress.progress).toEqual({done: 3, total: 10});
	});

	it('no longer has removed fields', () => {
		const model = buildHeaderModel(baseInput);
		expect(model).not.toHaveProperty('active_agents');
		expect(model).not.toHaveProperty('token_in');
		expect(model).not.toHaveProperty('token_out');
		expect(model).not.toHaveProperty('err_count');
		expect(model).not.toHaveProperty('block_count');
	});

	it('passes engine from session agent_type', () => {
		const model = buildHeaderModel(baseInput);
		expect(model.engine).toBe('claude-code');
	});

	it('handles null session gracefully', () => {
		const model = buildHeaderModel({...baseInput, session: null});
		expect(model.session_id).toBe('–');
		expect(model.session_index).toBeNull();
		expect(model.session_total).toBe(0);
		expect(model.engine).toBeUndefined();
	});

	it('defaults total_tokens to null and run_count to 0', () => {
		const model = buildHeaderModel(baseInput);
		expect(model.total_tokens).toBeNull();
		expect(model.run_count).toBe(0);
	});

	it('passes through totalTokens and runCount', () => {
		const model = buildHeaderModel({
			...baseInput,
			totalTokens: 45200,
			runCount: 3,
		});
		expect(model.total_tokens).toBe(45200);
		expect(model.run_count).toBe(3);
	});
});
