import {describe, it, expect} from 'vitest';
import {buildTimelineCurrentRun} from './useSessionScope';

describe('buildTimelineCurrentRun', () => {
	it('returns null when run_id is null', () => {
		expect(
			buildTimelineCurrentRun({
				runId: null,
				startedAt: 100,
				promptPreview: 'hello',
			}),
		).toBeNull();
	});

	it('returns null when started_at is null', () => {
		expect(
			buildTimelineCurrentRun({
				runId: 'run-1',
				startedAt: null,
				promptPreview: 'hello',
			}),
		).toBeNull();
	});

	it('returns shaped object when both run_id and started_at exist', () => {
		const result = buildTimelineCurrentRun({
			runId: 'run-1',
			startedAt: 1000,
			promptPreview: 'hello world',
		});
		expect(result).toEqual({
			run_id: 'run-1',
			trigger: {prompt_preview: 'hello world'},
			started_at: 1000,
		});
	});

	it('handles undefined prompt_preview', () => {
		const result = buildTimelineCurrentRun({
			runId: 'run-2',
			startedAt: 2000,
			promptPreview: undefined,
		});
		expect(result).toEqual({
			run_id: 'run-2',
			trigger: {prompt_preview: undefined},
			started_at: 2000,
		});
	});
});
