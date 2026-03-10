import type {TokenUsage} from '../../../shared/types/headerMetrics';
import type {CodexThreadTokenUsage} from '../protocol';

export const NULL_TOKENS: TokenUsage = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
};

function fromBreakdown(
	breakdown:
		| CodexThreadTokenUsage['total']
		| CodexThreadTokenUsage['last']
		| null
		| undefined,
): TokenUsage {
	if (!breakdown) {
		return {
			...NULL_TOKENS,
		};
	}

	return {
		input: breakdown.inputTokens,
		output: breakdown.outputTokens + breakdown.reasoningOutputTokens,
		cacheRead: breakdown.cachedInputTokens,
		cacheWrite: null,
		total: breakdown.totalTokens,
		// Codex reports the model window separately (`modelContextWindow`), but it
		// does not expose the current in-context occupancy in this payload.
		contextSize: null,
	};
}

export function getCodexUsageTotals(
	usage: CodexThreadTokenUsage | null | undefined,
): TokenUsage {
	if (!usage) return {...NULL_TOKENS};
	return fromBreakdown(usage.total);
}

export function getCodexUsageDelta(
	usage: CodexThreadTokenUsage | null | undefined,
): TokenUsage {
	if (!usage) return {...NULL_TOKENS};
	return fromBreakdown(usage.last);
}

export function readTokenUsage(value: unknown): TokenUsage {
	if (typeof value !== 'object' || value === null) {
		return {...NULL_TOKENS};
	}

	const record = value as Record<string, unknown>;
	return {
		input: typeof record['input'] === 'number' ? record['input'] : null,
		output: typeof record['output'] === 'number' ? record['output'] : null,
		cacheRead:
			typeof record['cacheRead'] === 'number' ? record['cacheRead'] : null,
		cacheWrite:
			typeof record['cacheWrite'] === 'number' ? record['cacheWrite'] : null,
		total: typeof record['total'] === 'number' ? record['total'] : null,
		contextSize:
			typeof record['contextSize'] === 'number'
				? record['contextSize']
				: null,
	};
}
