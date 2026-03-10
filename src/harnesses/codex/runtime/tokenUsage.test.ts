import {describe, expect, it} from 'vitest';
import {getCodexUsageDelta, getCodexUsageTotals} from './tokenUsage';

describe('Codex token usage mapping', () => {
	it('keeps total billing tokens but does not invent a current context size', () => {
		const usage = getCodexUsageTotals({
			total: {
				totalTokens: 258_400,
				inputTokens: 200_000,
				cachedInputTokens: 12_000,
				outputTokens: 40_000,
				reasoningOutputTokens: 6_400,
			},
			last: {
				totalTokens: 0,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
			},
			modelContextWindow: 200_000,
		});

		expect(usage).toEqual({
			input: 200_000,
			output: 46_400,
			cacheRead: 12_000,
			cacheWrite: null,
			total: 258_400,
			contextSize: null,
		});
	});

	it('maps last-turn deltas without assigning a fake context size', () => {
		const usage = getCodexUsageDelta({
			total: {
				totalTokens: 0,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
			},
			last: {
				totalTokens: 1_500,
				inputTokens: 900,
				cachedInputTokens: 100,
				outputTokens: 400,
				reasoningOutputTokens: 100,
			},
			modelContextWindow: 400_000,
		});

		expect(usage).toEqual({
			input: 900,
			output: 500,
			cacheRead: 100,
			cacheWrite: null,
			total: 1_500,
			contextSize: null,
		});
	});
});
