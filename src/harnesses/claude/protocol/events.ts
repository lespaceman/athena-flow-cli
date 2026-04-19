/**
 * Discriminated union types for Claude Code hook events.
 *
 * These types provide proper type safety through discriminated unions,
 * allowing TypeScript to narrow types based on hook_event_name.
 *
 * Complete list of Claude Code hooks (per https://code.claude.com/docs/en/hooks.md):
 * - SessionStart: Session begins or resumes
 * - UserPromptSubmit: User submits a prompt
 * - PreToolUse: Before tool execution
 * - PermissionRequest: When permission dialog appears
 * - PermissionDenied: Auto-mode classifier denied a tool call
 * - PostToolUse: After tool succeeds
 * - PostToolUseFailure: After tool fails
 * - SubagentStart: When spawning a subagent
 * - SubagentStop: When subagent finishes
 * - Stop: Claude finishes responding
 * - StopFailure: Turn ends due to API error
 * - PreCompact: Before context compaction
 * - PostCompact: After context compaction completes
 * - SessionEnd: Session terminates
 * - Notification: Claude Code sends notifications
 * - Setup: Athena-observed init/maintenance trigger
 * - TeammateIdle: When a teammate is about to go idle
 * - TaskCreated: When a task is created via TaskCreate
 * - TaskCompleted: When a task is marked complete
 * - ConfigChange: When configuration changes during a session
 * - InstructionsLoaded: When CLAUDE.md or rules files are loaded
 * - CwdChanged: Working directory changed
 * - FileChanged: Watched file changed on disk
 * - WorktreeCreate: When a worktree is created
 * - WorktreeRemove: When a worktree is removed
 * - Elicitation: MCP server requested user input mid-tool
 * - ElicitationResult: User responded to an MCP elicitation
 */

export type PermissionMode =
	| 'default'
	| 'plan'
	| 'acceptEdits'
	| 'auto'
	| 'dontAsk'
	| 'bypassPermissions';

/**
 * A permission suggestion attached to PermissionRequest events.
 * See hooks reference: `permission_suggestions[].type` is one of the
 * documented update kinds; additional fields vary by kind.
 *
 * The canonical shape lives in `src/shared/types/permissionSuggestion.ts`
 * so that layer-neutral `core/` code can reference it without importing
 * from `harnesses/` (ESLint-enforced layer rule).
 */
export type {
	PermissionSuggestion,
	PermissionSuggestionDestination,
} from '../../../shared/types/permissionSuggestion';

import type {PermissionSuggestion} from '../../../shared/types/permissionSuggestion';

export type NotificationType =
	| 'permission_prompt'
	| 'idle_prompt'
	| 'auth_success'
	| 'elicitation_dialog';

export type SessionEndReason =
	| 'clear'
	| 'resume'
	| 'logout'
	| 'prompt_input_exit'
	| 'bypass_permissions_disabled'
	| 'other';

export type ConfigChangeSource =
	| 'user_settings'
	| 'project_settings'
	| 'local_settings'
	| 'policy_settings'
	| 'skills';

export type InstructionsMemoryType = 'User' | 'Project' | 'Local' | 'Managed';

export type InstructionsLoadReason =
	| 'session_start'
	| 'nested_traversal'
	| 'path_glob_match'
	| 'include'
	| 'compact';

export type StopFailureErrorType =
	| 'rate_limit'
	| 'authentication_failed'
	| 'billing_error'
	| 'invalid_request'
	| 'server_error'
	| 'max_output_tokens'
	| 'unknown';

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export type ElicitationFormField = {
	id: string;
	label: string;
	type: string;
	required?: boolean;
};

// Base fields present in all hook events
type BaseHookEvent = {
	session_id: string;
	transcript_path: string;
	cwd: string;
	permission_mode?: PermissionMode;
	agent_id?: string;
	agent_type?: string;
};

// Tool-related fields for PreToolUse, PermissionRequest, PostToolUse,
// PostToolUseFailure, and PermissionDenied
type ToolEventBase = BaseHookEvent & {
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_use_id?: string;
};

// PreToolUse: Before a tool is executed
export type PreToolUseEvent = ToolEventBase & {
	hook_event_name: 'PreToolUse';
};

