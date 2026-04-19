import type {
	RuntimeEventDataMap,
	RuntimeEventKind,
} from '../../../core/runtime/events';
import type {
	JsonRpcNotification,
	JsonRpcServerRequest,
} from '../protocol/jsonrpc';
import type {
	CodexAccountLoginCompletedNotification,
	CodexAccountRateLimitsUpdatedNotification,
	CodexAccountUpdatedNotification,
	CodexApplyPatchApprovalParams,
	CodexAgentMessageDeltaNotification,
	CodexAppListUpdatedNotification,
	CodexCommandExecOutputDeltaNotification,
	CodexCommandExecutionRequestApprovalParams,
	CodexConfigWarningNotification,
	CodexContextCompactedNotification,
	CodexDeprecationNoticeNotification,
	CodexErrorNotification,
	CodexExecCommandApprovalParams,
	CodexFileChangeOutputDeltaNotification,
	CodexFsChangedNotification,
	CodexFuzzyFileSearchSessionCompletedNotification,
	CodexFuzzyFileSearchSessionUpdatedNotification,
	CodexFileChangeRequestApprovalParams,
	CodexHookStartedNotification,
	CodexHookCompletedNotification,
	CodexItemCompletedNotification,
	CodexItemGuardianApprovalReviewStartedNotification,
	CodexItemGuardianApprovalReviewCompletedNotification,
	CodexItemStartedNotification,
	CodexMcpServerOauthLoginCompletedNotification,
	CodexMcpServerElicitationRequestParams,
	CodexMcpServerStatusUpdatedNotification,
	CodexMcpToolCallProgressNotification,
	CodexModelReroutedNotification,
	CodexPlanDeltaNotification,
	CodexPermissionsRequestApprovalParams,
	CodexRawResponseItemCompletedNotification,
	CodexReasoningSummaryPartAddedNotification,
	CodexReasoningSummaryTextDeltaNotification,
	CodexReasoningTextDeltaNotification,
	CodexServerRequestResolvedNotification,
	CodexTerminalInteractionNotification,
	CodexThreadArchivedNotification,
	CodexThreadClosedNotification,
	CodexThreadNameUpdatedNotification,
	CodexThreadRealtimeClosedNotification,
	CodexThreadRealtimeErrorNotification,
	CodexThreadRealtimeItemAddedNotification,
	CodexThreadRealtimeOutputAudioDeltaNotification,
	CodexThreadRealtimeSdpNotification,
	CodexThreadRealtimeStartedNotification,
	CodexThreadRealtimeTranscriptDeltaNotification,
	CodexThreadRealtimeTranscriptDoneNotification,
	CodexThreadStatusChangedNotification,
	CodexThreadTokenUsageUpdatedNotification,
	CodexThreadUnarchivedNotification,
	CodexToolRequestUserInputParams,
	CodexTurnCompletedNotification,
	CodexTurnDiffUpdatedNotification,
	CodexTurnPlanUpdatedNotification,
	CodexTurnStartedNotification,
	CodexWindowsSandboxSetupCompletedNotification,
	CodexWindowsWorldWritableWarningNotification,
} from '../protocol';
import {getCodexUsageDelta, getCodexUsageTotals} from './tokenUsage';
import * as M from '../protocol/methods';

/**
 * Discriminated per-kind shape: `data` is statically tied to `kind` via the
 * `RuntimeEventDataMap`. Each branch of `translateNotification()` and
 * `translateServerRequest()` must emit a `data` object that matches the
 * runtime contract for the declared `kind`; mismatches fail to typecheck.
 */
export type CodexTranslatedEvent = {
	[K in RuntimeEventKind]: {
		kind: K;
		data: RuntimeEventDataMap[K];
		toolName?: string;
		toolUseId?: string;
		expectsDecision: boolean;
	};
}[RuntimeEventKind];

export function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === 'object' && v !== null
		? (v as Record<string, unknown>)
		: {};
}

function resolveToolName(
	itemType: string,
	item: Record<string, unknown>,
): string {
	switch (itemType) {
		case 'commandExecution':
			return 'Bash';
		case 'fileChange':
			return 'Edit';
		case 'webSearch':
			return 'WebSearch';
		case 'mcpToolCall': {
			const server = String(item['server'] ?? 'unknown');
			const tool = String(item['tool'] ?? 'unknown');
			return `mcp__${server}__${tool}`;
		}
		case 'dynamicToolCall':
			return String(item['tool'] ?? 'DynamicTool');
		default:
			return itemType;
	}
}

function resolveToolInput(
	itemType: string,
	item: Record<string, unknown>,
): Record<string, unknown> {
	switch (itemType) {
		case 'commandExecution':
			return {command: item['command'], cwd: item['cwd']};
		case 'fileChange':
			return {changes: item['changes']};
		case 'webSearch':
			return {query: item['query']};
		case 'mcpToolCall':
			return asRecord(item['arguments']);
		case 'dynamicToolCall':
			return asRecord(item['arguments']);
		default:
			return item;
	}
}

