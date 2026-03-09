import type {SessionMetrics} from '../../shared/types/headerMetrics';

export type SessionTelemetryCarry = {
	toolCallCount: number;
	permissionsAllowed: number;
	permissionsDenied: number;
	subagentIds: Set<string>;
};

export function createEmptySessionTelemetryCarry(): SessionTelemetryCarry {
	return {
		toolCallCount: 0,
		permissionsAllowed: 0,
		permissionsDenied: 0,
		subagentIds: new Set<string>(),
	};
}

export function accumulateSessionTelemetryCarry(
	carry: SessionTelemetryCarry,
	metrics: SessionMetrics,
): SessionTelemetryCarry {
	const subagentIds = new Set(carry.subagentIds);
	for (const subagent of metrics.subagentMetrics) {
		subagentIds.add(subagent.agentId);
	}

	return {
		toolCallCount: carry.toolCallCount + metrics.totalToolCallCount,
		permissionsAllowed: carry.permissionsAllowed + metrics.permissions.allowed,
		permissionsDenied: carry.permissionsDenied + metrics.permissions.denied,
		subagentIds,
	};
}

export function buildSessionTelemetrySummary(
	carry: SessionTelemetryCarry,
	metrics: SessionMetrics,
): {
	toolCallCount: number;
	subagentCount: number;
	permissionsAllowed: number;
	permissionsDenied: number;
} {
	const combined = accumulateSessionTelemetryCarry(carry, metrics);
	return {
		toolCallCount: combined.toolCallCount,
		subagentCount: combined.subagentIds.size,
		permissionsAllowed: combined.permissionsAllowed,
		permissionsDenied: combined.permissionsDenied,
	};
}
