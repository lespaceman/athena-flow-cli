import {EventEmitter} from 'node:events';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createCodexServer} from '../server';
import type {RuntimeEvent} from '../../../../core/runtime/types';
import * as M from '../../protocol/methods';

const mockAgentResult = vi.hoisted(() => ({
	current: undefined as
		| {
				agentConfigEdits: Array<{
					keyPath: string;
					value: unknown;
					mergeStrategy: string;
				}>;
				tempDir: string;
				agentNames: string[];
				errors: Array<{path: string; message: string}>;
		  }
		| undefined,
}));

vi.mock('../agentConfig', () => ({
	resolveCodexAgentConfig: () => mockAgentResult.current,
	buildAgentRemovalEdits: (names: string[]) =>
		names.map(name => ({
			keyPath: `agents.${name}`,
			value: null,
			mergeStrategy: 'replace',
		})),
	cleanupAgentConfig: () => {},
}));

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

			if (method === 'plugin/read') {
				const pluginName = params?.['pluginName'];
				const installed = this.requests.some(
					request =>
						request.method === 'plugin/install' &&
						request.params?.['pluginName'] === pluginName,
				);
				return {
					plugin: {
						marketplaceName: 'athena-workflow-marketplace',
						summary: {
							installed,
						},
					},
				};
			}

			if (method === 'plugin/install') {
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

			if (method === 'config/batchWrite') {
				return {};
			}

			if (method === 'config/mcpServer/reload') {
				return {};
			}

			if (method === 'model/list') {
				const cursor =
					typeof params?.['cursor'] === 'string' ? params['cursor'] : null;
				if (cursor === 'page-2') {
					return {
						data: [
							{
								id: 'gpt-5-mini',
								model: 'gpt-5-mini',
								displayName: 'GPT-5 Mini',
								description: 'Smaller fast model',
								hidden: false,
								isDefault: false,
							},
						],
						nextCursor: null,
					};
				}
				return {
					data: [
						{
							id: 'gpt-5.4',
							model: 'gpt-5.4',
							displayName: 'GPT-5.4',
							description: 'Latest frontier agentic coding model',
							hidden: false,
							isDefault: true,
						},
					],
					nextCursor: 'page-2',
				};
			}

			throw new Error(`Unexpected request: ${method}`);
		}
	},
}));

