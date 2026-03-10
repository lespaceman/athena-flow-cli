import {EventEmitter} from 'node:events';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createCodexServer} from '../server';
import type {RuntimeEvent} from '../../../../core/runtime/types';

const mockState = vi.hoisted(() => ({
	current: null as {
		responses: Array<{id: number; result: unknown}>;
		errors: Array<{id: number; code: number; message: string}>;
		emit: (event: string, payload: unknown) => boolean;
	} | null,
}));

vi.mock('../appServerManager', () => ({
	AppServerManager: class MockAppServerManager extends EventEmitter {
		readonly responses: Array<{id: number; result: unknown}> = [];
		readonly errors: Array<{id: number; code: number; message: string}> = [];

		constructor(
			readonly binaryPath: string,
			readonly cwd?: string,
			readonly env?: Record<string, string>,
		) {
			super();
			mockState.current = this;
		}

		async start(): Promise<void> {}

		async stop(): Promise<void> {}

		sendNotification(): void {}

		respondToServerRequest(id: number, result: unknown): void {
			this.responses.push({id, result});
		}

		respondToServerRequestError(
			id: number,
			code: number,
			message: string,
		): void {
			this.errors.push({id, code, message});
		}

		async sendRequest(
			method: string,
			_params?: Record<string, unknown>,
		): Promise<unknown> {
			if (method === 'initialize') {
				return {};
			}

			if (method === 'thread/start') {
				return {
					thread: {id: 'th-1'},
					model: 'gpt-5-codex',
					modelProvider: 'openai',
				};
			}

			if (method === 'turn/start') {
				this.emit('notification', {
					method: 'thread/started',
					params: {
						thread: {
							id: 'th-1',
							preview: 'Hello Codex',
							ephemeral: false,
							modelProvider: 'openai',
							createdAt: 0,
							updatedAt: 0,
							status: 'idle',
							path: null,
							cwd: '/project',
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
				this.emit('notification', {
					method: 'turn/started',
					params: {
						threadId: 'th-1',
						turn: {id: 'turn-1', items: [], status: 'inProgress'},
					},
				});
				this.emit('notification', {
					method: 'turn/completed',
					params: {
						threadId: 'th-1',
						turn: {id: 'turn-1', items: [], status: 'completed'},
					},
				});
				return {turn: {id: 'turn-1', items: [], status: 'completed'}};
			}

			throw new Error(`Unexpected request: ${method}`);
		}
	},
}));

describe('createCodexServer', () => {
	beforeEach(() => {
		mockState.current = null;
	});

	it('resolves sendPrompt when turn completion arrives before turn/start responds', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});
		const events: RuntimeEvent[] = [];
		runtime.onEvent(event => {
			events.push(event);
		});

		await runtime.start();
		await expect(runtime.sendPrompt('Hello Codex')).resolves.toBeUndefined();

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'session.start',
					data: expect.objectContaining({model: 'gpt-5-codex'}),
				}),
				expect.objectContaining({
					kind: 'turn.start',
					data: expect.objectContaining({prompt: 'Hello Codex'}),
				}),
				expect.objectContaining({kind: 'turn.complete'}),
			]),
		);
	});

	it('returns typed fallback results for known unsupported Codex server requests', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		const manager = mockState.current;
		expect(manager).not.toBeNull();

		manager!.emit('serverRequest', {
			method: 'mcpServer/elicitation/request',
			id: 21,
			params: {
				threadId: 'th-1',
				turnId: 'turn-1',
				serverName: 'demo',
				mode: 'url',
				message: 'Open this URL',
				url: 'https://example.com',
				elicitationId: 'elic-1',
			},
		});
		manager!.emit('serverRequest', {
			method: 'item/tool/call',
			id: 22,
			params: {
				threadId: 'th-1',
				turnId: 'turn-1',
				callId: 'call-1',
				tool: 'demo_tool',
				arguments: {},
			},
		});
		manager!.emit('serverRequest', {
			method: 'account/chatgptAuthTokens/refresh',
			id: 23,
			params: {reason: 'unauthorized', previousAccountId: null},
		});

		expect(manager!.responses).toEqual(
			expect.arrayContaining([
				{id: 21, result: {action: 'decline', content: null}},
				{id: 22, result: {contentItems: [], success: false}},
			]),
		);
		expect(manager!.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 23,
					code: -32601,
				}),
			]),
		);
	});

	it('ignores legacy codex/event notifications and thread status chatter', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});
		const events: RuntimeEvent[] = [];
		runtime.onEvent(event => {
			events.push(event);
		});

		await runtime.start();
		const manager = mockState.current;
		expect(manager).not.toBeNull();

		manager!.emit('notification', {
			method: 'codex/event/agent_message_delta',
			params: {delta: 'hello'},
		});
		manager!.emit('notification', {
			method: 'thread/status/changed',
			params: {threadId: 'th-1', status: 'running'},
		});

		expect(events).toEqual([]);
	});
});
