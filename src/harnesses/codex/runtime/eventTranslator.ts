import type {
	RuntimeEventKind,
	RuntimeEventData,
} from '../../../core/runtime/events';
import type {
	JsonRpcNotification,
	JsonRpcServerRequest,
} from '../protocol/jsonrpc';
import * as M from '../protocol/methods';

export type CodexTranslatedEvent = {
	kind: RuntimeEventKind;
	data: RuntimeEventData;
	toolName?: string;
	toolUseId?: string;
	expectsDecision: boolean;
};

function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === 'object' && v !== null
		? (v as Record<string, unknown>)
		: {};
}

export function translateNotification(
	msg: JsonRpcNotification,
): CodexTranslatedEvent {
	const params = asRecord(msg.params);

	switch (msg.method) {
		case M.THREAD_STARTED:
			return {
				kind: 'session.start',
				data: {source: 'codex'},
				expectsDecision: false,
			};

		case M.TURN_STARTED: {
			const turn = asRecord(params['turn']);
			return {
				kind: 'user.prompt',
				data: {
					prompt: turn['input'] as string | undefined,
					permission_mode: undefined,
				},
				expectsDecision: false,
			};
		}

		case M.TURN_COMPLETED: {
			const turn = asRecord(params['turn']);
			return {
				kind: 'stop.request',
				data: {
					stop_hook_active: false,
					last_assistant_message: turn['status'] as string | undefined,
				},
				expectsDecision: false,
			};
		}

		case M.ITEM_STARTED: {
			const item = asRecord(params['item']);
			const itemType = item['type'] as string;
			if (itemType === 'commandExecution') {
				return {
					kind: 'tool.pre',
					data: {
						tool_name: 'command_execution',
						tool_input: {command: item['command'], cwd: item['cwd']},
						tool_use_id: item['id'] as string | undefined,
					},
					toolName: 'command_execution',
					toolUseId: item['id'] as string | undefined,
					expectsDecision: false,
				};
			}
			if (itemType === 'fileChange') {
				return {
					kind: 'tool.pre',
					data: {
						tool_name: 'file_change',
						tool_input: {changes: item['changes']},
						tool_use_id: item['id'] as string | undefined,
					},
					toolName: 'file_change',
					toolUseId: item['id'] as string | undefined,
					expectsDecision: false,
				};
			}
			if (itemType === 'mcpToolCall') {
				return {
					kind: 'tool.pre',
					data: {
						tool_name: `mcp:${item['server'] ?? 'unknown'}/${item['tool'] ?? 'unknown'}`,
						tool_input: asRecord(item['arguments']),
						tool_use_id: item['id'] as string | undefined,
					},
					toolName: `mcp:${item['server']}/${item['tool']}`,
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
			const item = asRecord(params['item']);
			const itemType = item['type'] as string;
			if (
				itemType === 'commandExecution' ||
				itemType === 'fileChange' ||
				itemType === 'mcpToolCall'
			) {
				const status = item['status'] as string;
				const toolName =
					itemType === 'commandExecution'
						? 'command_execution'
						: itemType === 'fileChange'
							? 'file_change'
							: `mcp:${item['server']}/${item['tool']}`;
				if (status === 'failed' || status === 'cancelled') {
					return {
						kind: 'tool.failure',
						data: {
							tool_name: toolName,
							tool_input: {},
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
						tool_input: {},
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

		case M.ITEM_AGENT_MESSAGE_DELTA: {
			const delta = params['delta'] as string | undefined;
			return {
				kind: 'notification',
				data: {
					message: delta ?? '',
					notification_type: 'agent_message_delta',
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_TOKEN_USAGE_UPDATED: {
			const usage = asRecord(params['usage'] ?? params);
			return {
				kind: 'notification',
				data: {
					message: 'Token usage updated',
					notification_type: 'token_usage',
					...usage,
				},
				expectsDecision: false,
			};
		}

		case M.THREAD_NAME_UPDATED:
			return {
				kind: 'notification',
				data: {
					message: `Thread renamed: ${params['name']}`,
					notification_type: 'thread_name',
				},
				expectsDecision: false,
			};

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
	const params = asRecord(msg.params);

	switch (msg.method) {
		case M.CMD_EXEC_REQUEST_APPROVAL:
			return {
				kind: 'permission.request',
				data: {
					tool_name: 'command_execution',
					tool_input: {command: params['command'], cwd: params['cwd']},
				},
				toolName: 'command_execution',
				expectsDecision: true,
			};

		case M.FILE_READ_REQUEST_APPROVAL:
			return {
				kind: 'permission.request',
				data: {
					tool_name: 'file_read',
					tool_input: {path: params['path'], reason: params['reason']},
				},
				toolName: 'file_read',
				expectsDecision: true,
			};

		case M.FILE_CHANGE_REQUEST_APPROVAL:
			return {
				kind: 'permission.request',
				data: {
					tool_name: 'file_change',
					tool_input: {changes: params['changes']},
				},
				toolName: 'file_change',
				expectsDecision: true,
			};

		case M.PERMISSIONS_REQUEST_APPROVAL:
			return {
				kind: 'permission.request',
				data: {
					tool_name: 'filesystem_permissions',
					tool_input: {roots: params['roots']},
				},
				toolName: 'filesystem_permissions',
				expectsDecision: true,
			};

		case M.TOOL_REQUEST_USER_INPUT:
			return {
				kind: 'permission.request',
				data: {
					tool_name: 'user_input',
					tool_input: params,
				},
				toolName: 'user_input',
				expectsDecision: true,
			};

		default:
			return {
				kind: 'unknown',
				data: {source_event_name: msg.method, payload: msg.params},
				expectsDecision: false,
			};
	}
}