describe('createCodexServer', () => {
	beforeEach(() => {
		mockState.current = null;
		mockAgentResult.current = undefined;
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

	it('lists models through the app-server and follows pagination', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		const models = await runtime.listModels();

		expect(models).toEqual([
			expect.objectContaining({
				model: 'gpt-5.4',
				displayName: 'GPT-5.4',
				isDefault: true,
			}),
			expect.objectContaining({
				model: 'gpt-5-mini',
				displayName: 'GPT-5 Mini',
				isDefault: false,
			}),
		]);

		const manager = mockState.current;
		expect(manager?.requests.filter(r => r.method === M.MODEL_LIST)).toEqual([
			{
				method: M.MODEL_LIST,
				params: {limit: 100, includeHidden: false},
			},
			{
				method: M.MODEL_LIST,
				params: {limit: 100, includeHidden: false, cursor: 'page-2'},
			},
		]);
	});

	it('hydrates thread startup with native workflow plugin install and mcp config', async () => {
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
			plugins: [
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
				},
			],
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
					method: 'plugin/install',
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
				expect.objectContaining({
					method: 'turn/start',
					params: expect.objectContaining({
						input: [
							{
								type: 'text',
								text: 'Hello Codex',
								text_elements: [],
							},
							{
								type: 'mention',
								name: 'plugin-a',
								path: 'plugin://plugin-a@athena-workflow-marketplace',
							},
						],
					}),
				}),
			]),
		);
		expect(
			manager!.requests.find(request => request.method === 'thread/start')
				?.params?.['developerInstructions'],
		).toEqual('Use the workflow tracker.');
		expect(events.some(event => event.hookName === 'skills.loaded')).toBe(
			false,
		);
	});

	it('ensures workflow plugins before turn start without Athena-side skill routing', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		await runtime.sendPrompt('Hello Codex', {
			plugins: [
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
				},
			],
			config: {},
		});

		const manager = mockState.current;
		expect(manager).not.toBeNull();
		const methodOrder = manager!.requests.map(request => request.method);
		expect(methodOrder).toEqual(
			expect.arrayContaining(['plugin/read', 'plugin/install', 'thread/start']),
		);
		expect(methodOrder.indexOf('plugin/install')).toBeLessThan(
			methodOrder.indexOf('thread/start'),
		);
		expect(methodOrder.indexOf('plugin/read')).toBeLessThan(
			methodOrder.indexOf('plugin/install'),
		);
		expect(methodOrder).not.toContain('skills/list');
		expect(
			manager!.requests.find(request => request.method === 'turn/start')
				?.params?.['input'],
		).toEqual([
			{type: 'text', text: 'Hello Codex', text_elements: []},
			{
				type: 'mention',
				name: 'plugin-a',
				path: 'plugin://plugin-a@athena-workflow-marketplace',
			},
		]);
		expect(
			manager!.requests.find(request => request.method === 'thread/start')
				?.params?.['config'],
		).toEqual({});
	});

	it('preserves plugin mentions on reuse-current turns after the thread is already configured', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		await runtime.sendPrompt('Hello Codex', {
			plugins: [
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
				},
			],
			config: {},
		});
		await runtime.sendPrompt('Hello again', {
			continuation: {mode: 'reuse-current'},
			plugins: [
				{
					ref: 'plugin-a@owner/repo',
					pluginName: 'plugin-a',
					marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
				},
			],
		});

		const manager = mockState.current;
		expect(manager).not.toBeNull();
		const secondTurnRequest = manager!.requests
			.filter(request => request.method === 'turn/start')
			.at(1);
		expect(secondTurnRequest?.params?.['input']).toEqual([
			{type: 'text', text: 'Hello again', text_elements: []},
			{
				type: 'mention',
				name: 'plugin-a',
				path: 'plugin://plugin-a@athena-workflow-marketplace',
			},
		]);
	});

	it('fails prompt startup when required workflow plugins cannot be verified as installed', async () => {
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
			if (method === 'plugin/read') {
				return {
					plugin: {
						summary: {
							installed: false,
						},
					},
				};
			}
			return originalSendRequest(method, params);
		});

		await expect(
			runtime.sendPrompt('Hello Codex', {
				plugins: [
					{
						ref: 'plugin-a@owner/repo',
						pluginName: 'plugin-a',
						marketplacePath: '/cache/repo/.agents/plugins/marketplace.json',
					},
				],
				config: {},
			}),
		).rejects.toThrow(/did not report workflow plugin as installed/i);

		expect(
			manager!.requests.some(request => request.method === 'thread/start'),
		).toBe(false);
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

	it('returns typed fallback results for known unsupported dynamic/auth Codex server requests', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		const manager = mockState.current;
		expect(manager).not.toBeNull();

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

	it('ignores skills/changed notifications now that workflow skills are passed natively', async () => {
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
		await runtime.sendPrompt('Hello Codex');

		const manager = mockState.current;
		expect(manager).not.toBeNull();
		const eventCountBefore = events.length;

		manager!.emit('notification', {
			method: M.SKILLS_CHANGED,
			params: {},
		});

		expect(events).toHaveLength(eventCountBefore);
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

	it('sends config/batchWrite with agent config when agentRoots contain agents', async () => {
		mockAgentResult.current = {
			agentConfigEdits: [
				{
					keyPath: 'features.multi_agent',
					value: true,
					mergeStrategy: 'replace',
				},
				{
					keyPath: 'agents.max_threads',
					value: 6,
					mergeStrategy: 'replace',
				},
				{
					keyPath: 'agents.max_depth',
					value: 1,
					mergeStrategy: 'replace',
				},
				{
					keyPath: 'agents.reviewer',
					value: {
						description: 'Reviews code',
						config_file: '/tmp/athena-agents-test/reviewer.toml',
					},
					mergeStrategy: 'upsert',
				},
			],
			tempDir: '/tmp/athena-agents-test',
			agentNames: ['reviewer'],
			errors: [],
		};

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
			agentRoots: ['/workflow/plugins/test-plugin/agents'],
		});

		const manager = mockState.current;
		expect(manager).not.toBeNull();

		// config/batchWrite should have been called with agent edits
		const batchWriteReq = manager!.requests.find(
			r => r.method === 'config/batchWrite',
		);
		expect(batchWriteReq).toBeDefined();
		expect(batchWriteReq!.params).toEqual({
			filePath: '/project/.codex/config.toml',
			edits: expect.arrayContaining([
				expect.objectContaining({
					keyPath: 'features.multi_agent',
					value: true,
				}),
				expect.objectContaining({
					keyPath: 'agents.reviewer',
					value: expect.objectContaining({
						description: 'Reviews code',
					}),
				}),
			]),
		});

		// config/mcpServer/reload should have been called after config/batchWrite
		const mcpReloadReq = manager!.requests.find(
			r => r.method === 'config/mcpServer/reload',
		);
		expect(mcpReloadReq).toBeDefined();

		// agents.loaded notification should have been emitted
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'notification',
					data: expect.objectContaining({
						title: 'Agents loaded',
						notification_type: 'agents.loaded',
						message: 'Loaded 1 workflow agent: reviewer.',
					}),
					hookName: M.AGENTS_LOADED,
				}),
			]),
		);
	});

	it('sends removal edits on workflow switch before loading new agents', async () => {
		// First workflow: has reviewer agent
		mockAgentResult.current = {
			agentConfigEdits: [
				{
					keyPath: 'features.multi_agent',
					value: true,
					mergeStrategy: 'replace',
				},
				{
					keyPath: 'agents.reviewer',
					value: {
						description: 'Reviews code',
						config_file: '/tmp/athena-agents-1/reviewer.toml',
					},
					mergeStrategy: 'upsert',
				},
			],
			tempDir: '/tmp/athena-agents-1',
			agentNames: ['reviewer'],
			errors: [],
		};

		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		await runtime.sendPrompt('First workflow turn', {
			agentRoots: ['/workflow/plugins/plugin-a/agents'],
		});

		// Switch to second workflow with explorer agent
		mockAgentResult.current = {
			agentConfigEdits: [
				{
					keyPath: 'features.multi_agent',
					value: true,
					mergeStrategy: 'replace',
				},
				{
					keyPath: 'agents.explorer',
					value: {
						description: 'Explores codebase',
						config_file: '/tmp/athena-agents-2/explorer.toml',
					},
					mergeStrategy: 'upsert',
				},
			],
			tempDir: '/tmp/athena-agents-2',
			agentNames: ['explorer'],
			errors: [],
		};

		await runtime.sendPrompt('Second workflow turn', {
			continuation: {mode: 'fresh', handle: ''},
			agentRoots: ['/workflow/plugins/plugin-b/agents'],
		});

		const manager = mockState.current;
		expect(manager).not.toBeNull();

		const batchWrites = manager!.requests.filter(
			r => r.method === 'config/batchWrite',
		);

		// Should have 3 config/batchWrite calls:
		// 1. Load reviewer
		// 2. Remove reviewer (workflow switch cleanup)
		// 3. Load explorer
		expect(batchWrites).toHaveLength(3);

		// Second call should contain removal edits
		expect(batchWrites[1]!.params).toEqual({
			filePath: '/project/.codex/config.toml',
			edits: expect.arrayContaining([
				expect.objectContaining({
					keyPath: 'agents.reviewer',
					value: null,
					mergeStrategy: 'replace',
				}),
			]),
		});

		// Third call should contain new agent
		expect(batchWrites[2]!.params).toEqual({
			filePath: '/project/.codex/config.toml',
			edits: expect.arrayContaining([
				expect.objectContaining({
					keyPath: 'agents.explorer',
				}),
			]),
		});
	});

	it('does not send config/batchWrite when agentRoots is empty', async () => {
		const runtime = createCodexServer({
			projectDir: '/project',
			instanceId: 1,
			binaryPath: 'codex',
		});

		await runtime.start();
		await runtime.sendPrompt('Hello Codex', {
			agentRoots: [],
		});

		const manager = mockState.current;
		expect(manager).not.toBeNull();

		const batchWrites = manager!.requests.filter(
			r => r.method === 'config/batchWrite',
		);
		expect(batchWrites).toHaveLength(0);
	});
});
