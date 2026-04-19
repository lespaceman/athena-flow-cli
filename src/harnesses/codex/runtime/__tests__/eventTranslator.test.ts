import {describe, it, expect} from 'vitest';
import {
	translateNotification,
	translateServerRequest,
} from '../eventTranslator';

describe('translateNotification', () => {
	it('maps thread/started to session.start without inventing a model id', () => {
		const result = translateNotification({
			method: 'thread/started',
			params: {
				thread: {
					id: 'th1',
					preview: 'hello',
					ephemeral: false,
					modelProvider: 'openai',
					createdAt: 0,
					updatedAt: 0,
					status: 'idle',
					path: null,
					cwd: '/tmp',
					cliVersion: '0.0.0',
					source: {type: 'appServer'},
					agentNickname: null,
					agentRole: null,
					gitInfo: null,
					name: null,
					turns: [],
				},
			},
		});
		expect(result.kind).toBe('session.start');
		expect(result.data).toEqual({source: 'codex'});
	});

	it('maps turn/started to turn.start', () => {
		const result = translateNotification({
			method: 'turn/started',
			params: {
				threadId: 'th1',
				turn: {id: 't1', items: [], status: 'inProgress'},
			},
		});
		expect(result.kind).toBe('turn.start');
		expect(result.expectsDecision).toBe(false);
	});

	it('maps skills/changed to a visible notification', () => {
		const result = translateNotification({
			method: 'skills/changed',
			params: {},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				title: 'Skills changed',
				notification_type: 'skills.changed',
			}),
		);
	});

	it('maps item/agentMessage/delta to message.delta', () => {
		const result = translateNotification({
			method: 'item/agentMessage/delta',
			params: {
				threadId: 'th1',
				turnId: 't1',
				itemId: 'i1',
				delta: 'Hello world',
			},
		});
		expect(result.kind).toBe('message.delta');
		expect(result.data).toEqual(
			expect.objectContaining({
				thread_id: 'th1',
				turn_id: 't1',
				item_id: 'i1',
				delta: 'Hello world',
			}),
		);
	});

	it('maps item/commandExecution/outputDelta to tool.delta', () => {
		const result = translateNotification({
			method: 'item/commandExecution/outputDelta',
			params: {
				threadId: 'th1',
				turnId: 't1',
				itemId: 'cmd-1',
				delta: 'line 1\n',
			},
		});
		expect(result.kind).toBe('tool.delta');
		expect(result.data).toEqual(
			expect.objectContaining({
				thread_id: 'th1',
				turn_id: 't1',
				tool_name: 'Bash',
				tool_use_id: 'cmd-1',
				delta: 'line 1\n',
			}),
		);
	});

	it('maps item/fileChange/outputDelta to Edit tool.delta', () => {
		const result = translateNotification({
			method: 'item/fileChange/outputDelta',
			params: {
				threadId: 'th1',
				turnId: 't1',
				itemId: 'edit-1',
				delta: 'patched\n',
			},
		});
		expect(result.kind).toBe('tool.delta');
		expect(result.data).toEqual(
			expect.objectContaining({
				thread_id: 'th1',
				turn_id: 't1',
				tool_name: 'Edit',
				tool_use_id: 'edit-1',
				delta: 'patched\n',
			}),
		);
	});

	it('maps item/commandExecution/terminalInteraction to readable notification', () => {
		const result = translateNotification({
			method: 'item/commandExecution/terminalInteraction',
			params: {
				threadId: 'th1',
				turnId: 't1',
				itemId: 'cmd-1',
				processId: 'proc-1',
				stdin: 'allow\n',
			},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				title: 'Terminal input',
				notification_type: 'command_execution.terminal_interaction',
			}),
		);
	});

	it('maps item/completed (agentMessage) to message.complete', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'i1',
					type: 'agentMessage',
					text: 'Using agent-web-interface-guide because this requires live browser interaction.',
					phase: 'commentary',
				},
			},
		});
		expect(result.kind).toBe('message.complete');
		expect(result.data).toEqual(
			expect.objectContaining({
				thread_id: 'th1',
				turn_id: 't1',
				item_id: 'i1',
				message:
					'Using agent-web-interface-guide because this requires live browser interaction.',
				phase: 'commentary',
			}),
		);
	});

	it('maps turn/completed to turn.complete', () => {
		const result = translateNotification({
			method: 'turn/completed',
			params: {
				threadId: 'th1',
				turn: {id: 't1', items: [], status: 'completed'},
			},
		});
		expect(result.kind).toBe('turn.complete');
	});

	it('maps configWarning to readable notification', () => {
		const result = translateNotification({
			method: 'configWarning',
			params: {
				summary: 'Invalid config value',
				details: 'model_reasoning_effort is ignored here',
				path: '/tmp/config.json',
			},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				title: 'Config warning (/tmp/config.json)',
				notification_type: 'config.warning',
			}),
		);
	});

	it('maps thread/closed to session.end', () => {
		const result = translateNotification({
			method: 'thread/closed',
			params: {
				threadId: 'th1',
			},
		});
		expect(result.kind).toBe('session.end');
		expect(result.data).toEqual(
			expect.objectContaining({
				reason: 'thread closed (th1)',
			}),
		);
	});

	it('maps mcpServer/startupStatus/updated to readable notification', () => {
		const result = translateNotification({
			method: 'mcpServer/startupStatus/updated',
			params: {
				name: 'github',
				status: 'failed',
				error: 'bad auth',
			},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				notification_type: 'mcp_server.startup_status',
			}),
		);
	});

	it('maps thread/realtime/transcript/delta to readable notification', () => {
		const result = translateNotification({
			method: 'thread/realtime/transcript/delta',
			params: {
				threadId: 'th1',
				role: 'assistant',
				delta: 'Hello from realtime',
			},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				title: 'Realtime transcript',
				notification_type: 'thread.realtime.transcript_delta',
			}),
		);
	});

	it('maps item/started (commandExecution) to tool.pre', () => {
		const result = translateNotification({
			method: 'item/started',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {id: 'i1', type: 'commandExecution', command: 'ls -la'},
			},
		});
		expect(result.kind).toBe('tool.pre');
		expect(result.toolName).toBe('Bash');
	});

	it('maps item/completed (commandExecution) to tool.post', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'i1',
					type: 'commandExecution',
					status: 'completed',
					aggregatedOutput: 'output',
				},
			},
		});
		expect(result.kind).toBe('tool.post');
	});

	it('maps item/started (webSearch) to a notification with query details', () => {
		const result = translateNotification({
			method: 'item/started',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {id: 'ws-1', type: 'webSearch', query: 'cheapest mac'},
			},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				notification_type: 'web.search',
				phase: 'started',
				query: 'cheapest mac',
			}),
		);
	});

	it('maps item/completed (webSearch) to a notification with action details', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'ws-1',
					type: 'webSearch',
					status: 'completed',
					query: 'cheapest mac',
					action: {type: 'search', query: 'cheapest mac'},
				},
			},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				notification_type: 'web.search',
				phase: 'completed',
				query: 'cheapest mac',
				action_type: 'search',
			}),
		);
	});

	it('maps item/completed (failed) to tool.failure', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'i1',
					type: 'commandExecution',
					status: 'failed',
					error: 'boom',
				},
			},
		});
		expect(result.kind).toBe('tool.failure');
	});

	it('maps unknown methods to unknown kind', () => {
		const result = translateNotification({
			method: 'some/unknown/event',
			params: {},
		});
		expect(result.kind).toBe('unknown');
	});

	it('maps collabAgentToolCall (spawnAgent, inProgress) item/started to subagent.start', () => {
		const result = translateNotification({
			method: 'item/started',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'collab-1',
					type: 'collabAgentToolCall',
					tool: 'spawnAgent',
					status: 'inProgress',
					agentsStates: {
						'agent-abc': {status: 'running', message: null},
					},
					callerThreadId: 'th1',
					callerTurnId: 't1',
				},
			},
		});
		expect(result.kind).toBe('subagent.start');
		expect(result.data).toEqual(
			expect.objectContaining({
				agent_id: 'agent-abc',
				agent_type: 'codex',
				tool: 'spawnAgent',
			}),
		);
	});

	it('maps collabAgentToolCall (completed) item/completed to subagent.stop', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'collab-1',
					type: 'collabAgentToolCall',
					tool: 'spawnAgent',
					status: 'completed',
					agentsStates: {
						'agent-abc': {status: 'completed', message: null},
					},
					callerThreadId: 'th1',
					callerTurnId: 't1',
				},
			},
		});
		expect(result.kind).toBe('subagent.stop');
		expect(result.data).toEqual(
			expect.objectContaining({
				agent_id: 'agent-abc',
				agent_type: 'codex',
				status: 'completed',
			}),
		);
	});

	it('preserves structured error details in commandExecution failure', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'i1',
					type: 'commandExecution',
					command: 'git push',
					cwd: '/project',
					status: 'failed',
					error: {code: 128, message: 'push rejected'},
					aggregatedOutput: 'fatal: remote rejected',
					exitCode: 128,
				},
			},
		});
		expect(result.kind).toBe('tool.failure');
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_name: 'Bash',
				error: 'push rejected',
				exit_code: 128,
				output: 'fatal: remote rejected',
			}),
		);
	});

	it('preserves structured error details in mcpToolCall failure', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'i1',
					type: 'mcpToolCall',
					server: 'demo',
					tool: 'fetch',
					status: 'failed',
					error: {message: 'connection refused', code: 'ECONNREFUSED'},
					arguments: {url: 'http://localhost'},
				},
			},
		});
		expect(result.kind).toBe('tool.failure');
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_name: 'mcp__demo__fetch',
				error: 'connection refused',
				error_code: 'ECONNREFUSED',
			}),
		);
	});

	it('maps item/started (dynamicToolCall) to tool.pre', () => {
		const result = translateNotification({
			method: 'item/started',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'dyn-1',
					type: 'dynamicToolCall',
					tool: 'MyCustomTool',
					arguments: {foo: 'bar'},
					status: 'inProgress',
				},
			},
		});
		expect(result.kind).toBe('tool.pre');
		expect(result.toolName).toBe('MyCustomTool');
		expect(result.toolUseId).toBe('dyn-1');
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_name: 'MyCustomTool',
				tool_input: {foo: 'bar'},
				tool_use_id: 'dyn-1',
			}),
		);
	});

	it('maps item/completed (dynamicToolCall) to tool.post', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'dyn-1',
					type: 'dynamicToolCall',
					tool: 'MyCustomTool',
					arguments: {foo: 'bar'},
					status: 'completed',
					success: true,
					contentItems: [{type: 'inputText', text: 'result data'}],
				},
			},
		});
		expect(result.kind).toBe('tool.post');
		expect(result.toolName).toBe('MyCustomTool');
		expect(result.toolUseId).toBe('dyn-1');
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_name: 'MyCustomTool',
				tool_input: {foo: 'bar'},
				tool_use_id: 'dyn-1',
				tool_response: [{type: 'inputText', text: 'result data'}],
			}),
		);
	});

	it('maps item/completed (dynamicToolCall, failed) to tool.failure', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'dyn-1',
					type: 'dynamicToolCall',
					tool: 'MyCustomTool',
					arguments: {foo: 'bar'},
					status: 'failed',
					success: false,
					error: 'tool execution failed',
				},
			},
		});
		expect(result.kind).toBe('tool.failure');
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_name: 'MyCustomTool',
				tool_input: {foo: 'bar'},
				error: 'tool execution failed',
			}),
		);
	});

	it('extracts error from result.content when error field is null (mcpToolCall)', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'mcp-1',
					type: 'mcpToolCall',
					server: 'agent-web-interface',
					tool: 'navigate',
					status: 'failed',
					error: null,
					arguments: {url: 'http://localhost'},
					result: {
						content: [
							{type: 'text', text: 'Navigation failed: page not found'},
						],
					},
				},
			},
		});
		expect(result.kind).toBe('tool.failure');
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_name: 'mcp__agent-web-interface__navigate',
				error: 'Navigation failed: page not found',
			}),
		);
	});

	it('falls back to Unknown error when both error and result.content are empty', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'mcp-2',
					type: 'mcpToolCall',
					server: 'demo',
					tool: 'test',
					status: 'failed',
					error: null,
					arguments: {},
					result: null,
				},
			},
		});
		expect(result.kind).toBe('tool.failure');
		expect(result.data).toEqual(
			expect.objectContaining({
				error: 'Unknown error',
			}),
		);
	});

	it('preserves structured error details in fileChange failure', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {
					id: 'i1',
					type: 'fileChange',
					status: 'failed',
					error: {message: 'permission denied'},
					changes: [{path: '/etc/hosts', kind: 'write'}],
				},
			},
		});
		expect(result.kind).toBe('tool.failure');
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_name: 'Edit',
				error: 'permission denied',
			}),
		);
	});

	it('maps error notification to a codex.error notification', () => {
		const result = translateNotification({
			method: 'error',
			params: {
				threadId: 'th1',
				turnId: 't1',
				willRetry: true,
				error: {
					message: 'upstream 503',
					codexErrorInfo: {type: 'HttpConnectionFailed', httpStatusCode: 503},
					additionalDetails: 'retry scheduled',
				},
			},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				notification_type: 'codex.error',
				error_code: 'HttpConnectionFailed',
				will_retry: true,
			}),
		);
	});

	it('maps thread/status/changed to a thread.status_changed notification', () => {
		const result = translateNotification({
			method: 'thread/status/changed',
			params: {
				threadId: 'th1',
				status: {type: 'active', activeFlags: ['turn']},
			},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				message: 'Active: turn.',
				notification_type: 'thread.status_changed',
				status_type: 'active',
				active_flags: ['turn'],
			}),
		);
	});

	it('maps turn/diff/updated to a turn.diff_updated notification carrying diff', () => {
		const result = translateNotification({
			method: 'turn/diff/updated',
			params: {threadId: 'th1', turnId: 't1', diff: '--- a\n+++ b\n'},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				message: 'Draft diff updated (12 bytes).',
				notification_type: 'turn.diff_updated',
				diff: '--- a\n+++ b\n',
			}),
		);
	});

	it('maps serverRequest/resolved to a server_request.resolved notification', () => {
		const result = translateNotification({
			method: 'serverRequest/resolved',
			params: {threadId: 'th1', requestId: 42},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				message: 'Request #42 resolved.',
				notification_type: 'server_request.resolved',
				request_id: 42,
			}),
		);
	});

	it('maps item/completed (enteredReviewMode) to an item notification with review text', () => {
		const result = translateNotification({
			method: 'item/completed',
			params: {
				threadId: 'th1',
				turnId: 't1',
				item: {type: 'enteredReviewMode', id: 'i1', review: 'current changes'},
			},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				notification_type: 'item.enteredReviewMode.completed',
				item_type: 'enteredReviewMode',
				item_id: 'i1',
			}),
		);
	});
});

