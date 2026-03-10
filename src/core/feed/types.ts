// src/feed/types.ts

// ── Base ──────────────────────────────────────────────────

export type FeedEventKind =
	| 'session.start'
	| 'session.end'
	| 'run.start'
	| 'run.end'
	| 'user.prompt'
	| 'tool.delta'
	| 'tool.pre'
	| 'tool.post'
	| 'tool.failure'
	| 'permission.request'
	| 'permission.decision'
	| 'stop.request'
	| 'stop.decision'
	| 'subagent.start'
	| 'subagent.stop'
	| 'notification'
	| 'compact.pre'
	| 'setup'
	| 'unknown.hook'
	| 'todo.add'
	| 'todo.update'
	| 'todo.done'
	| 'agent.message'
	| 'teammate.idle'
	| 'task.completed'
	| 'config.change';

export type FeedEventLevel = 'debug' | 'info' | 'warn' | 'error';

export type FeedEventCause = {
	parent_event_id?: string;
	hook_request_id?: string;
	tool_use_id?: string;
	transcript_path?: string;
};

export type FeedEventUI = {
	collapsed_default?: boolean;
	pin?: boolean;
	badge?: string;
};

export type FeedEventBase = {
	event_id: string;
	seq: number;
	ts: number;
	session_id: string;
	run_id: string;
	kind: FeedEventKind;
	level: FeedEventLevel;
	actor_id: string;
	cause?: FeedEventCause;
	title: string;
	body?: string;
	ui?: FeedEventUI;
	raw?: unknown;
};

// ── Kind-specific data ───────────────────────────────────

export type SessionStartData = {
	source: 'startup' | 'resume' | 'clear' | 'compact' | string;
	model?: string;
	agent_type?: string;
};

export type SessionEndData = {
	reason: string;
};

export type RunStartData = {
	trigger: {
		type: 'user_prompt_submit' | 'resume' | 'clear' | 'compact' | 'other';
		prompt_preview?: string;
	};
};

export type RunEndData = {
	status: 'completed' | 'failed' | 'aborted';
	counters: {
		tool_uses: number;
		tool_failures: number;
		permission_requests: number;
		blocks: number;
	};
};

export type UserPromptData = {
	prompt: string;
	cwd: string;
	permission_mode?: string;
};

export type ToolPreData = {
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_use_id?: string;
};

export type ToolDeltaData = {
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_use_id?: string;
	delta: string;
};

export type ToolPostData = {
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_use_id?: string;
	tool_response: unknown;
};

export type ToolFailureData = {
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_use_id?: string;
	error: string;
	is_interrupt?: boolean;
};

export type PermissionRequestData = {
	tool_name: string;
	tool_input: Record<string, unknown>;
	tool_use_id?: string;
	permission_suggestions?: Array<{type: string; tool: string}>;
};

export type PermissionDecisionData =
	| {decision_type: 'no_opinion'; reason?: string}
	| {
			decision_type: 'allow';
			updated_input?: Record<string, unknown>;
			updated_permissions?: unknown;
			reason?: string;
	  }
	| {
			decision_type: 'deny';
			message: string;
			interrupt?: boolean;
			reason?: string;
	  }
	| {decision_type: 'ask'; reason?: string};

export type StopRequestData = {
	stop_hook_active: boolean;
	last_assistant_message?: string;
};

export type StopDecisionData =
	| {decision_type: 'no_opinion'; reason?: string}
	| {decision_type: 'block'; reason: string}
	| {decision_type: 'allow'; reason?: string};

export type SubagentStartData = {
	agent_id: string;
	agent_type: string;
	description?: string;
};
export type SubagentStopData = {
	agent_id: string;
	agent_type: string;
	stop_hook_active: boolean;
	agent_transcript_path?: string;
	last_assistant_message?: string;
	description?: string;
};

export type NotificationData = {
	message: string;
	title?: string;
	notification_type?: string;
};
export type PreCompactData = {
	trigger: 'manual' | 'auto';
	custom_instructions?: string;
};
export type SetupData = {trigger: 'init' | 'maintenance'};
export type UnknownHookData = {hook_event_name: string; payload: unknown};

export type TeammateIdleData = {
	teammate_name: string;
	team_name: string;
};

export type TaskCompletedData = {
	task_id: string;
	task_subject: string;
	task_description?: string;
	teammate_name?: string;
	team_name?: string;
};

export type ConfigChangeData = {
	source: string;
	file_path?: string;
};

// Phase 2 stubs
export type TodoPriority = 'p0' | 'p1' | 'p2';
export type TodoFeedStatus = 'open' | 'doing' | 'blocked' | 'done';
export type TodoAddData = {
	todo_id: string;
	text: string;
	details?: string;
	priority?: TodoPriority;
	linked_event_id?: string;
	assigned_actor_id?: string;
	tags?: string[];
};
export type TodoUpdateData = {
	todo_id: string;
	patch: Partial<{
		text: string;
		details: string;
		priority: TodoPriority;
		status: TodoFeedStatus;
		assigned_actor_id: string;
		tags: string[];
	}>;
};
export type TodoDoneData = {todo_id: string; reason?: string};

export type AgentMessageData = {
	message: string;
	source: 'hook' | 'transcript';
	scope: 'root' | 'subagent';
};

// ── Discriminated union ──────────────────────────────────

export type FeedEvent =
	| (FeedEventBase & {kind: 'session.start'; data: SessionStartData})
	| (FeedEventBase & {kind: 'session.end'; data: SessionEndData})
	| (FeedEventBase & {kind: 'run.start'; data: RunStartData})
	| (FeedEventBase & {kind: 'run.end'; data: RunEndData})
	| (FeedEventBase & {kind: 'user.prompt'; data: UserPromptData})
	| (FeedEventBase & {kind: 'tool.delta'; data: ToolDeltaData})
	| (FeedEventBase & {kind: 'tool.pre'; data: ToolPreData})
	| (FeedEventBase & {kind: 'tool.post'; data: ToolPostData})
	| (FeedEventBase & {kind: 'tool.failure'; data: ToolFailureData})
	| (FeedEventBase & {kind: 'permission.request'; data: PermissionRequestData})
	| (FeedEventBase & {
			kind: 'permission.decision';
			data: PermissionDecisionData;
	  })
	| (FeedEventBase & {kind: 'stop.request'; data: StopRequestData})
	| (FeedEventBase & {kind: 'stop.decision'; data: StopDecisionData})
	| (FeedEventBase & {kind: 'subagent.start'; data: SubagentStartData})
	| (FeedEventBase & {kind: 'subagent.stop'; data: SubagentStopData})
	| (FeedEventBase & {kind: 'notification'; data: NotificationData})
	| (FeedEventBase & {kind: 'compact.pre'; data: PreCompactData})
	| (FeedEventBase & {kind: 'setup'; data: SetupData})
	| (FeedEventBase & {kind: 'unknown.hook'; data: UnknownHookData})
	| (FeedEventBase & {kind: 'todo.add'; data: TodoAddData})
	| (FeedEventBase & {kind: 'todo.update'; data: TodoUpdateData})
	| (FeedEventBase & {kind: 'todo.done'; data: TodoDoneData})
	| (FeedEventBase & {kind: 'agent.message'; data: AgentMessageData})
	| (FeedEventBase & {kind: 'teammate.idle'; data: TeammateIdleData})
	| (FeedEventBase & {kind: 'task.completed'; data: TaskCompletedData})
	| (FeedEventBase & {kind: 'config.change'; data: ConfigChangeData});
