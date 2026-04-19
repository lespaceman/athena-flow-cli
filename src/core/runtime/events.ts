import type {TokenUsage} from '../../shared/types/headerMetrics';
import type {PermissionSuggestion} from '../../shared/types/permissionSuggestion';

export type RuntimeEventKind =
	| 'session.start'
	| 'session.end'
	| 'user.prompt'
	| 'turn.start'
	| 'turn.complete'
	| 'message.delta'
	| 'message.complete'
	| 'plan.delta'
	| 'reasoning.delta'
	| 'usage.update'
	| 'tool.delta'
	| 'tool.pre'
	| 'tool.post'
	| 'tool.failure'
	| 'permission.request'
	| 'permission.denied'
	| 'stop.request'
	| 'stop.failure'
	| 'subagent.start'
	| 'subagent.stop'
	| 'notification'
	| 'compact.pre'
	| 'compact.post'
	| 'setup'
	| 'teammate.idle'
	| 'task.created'
	| 'task.completed'
	| 'config.change'
	| 'cwd.changed'
	| 'file.changed'
	| 'elicitation.request'
	| 'elicitation.result'
	| 'unknown';

// ── Runtime event data shapes ────────────────────────────
//
// Each kind's shape is declared here as the single source of truth for the
// post-adapter/pre-mapper representation. All fields are optional since
// adapter translators produce partial data.
//
// Feed-layer per-kind data types (in `src/core/feed/types.ts`) must extend
// these shapes for any kind the mapper maps 1:1. Compatibility is enforced
// by the `AssertFeedExtendsRuntime` rows at the bottom of `feed/types.ts`.

export type SessionStartRuntimeData = {
	source?: string;
	model?: string;
	agent_type?: string;
};

export type SessionEndRuntimeData = {
	reason?: string;
};

export type UserPromptRuntimeData = {
	prompt?: string;
	cwd?: string;
	permission_mode?: string;
};

export type TurnStartRuntimeData = {
	thread_id?: string;
	turn_id?: string;
	status?: string;
	prompt?: string;
};

export type TurnCompleteRuntimeData = {
	thread_id?: string;
	turn_id?: string;
	status?: string;
};

export type MessageDeltaRuntimeData = {
	thread_id?: string;
	turn_id?: string;
	item_id?: string;
	delta?: string;
};

export type MessageCompleteRuntimeData = {
	thread_id?: string;
	turn_id?: string;
	item_id?: string;
	message?: string;
	phase?: string | null;
};

export type PlanDeltaRuntimeData = {
	thread_id?: string;
	turn_id?: string;
	item_id?: string;
	delta?: string;
	explanation?: string | null;
	plan?: unknown[];
};

export type ReasoningDeltaRuntimeData = {
	thread_id?: string;
	turn_id?: string;
	item_id?: string;
	delta?: string;
	content_index?: number;
	phase?: 'summary' | 'text';
	summary_index?: number;
};

export type UsageUpdateRuntimeData = {
	thread_id?: string;
	turn_id?: string;
	usage?: TokenUsage;
	delta?: TokenUsage;
};

export type ToolDeltaRuntimeData = {
	thread_id?: string;
	turn_id?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_use_id?: string;
	delta?: string;
};

export type ToolPreRuntimeData = {
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_use_id?: string;
};

export type ToolPostRuntimeData = {
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_use_id?: string;
	tool_response?: unknown;
};

export type ToolFailureRuntimeData = {
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_use_id?: string;
	error?: string;
	is_interrupt?: boolean;
	exit_code?: number;
	output?: string;
	error_code?: string;
};

export type PermissionRequestRuntimeData = {
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_use_id?: string;
	permission_suggestions?: PermissionSuggestion[];
	network_context?: {
		host?: string;
		protocol?: string;
	};
};

export type PermissionDeniedRuntimeData = {
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_use_id?: string;
	reason?: string;
};

export type StopRequestRuntimeData = {
	stop_hook_active?: boolean;
	last_assistant_message?: string;
};

export type StopFailureRuntimeData = {
	error_type?: string;
	error_message?: string;
};

export type SubagentStartRuntimeData = {
	agent_id?: string;
	agent_type?: string;
	tool?: string;
	description?: string;
	prompt?: string;
	sender_thread_id?: string;
	receiver_thread_id?: string;
	new_thread_id?: string;
	agent_status?: string;
};

export type SubagentStopRuntimeData = {
	agent_id?: string;
	agent_type?: string;
	tool?: string;
	status?: string;
	stop_hook_active?: boolean;
	agent_transcript_path?: string;
	last_assistant_message?: string;
	description?: string;
	prompt?: string;
	sender_thread_id?: string;
	receiver_thread_id?: string;
	new_thread_id?: string;
	agent_status?: string;
};

/**
 * Notification is the catch-all route used by the Codex translator for most
 * non-content server signals (thread status, rate limits, MCP progress,
 * server request resolution, file-system changes, realtime transport events,
 * etc.). The mapper branches on `notification_type` and reads additional
 * structured fields off this payload to synthesize feed-only kinds
 * (`thread.status`, `turn.diff`, `runtime.error`, …). Because the set of
 * fields carried here is intentionally open-ended, notification data carries
 * a string-indexed signature in addition to the canonical three fields.
 */