describe('translateServerRequest', () => {
	it('maps commandExecution approval to permission.request', () => {
		const result = translateServerRequest({
			method: 'item/commandExecution/requestApproval',
			id: 5,
			params: {
				threadId: 'th1',
				turnId: 't1',
				itemId: 'i1',
				command: 'rm -rf /',
				cwd: '/home',
			},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.expectsDecision).toBe(true);
		expect(result.toolName).toBe('Bash');
	});

	it('preserves network approval context on command approvals', () => {
		const result = translateServerRequest({
			id: 1,
			method: 'item/commandExecution/requestApproval',
			params: {
				command: 'curl https://api.example.com',
				cwd: '/tmp',
				reason: 'Need network access',
				commandActions: [],
				additionalPermissions: [],
				networkApprovalContext: {
					host: 'api.example.com',
					protocol: 'https',
				},
			},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.data).toEqual(
			expect.objectContaining({
				network_context: {
					host: 'api.example.com',
					protocol: 'https',
				},
			}),
		);
	});

	it('maps fileChange approval to permission.request', () => {
		const result = translateServerRequest({
			method: 'item/fileChange/requestApproval',
			id: 6,
			params: {
				threadId: 'th1',
				turnId: 't1',
				itemId: 'i1',
				reason: 'needs write access',
				grantRoot: '/home/user/project',
			},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.expectsDecision).toBe(true);
		expect(result.toolName).toBe('Edit');
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_input: {
					reason: 'needs write access',
					grantRoot: '/home/user/project',
				},
			}),
		);
	});

	it('maps applyPatchApproval to permission.request', () => {
		const result = translateServerRequest({
			method: 'applyPatchApproval',
			id: 9,
			params: {
				conversationId: 'th1',
				callId: 'patch-1',
				fileChanges: {},
				reason: 'legacy patch approval',
				grantRoot: '/home/user/project',
			},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.toolName).toBe('Edit');
		expect(result.toolUseId).toBe('patch-1');
	});

	it('maps execCommandApproval to permission.request', () => {
		const result = translateServerRequest({
			method: 'execCommandApproval',
			id: 10,
			params: {
				conversationId: 'th1',
				callId: 'exec-1',
				approvalId: null,
				command: ['git', 'status'],
				cwd: '/home/user/project',
				reason: 'legacy exec approval',
				parsedCmd: [],
			},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.toolName).toBe('Bash');
		expect(result.toolUseId).toBe('exec-1');
	});

	it('maps permissions approval requests to permission.request', () => {
		const result = translateServerRequest({
			method: 'item/permissions/requestApproval',
			id: 8,
			params: {
				threadId: 'th1',
				turnId: 't1',
				itemId: 'i1',
				permissions: {network: {enabled: true}},
			},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.toolName).toBe('Permissions');
		expect(result.toolUseId).toBe('i1');
		expect(result.expectsDecision).toBe(true);
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_name: 'Permissions',
				tool_input: expect.objectContaining({
					threadId: 'th1',
					turnId: 't1',
					itemId: 'i1',
					permissions: {network: {enabled: true}},
				}),
			}),
		);
	});

	it('maps MCP tool approval elicitations to permission.request', () => {
		const result = translateServerRequest({
			method: 'mcpServer/elicitation/request',
			id: 21,
			params: {
				threadId: 'th1',
				turnId: 't1',
				serverName: 'browser',
				mode: 'form',
				message: 'Allow the browser MCP server to run tool "list_pages"?',
				requestedSchema: {
					type: 'object',
					properties: {},
				},
				_meta: {
					codex_approval_kind: 'mcp_tool_call',
					tool_title: 'List Pages',
				},
			},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.toolName).toBe('mcp__browser__list_pages');
		expect(result.data).toEqual(
			expect.objectContaining({
				tool_name: 'mcp__browser__list_pages',
				tool_input: expect.objectContaining({
					serverName: 'browser',
					mode: 'form',
					reason: 'Allow the browser MCP server to run tool "list_pages"?',
				}),
			}),
		);
	});
});
