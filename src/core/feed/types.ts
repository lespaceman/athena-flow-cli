// src/feed/types.ts

// ── Base ──────────────────────────────────────────────────

export type FeedEventKind =
	| 'session.start'
	| 'session.end'
	| 'run.start'
	| 'run.end'
	| 'user.prompt'
	| 'plan.update'
	| 'reasoning.summary'
	| 'usage.update'
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
	| 'runtime.error'
	| 'thread.status'
	| 'turn.diff'
	| 'server.request.resolved'
	| 'web.search'
	| 'review.status'
	| 'image.view'
	| 'context.compaction'
	| 'mcp.progress'
	| 'terminal.input'
	| 'skills.changed'
	| 'skills.loaded'
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
	agent_type?: string;
	model?: string;
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

export type PlanUpdateData = {
	explanation?: string | null;
	delta?: string;
	item_id?: string;
	thread_id?: string;
	turn_id?: string;
	plan?: Array<{step?: string; status?: string}>;
};

export type ReasoningSummaryData = {
	message: string;
	item_id?: string;
	content_index?: number;
	summary_index?: number;
	thread_id?: string;
	turn_id?: string;
};

export type UsageUpdateData = {
	thread_id?: string;
	turn_id?: string;
	usage?: import('../../shared/types/headerMetrics').TokenUsage;
	delta?: import('../../shared/types/headerMetrics').TokenUsage;
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
	network_context?: {
		host?: string;
		protocol?: string;
	};
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
	tool?: string;
	sender_thread_id?: string;
	receiver_thread_id?: string;
	new_thread_id?: string;
	agent_status?: string;
};
export type SubagentStopData = {
	agent_id: string;
	agent_type: string;
	stop_hook_active: boolean;
	agent_transcript_path?: string;
	last_assistant_message?: string;
	description?: string;
	tool?: string;
	status?: string;
	sender_thread_id?: string;
	receiver_thread_id?: string;
	new_thread_id?: string;
	agent_status?: string;
};

export type NotificationData = {
	message: string;
	title?: string;
	notification_type?: string;
};
export type RuntimeErrorData = {
	message: string;
	title?: string;
	thread_id?: string;
	turn_id?: string;
	error_code?: string;
	will_retry?: boolean;
};
export type ThreadStatusData = {
	message: string;
	thread_id?: string;
	status_type?: string;
	active_flags?: string[];
};
export type TurnDiffData = {
	message: string;
	thread_id?: string;
	turn_id?: string;
	diff: string;
};
export type ServerRequestResolvedData = {
	message: string;
	request_id?: string;
	resolved_kind?: string;
};
export type WebSearchData = {
	message: string;
	phase: 'started' | 'completed';
	query?: string;
	action_type?: string;
	url?: string;
	pattern?: string;
	queries?: string[];
	item_id?: string;
};
export type ReviewStatusData = {
	message: string;
	phase: 'started' | 'completed';
	review?: string;
	item_id?: string;
};
export type ImageViewData = {
	message: string;
	path?: string;
	item_id?: string;
};
export type ContextCompactionData = {
	message: string;
	phase: 'started' | 'completed';
	item_id?: string;
};
export type McpProgressData = {
	message: string;
	title?: string;
};
export type TerminalInputData = {
	message: string;
	input_preview?: string;
};
export type SkillsChangedData = {
	message: string;
};
export type SkillsLoadedData = {
	message: string;
	count?: number;
	error_count?: number;
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
	model?: string;
};

// ── Discriminated union ──────────────────────────────────

export type FeedEvent =
	| (FeedEventBase & {kind: 'session.start'; data: SessionStartData})
	| (FeedEventBase & {kind: 'session.end'; data: SessionEndData})
	| (FeedEventBase & {kind: 'run.start'; data: RunStartData})
	| (FeedEventBase & {kind: 'run.end'; data: RunEndData})
	| (FeedEventBase & {kind: 'user.prompt'; data: UserPromptData})
	| (FeedEventBase & {kind: 'plan.update'; data: PlanUpdateData})
	| (FeedEventBase & {kind: 'reasoning.summary'; data: ReasoningSummaryData})
	| (FeedEventBase & {kind: 'usage.update'; data: UsageUpdateData})
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
	| (FeedEventBase & {kind: 'runtime.error'; data: RuntimeErrorData})
	| (FeedEventBase & {kind: 'thread.status'; data: ThreadStatusData})
	| (FeedEventBase & {kind: 'turn.diff'; data: TurnDiffData})
	| (FeedEventBase & {
			kind: 'server.request.resolved';
			data: ServerRequestResolvedData;
	  })
	| (FeedEventBase & {kind: 'web.search'; data: WebSearchData})
	| (FeedEventBase & {kind: 'review.status'; data: ReviewStatusData})
	| (FeedEventBase & {kind: 'image.view'; data: ImageViewData})
	| (FeedEventBase & {kind: 'context.compaction'; data: ContextCompactionData})
	| (FeedEventBase & {kind: 'mcp.progress'; data: McpProgressData})
	| (FeedEventBase & {kind: 'terminal.input'; data: TerminalInputData})
	| (FeedEventBase & {kind: 'skills.changed'; data: SkillsChangedData})
	| (FeedEventBase & {kind: 'skills.loaded'; data: SkillsLoadedData})
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
