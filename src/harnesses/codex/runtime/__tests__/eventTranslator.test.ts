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
		expect(result.toolName).toBe('command_execution');
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
		expect(result.toolName).toBe('command_execution');
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
		expect(result.toolName).toBe('file_change');
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
		expect(result.toolName).toBe('file_change');
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
		expect(result.toolName).toBe('command_execution');
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
