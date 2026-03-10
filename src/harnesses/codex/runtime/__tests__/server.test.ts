import {EventEmitter} from 'node:events';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createCodexServer} from '../server';
import type {RuntimeEvent} from '../../../../core/runtime/types';
import * as M from '../../protocol/methods';

const mockState = vi.hoisted(() => ({
	current: null as {
		requests: Array<{method: string; params?: Record<string, unknown>}>;
		responses: Array<{id: number; result: unknown}>;
		errors: Array<{id: number; code: number; message: string}>;
		emit: (event: string, payload: unknown) => boolean;
	} | null,
}));

vi.mock('../appServerManager', () => ({
	AppServerManager: class MockAppServerManager extends EventEmitter {
		readonly requests: Array<{
			method: string;
			params?: Record<string, unknown>;
		}> = [];
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
			params?: Record<string, unknown>,
		): Promise<unknown> {
			this.requests.push({method, params});

			if (method === 'initialize') {
				return {};
			}

			if (method === 'skills/list') {
				return {
					data: [
						{
							cwd: '/project',
							skills: [
								{
									name: 'workflow-skill',
									description: 'Handle workflow tasks.',
									path: '/workflow/plugins/e2e-test-builder/skills/workflow-skill/SKILL.md',
									enabled: true,
									dependencies: {
										tools: [
											{
												type: 'mcp',
												value: 'agent-web-interface',
											},
										],
									},
								},
								{
									name: 'global-skill',
									description: 'Do not include this.',
									path: '/elsewhere/global-skill/SKILL.md',
									enabled: true,
								},
							],
							errors: [],
						},
					],
				};
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

	it('hydrates thread startup with workflow skill roots and mcp config', async () => {
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
		await runtime.sendPrompt('Hello Codex', {
			developerInstructions: 'Use the workflow tracker.',
			skillRoots: ['/workflow/plugins/e2e-test-builder/skills'],
			config: {
				mcp_servers: {
					'agent-web-interface': {
						command: 'npx',
						args: ['-y', 'agent-web-interface@latest'],
					},
				},
			},
		});

		const manager = mockState.current;
		expect(manager).not.toBeNull();
		expect(manager!.requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: 'skills/list',
					params: {
						cwds: ['/project'],
						forceReload: true,
						perCwdExtraUserRoots: [
							{
								cwd: '/project',
								extraUserRoots: ['/workflow/plugins/e2e-test-builder/skills'],
							},
						],
					},
				}),
				expect.objectContaining({
					method: 'thread/start',
					params: expect.objectContaining({
						config: {
							mcp_servers: {
								'agent-web-interface': {
									command: 'npx',
									args: ['-y', 'agent-web-interface@latest'],
								},
							},
						},
						developerInstructions: expect.stringContaining(
							'Use the workflow tracker.',
						),
					}),
				}),
			]),
		);
		expect(
			manager!.requests.find(request => request.method === 'thread/start')
				?.params?.['developerInstructions'],
		).toEqual(expect.stringContaining('workflow-skill'));
		expect(
			manager!.requests.find(request => request.method === 'thread/start')
				?.params?.['developerInstructions'],
		).not.toEqual(expect.stringContaining('global-skill'));
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'notification',
					data: expect.objectContaining({
						title: 'Skills loaded',
						notification_type: 'skills.loaded',
						message: 'Loaded 1 workflow skill: workflow-skill.',
					}),
					hookName: 'skills/list',
				}),
			]),
		);
	});

	it('starts ephemeral Codex threads without extended history persistence', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		await runtime.sendPrompt('Hello Codex', {
			ephemeral: true,
		});

		const manager = mockState.current;
		expect(manager).not.toBeNull();
		expect(
			manager!.requests.find(request => request.method === 'thread/start')
				?.params,
		).toEqual(
			expect.objectContaining({
				ephemeral: true,
				persistExtendedHistory: false,
			}),
		);
	});

	it('fails fast when thread/start does not return a thread id', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		const manager = mockState.current as
			| (typeof mockState.current & {
					sendRequest: (
						method: string,
						params?: Record<string, unknown>,
					) => Promise<unknown>;
			  })
			| null;
		expect(manager).not.toBeNull();

		const originalSendRequest = manager!.sendRequest.bind(manager);
		manager!.sendRequest = vi.fn(async (method, params) => {
			if (method === M.THREAD_START) {
				manager!.requests.push({method, params});
				return {thread: {}};
			}
			if (method === M.TURN_START) {
				manager!.requests.push({method, params});
				throw new Error('turn/start should not be called');
			}
			return originalSendRequest(method, params);
		});

		await expect(runtime.sendPrompt('Hello Codex')).rejects.toThrow(
			/Codex thread\/start did not return a thread id/,
		);
		expect(
			manager!.requests.some(request => request.method === M.TURN_START),
		).toBe(false);
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

	it('surfaces skills/changed after skill roots are configured', async () => {
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
		await runtime.sendPrompt('Hello Codex', {
			skillRoots: ['/workflow/plugins/e2e-test-builder/skills'],
		});

		const manager = mockState.current;
		expect(manager).not.toBeNull();

		manager!.emit('notification', {
			method: M.SKILLS_CHANGED,
			params: {},
		});

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'notification',
					data: expect.objectContaining({
						title: 'Skills changed',
						notification_type: 'skills.changed',
					}),
					hookName: M.SKILLS_CHANGED,
				}),
			]),
		);
	});

	it('does not suppress completed agentMessage items', async () => {
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
			method: M.ITEM_COMPLETED,
			params: {
				threadId: 'th-1',
				turnId: 'turn-1',
				item: {
					id: 'msg-1',
					type: 'agentMessage',
					text: 'Incremental commentary',
					phase: 'commentary',
				},
			},
		});

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'message.complete',
					data: expect.objectContaining({
						item_id: 'msg-1',
						message: 'Incremental commentary',
					}),
				}),
			]),
		);
	});

	it('interrupts using the turn id returned from turn/start before notifications arrive', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		const manager = mockState.current as
			| (typeof mockState.current & {
					sendRequest: (
						method: string,
						params?: Record<string, unknown>,
					) => Promise<unknown>;
					sendNotification: (
						method: string,
						params?: Record<string, unknown>,
					) => void;
			  })
			| null;
		expect(manager).not.toBeNull();

		const originalSendRequest = manager!.sendRequest.bind(manager);
		const sendNotification = vi.fn();
		manager!.sendNotification = sendNotification;
		manager!.sendRequest = vi.fn(async (method, params) => {
			if (method === M.TURN_START) {
				manager!.requests.push({method, params});
				return {turn: {id: 'turn-early', items: [], status: 'inProgress'}};
			}
			return originalSendRequest(method, params);
		});

		const promptPromise = runtime.sendPrompt('Interruptible turn');
		await new Promise(resolve => setTimeout(resolve, 0));
		runtime.sendInterrupt();

		expect(sendNotification).toHaveBeenCalledWith(M.TURN_INTERRUPT, {
			threadId: 'th-1',
			turnId: 'turn-early',
		});

		manager!.emit('notification', {
			method: 'turn/completed',
			params: {
				threadId: 'th-1',
				turn: {id: 'turn-early', items: [], status: 'cancelled'},
			},
		});

		await expect(promptPromise).resolves.toBeUndefined();
	});
});
