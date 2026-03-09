/**
 * Types for the dynamic Header component's metrics and state.
 */

export type TokenUsage = {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	total: number | null;
	contextSize: number | null;
};

export type SubagentMetrics = {
	agentId: string;
	agentType: string;
	toolCallCount: number;
	tokenCount: number | null;
};

export type PermissionMetrics = {
	allowed: number;
	denied: number;
};

export type SessionMetrics = {
	modelName: string | null;
	toolCallCount: number;
	totalToolCallCount: number; // main + all subagents
	subagentCount: number;
	subagentMetrics: SubagentMetrics[];
	permissions: PermissionMetrics;
	sessionStartTime: Date | null;
	tokens: TokenUsage;
	failures: number;
	blocks: number;
};

export type SessionStatsSnapshot = {
	metrics: SessionMetrics;
	tokens: TokenUsage;
	elapsed: number;
};

export type ClaudeState = 'idle' | 'working' | 'waiting' | 'error';

/**
 * Explicit app mode — replaces scattered boolean checks.
 * Priority order: permission > question > working > idle.
 */
export type AppMode =
	| {type: 'idle'}
	| {type: 'working'}
	| {type: 'permission'}
	| {type: 'question'}
	| {type: 'startup_failed'; message: string};

/** Map AppMode to ClaudeState for Header display. */
export function appModeToClaudeState(mode: AppMode): ClaudeState {
	switch (mode.type) {
		case 'startup_failed':
			return 'error';
		case 'permission':
		case 'question':
			return 'waiting';
		case 'working':
			return 'working';
		case 'idle':
			return 'idle';
	}
}
