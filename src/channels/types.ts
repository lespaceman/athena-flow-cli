/**
 * Channel layer types: harness-independent contract between Athena and
 * external messaging subprocesses (Telegram, Slack, etc.).
 *
 * Two distinct IDs flow through this layer:
 *   - `runtimeEventId`: opaque, harness-issued, accepted by `runtime.sendDecision`.
 *   - `channelRequestId`: 5 chars from [a-km-z], Athena-generated, channel-display only.
 */

export type ChannelCancelReason =
	| 'resolved_locally'
	| 'resolved_by_other_channel'
	| 'auto_resolved'
	| 'timeout';

export type ChannelLogLevel = 'debug' | 'info' | 'warn' | 'error';

// ── Athena → channel methods ─────────────────────────────────────────

export type ChannelInitParams = {
	allowed_user_ids: string[];
	options: Record<string, unknown>;
};

export type ChannelPermissionRequestParams = {
	channel_request_id: string;
	tool_name: string;
	description: string;
	input_preview: string;
};

export type ChannelPermissionCancelParams = {
	channel_request_id: string;
	reason: ChannelCancelReason;
};

export type ChannelQuestionOption = {
	label: string;
	description: string;
};

export type ChannelQuestion = {
	key: string;
	header: string;
	question: string;
	multi_select: boolean;
	options: ChannelQuestionOption[];
};

export type ChannelQuestionRequestParams = {
	channel_request_id: string;
	title: string;
	questions: ChannelQuestion[];
};

export type ChannelQuestionCancelParams = {
	channel_request_id: string;
	reason: ChannelCancelReason;
};

export type ChannelNotificationParams = {
	content: string;
	meta: Record<string, string>;
};

export type ChannelShutdownParams = Record<string, never>;

export const CHANNEL_BROADCAST_SESSION_ID = '*';

export type ChannelMethodMessage =
	| {session_id: string; method: 'init'; params: ChannelInitParams}
	| {
			session_id: string;
			method: 'permission.request';
			params: ChannelPermissionRequestParams;
	  }
	| {
			session_id: string;
			method: 'permission.cancel';
			params: ChannelPermissionCancelParams;
	  }
	| {
			session_id: string;
			method: 'question.request';
			params: ChannelQuestionRequestParams;
	  }
	| {
			session_id: string;
			method: 'question.cancel';
			params: ChannelQuestionCancelParams;
	  }
	| {
			session_id: string;
			method: 'notification';
			params: ChannelNotificationParams;
	  }
	| {session_id: string; method: 'shutdown'; params: ChannelShutdownParams};

// ── Channel → Athena events ──────────────────────────────────────────

export type ChannelReadyParams = {
	name: string;
	version: string;
};

export type ChannelPermissionVerdictParams = {
	channel_request_id: string;
	behavior: 'allow' | 'deny';
};

export type ChannelQuestionAnswerParams = {
	channel_request_id: string;
	answers: Record<string, string>;
};

export type ChannelChatMessageParams = {
	content: string;
	meta: Record<string, string>;
};

export type ChannelErrorParams = {
	message: string;
	fatal?: boolean;
};

export type ChannelLogParams = {
	level: ChannelLogLevel;
	message: string;
};

export type ChannelEventMessage =
	| {session_id: string; event: 'ready'; params: ChannelReadyParams}
	| {
			session_id: string;
			event: 'permission.verdict';
			params: ChannelPermissionVerdictParams;
	  }
	| {
			session_id: string;
			event: 'question.answer';
			params: ChannelQuestionAnswerParams;
	  }
	| {
			session_id: string;
			event: 'chat.message';
			params: ChannelChatMessageParams;
	  }
	| {session_id: string; event: 'error'; params: ChannelErrorParams}
	| {session_id: string; event: 'log'; params: ChannelLogParams};

// ── Host-side state ──────────────────────────────────────────────────

export type ChannelDefinition = {
	name: string;
	/** Absolute path to the channel entry script (Node-runnable). */
	entryPath: string;
	/** Absolute path to the channel daemon entry script (Node-runnable). */
	daemonEntryPath?: string;
	/** Extra args appended after entryPath (defaults to []). */
	args?: string[];
	/** Channel-supplied options forwarded in `init`. */
	options?: Record<string, unknown>;
	/** Sender allowlist forwarded in `init`. */
	allowedUserIds: string[];
};

export type PendingRelay = {
	runtimeEventId: string;
	channelRequestId: string;
	toolName: string;
	createdAt: number;
};

export type PendingQuestionRelay = {
	runtimeEventId: string;
	channelRequestId: string;
	questionKeys: string[];
	title: string;
	createdAt: number;
};

/**
 * Distinct paths that can claim a pending permission. `'user'` is
 * intentionally absent: when a runtime emits a `decision.source === 'user'`
 * event it always corresponds to a prior `tryClaim('local', ...)` from the
 * UI, so the relay collapses that case onto `'local'`.
 */
export type ClaimSource = 'local' | 'channel' | 'rule' | 'timeout';

export type ClaimBehavior = 'allow' | 'deny';

export type QuestionClaimSource = 'local' | 'channel' | 'timeout';
