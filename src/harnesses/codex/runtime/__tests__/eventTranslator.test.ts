import {describe, it, expect} from 'vitest';
import {
	translateNotification,
	translateServerRequest,
} from '../eventTranslator';

describe('translateNotification', () => {
	it('maps turn/started to user.prompt', () => {
		const result = translateNotification({
			method: 'turn/started',
			params: {turn: {id: 't1', model: 'gpt-5.3-codex'}},
		});
		expect(result.kind).toBe('user.prompt');
		expect(result.expectsDecision).toBe(false);
	});

	it('maps item/agentMessage/delta to notification', () => {
		const result = translateNotification({
			method: 'item/agentMessage/delta',
			params: {delta: 'Hello world'},
		});
		expect(result.kind).toBe('notification');
		expect(result.data).toEqual(
			expect.objectContaining({
				notification_type: 'agent_message_delta',
				message: 'Hello world',
			}),
		);
	});

	it('maps turn/completed to stop.request', () => {
		const result = translateNotification({
			method: 'turn/completed',
			params: {turn: {id: 't1', status: 'completed'}},
		});
		expect(result.kind).toBe('stop.request');
	});

	it('maps item/started (commandExecution) to tool.pre', () => {
		const result = translateNotification({
			method: 'item/started',
			params: {
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
			params: {command: 'rm -rf /', cwd: '/home'},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.expectsDecision).toBe(true);
		expect(result.toolName).toBe('command_execution');
	});

	it('maps fileRead approval to permission.request', () => {
		const result = translateServerRequest({
			method: 'item/fileRead/requestApproval',
			id: 7,
			params: {path: '/etc/passwd', reason: 'needs config'},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.expectsDecision).toBe(true);
		expect(result.toolName).toBe('file_read');
	});

	it('maps fileChange approval to permission.request', () => {
		const result = translateServerRequest({
			method: 'item/fileChange/requestApproval',
			id: 6,
			params: {changes: [{path: 'foo.ts', kind: 'modify'}]},
		});
		expect(result.kind).toBe('permission.request');
		expect(result.expectsDecision).toBe(true);
	});
});