// PermissionRequest: When a permission dialog is shown
export type PermissionRequestEvent = ToolEventBase & {
	hook_event_name: 'PermissionRequest';
	permission_suggestions?: PermissionSuggestion[];
};

// PermissionDenied: Auto-mode classifier denied a tool call
export type PermissionDeniedEvent = ToolEventBase & {
	hook_event_name: 'PermissionDenied';
	reason: string;
};

// PostToolUse: After a tool completes successfully
export type PostToolUseEvent = ToolEventBase & {
	hook_event_name: 'PostToolUse';
	tool_response: unknown;
};

// PostToolUseFailure: After a tool fails
export type PostToolUseFailureEvent = ToolEventBase & {
	hook_event_name: 'PostToolUseFailure';
	error: string;
	is_interrupt?: boolean;
};

// Notification: Claude sends a notification
export type NotificationEvent = BaseHookEvent & {
	hook_event_name: 'Notification';
	message: string;
	title?: string;
	notification_type?: NotificationType;
};

// Stop: Claude finishes responding.
// Note: `stop_hook_active` and `last_assistant_message` are not formally
// documented in the current hooks reference (they appear on SubagentStop) but
// have been observed on Stop payloads in practice; kept optional for safety.
export type StopEvent = BaseHookEvent & {
	hook_event_name: 'Stop';
	stop_hook_active?: boolean;
	last_assistant_message?: string;
};

// StopFailure: Turn ended due to an API error
export type StopFailureEvent = BaseHookEvent & {
	hook_event_name: 'StopFailure';
	error_type: StopFailureErrorType;
	error_message: string;
};

// SubagentStart: Subagent spawn event
export type SubagentStartEvent = BaseHookEvent & {
	hook_event_name: 'SubagentStart';
	agent_id: string;
	agent_type: string;
};

// SubagentStop: Subagent stop event
export type SubagentStopEvent = BaseHookEvent & {
	hook_event_name: 'SubagentStop';
	stop_hook_active: boolean;
	agent_id: string;
	agent_type: string;
	agent_transcript_path?: string;
	last_assistant_message?: string;
};

// UserPromptSubmit: User submits a prompt
export type UserPromptSubmitEvent = BaseHookEvent & {
	hook_event_name: 'UserPromptSubmit';
	prompt: string;
};

// PreCompact: Before context compaction.
// `custom_instructions` is not in the current hooks reference but has been
// observed in practice; kept optional.
export type PreCompactEvent = BaseHookEvent & {
	hook_event_name: 'PreCompact';
	trigger: 'manual' | 'auto';
	custom_instructions?: string;
};

// PostCompact: After context compaction completes
export type PostCompactEvent = BaseHookEvent & {
	hook_event_name: 'PostCompact';
	trigger: 'manual' | 'auto';
};

// Setup: Repository initialization or maintenance.
// Not in the official hooks reference; emitted by Claude Code when invoked
// with --init / --init-only / --maintenance. Retained because Athena observes
// it and the harness must register a handler when it fires.
export type SetupEvent = BaseHookEvent & {
	hook_event_name: 'Setup';
	trigger: 'init' | 'maintenance';
};

// SessionStart: Session begins
export type SessionStartEvent = BaseHookEvent & {
	hook_event_name: 'SessionStart';
	source: 'startup' | 'resume' | 'clear' | 'compact';
	model?: string;
};

// SessionEnd: Session ends
export type SessionEndEvent = BaseHookEvent & {
	hook_event_name: 'SessionEnd';
	reason: SessionEndReason;
};

// TeammateIdle: Team teammate is about to go idle.
// `team_name` is not in the current hooks reference; kept optional.
export type TeammateIdleEvent = BaseHookEvent & {
	hook_event_name: 'TeammateIdle';
	teammate_name: string;
	team_name?: string;
};

// TaskCreated: Task is created via TaskCreate tool
export type TaskCreatedEvent = BaseHookEvent & {
	hook_event_name: 'TaskCreated';
	task_id: string;
	task_subject: string;
	task_description?: string;
	teammate_name?: string;
	team_name?: string;
};

