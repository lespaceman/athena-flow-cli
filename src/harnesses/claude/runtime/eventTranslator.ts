import type {
	RuntimeEventData,
	RuntimeEventKind,
} from '../../../core/runtime/events';
import type {HookEventEnvelope} from '../protocol/envelope';
import {
	isToolEvent,
	isSubagentStartEvent,
	isSubagentStopEvent,
} from '../protocol/events';

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === 'object' && value !== null) {
		return value as Record<string, unknown>;
	}
	return {};
}

export type ClaudeTranslatedEvent = {
	kind: RuntimeEventKind;
	data: RuntimeEventData;
	toolName?: string;
	toolUseId?: string;
	agentId?: string;
	agentType?: string;
};

export function translateClaudeEnvelope(
	envelope: HookEventEnvelope,
): ClaudeTranslatedEvent {
	const payload = asRecord(envelope.payload);

	// Derived fields available across event kinds.
	let toolName: string | undefined;
	let toolUseId: string | undefined;
	if (isToolEvent(envelope.payload)) {
		toolName = envelope.payload.tool_name;
		toolUseId = envelope.payload.tool_use_id;
	}

	let agentId: string | undefined;
	let agentType: string | undefined;
	if (isSubagentStartEvent(envelope.payload)) {
		agentId = envelope.payload.agent_id;
		agentType = envelope.payload.agent_type;
	} else if (isSubagentStopEvent(envelope.payload)) {
		agentId = envelope.payload.agent_id;
		agentType = envelope.payload.agent_type;
	}

	const hookName = envelope.hook_event_name as string;

	switch (hookName) {
		case 'SessionStart':
			return {
				kind: 'session.start',
				data: {
					source: payload['source'] as string | undefined,
					agent_type: payload['agent_type'] as string | undefined,
				},
			};
		case 'SessionEnd':
			return {
				kind: 'session.end',
				data: {
					reason: payload['reason'] as string | undefined,
				},
			};
		case 'UserPromptSubmit':
			return {
				kind: 'user.prompt',
				data: {
					prompt: payload['prompt'] as string | undefined,
					permission_mode: payload['permission_mode'] as string | undefined,
				},
			};
		case 'PreToolUse':
			return {
				kind: 'tool.pre',
				toolName,
				toolUseId,
				data: {
					tool_name: toolName,
					tool_input:
						(payload['tool_input'] as Record<string, unknown> | undefined) ??
						{},
					tool_use_id: toolUseId,
				},
			};
		case 'PostToolUse':
			return {
				kind: 'tool.post',
				toolName,
				toolUseId,
				data: {
					tool_name: toolName,
					tool_input:
						(payload['tool_input'] as Record<string, unknown> | undefined) ??
						{},
					tool_use_id: toolUseId,
					tool_response: payload['tool_response'],
				},
			};
		case 'PostToolUseFailure':
			return {
				kind: 'tool.failure',
				toolName,
				toolUseId,
				data: {
					tool_name: toolName,
					tool_input:
						(payload['tool_input'] as Record<string, unknown> | undefined) ??
						{},
					tool_use_id: toolUseId,
					error: payload['error'] as string | undefined,
					is_interrupt: payload['is_interrupt'] as boolean | undefined,
				},
			};
		case 'PermissionRequest':
			return {
				kind: 'permission.request',
				toolName,
				toolUseId,
				data: {
					tool_name: toolName,
					tool_input:
						(payload['tool_input'] as Record<string, unknown> | undefined) ??
						{},
					tool_use_id: toolUseId,
					permission_suggestions: payload['permission_suggestions'] as
						| Array<{type: string; tool: string}>
						| undefined,
				},
			};
		case 'Stop':
			return {
				kind: 'stop.request',
				data: {
					stop_hook_active: payload['stop_hook_active'] as boolean | undefined,
					last_assistant_message: payload['last_assistant_message'] as
						| string
						| undefined,
				},
			};
		case 'SubagentStart':
			return {
				kind: 'subagent.start',
				agentId,
				agentType,
				data: {
					agent_id: agentId,
					agent_type: agentType,
				},
			};
		case 'SubagentStop':
			return {
				kind: 'subagent.stop',
				agentId,
				agentType,
				data: {
					agent_id: agentId,
					agent_type: agentType,
					stop_hook_active: payload['stop_hook_active'] as boolean | undefined,
					agent_transcript_path: payload['agent_transcript_path'] as
						| string
						| undefined,
					last_assistant_message: payload['last_assistant_message'] as
						| string
						| undefined,
				},
			};
		case 'Notification':
			return {
				kind: 'notification',
				data: {
					message: payload['message'] as string | undefined,
					title: payload['title'] as string | undefined,
					notification_type: payload['notification_type'] as string | undefined,
				},
			};
		case 'PreCompact':
			return {
				kind: 'compact.pre',
				data: {
					trigger: payload['trigger'] as 'manual' | 'auto' | undefined,
					custom_instructions: payload['custom_instructions'] as
						| string
						| undefined,
				},
			};
		case 'Setup':
			return {
				kind: 'setup',
				data: {
					trigger: payload['trigger'] as 'init' | 'maintenance' | undefined,
				},
			};
		case 'TeammateIdle':
			return {
				kind: 'teammate.idle',
				data: {
					teammate_name: payload['teammate_name'] as string | undefined,
					team_name: payload['team_name'] as string | undefined,
				},
			};
		case 'TaskCompleted':
			return {
				kind: 'task.completed',
				data: {
					task_id: payload['task_id'] as string | undefined,
					task_subject: payload['task_subject'] as string | undefined,
					task_description: payload['task_description'] as string | undefined,
					teammate_name: payload['teammate_name'] as string | undefined,
					team_name: payload['team_name'] as string | undefined,
				},
			};
		case 'ConfigChange':
			return {
				kind: 'config.change',
				data: {
					source: payload['source'] as string | undefined,
					file_path: payload['file_path'] as string | undefined,
				},
			};
		default:
			return {
				kind: 'unknown',
				data: {
					source_event_name: hookName,
					payload: envelope.payload,
				},
			};
	}
}
