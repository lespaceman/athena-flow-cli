import type {TokenUsage} from '../../shared/types/headerMetrics';

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
	| 'stop.request'
	| 'subagent.start'
	| 'subagent.stop'
	| 'notification'
	| 'compact.pre'
	| 'setup'
	| 'teammate.idle'
	| 'task.completed'
	| 'config.change'
	| 'unknown';

export type RuntimeEventDataMap = {
	'session.start': {
		source?: string;
		model?: string;
		agent_type?: string;
	};
	'session.end': {
		reason?: string;
	};
	'user.prompt': {
		prompt?: string;
		permission_mode?: string;
	};
	'turn.start': {
		thread_id?: string;
		turn_id?: string;
		status?: string;
		prompt?: string;
	};
	'turn.complete': {
		thread_id?: string;
		turn_id?: string;
		status?: string;
	};
	'message.delta': {
		thread_id?: string;
		turn_id?: string;
		item_id?: string;
		delta?: string;
	};
	'message.complete': {
		thread_id?: string;
		turn_id?: string;
		item_id?: string;
		message?: string;
		phase?: string | null;
	};
	'plan.delta': {
		thread_id?: string;
		turn_id?: string;
		item_id?: string;
		delta?: string;
		explanation?: string | null;
		plan?: unknown[];
	};
	'reasoning.delta': {
		thread_id?: string;
		turn_id?: string;
		item_id?: string;
		delta?: string;
		content_index?: number;
		phase?: 'summary' | 'text';
		summary_index?: number;
	};
	'usage.update': {
		thread_id?: string;
		turn_id?: string;
		usage?: TokenUsage;
		delta?: TokenUsage;
	};
	'tool.delta': {
		thread_id?: string;
		turn_id?: string;
		tool_name?: string;
		tool_input?: Record<string, unknown>;
		tool_use_id?: string;
		delta?: string;
	};
	'tool.pre': {
		tool_name?: string;
		tool_input?: Record<string, unknown>;
		tool_use_id?: string;
	};
	'tool.post': {
		tool_name?: string;
		tool_input?: Record<string, unknown>;
		tool_use_id?: string;
		tool_response?: unknown;
	};
	'tool.failure': {
		tool_name?: string;
		tool_input?: Record<string, unknown>;
		tool_use_id?: string;
		error?: string;
		is_interrupt?: boolean;
		exit_code?: number;
		output?: string;
		error_code?: string;
	};
	'permission.request': {
		tool_name?: string;
		tool_input?: Record<string, unknown>;
		tool_use_id?: string;
		permission_suggestions?: Array<{type: string; tool: string}>;
	};
	'stop.request': {
		stop_hook_active?: boolean;
		last_assistant_message?: string;
	};
	'subagent.start': {
		agent_id?: string;
		agent_type?: string;
		tool?: string;
	};
	'subagent.stop': {
		agent_id?: string;
		agent_type?: string;
		tool?: string;
		status?: string;
		stop_hook_active?: boolean;
		agent_transcript_path?: string;
		last_assistant_message?: string;
	};
	notification: {
		message?: string;
		title?: string;
		notification_type?: string;
	};
	'compact.pre': {
		trigger?: 'manual' | 'auto';
		custom_instructions?: string;
	};
	setup: {
		trigger?: 'init' | 'maintenance';
	};
	'teammate.idle': {
		teammate_name?: string;
		team_name?: string;
	};
	'task.completed': {
		task_id?: string;
		task_subject?: string;
		task_description?: string;
		teammate_name?: string;
		team_name?: string;
	};
	'config.change': {
		source?: string;
		file_path?: string;
	};
	unknown: {
		source_event_name?: string;
		payload?: unknown;
	};
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
		case 'Stop':
			return 'stop.request';
		case 'SubagentStart':
			return 'subagent.start';
		case 'SubagentStop':
			return 'subagent.stop';
		case 'Notification':
			return 'notification';
		case 'PreCompact':
			return 'compact.pre';
		case 'Setup':
			return 'setup';
		case 'TeammateIdle':
			return 'teammate.idle';
		case 'TaskCompleted':
			return 'task.completed';
		case 'ConfigChange':
			return 'config.change';
		default:
			return 'unknown';
	}
}
