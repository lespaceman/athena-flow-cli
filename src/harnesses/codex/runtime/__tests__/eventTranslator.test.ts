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

	it('marks removed permissions approval requests as unknown', () => {
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
		expect(result.kind).toBe('unknown');
		expect(result.expectsDecision).toBe(false);
	});
});