function summarizeRateLimits(
	params: CodexAccountRateLimitsUpdatedNotification,
): string {
	const snapshot = params.rateLimits;
	const name = snapshot.limitName ?? snapshot.limitId ?? 'current account';
	const primary = snapshot.primary;
	if (!primary) {
		return `Rate limits updated for ${name}.`;
	}

	const usedPercent =
		typeof primary.usedPercent === 'number' ? primary.usedPercent : null;
	const windowDuration =
		typeof primary.windowDurationMins === 'number'
			? primary.windowDurationMins
			: null;
	if (usedPercent !== null) {
		const rounded = Math.round(usedPercent);
		return windowDuration !== null
			? `${name}: ${rounded}% used (${windowDuration}m window).`
			: `${name}: ${rounded}% used.`;
	}

	return `Rate limits updated for ${name}.`;
}

function summarizeThreadStatus(
	status: CodexThreadStatusChangedNotification['status'],
): string {
	if (status.type === 'active') {
		if (status.activeFlags.includes('waitingOnApproval')) {
			return 'Waiting for approval.';
		}
		if (status.activeFlags.length > 0) {
			return `Active: ${status.activeFlags.join(', ')}.`;
		}
		return 'Active.';
	}

	if (status.type === 'idle') {
		return 'Idle.';
	}

	return `${status.type}.`;
}

function describeItemTitle(
	itemType: string,
	phase: 'started' | 'completed',
): string {
	switch (itemType) {
		case 'agentMessage':
			return 'Assistant response';
		case 'hookPrompt':
			return phase === 'started' ? 'Hook prompt' : 'Hook prompt complete';
		case 'imageView':
			return 'Image viewed';
		case 'imageGeneration':
			return phase === 'started' ? 'Generating image' : 'Image generated';
		case 'enteredReviewMode':
			return 'Review started';
		case 'exitedReviewMode':
			return 'Review finished';
		case 'contextCompaction':
			return 'Context compaction';
		default:
			return `${itemType} ${phase}`;
	}
}

function describeItemMessage(
	itemType: string,
	item: Record<string, unknown>,
	phase: 'started' | 'completed',
): string {
	switch (itemType) {
		case 'agentMessage':
			return phase === 'started'
				? 'Assistant is responding.'
				: 'Assistant response finished.';
		case 'imageView':
			return `Viewed image at ${String(item['path'] ?? 'unknown path')}.`;
		case 'imageGeneration': {
			const status =
				typeof item['status'] === 'string' ? item['status'] : phase;
			const prompt = previewText(
				typeof item['revisedPrompt'] === 'string'
					? item['revisedPrompt']
					: undefined,
				80,
			);
			return prompt
				? `Image generation ${status}: ${prompt}`
				: `Image generation ${status}.`;
		}
		case 'enteredReviewMode':
			return `Review started: ${previewText(String(item['review'] ?? ''), 120) || 'current changes'}.`;
		case 'exitedReviewMode':
			return `Review finished: ${previewText(String(item['review'] ?? ''), 200) || '(no notes)'}`;
		case 'contextCompaction':
			return 'Codex compacted conversation history.';
		case 'hookPrompt': {
			const fragments = Array.isArray(item['fragments'])
				? item['fragments'].length
				: 0;
			return `Hook prompt ${phase} (${fragments} fragment${fragments === 1 ? '' : 's'}).`;
		}
		default:
			return `${itemType} ${phase}.`;
	}
}

function previewText(value: string | null | undefined, max = 80): string {
	if (!value) return '';
	const normalized = value.replace(/\s+/g, ' ').trim();
	if (!normalized) return '';
	return normalized.length <= max
		? normalized
		: `${normalized.slice(0, max - 1)}…`;
}

function permissionRequestEvent(
	toolName: string,
	toolInput: Record<string, unknown>,
	extra?: {toolUseId?: string; networkContext?: Record<string, unknown>},
): CodexTranslatedEvent {
	return {
		kind: 'permission.request',
		data: {
			tool_name: toolName,
			tool_input: toolInput,
			...(extra?.toolUseId ? {tool_use_id: extra.toolUseId} : {}),
			...(extra?.networkContext ? {network_context: extra.networkContext} : {}),
		},
		toolName,
		toolUseId: extra?.toolUseId,
		expectsDecision: true,
	};
}

function extractMcpToolNameFromMessage(message: string): string | null {
	const quotedToolMatch =
		/(?:run|use)(?: the)? tool ["']([^"']+)["']/i.exec(message) ??
		/tool ["']([^"']+)["']/i.exec(message);
	return quotedToolMatch?.[1] ?? null;
}

function resolveMcpElicitationToolName(
	params: CodexMcpServerElicitationRequestParams,
): string {
	const meta = asRecord(params._meta);
	if (meta['codex_approval_kind'] === 'mcp_tool_call') {
		const toolName = extractMcpToolNameFromMessage(params.message);
		if (toolName) {
			return `mcp__${params.serverName}__${toolName}`;
		}
	}

	return `mcp__${params.serverName}__elicitation`;
}

