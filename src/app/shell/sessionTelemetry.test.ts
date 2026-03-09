import {describe, expect, it} from 'vitest';
import type {SessionMetrics} from '../../shared/types/headerMetrics';
import {
	accumulateSessionTelemetryCarry,
	buildSessionTelemetrySummary,
	createEmptySessionTelemetryCarry,
} from './sessionTelemetry';

function makeMetrics(
	overrides: Partial<SessionMetrics> = {},
): SessionMetrics {
	return {
		modelName: null,
		toolCallCount: 0,
		totalToolCallCount: 0,
		subagentCount: 0,
		subagentMetrics: [],
		permissions: {
			allowed: 0,
			denied: 0,
		},
		sessionStartTime: null,
		tokens: {
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			total: null,
			contextSize: null,
		},
		failures: 0,
		blocks: 0,
		...overrides,
	};
}

describe('session telemetry helpers', () => {
	it('accumulates tool and permission counts across cleared segments', () => {
		const firstSegment = makeMetrics({
			totalToolCallCount: 3,
			permissions: {
				allowed: 2,
				denied: 1,
			},
			subagentMetrics: [
				{agentId: 'subagent-1', agentType: 'worker', toolCallCount: 1, tokenCount: null},
			],
		});
		const secondSegment = makeMetrics({
			totalToolCallCount: 4,
			permissions: {
				allowed: 1,
				denied: 0,
			},
			subagentMetrics: [
				{agentId: 'subagent-2', agentType: 'worker', toolCallCount: 2, tokenCount: null},
			],
		});

		const carry = accumulateSessionTelemetryCarry(
			createEmptySessionTelemetryCarry(),
			firstSegment,
		);
		const summary = buildSessionTelemetrySummary(carry, secondSegment);

		expect(summary).toEqual({
			toolCallCount: 7,
			subagentCount: 2,
			permissionsAllowed: 3,
			permissionsDenied: 1,
		});
	});

	it('deduplicates subagent ids seen before and after a clear', () => {
		const segmentBeforeClear = makeMetrics({
			totalToolCallCount: 1,
			subagentMetrics: [
				{agentId: 'subagent-1', agentType: 'worker', toolCallCount: 1, tokenCount: null},
			],
		});
		const segmentAfterClear = makeMetrics({
			totalToolCallCount: 2,
			subagentMetrics: [
				{agentId: 'subagent-1', agentType: 'worker', toolCallCount: 2, tokenCount: null},
			],
		});

		const carry = accumulateSessionTelemetryCarry(
			createEmptySessionTelemetryCarry(),
			segmentBeforeClear,
		);
		const summary = buildSessionTelemetrySummary(carry, segmentAfterClear);

		expect(summary.subagentCount).toBe(1);
		expect(summary.toolCallCount).toBe(3);
	});
});