// TaskCompleted: Task is being marked complete
export type TaskCompletedEvent = BaseHookEvent & {
	hook_event_name: 'TaskCompleted';
	task_id: string;
	task_subject: string;
	task_description?: string;
	teammate_name?: string;
	team_name?: string;
};

// ConfigChange: Claude config changed during a session.
// `file_path` is not in the current hooks reference; kept optional.
export type ConfigChangeEvent = BaseHookEvent & {
	hook_event_name: 'ConfigChange';
	source: ConfigChangeSource;
	file_path?: string;
};

// InstructionsLoaded: CLAUDE.md or rules were loaded into context
export type InstructionsLoadedEvent = BaseHookEvent & {
	hook_event_name: 'InstructionsLoaded';
	file_path: string;
	memory_type: InstructionsMemoryType;
	load_reason: InstructionsLoadReason;
	globs?: string[];
	trigger_file_path?: string;
	parent_file_path?: string;
};

// CwdChanged: Working directory changed (e.g. via `cd`)
export type CwdChangedEvent = BaseHookEvent & {
	hook_event_name: 'CwdChanged';
};

// FileChanged: A watched file was modified on disk
export type FileChangedEvent = BaseHookEvent & {
	hook_event_name: 'FileChanged';
	file_path: string;
};

// WorktreeCreate: A worktree is being created
export type WorktreeCreateEvent = BaseHookEvent & {
	hook_event_name: 'WorktreeCreate';
	worktree_path: string;
};

// WorktreeRemove: A worktree is being removed
export type WorktreeRemoveEvent = BaseHookEvent & {
	hook_event_name: 'WorktreeRemove';
	worktree_path: string;
};

// Elicitation: MCP server requested user input during a tool call
export type ElicitationEvent = BaseHookEvent & {
	hook_event_name: 'Elicitation';
	mcp_server: string;
	form: {
		fields: ElicitationFormField[];
	};
};

// ElicitationResult: User responded to an MCP elicitation
export type ElicitationResultEvent = BaseHookEvent & {
	hook_event_name: 'ElicitationResult';
	mcp_server: string;
	action: ElicitationAction;
	content?: Record<string, unknown>;
};

/**
 * Union of all hook event types.
 * TypeScript can narrow this type based on hook_event_name.
 */
export type ClaudeHookEvent =
	| PreToolUseEvent
	| PermissionRequestEvent
	| PermissionDeniedEvent
	| PostToolUseEvent
	| PostToolUseFailureEvent
	| NotificationEvent
	| StopEvent
	| StopFailureEvent
	| SubagentStartEvent
	| SubagentStopEvent
	| UserPromptSubmitEvent
	| PreCompactEvent
	| PostCompactEvent
	| SetupEvent
	| SessionStartEvent
	| SessionEndEvent
	| TeammateIdleEvent
	| TaskCreatedEvent
	| TaskCompletedEvent
	| ConfigChangeEvent
	| InstructionsLoadedEvent
	| CwdChangedEvent
	| FileChangedEvent
	| WorktreeCreateEvent
	| WorktreeRemoveEvent
	| ElicitationEvent
	| ElicitationResultEvent;

/**
 * All valid hook event names.
 * Derived from the ClaudeHookEvent union type.
 */
export type HookEventName = ClaudeHookEvent['hook_event_name'];

// Type guards for each event type

export function isPreToolUseEvent(
	event: ClaudeHookEvent,
): event is PreToolUseEvent {
	return event.hook_event_name === 'PreToolUse';
}

export function isPermissionRequestEvent(
	event: ClaudeHookEvent,
): event is PermissionRequestEvent {
	return event.hook_event_name === 'PermissionRequest';
}

export function isPermissionDeniedEvent(
	event: ClaudeHookEvent,
): event is PermissionDeniedEvent {
	return event.hook_event_name === 'PermissionDenied';
}

export function isPostToolUseEvent(
	event: ClaudeHookEvent,
): event is PostToolUseEvent {
	return event.hook_event_name === 'PostToolUse';
}

export function isPostToolUseFailureEvent(
	event: ClaudeHookEvent,
): event is PostToolUseFailureEvent {
	return event.hook_event_name === 'PostToolUseFailure';
}