export function translateNotification(
	msg: JsonRpcNotification,
): CodexTranslatedEvent {
	switch (msg.method) {
		case M.THREAD_STARTED: {
			return {
				kind: 'session.start',
				data: {
					source: 'codex',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_ARCHIVED: {
			const params = msg.params as CodexThreadArchivedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Thread archived',
					message: `Thread ${params.threadId} archived.`,
					notification_type: 'thread.archived',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_UNARCHIVED: {
			const params = msg.params as CodexThreadUnarchivedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Thread unarchived',
					message: `Thread ${params.threadId} restored from archive.`,
					notification_type: 'thread.unarchived',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_CLOSED: {
			const params = msg.params as CodexThreadClosedNotification;
			return {
				kind: 'session.end',
				data: {
					reason: `thread closed (${params.threadId})`,
				},
				expectsDecision: false,
			};
		}

		case M.SKILLS_CHANGED: {
			return {
				kind: 'notification',
				data: {
					title: 'Skills changed',
					message:
						'Workflow skill files changed. Refresh or start a new Codex thread to pick up updated skill instructions.',
					notification_type: 'skills.changed',
				},
				expectsDecision: false,
			};
		}

		case M.TURN_STARTED: {
			const params = msg.params as CodexTurnStartedNotification;
			return {
				kind: 'turn.start',
				data: {
					thread_id: params.threadId,
					turn_id: params.turn.id,
					status: params.turn.status,
				},
				expectsDecision: false,
			};
		}

		case M.TURN_COMPLETED: {
			const params = msg.params as CodexTurnCompletedNotification;
			return {
				kind: 'turn.complete',
				data: {
					thread_id: params.threadId,
					turn_id: params.turn.id,
					status: params.turn.status,
				},
				expectsDecision: false,
			};
		}

		case M.TURN_PLAN_UPDATED: {
			const params = msg.params as CodexTurnPlanUpdatedNotification;
			return {
				kind: 'plan.delta',
				data: {
					thread_id: params.threadId,
					turn_id: params.turnId,
					explanation: params.explanation,
					plan: params.plan,
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_PLAN_DELTA: {
			const params = msg.params as CodexPlanDeltaNotification;
			return {
				kind: 'plan.delta',
				data: {
					thread_id: params.threadId,
					turn_id: params.turnId,
					item_id: params.itemId,
					delta: params.delta,
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_AGENT_MESSAGE_DELTA: {
			const params = msg.params as CodexAgentMessageDeltaNotification;
			return {
				kind: 'message.delta',
				data: {
					thread_id: params.threadId,
					turn_id: params.turnId,
					item_id: params.itemId,
					delta: params.delta,
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_COMMAND_EXECUTION_OUTPUT_DELTA: {
			const params = asRecord(msg.params);
			return {
				kind: 'tool.delta',
				data: {
					thread_id:
						typeof params['threadId'] === 'string'
							? params['threadId']
							: undefined,
					turn_id:
						typeof params['turnId'] === 'string' ? params['turnId'] : undefined,
					tool_name: 'Bash',
					tool_input: {},
					tool_use_id:
						typeof params['itemId'] === 'string' ? params['itemId'] : undefined,
					delta:
						typeof params['delta'] === 'string' ? params['delta'] : undefined,
				},
				toolName: 'Bash',
				toolUseId:
					typeof params['itemId'] === 'string' ? params['itemId'] : undefined,
				expectsDecision: false,
			};
		}

		case M.ITEM_COMMAND_EXECUTION_TERMINAL_INTERACTION: {
			const params = msg.params as CodexTerminalInteractionNotification;
			const stdinPreview = previewText(params.stdin, 60);
			return {
				kind: 'notification',
				data: {
					title: 'Terminal input',
					message: stdinPreview
						? `Sent terminal input to interactive Bash session: ${stdinPreview}`
						: 'Sent terminal input to interactive Bash session.',
					notification_type: 'command_execution.terminal_interaction',
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_FILE_CHANGE_OUTPUT_DELTA: {
			const params = msg.params as CodexFileChangeOutputDeltaNotification;
			return {
				kind: 'tool.delta',
				data: {
					thread_id: params.threadId,
					turn_id: params.turnId,
					tool_name: 'Edit',
					tool_input: {},
					tool_use_id: params.itemId,
					delta: params.delta,
				},
				toolName: 'Edit',
				toolUseId: params.itemId,
				expectsDecision: false,
			};
		}

		case M.ITEM_MCP_TOOL_CALL_PROGRESS: {
			const params = msg.params as CodexMcpToolCallProgressNotification;
			return {
				kind: 'notification',
				data: {
					title: 'MCP progress',
					message: params.message,
					notification_type: 'mcp_tool_call.progress',
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_REASONING_TEXT_DELTA: {
			const params = msg.params as CodexReasoningTextDeltaNotification;
			return {
				kind: 'reasoning.delta',
				data: {
					thread_id: params.threadId,
					turn_id: params.turnId,
					item_id: params.itemId,
					delta: params.delta,
					content_index: params.contentIndex,
					phase: 'text',
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_REASONING_SUMMARY_TEXT_DELTA: {
			const params = msg.params as CodexReasoningSummaryTextDeltaNotification;
			return {
				kind: 'reasoning.delta',
				data: {
					thread_id: params.threadId,
					turn_id: params.turnId,
					item_id: params.itemId,
					delta: params.delta,
					content_index: params.summaryIndex,
					phase: 'summary',
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_REASONING_SUMMARY_PART_ADDED: {
			const params = msg.params as CodexReasoningSummaryPartAddedNotification;
			return {
				kind: 'reasoning.delta',
				data: {
					thread_id: params.threadId,
					turn_id: params.turnId,
					item_id: params.itemId,
					summary_index: params.summaryIndex,
					phase: 'summary',
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_STARTED: {
			const params = msg.params as CodexItemStartedNotification;
			const item = asRecord(params.item);
			const itemType = item['type'] as string;

			if (itemType === 'collabAgentToolCall') {
				return translateCollabStarted(item);
			}

			const toolName = resolveToolName(itemType, item);
			if (
				itemType === 'commandExecution' ||
				itemType === 'fileChange' ||
				itemType === 'mcpToolCall' ||
				itemType === 'webSearch' ||
				itemType === 'dynamicToolCall'
			) {
				return {
					kind: 'tool.pre',
					data: {
						tool_name: toolName,
						tool_input: resolveToolInput(itemType, item),
						tool_use_id: item['id'] as string | undefined,
					},
					toolName,
					toolUseId: item['id'] as string | undefined,
					expectsDecision: false,
				};
			}
			return {
				kind: 'notification',
				data: {
					title: describeItemTitle(itemType, 'started'),
					message: describeItemMessage(itemType, item, 'started'),
					notification_type: `item.${itemType}.started`,
					item_type: itemType,
					item_id: typeof item['id'] === 'string' ? item['id'] : undefined,
					item,
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_COMPLETED: {
			const params = msg.params as CodexItemCompletedNotification;
			const item = asRecord(params.item);
			const itemType = item['type'] as string;

			if (itemType === 'collabAgentToolCall') {
				return translateCollabCompleted(item);
			}

			if (itemType === 'agentMessage') {
				return {
					kind: 'message.complete',
					data: {
						thread_id: params.threadId,
						turn_id: params.turnId,
						item_id: item['id'] as string | undefined,
						message: item['text'] as string | undefined,
						phase:
							typeof item['phase'] === 'string' || item['phase'] === null
								? (item['phase'] as string | null)
								: undefined,
					},
					expectsDecision: false,
				};
			}

			const toolName = resolveToolName(itemType, item);
			if (
				itemType === 'commandExecution' ||
				itemType === 'fileChange' ||
				itemType === 'mcpToolCall' ||
				itemType === 'webSearch' ||
				itemType === 'dynamicToolCall'
			) {
				const itemStatus = item['status'] as string;
				if (itemStatus === 'failed' || itemStatus === 'cancelled') {
					return resolveToolFailure(itemType, toolName, item);
				}
				return {
					kind: 'tool.post',
					data: {
						tool_name: toolName,
						tool_input: resolveToolInput(itemType, item),
						tool_use_id: item['id'] as string | undefined,
						tool_response:
							item['aggregatedOutput'] ??
							item['action'] ??
							item['result'] ??
							item['changes'] ??
							item['contentItems'],
					},
					toolName,
					toolUseId: item['id'] as string | undefined,
					expectsDecision: false,
				};
			}
			return {
				kind: 'notification',
				data: {
					title: describeItemTitle(itemType, 'completed'),
					message: describeItemMessage(itemType, item, 'completed'),
					notification_type: `item.${itemType}.completed`,
					item_type: itemType,
					item_id: typeof item['id'] === 'string' ? item['id'] : undefined,
					item,
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_TOKEN_USAGE_UPDATED: {
			const params = msg.params as CodexThreadTokenUsageUpdatedNotification;
			return {
				kind: 'usage.update',
				data: {
					thread_id: params.threadId,
					turn_id: params.turnId,
					usage: getCodexUsageTotals(params.tokenUsage),
					delta: getCodexUsageDelta(params.tokenUsage),
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_NAME_UPDATED: {
			const params = msg.params as CodexThreadNameUpdatedNotification;
			return {
				kind: 'notification',
				data: {
					message: `Thread renamed: ${params.threadName ?? params.threadId}`,
					notification_type: 'thread_name',
				},
				expectsDecision: false,
			};
		}

		case M.CONFIG_WARNING: {
			const params = msg.params as CodexConfigWarningNotification;
			const pathSuffix = params.path ? ` (${params.path})` : '';
			const details = previewText(params.details ?? undefined, 120);
			return {
				kind: 'notification',
				data: {
					title: `Config warning${pathSuffix}`,
					message: details ? `${params.summary} ${details}` : params.summary,
					notification_type: 'config.warning',
				},
				expectsDecision: false,
			};
		}

		case M.MCP_SERVER_STARTUP_STATUS_UPDATED: {
			const params = msg.params as CodexMcpServerStatusUpdatedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'MCP server status',
					message: params.error
						? `${params.name}: ${params.status} (${params.error})`
						: `${params.name}: ${params.status}.`,
					notification_type: 'mcp_server.startup_status',
				},
				expectsDecision: false,
			};
		}

		case M.MCP_SERVER_OAUTH_LOGIN_COMPLETED: {
			const params =
				msg.params as CodexMcpServerOauthLoginCompletedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'MCP login',
					message: params.success
						? `MCP server ${params.name} login completed.`
						: `MCP server ${params.name} login failed${params.error ? `: ${params.error}` : '.'}`,
					notification_type: 'mcp_server.oauth_login_completed',
				},
				expectsDecision: false,
			};
		}

		case M.ACCOUNT_RATE_LIMITS_UPDATED: {
			const params = msg.params as CodexAccountRateLimitsUpdatedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Rate limits updated',
					message: summarizeRateLimits(params),
					notification_type: 'account.rate_limits_updated',
				},
				expectsDecision: false,
			};
		}

		case M.ACCOUNT_LOGIN_COMPLETED: {
			const params = msg.params as CodexAccountLoginCompletedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Account login',
					message: params.success
						? `Account login completed${params.loginId ? ` (${params.loginId})` : '.'}`
						: `Account login failed${params.error ? `: ${params.error}` : '.'}`,
					notification_type: 'account.login_completed',
				},
				expectsDecision: false,
			};
		}

		case M.APP_LIST_UPDATED: {
			const params = msg.params as CodexAppListUpdatedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Apps updated',
					message: `App list updated (${params.data.length} apps available).`,
					notification_type: 'app.list_updated',
				},
				expectsDecision: false,
			};
		}

		case M.MODEL_REROUTED: {
			const params = msg.params as CodexModelReroutedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Model rerouted',
					message: `Turn rerouted from ${params.fromModel} to ${params.toModel} (${params.reason}).`,
					notification_type: 'model.rerouted',
				},
				expectsDecision: false,
			};
		}

		case M.DEPRECATION_NOTICE: {
			const params = msg.params as CodexDeprecationNoticeNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Deprecation notice',
					message: params.details
						? `${params.summary} ${previewText(params.details, 120)}`
						: params.summary,
					notification_type: 'deprecation.notice',
				},
				expectsDecision: false,
			};
		}

		case M.FUZZY_FILE_SEARCH_SESSION_UPDATED: {
			const params =
				msg.params as CodexFuzzyFileSearchSessionUpdatedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'File search updated',
					message: `Fuzzy file search "${params.query}" now has ${params.files.length} matches.`,
					notification_type: 'fuzzy_file_search.updated',
				},
				expectsDecision: false,
			};
		}

		case M.FUZZY_FILE_SEARCH_SESSION_COMPLETED: {
			const params =
				msg.params as CodexFuzzyFileSearchSessionCompletedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'File search completed',
					message: `Fuzzy file search session ${params.sessionId} completed.`,
					notification_type: 'fuzzy_file_search.completed',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_REALTIME_STARTED: {
			const params = msg.params as CodexThreadRealtimeStartedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Realtime started',
					message: `Realtime started for thread ${params.threadId}.`,
					notification_type: 'thread.realtime.started',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_REALTIME_ITEM_ADDED: {
			const params = msg.params as CodexThreadRealtimeItemAddedNotification;
			const item = asRecord(params.item);
			const itemType = typeof item['type'] === 'string' ? item['type'] : 'item';
			return {
				kind: 'notification',
				data: {
					title: 'Realtime item',
					message: `Realtime emitted ${itemType} for thread ${params.threadId}.`,
					notification_type: 'thread.realtime.item_added',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_REALTIME_TRANSCRIPT_DELTA: {
			const params =
				msg.params as CodexThreadRealtimeTranscriptDeltaNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Realtime transcript',
					message: `${params.role}: ${previewText(params.delta, 100)}`,
					notification_type: 'thread.realtime.transcript_delta',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_REALTIME_TRANSCRIPT_DONE: {
			const params =
				msg.params as CodexThreadRealtimeTranscriptDoneNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Realtime transcript',
					message: `${params.role}: ${previewText(params.text, 100)}`,
					notification_type: 'thread.realtime.transcript_done',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_REALTIME_ERROR: {
			const params = msg.params as CodexThreadRealtimeErrorNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Realtime error',
					message: params.message,
					notification_type: 'thread.realtime.error',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_REALTIME_CLOSED: {
			const params = msg.params as CodexThreadRealtimeClosedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Realtime closed',
					message: params.reason
						? `Realtime closed: ${params.reason}`
						: 'Realtime transport closed.',
					notification_type: 'thread.realtime.closed',
				},
				expectsDecision: false,
			};
		}

		case M.WINDOWS_WORLD_WRITABLE_WARNING: {
			const params = msg.params as CodexWindowsWorldWritableWarningNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Windows sandbox warning',
					message: `World-writable directories detected (${params.samplePaths.length} samples${params.extraCount > 0 ? `, ${params.extraCount} more` : ''}).`,
					notification_type: 'windows.world_writable_warning',
				},
				expectsDecision: false,
			};
		}

		case M.WINDOWS_SANDBOX_SETUP_COMPLETED: {
			const params =
				msg.params as CodexWindowsSandboxSetupCompletedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Windows sandbox setup',
					message: params.success
						? `Windows sandbox setup completed for ${params.mode}.`
						: `Windows sandbox setup failed for ${params.mode}${params.error ? `: ${params.error}` : '.'}`,
					notification_type: 'windows_sandbox.setup_completed',
				},
				expectsDecision: false,
			};
		}

		case M.ERROR: {
			const params = msg.params as CodexErrorNotification;
			const info = params.error.codexErrorInfo;
			const code =
				info && typeof info === 'object'
					? ((info as Record<string, unknown>)['type'] ?? null)
					: info;
			const details = params.error.additionalDetails
				? ` ${previewText(params.error.additionalDetails, 200)}`
				: '';
			return {
				kind: 'notification',
				data: {
					title: params.willRetry ? 'Codex error (retrying)' : 'Codex error',
					message: `${params.error.message}${details}`,
					notification_type: 'codex.error',
					thread_id: params.threadId,
					turn_id: params.turnId,
					error_code: typeof code === 'string' ? code : undefined,
					will_retry: params.willRetry,
				},
				expectsDecision: false,
			};
		}

		case M.WARNING: {
			const params = asRecord(msg.params);
			const message =
				typeof params['message'] === 'string'
					? params['message']
					: 'Codex runtime warning.';
			return {
				kind: 'notification',
				data: {
					title: 'Codex warning',
					message,
					notification_type: 'codex.warning',
					thread_id:
						typeof params['threadId'] === 'string'
							? params['threadId']
							: undefined,
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_STATUS_CHANGED: {
			const params = msg.params as CodexThreadStatusChangedNotification;
			const status = params.status;
			return {
				kind: 'notification',
				data: {
					title: 'Thread status',
					message: summarizeThreadStatus(status),
					notification_type: 'thread.status_changed',
					thread_id: params.threadId,
					status_type: status.type,
					active_flags:
						status.type === 'active' ? status.activeFlags : undefined,
				},
				expectsDecision: false,
			};
		}

		case M.TURN_DIFF_UPDATED: {
			const params = msg.params as CodexTurnDiffUpdatedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Turn diff updated',
					message: `Draft diff updated (${params.diff.length} bytes).`,
					notification_type: 'turn.diff_updated',
					thread_id: params.threadId,
					turn_id: params.turnId,
					diff: params.diff,
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_COMPACTED: {
			const params = msg.params as CodexContextCompactedNotification;
			return {
				kind: 'compact.pre',
				data: {
					trigger: 'auto',
					thread_id: params.threadId,
					turn_id: params.turnId,
				},
				expectsDecision: false,
			};
		}

		case M.HOOK_STARTED: {
			const params = msg.params as CodexHookStartedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Hook started',
					message: `Hook ${params.run.eventName} (${params.run.handlerType}) started.`,
					notification_type: 'hook.started',
					thread_id: params.threadId,
					turn_id: params.turnId ?? undefined,
					hook_id: params.run.id,
					hook_event: params.run.eventName,
				},
				expectsDecision: false,
			};
		}

		case M.HOOK_COMPLETED: {
			const params = msg.params as CodexHookCompletedNotification;
			const duration =
				params.run.durationMs !== null ? ` in ${params.run.durationMs}ms` : '';
			return {
				kind: 'notification',
				data: {
					title: 'Hook completed',
					message: `Hook ${params.run.eventName} ${params.run.status}${duration}.`,
					notification_type: 'hook.completed',
					thread_id: params.threadId,
					turn_id: params.turnId ?? undefined,
					hook_id: params.run.id,
					hook_event: params.run.eventName,
					hook_status: params.run.status,
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_AUTO_APPROVAL_REVIEW_STARTED: {
			const params =
				msg.params as CodexItemGuardianApprovalReviewStartedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Auto-approval review started',
					message: `Guardian review ${params.reviewId} started.`,
					notification_type: 'auto_approval_review.started',
					thread_id: params.threadId,
					turn_id: params.turnId,
					review_id: params.reviewId,
					target_item_id: params.targetItemId ?? undefined,
					action: params.action,
					review: params.review,
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_AUTO_APPROVAL_REVIEW_COMPLETED: {
			const params =
				msg.params as CodexItemGuardianApprovalReviewCompletedNotification;
			const status = (params.review as {status?: string}).status ?? 'done';
			return {
				kind: 'notification',
				data: {
					title: 'Auto-approval review completed',
					message: `Guardian review ${params.reviewId} ${status}.`,
					notification_type: 'auto_approval_review.completed',
					thread_id: params.threadId,
					turn_id: params.turnId,
					review_id: params.reviewId,
					target_item_id: params.targetItemId ?? undefined,
					decision_source: params.decisionSource,
					action: params.action,
					review: params.review,
				},
				expectsDecision: false,
			};
		}

		case M.RAW_RESPONSE_ITEM_COMPLETED: {
			const params = msg.params as CodexRawResponseItemCompletedNotification;
			const rawItem = asRecord(params.item);
			const itemType =
				typeof rawItem['type'] === 'string' ? rawItem['type'] : 'unknown';
			return {
				kind: 'notification',
				data: {
					title: 'Raw response item',
					message: `Raw response item (${itemType}) completed.`,
					notification_type: 'raw_response_item.completed',
					thread_id: params.threadId,
					turn_id: params.turnId,
					item: params.item,
				},
				expectsDecision: false,
			};
		}

		case M.SERVER_REQUEST_RESOLVED: {
			const params = msg.params as CodexServerRequestResolvedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Server request resolved',
					message: `Request #${String(params.requestId)} resolved.`,
					notification_type: 'server_request.resolved',
					thread_id: params.threadId,
					request_id: params.requestId,
				},
				expectsDecision: false,
			};
		}

		case M.COMMAND_EXEC_OUTPUT_DELTA: {
			const params = msg.params as CodexCommandExecOutputDeltaNotification;
			return {
				kind: 'notification',
				data: {
					title: 'command/exec output',
					message: `command/exec ${params.processId} emitted ${params.stream} chunk${params.capReached ? ' (cap reached)' : ''}.`,
					notification_type: 'command_exec.output_delta',
					process_id: params.processId,
					stream: params.stream,
					delta_base64: params.deltaBase64,
					cap_reached: params.capReached,
				},
				expectsDecision: false,
			};
		}

		case M.ACCOUNT_UPDATED: {
			const params = msg.params as CodexAccountUpdatedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Account updated',
					message: `Account auth=${params.authMode ?? 'none'} plan=${params.planType ?? 'none'}.`,
					notification_type: 'account.updated',
					auth_mode: params.authMode ?? undefined,
					plan_type: params.planType ?? undefined,
				},
				expectsDecision: false,
			};
		}

		case M.FS_CHANGED: {
			const params = msg.params as CodexFsChangedNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Filesystem changed',
					message: `Watch ${params.watchId} saw ${params.changedPaths.length} path change(s).`,
					notification_type: 'fs.changed',
					watch_id: params.watchId,
					changed_paths: params.changedPaths,
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_REALTIME_OUTPUT_AUDIO_DELTA: {
			const params =
				msg.params as CodexThreadRealtimeOutputAudioDeltaNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Realtime audio',
					message: `Realtime output audio chunk (${params.audio.samplesPerChannel} samples).`,
					notification_type: 'thread.realtime.output_audio_delta',
					thread_id: params.threadId,
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_REALTIME_SDP: {
			const params = msg.params as CodexThreadRealtimeSdpNotification;
			return {
				kind: 'notification',
				data: {
					title: 'Realtime SDP',
					message: `Realtime WebRTC SDP answer received (${params.sdp.length} bytes).`,
					notification_type: 'thread.realtime.sdp',
					thread_id: params.threadId,
					sdp: params.sdp,
				},
				expectsDecision: false,
			};
		}

		default:
			return {
				kind: 'unknown',
				data: {source_event_name: msg.method, payload: msg.params},
				expectsDecision: false,
			};
	}
}

/**
 * Extract the first agent ID from the agentsStates map on a
 * collabAgentToolCall item.
 */
function resolveCollabAgentId(item: Record<string, unknown>): string {
	const states = asRecord(item['agentsStates']);
	const keys = Object.keys(states);
	return keys[0] ?? 'unknown';
}

function translateCollabStarted(
	item: Record<string, unknown>,
): CodexTranslatedEvent {
	const agentId = resolveCollabAgentId(item);
	const tool = typeof item['tool'] === 'string' ? item['tool'] : 'spawnAgent';
	const prompt =
		typeof item['prompt'] === 'string' ? (item['prompt'] as string) : undefined;
	const state = asRecord(asRecord(item['agentsStates'])[agentId]);
	return {
		kind: 'subagent.start',
		data: {
			agent_id: agentId,
			agent_type: 'codex',
			tool,
			prompt,
			sender_thread_id:
				typeof item['senderThreadId'] === 'string'
					? (item['senderThreadId'] as string)
					: undefined,
			receiver_thread_id:
				typeof item['receiverThreadId'] === 'string'
					? (item['receiverThreadId'] as string)
					: undefined,
			new_thread_id:
				typeof item['newThreadId'] === 'string'
					? (item['newThreadId'] as string)
					: undefined,
			agent_status:
				typeof state['status'] === 'string'
					? (state['status'] as string)
					: undefined,
		},
		expectsDecision: false,
	};
}

function translateCollabCompleted(
	item: Record<string, unknown>,
): CodexTranslatedEvent {
	const agentId = resolveCollabAgentId(item);
	const tool = typeof item['tool'] === 'string' ? item['tool'] : 'spawnAgent';
	const status =
		typeof item['status'] === 'string' ? item['status'] : 'completed';
	const prompt =
		typeof item['prompt'] === 'string' ? (item['prompt'] as string) : undefined;
	const state = asRecord(asRecord(item['agentsStates'])[agentId]);
	return {
		kind: 'subagent.stop',
		data: {
			agent_id: agentId,
			agent_type: 'codex',
			tool,
			status,
			prompt,
			sender_thread_id:
				typeof item['senderThreadId'] === 'string'
					? (item['senderThreadId'] as string)
					: undefined,
			receiver_thread_id:
				typeof item['receiverThreadId'] === 'string'
					? (item['receiverThreadId'] as string)
					: undefined,
			new_thread_id:
				typeof item['newThreadId'] === 'string'
					? (item['newThreadId'] as string)
					: undefined,
			agent_status:
				typeof state['status'] === 'string'
					? (state['status'] as string)
					: undefined,
		},
		expectsDecision: false,
	};
}

/**
 * Try to extract an error message from MCP-style result content.
 * MCP tool calls may return error text inside `result.content` items
 * when the `error` field on the item is null.
 */
function extractResultContentError(
	item: Record<string, unknown>,
): string | undefined {
	const result = asRecord(item['result']);
	const content = result['content'];
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const entry of content) {
		const rec = asRecord(entry);
		if (rec['type'] === 'text' && typeof rec['text'] === 'string') {
			texts.push(rec['text']);
		}
	}
	return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Build a tool.failure event with structured error details preserved.
 *
 * For commandExecution: extract exit_code and aggregatedOutput.
 * For mcpToolCall: extract error_code from the error object.
 * For all types: prefer error.message over raw error-as-string.
 * Falls back to result.content text for MCP-style errors.
 */
function resolveToolFailure(
	itemType: string,
	toolName: string,
	item: Record<string, unknown>,
): CodexTranslatedEvent {
	const rawError = item['error'];
	const errorRecord = asRecord(rawError);
	const errorMessage =
		typeof rawError === 'string'
			? rawError
			: typeof errorRecord['message'] === 'string'
				? errorRecord['message']
				: (extractResultContentError(item) ?? 'Unknown error');
	const base: Record<string, unknown> = {
		tool_name: toolName,
		tool_input: resolveToolInput(itemType, item),
		tool_use_id: item['id'] as string | undefined,
		error: errorMessage,
	};

	if (itemType === 'commandExecution') {
		if (typeof item['exitCode'] === 'number') {
			base['exit_code'] = item['exitCode'];
		}
		if (typeof item['aggregatedOutput'] === 'string') {
			base['output'] = item['aggregatedOutput'];
		}
	}

	if (itemType === 'mcpToolCall') {
		if (typeof errorRecord['code'] === 'string') {
			base['error_code'] = errorRecord['code'];
		}
	}

	return {
		kind: 'tool.failure',
		data: base,
		toolName,
		toolUseId: item['id'] as string | undefined,
		expectsDecision: false,
	};
}

export function translateServerRequest(
	msg: JsonRpcServerRequest,
): CodexTranslatedEvent {
	switch (msg.method) {
		case M.CMD_EXEC_REQUEST_APPROVAL: {
			const params = msg.params as CodexCommandExecutionRequestApprovalParams;
			return permissionRequestEvent(
				'Bash',
				{
					command: params.command,
					cwd: params.cwd,
					reason: params.reason,
					commandActions: params.commandActions,
					additionalPermissions: params.additionalPermissions,
				},
				{
					networkContext:
						params.networkApprovalContext &&
						typeof params.networkApprovalContext === 'object'
							? {
									host: params.networkApprovalContext.host,
									protocol: params.networkApprovalContext.protocol,
								}
							: undefined,
				},
			);
		}

		case M.FILE_CHANGE_REQUEST_APPROVAL: {
			const params = msg.params as CodexFileChangeRequestApprovalParams;
			return permissionRequestEvent('Edit', {
				reason: params.reason,
				grantRoot: params.grantRoot,
			});
		}

		case M.PERMISSIONS_REQUEST_APPROVAL: {
			const params = msg.params as CodexPermissionsRequestApprovalParams;
			return permissionRequestEvent(
				'Permissions',
				{
					threadId: params.threadId,
					turnId: params.turnId,
					itemId: params.itemId,
					reason: params.reason,
					permissions: params.permissions,
				},
				{toolUseId: params.itemId},
			);
		}

		case M.TOOL_REQUEST_USER_INPUT: {
			const params = msg.params as CodexToolRequestUserInputParams;
			return permissionRequestEvent('user_input', params);
		}

		case M.APPLY_PATCH_APPROVAL: {
			const params = msg.params as CodexApplyPatchApprovalParams;
			return permissionRequestEvent(
				'Edit',
				{
					fileChanges: params.fileChanges,
					reason: params.reason,
					grantRoot: params.grantRoot,
					callId: params.callId,
				},
				{toolUseId: params.callId},
			);
		}

		case M.EXEC_COMMAND_APPROVAL: {
			const params = msg.params as CodexExecCommandApprovalParams;
			return permissionRequestEvent(
				'Bash',
				{
					command: params.command,
					cwd: params.cwd,
					reason: params.reason,
					parsedCmd: params.parsedCmd,
					approvalId: params.approvalId,
					callId: params.callId,
				},
				{toolUseId: params.callId},
			);
		}

		case M.MCP_SERVER_ELICITATION_REQUEST: {
			const params = msg.params as CodexMcpServerElicitationRequestParams;
			const toolName = resolveMcpElicitationToolName(params);
			return permissionRequestEvent(
				toolName,
				{
					serverName: params.serverName,
					mode: params.mode,
					reason: params.message,
					...(params.mode === 'form'
						? {
								requestedSchema: params.requestedSchema,
								_meta: params._meta,
							}
						: {
								url: params.url,
								elicitationId: params.elicitationId,
								_meta: params._meta,
							}),
				},
				{
					toolUseId: params.mode === 'url' ? params.elicitationId : undefined,
				},
			);
		}

		default:
			return {
				kind: 'unknown',
				data: {
					source_event_name: msg.method,
					payload: msg.params,
					unsupported: true,
				},
				expectsDecision: false,
			};
	}
}