export type NotificationRuntimeData = {
	message?: string;
	title?: string;
	notification_type?: string;
	[key: string]: unknown;
};

export type CompactPreRuntimeData = {
	trigger?: 'manual' | 'auto';
	custom_instructions?: string;
	thread_id?: string;
	turn_id?: string;
};

export type CompactPostRuntimeData = {
	trigger?: 'manual' | 'auto';
};

export type SetupRuntimeData = {
	trigger?: 'init' | 'maintenance';
};

export type TeammateIdleRuntimeData = {
	teammate_name?: string;
	team_name?: string;
};

export type TaskCreatedRuntimeData = {
	task_id?: string;
	task_subject?: string;
	task_description?: string;
	teammate_name?: string;
	team_name?: string;
};

export type TaskCompletedRuntimeData = {
	task_id?: string;
	task_subject?: string;
	task_description?: string;
	teammate_name?: string;
	team_name?: string;
};

export type ConfigChangeRuntimeData = {
	source?: string;
	file_path?: string;
};

export type CwdChangedRuntimeData = {
	cwd?: string;
};

export type FileChangedRuntimeData = {
	file_path?: string;
};

export type ElicitationRequestRuntimeData = {
	mcp_server?: string;
	form?: unknown;
};

export type ElicitationResultRuntimeData = {
	mcp_server?: string;
	action?: string;
	content?: Record<string, unknown>;
};

/**
 * Catch-all for source events without a dedicated runtime kind. Open-ended
 * to let harnesses annotate the fallthrough with whatever diagnostic
 * metadata is convenient (e.g. `unsupported: true`).
 */
export type UnknownRuntimeData = {
	source_event_name?: string;
	payload?: unknown;
	[key: string]: unknown;
};

export type RuntimeEventDataMap = {
	'session.start': SessionStartRuntimeData;
	'session.end': SessionEndRuntimeData;
	'user.prompt': UserPromptRuntimeData;
	'turn.start': TurnStartRuntimeData;
	'turn.complete': TurnCompleteRuntimeData;
	'message.delta': MessageDeltaRuntimeData;
	'message.complete': MessageCompleteRuntimeData;
	'plan.delta': PlanDeltaRuntimeData;
	'reasoning.delta': ReasoningDeltaRuntimeData;
	'usage.update': UsageUpdateRuntimeData;
	'tool.delta': ToolDeltaRuntimeData;
	'tool.pre': ToolPreRuntimeData;
	'tool.post': ToolPostRuntimeData;
	'tool.failure': ToolFailureRuntimeData;
	'permission.request': PermissionRequestRuntimeData;
	'permission.denied': PermissionDeniedRuntimeData;
	'stop.request': StopRequestRuntimeData;
	'stop.failure': StopFailureRuntimeData;
	'subagent.start': SubagentStartRuntimeData;
	'subagent.stop': SubagentStopRuntimeData;
	notification: NotificationRuntimeData;
	'compact.pre': CompactPreRuntimeData;
	'compact.post': CompactPostRuntimeData;
	setup: SetupRuntimeData;
	'teammate.idle': TeammateIdleRuntimeData;
	'task.created': TaskCreatedRuntimeData;
	'task.completed': TaskCompletedRuntimeData;
	'config.change': ConfigChangeRuntimeData;
	'cwd.changed': CwdChangedRuntimeData;
	'file.changed': FileChangedRuntimeData;
	'elicitation.request': ElicitationRequestRuntimeData;
	'elicitation.result': ElicitationResultRuntimeData;
	unknown: UnknownRuntimeData;
};

export type RuntimeEventData =
	| RuntimeEventDataMap[keyof RuntimeEventDataMap]
	| Record<string, unknown>;

export function mapLegacyHookNameToRuntimeKind(
	hookName: string | undefined,
): RuntimeEventKind {
	if (!hookName) return 'unknown';
	switch (hookName) {
		case 'SessionStart':
			return 'session.start';
		case 'SessionEnd':
			return 'session.end';
		case 'UserPromptSubmit':
			return 'user.prompt';
		case 'TurnStart':
			return 'turn.start';
		case 'TurnComplete':
			return 'turn.complete';
		case 'PreToolUse':
			return 'tool.pre';
		case 'PostToolUse':
			return 'tool.post';
		case 'PostToolUseFailure':
			return 'tool.failure';
		case 'PermissionRequest':
			return 'permission.request';
		case 'PermissionDenied':
			return 'permission.denied';
		case 'Stop':
			return 'stop.request';
		case 'StopFailure':
			return 'stop.failure';
		case 'SubagentStart':
			return 'subagent.start';
		case 'SubagentStop':
			return 'subagent.stop';
		case 'Notification':
			return 'notification';
		case 'PreCompact':
			return 'compact.pre';
		case 'PostCompact':
			return 'compact.post';
		case 'Setup':
			return 'setup';
		case 'TeammateIdle':
			return 'teammate.idle';
		case 'TaskCreated':
			return 'task.created';
		case 'TaskCompleted':
			return 'task.completed';
		case 'ConfigChange':
			return 'config.change';
		case 'CwdChanged':
			return 'cwd.changed';
		case 'FileChanged':
			return 'file.changed';
		case 'Elicitation':
			return 'elicitation.request';
		case 'ElicitationResult':
			return 'elicitation.result';
		default:
			return 'unknown';
	}
}
