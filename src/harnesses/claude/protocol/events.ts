/**
 * Discriminated union types for Claude Code hook events.
 *
 * These types provide proper type safety through discriminated unions,
 * allowing TypeScript to narrow types based on hook_event_name.
 *
 * Complete list of Claude Code hooks:
 * - SessionStart: Session begins or resumes
 * - UserPromptSubmit: User submits a prompt
 * - PreToolUse: Before tool execution
 * - PermissionRequest: When permission dialog appears
 * - PostToolUse: After tool succeeds
 * - PostToolUseFailure: After tool fails
 * - SubagentStart: When spawning a subagent
 * - SubagentStop: When subagent finishes
 * - Stop: Claude finishes responding
 * - PreCompact: Before context compaction
 * - SessionEnd: Session terminates
 * - Notification: Claude Code sends notifications
 * - Setup: When Claude Code is invoked with --init, --init-only, or --maintenance flags
 * - TeammateIdle: When a teammate is about to go idle
 * - TaskCompleted: When a task is marked complete
 * - ConfigChange: When configuration changes during a session
 * - InstructionsLoaded: When CLAUDE.md or rules files are loaded
 * - WorktreeCreate: When a worktree is created
 * - WorktreeRemove: When a worktree is removed
 */

export type PermissionMode =
	| 'default'
	| 'plan'
	| 'acceptEdits'
	| 'dontAsk'
	| 'bypassPermissions';

export type PermissionSuggestion = {
	type: string;
	tool: string;
};

export type NotificationType =
	| 'permission_prompt'
	| 'idle_prompt'
	| 'auth_success'
	| 'elicitation_dialog';

export type SessionEndReason =
	| 'clear'
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
	| 'include';

// Base fields present in all hook events
type BaseHookEvent = {
	session_id: string;
	transcript_path: string;
	cwd: string;
	permission_mode?: PermissionMode;
};

// Tool-related fields for PreToolUse, PermissionRequest, PostToolUse, and PostToolUseFailure
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

// PostToolUse: After a tool completes successfully
export type PostToolUseEvent = ToolEventBase & {
	hook_event_name: 'PostToolUse';
	tool_response: unknown;
};

// PostToolUseFailure: After a tool fails
// Per the hooks reference, failure events carry `error` and `is_interrupt`
// instead of `tool_response`.
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

// Stop: Session stop event
export type StopEvent = BaseHookEvent & {
	hook_event_name: 'Stop';
	stop_hook_active: boolean;
	last_assistant_message?: string;
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

// PreCompact: Before context compaction
export type PreCompactEvent = BaseHookEvent & {
	hook_event_name: 'PreCompact';
	trigger: 'manual' | 'auto';
	custom_instructions?: string;
};

// Setup: Repository initialization or maintenance
export type SetupEvent = BaseHookEvent & {
	hook_event_name: 'Setup';
	trigger: 'init' | 'maintenance';
};

// SessionStart: Session begins
export type SessionStartEvent = BaseHookEvent & {
	hook_event_name: 'SessionStart';
	source: 'startup' | 'resume' | 'clear' | 'compact';
	model?: string;
	agent_type?: string;
};

// SessionEnd: Session ends
export type SessionEndEvent = BaseHookEvent & {
	hook_event_name: 'SessionEnd';
	reason: SessionEndReason;
};

// TeammateIdle: Team teammate is about to go idle
export type TeammateIdleEvent = BaseHookEvent & {
	hook_event_name: 'TeammateIdle';
	teammate_name: string;
	team_name: string;
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

// ConfigChange: Claude config changed during a session
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

// WorktreeCreate: A worktree is being created
export type WorktreeCreateEvent = BaseHookEvent & {
	hook_event_name: 'WorktreeCreate';
	name: string;
};

// WorktreeRemove: A worktree is being removed
export type WorktreeRemoveEvent = BaseHookEvent & {
	hook_event_name: 'WorktreeRemove';
	worktree_path: string;
};

/**
 * Union of all hook event types.
 * TypeScript can narrow this type based on hook_event_name.
 */
export type ClaudeHookEvent =
	| PreToolUseEvent
	| PermissionRequestEvent
	| PostToolUseEvent
	| PostToolUseFailureEvent
	| NotificationEvent
	| StopEvent
	| SubagentStartEvent
	| SubagentStopEvent
	| UserPromptSubmitEvent
	| PreCompactEvent
	| SetupEvent
	| SessionStartEvent
	| SessionEndEvent
	| TeammateIdleEvent
	| TaskCompletedEvent
	| ConfigChangeEvent
	| InstructionsLoadedEvent
	| WorktreeCreateEvent
	| WorktreeRemoveEvent;

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

/**
 * Check if an event is a tool-related event.
 * Tool events: PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure
 */
export function isToolEvent(
	event: ClaudeHookEvent,
): event is
	| PreToolUseEvent
	| PermissionRequestEvent
	| PostToolUseEvent
	| PostToolUseFailureEvent {
	return (
		event.hook_event_name === 'PreToolUse' ||
		event.hook_event_name === 'PermissionRequest' ||
		event.hook_event_name === 'PostToolUse' ||
		event.hook_event_name === 'PostToolUseFailure'
	);
}
