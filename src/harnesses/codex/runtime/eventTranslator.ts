import type {
	RuntimeEventData,
	RuntimeEventKind,
} from '../../../core/runtime/events';
import type {
	JsonRpcNotification,
	JsonRpcServerRequest,
} from '../protocol/jsonrpc';
import type {
	CodexApplyPatchApprovalParams,
	CodexAgentMessageDeltaNotification,
	CodexCommandExecutionRequestApprovalParams,
	CodexExecCommandApprovalParams,
	CodexFileChangeRequestApprovalParams,
	CodexItemCompletedNotification,
	CodexItemStartedNotification,
	CodexPlanDeltaNotification,
	CodexReasoningSummaryPartAddedNotification,
	CodexReasoningSummaryTextDeltaNotification,
	CodexReasoningTextDeltaNotification,
	CodexThreadNameUpdatedNotification,
	CodexThreadStartedNotification,
	CodexThreadTokenUsageUpdatedNotification,
	CodexToolRequestUserInputParams,
	CodexTurnCompletedNotification,
	CodexTurnPlanUpdatedNotification,
	CodexTurnStartedNotification,
} from '../protocol';
import {
	getCodexUsageDelta,
	getCodexUsageTotals,
} from './tokenUsage';
import * as M from '../protocol/methods';

export type CodexTranslatedEvent = {
	kind: RuntimeEventKind;
	data: RuntimeEventData;
	toolName?: string;
	toolUseId?: string;
	expectsDecision: boolean;
};

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
			return 'command_execution';
		case 'fileChange':
			return 'file_change';
		case 'mcpToolCall':
			return `mcp:${item['server'] ?? 'unknown'}/${item['tool'] ?? 'unknown'}`;
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
		case 'mcpToolCall':
			return asRecord(item['arguments']);
		default:
			return item;
	}
}

function permissionRequestEvent(
	toolName: string,
	toolInput: Record<string, unknown>,
	extra?: {toolUseId?: string},
): CodexTranslatedEvent {
	return {
		kind: 'permission.request',
		data: {
			tool_name: toolName,
			tool_input: toolInput,
			...(extra?.toolUseId ? {tool_use_id: extra.toolUseId} : {}),
		},
		toolName,
		toolUseId: extra?.toolUseId,
		expectsDecision: true,
	};
}

export function translateNotification(
	msg: JsonRpcNotification,
): CodexTranslatedEvent {
	switch (msg.method) {
		case M.THREAD_STARTED: {
			const params = msg.params as CodexThreadStartedNotification;
			return {
				kind: 'session.start',
				data: {
					source: 'codex',
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
			const toolName = resolveToolName(itemType, item);
			if (
				itemType === 'commandExecution' ||
				itemType === 'fileChange' ||
				itemType === 'mcpToolCall'
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
					message: `${itemType} started`,
					notification_type: itemType,
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_COMPLETED: {
			const params = msg.params as CodexItemCompletedNotification;
			const item = asRecord(params.item);
			const itemType = item['type'] as string;
			const toolName = resolveToolName(itemType, item);
			if (
				itemType === 'commandExecution' ||
				itemType === 'fileChange' ||
				itemType === 'mcpToolCall'
			) {
				const itemStatus = item['status'] as string;
				if (itemStatus === 'failed' || itemStatus === 'cancelled') {
					return {
						kind: 'tool.failure',
						data: {
							tool_name: toolName,
							tool_input: resolveToolInput(itemType, item),
							tool_use_id: item['id'] as string | undefined,
							error: item['error'] as string | undefined,
						},
						toolName,
						toolUseId: item['id'] as string | undefined,
						expectsDecision: false,
					};
				}
				return {
					kind: 'tool.post',
					data: {
						tool_name: toolName,
						tool_input: resolveToolInput(itemType, item),
						tool_use_id: item['id'] as string | undefined,
						tool_response:
							item['aggregatedOutput'] ?? item['result'] ?? item['changes'],
					},
					toolName,
					toolUseId: item['id'] as string | undefined,
					expectsDecision: false,
				};
			}
			return {
				kind: 'notification',
				data: {
					message: `${itemType} completed`,
					notification_type: itemType,
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
					message: `Thread renamed: ${params.name}`,
					notification_type: 'thread_name',
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

export function translateServerRequest(
	msg: JsonRpcServerRequest,
): CodexTranslatedEvent {
	switch (msg.method) {
		case M.CMD_EXEC_REQUEST_APPROVAL: {
			const params = msg.params as CodexCommandExecutionRequestApprovalParams;
			return permissionRequestEvent('command_execution', {
				command: params.command,
				cwd: params.cwd,
				reason: params.reason,
				commandActions: params.commandActions,
				additionalPermissions: params.additionalPermissions,
			});
		}

		case M.FILE_CHANGE_REQUEST_APPROVAL: {
			const params = msg.params as CodexFileChangeRequestApprovalParams;
			return permissionRequestEvent('file_change', {
				reason: params.reason,
				grantRoot: params.grantRoot,
			});
		}

		case M.TOOL_REQUEST_USER_INPUT: {
			const params = msg.params as CodexToolRequestUserInputParams;
			return permissionRequestEvent('user_input', params);
		}

		case M.APPLY_PATCH_APPROVAL: {
			const params = msg.params as CodexApplyPatchApprovalParams;
			return permissionRequestEvent(
				'file_change',
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
				'command_execution',
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
