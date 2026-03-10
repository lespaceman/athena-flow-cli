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
	CodexThreadTokenUsageUpdatedNotification,
	CodexToolRequestUserInputParams,
	CodexTurnCompletedNotification,
	CodexTurnPlanUpdatedNotification,
	CodexTurnStartedNotification,
} from '../protocol';
import {getCodexUsageDelta, getCodexUsageTotals} from './tokenUsage';
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
			return 'Bash';
		case 'fileChange':
			return 'Edit';
		case 'mcpToolCall': {
			const server = String(item['server'] ?? 'unknown');
			const tool = String(item['tool'] ?? 'unknown');
			return `mcp__${server}__${tool}`;
		}
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
			return {
				kind: 'session.start',
				data: {
					source: 'codex',
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
				itemType === 'mcpToolCall'
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
					message: `Thread renamed: ${params.threadName ?? params.threadId}`,
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
	return {
		kind: 'subagent.start',
		data: {
			agent_id: agentId,
			agent_type: 'codex',
			tool,
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
	return {
		kind: 'subagent.stop',
		data: {
			agent_id: agentId,
			agent_type: 'codex',
			tool,
			status,
		},
		expectsDecision: false,
	};
}

/**
 * Build a tool.failure event with structured error details preserved.
 *
 * For commandExecution: extract exit_code and aggregatedOutput.
 * For mcpToolCall: extract error_code from the error object.
 * For all types: prefer error.message over raw error-as-string.
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
				: 'Unknown error';
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
			return permissionRequestEvent('Bash', {
				command: params.command,
				cwd: params.cwd,
				reason: params.reason,
				commandActions: params.commandActions,
				additionalPermissions: params.additionalPermissions,
			});
		}

		case M.FILE_CHANGE_REQUEST_APPROVAL: {
			const params = msg.params as CodexFileChangeRequestApprovalParams;
			return permissionRequestEvent('Edit', {
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