export function isNotificationEvent(
	event: ClaudeHookEvent,
): event is NotificationEvent {
	return event.hook_event_name === 'Notification';
}

export function isSubagentStartEvent(
	event: ClaudeHookEvent,
): event is SubagentStartEvent {
	return event.hook_event_name === 'SubagentStart';
}

export function isSubagentStopEvent(
	event: ClaudeHookEvent,
): event is SubagentStopEvent {
	return event.hook_event_name === 'SubagentStop';
}

export function isSessionStartEvent(
	event: ClaudeHookEvent,
): event is SessionStartEvent {
	return event.hook_event_name === 'SessionStart';
}

export function isSessionEndEvent(
	event: ClaudeHookEvent,
): event is SessionEndEvent {
	return event.hook_event_name === 'SessionEnd';
}

export function isStopFailureEvent(
	event: ClaudeHookEvent,
): event is StopFailureEvent {
	return event.hook_event_name === 'StopFailure';
}

export function isPostCompactEvent(
	event: ClaudeHookEvent,
): event is PostCompactEvent {
	return event.hook_event_name === 'PostCompact';
}

export function isElicitationEvent(
	event: ClaudeHookEvent,
): event is ElicitationEvent {
	return event.hook_event_name === 'Elicitation';
}

export function isElicitationResultEvent(
	event: ClaudeHookEvent,
): event is ElicitationResultEvent {
	return event.hook_event_name === 'ElicitationResult';
}

export function isStopEvent(event: ClaudeHookEvent): event is StopEvent {
	return event.hook_event_name === 'Stop';
}

export function isUserPromptSubmitEvent(
	event: ClaudeHookEvent,
): event is UserPromptSubmitEvent {
	return event.hook_event_name === 'UserPromptSubmit';
}

export function isPreCompactEvent(
	event: ClaudeHookEvent,
): event is PreCompactEvent {
	return event.hook_event_name === 'PreCompact';
}

export function isCwdChangedEvent(
	event: ClaudeHookEvent,
): event is CwdChangedEvent {
	return event.hook_event_name === 'CwdChanged';
}

export function isFileChangedEvent(
	event: ClaudeHookEvent,
): event is FileChangedEvent {
	return event.hook_event_name === 'FileChanged';
}

export function isWorktreeCreateEvent(
	event: ClaudeHookEvent,
): event is WorktreeCreateEvent {
	return event.hook_event_name === 'WorktreeCreate';
}

export function isWorktreeRemoveEvent(
	event: ClaudeHookEvent,
): event is WorktreeRemoveEvent {
	return event.hook_event_name === 'WorktreeRemove';
}

export function isInstructionsLoadedEvent(
	event: ClaudeHookEvent,
): event is InstructionsLoadedEvent {
	return event.hook_event_name === 'InstructionsLoaded';
}

export function isConfigChangeEvent(
	event: ClaudeHookEvent,
): event is ConfigChangeEvent {
	return event.hook_event_name === 'ConfigChange';
}

export function isTaskCreatedEvent(
	event: ClaudeHookEvent,
): event is TaskCreatedEvent {
	return event.hook_event_name === 'TaskCreated';
}

export function isTaskCompletedEvent(
	event: ClaudeHookEvent,
): event is TaskCompletedEvent {
	return event.hook_event_name === 'TaskCompleted';
}

export function isTeammateIdleEvent(
	event: ClaudeHookEvent,
): event is TeammateIdleEvent {
	return event.hook_event_name === 'TeammateIdle';
}

export function isSetupEvent(event: ClaudeHookEvent): event is SetupEvent {
	return event.hook_event_name === 'Setup';
}

/**
 * Check if an event is a tool-related event.
 * Tool events: PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure
 */
export function isToolEvent(
	event: ClaudeHookEvent,
): event is
	| PreToolUseEvent
	| PermissionRequestEvent
	| PermissionDeniedEvent
	| PostToolUseEvent
	| PostToolUseFailureEvent {
	return (
		event.hook_event_name === 'PreToolUse' ||
		event.hook_event_name === 'PermissionRequest' ||
		event.hook_event_name === 'PermissionDenied' ||
		event.hook_event_name === 'PostToolUse' ||
		event.hook_event_name === 'PostToolUseFailure'
	);
}
