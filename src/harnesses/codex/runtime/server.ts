import type {
	Runtime,
	RuntimeEvent,
	RuntimeDecision,
	RuntimeEventHandler,
	RuntimeDecisionHandler,
	RuntimeStartupError,
} from '../../../core/runtime/types';
import type {TurnContinuation} from '../../../core/runtime/process';
import {AppServerManager} from './appServerManager';
import {
	mapNotificationToRuntimeEvent,
	mapServerRequestToRuntimeEvent,
} from './mapper';
import {mapDecisionToCodexResult} from './decisionMapper';
import {asRecord} from './eventTranslator';
import {resolveCodexSkillInstructions} from './skillInstructions';
import * as M from '../protocol/methods';
import {generateId} from '../../../shared/utils/id';

export type CodexServerOptions = {
	projectDir: string;
	instanceId: number;
	binaryPath?: string;
	env?: Record<string, string>;
};

export type CodexRuntime = Runtime & {
	/** Send a user prompt. Starts a thread if needed. Resolves on turn completion. */
	sendPrompt(
		prompt: string,
		options?: {
			continuation?: TurnContinuation;
			model?: string;
			developerInstructions?: string;
			skillRoots?: string[];
			config?: Record<string, unknown>;
			ephemeral?: boolean;
			approvalPolicy?: string;
			sandbox?: string;
		},
	): Promise<void>;
	/** Interrupt the currently running turn. */
	sendInterrupt(): void;
	_getPendingCount(): number;
};

type PendingApproval = {
	event: RuntimeEvent;
	codexRequestId: number;
	timer: ReturnType<typeof setTimeout> | undefined;
};

type PendingTurnCompletion = {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
	interruptTimer: ReturnType<typeof setTimeout> | null;
};

const INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;

function requireThreadId(value: unknown, method: string): string {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}

	throw new Error(`Codex ${method} did not return a thread id`);
}

/**
 * Item types whose ITEM_STARTED / ITEM_COMPLETED lifecycle notifications
 * are suppressed because they are either accumulated (agentMessage) or
 * redundant (userMessage is already shown as user.prompt).
 */
const SUPPRESSED_ITEM_TYPES = new Set(['userMessage', 'plan', 'reasoning']);

const IGNORED_NOTIFICATION_METHODS = new Set([
	M.THREAD_STATUS_CHANGED,
	M.TURN_DIFF_UPDATED,
]);

function shouldIgnoreNotificationMethod(method: string): boolean {
	return (
		method.startsWith('codex/event/') ||
		IGNORED_NOTIFICATION_METHODS.has(method)
	);
}

function getUnsupportedServerRequestResponse(method: string): {
	result?: unknown;
	error?: {code: number; message: string};
} {
	switch (method) {
		case M.MCP_SERVER_ELICITATION_REQUEST:
			return {result: {action: 'decline', content: null}};
		case M.DYNAMIC_TOOL_CALL:
			return {result: {contentItems: [], success: false}};
		case M.CHATGPT_AUTH_TOKENS_REFRESH:
			return {
				error: {
					code: -32601,
					message:
						'Athena does not implement ChatGPT auth token refresh for Codex app-server',
				},
			};
		default:
			return {
				error: {
					code: -32601,
					message: `Unsupported Codex server request: ${method}`,
				},
			};
	}
}

export function createCodexServer(opts: CodexServerOptions): CodexRuntime {
	const {projectDir, binaryPath, env} = opts;
	const handlers = new Set<RuntimeEventHandler>();
	const decisionHandlers = new Set<RuntimeDecisionHandler>();
	const pending = new Map<string, PendingApproval>();
	let manager: AppServerManager | null = null;
	let status: 'stopped' | 'running' = 'stopped';
	let lastError: RuntimeStartupError | null = null;
	let threadId: string | null = null;
	let turnId: string | null = null;
	let threadModel: string | null = null;
	let pendingTurnPrompt: string | null = null;
	let pendingTurnCompletion: PendingTurnCompletion | null = null;
	let configuredSkillRoots: string[] = [];

	function createPendingTurnCompletion(): PendingTurnCompletion {
		let settleResolve: (() => void) | null = null;
		let settleReject: ((error: Error) => void) | null = null;
		const promise = new Promise<void>((resolve, reject) => {
			settleResolve = resolve;
			settleReject = reject;
		});
		return {
			promise,
			resolve: () => {
				if (!settleResolve) return;
				const resolve = settleResolve;
				settleResolve = null;
				settleReject = null;
				resolve();
			},
			reject: (error: Error) => {
				if (!settleReject) return;
				const reject = settleReject;
				settleResolve = null;
				settleReject = null;
				reject(error);
			},
			interruptTimer: null,
		};
	}

	function emit(event: RuntimeEvent): void {
		for (const handler of handlers) {
			try {
				handler(event);
			} catch (err) {
				console.error(
					`[athena:codex] handler error processing ${event.hookName}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
	}

	function emitNotification(input: {
		hookName: string;
		message: string;
		title?: string;
		notificationType: string;
		payload?: unknown;
	}): void {
		emit({
			id: `codex-local-${generateId()}`,
			timestamp: Date.now(),
			kind: 'notification',
			data: {
				message: input.message,
				title: input.title,
				notification_type: input.notificationType,
			},
			hookName: input.hookName,
			sessionId: threadId ?? '',
			context: {cwd: projectDir, transcriptPath: ''},
			interaction: {expectsDecision: false},
			payload: input.payload,
		});
	}

	function notifyDecision(eventId: string, decision: RuntimeDecision): void {
		for (const handler of decisionHandlers) {
			try {
				handler(eventId, decision);
			} catch (err) {
				console.error(
					'[athena:codex] decision handler error:',
					err instanceof Error ? err.message : err,
				);
			}
		}
	}

	function clearPendingApprovals(): void {
		for (const req of pending.values()) {
			if (req.timer) clearTimeout(req.timer);
		}
		pending.clear();
	}

	function clearPendingTurn(error?: Error): void {
		pendingTurnPrompt = null;
		turnId = null;
		if (pendingTurnCompletion?.interruptTimer) {
			clearTimeout(pendingTurnCompletion.interruptTimer);
			pendingTurnCompletion.interruptTimer = null;
		}
		if (error) {
			pendingTurnCompletion?.reject(error);
		}
		pendingTurnCompletion = null;
	}

	function trackNotificationState(msg: {
		method: string;
		params?: unknown;
	}): void {
		if (msg.method === M.THREAD_STARTED) {
			const params = asRecord(msg.params);
			const thread = asRecord(params['thread']);
			if (thread['id']) {
				threadId = String(thread['id']);
			}
			return;
		}

		if (msg.method === M.TURN_STARTED) {
			const params = asRecord(msg.params);
			const turn = asRecord(params['turn']);
			if (turn['id']) {
				turnId = String(turn['id']);
			}
			return;
		}

		if (msg.method === M.TURN_COMPLETED) {
			turnId = null;
		}
	}

	function shouldSuppressItemLifecycle(msg: {
		method: string;
		params?: unknown;
	}): boolean {
		if (msg.method !== M.ITEM_STARTED && msg.method !== M.ITEM_COMPLETED) {
			return false;
		}

		const params = asRecord(msg.params);
		const item = asRecord(params['item']);
		return SUPPRESSED_ITEM_TYPES.has(item['type'] as string);
	}

	function augmentNotificationEvent(
		msg: {method: string},
		event: RuntimeEvent,
	): RuntimeEvent {
		const data = event.data as Record<string, unknown>;
		if (msg.method === M.THREAD_STARTED && threadModel) {
			event.data = {...data, model: threadModel};
			return event;
		}

		if (msg.method === M.TURN_STARTED && pendingTurnPrompt) {
			event.data = {...data, prompt: pendingTurnPrompt};
		}

		return event;
	}

	function resolveUnsupportedServerRequest(msg: {
		id: number;
		method: string;
	}): void {
		const response = getUnsupportedServerRequestResponse(msg.method);
		if (response.result !== undefined) {
			manager?.respondToServerRequest(msg.id, response.result);
			return;
		}
		if (response.error) {
			manager?.respondToServerRequestError(
				msg.id,
				response.error.code,
				response.error.message,
			);
		}
	}

	function combineDeveloperInstructions(
		base: string | undefined,
		skills: string | undefined,
	): string | undefined {
		if (base && skills) {
			return `${base}\n\n${skills}`;
		}

		return base ?? skills;
	}

	function buildSkillLoadMessage(input: {
		skillNames: string[];
		skillRoots: string[];
	}): string {
		const {skillNames, skillRoots} = input;
		if (skillNames.length === 0) {
			const rootLabel = skillRoots.length === 1 ? 'root' : 'roots';
			return `No workflow skills were loaded from ${skillRoots.length} configured skill ${rootLabel}.`;
		}

		const label = skillNames.length === 1 ? 'skill' : 'skills';
		return `Loaded ${skillNames.length} workflow ${label}: ${skillNames.join(', ')}.`;
	}

	const runtime: CodexRuntime = {
		async start(): Promise<void> {
			if (status === 'running') return;

			try {
				manager = new AppServerManager(binaryPath ?? 'codex', projectDir, env);

				manager.on('notification', msg => {
					if (shouldIgnoreNotificationMethod(msg.method)) {
						return;
					}
					if (
						msg.method === M.SKILLS_CHANGED &&
						configuredSkillRoots.length === 0
					) {
						return;
					}
					trackNotificationState(msg);

					if (shouldSuppressItemLifecycle(msg)) {
						return;
					}

					const event = augmentNotificationEvent(
						msg,
						mapNotificationToRuntimeEvent(msg, threadId ?? '', projectDir),
					);
					emit(event);
					if (msg.method === M.TURN_COMPLETED) {
						pendingTurnCompletion?.resolve();
						clearPendingTurn();
					}
				});

				manager.on('serverRequest', msg => {
					const event = mapServerRequestToRuntimeEvent(
						msg,
						threadId ?? '',
						projectDir,
					);

					if (event.kind === 'unknown') {
						emit(event);
						resolveUnsupportedServerRequest(msg);
						return;
					}

					let timer: ReturnType<typeof setTimeout> | undefined;
					if (event.interaction.defaultTimeoutMs) {
						timer = setTimeout(() => {
							const timeoutDecision: RuntimeDecision = {
								type: 'passthrough',
								source: 'timeout',
							};
							runtime.sendDecision(event.id, timeoutDecision);
						}, event.interaction.defaultTimeoutMs);
					}

					pending.set(event.id, {
						event,
						codexRequestId: msg.id,
						timer,
					});
					emit(event);
				});

				manager.on('error', err => {
					console.error('[athena:codex] manager error:', err.message);
				});

				manager.on('exit', (_code, _signal) => {
					clearPendingApprovals();
					clearPendingTurn(new Error('Codex process exited during turn'));
					status = 'stopped';
				});

				await manager.start();
				status = 'running';
				lastError = null;
			} catch (err) {
				status = 'stopped';
				lastError = {
					code: 'socket_bind_failed',
					message: err instanceof Error ? err.message : String(err),
				};
				console.error(`[athena:codex] failed to start: ${lastError.message}`);
			}
		},

		stop(): void {
			clearPendingApprovals();

			if (manager) {
				manager.removeAllListeners();
				manager.stop().catch(() => {});
				manager = null;
			}
			status = 'stopped';
			lastError = null;
			threadId = null;
			turnId = null;
			threadModel = null;
			configuredSkillRoots = [];
			clearPendingTurn(new Error('Codex runtime stopped'));
		},

		getStatus() {
			return status;
		},

		getLastError() {
			return lastError;
		},

		onEvent(handler: RuntimeEventHandler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},

		onDecision(handler: RuntimeDecisionHandler) {
			decisionHandlers.add(handler);
			return () => decisionHandlers.delete(handler);
		},

		sendDecision(eventId: string, decision: RuntimeDecision): void {
			const req = pending.get(eventId);
			if (!req) return;

			if (req.timer) clearTimeout(req.timer);
			pending.delete(eventId);

			const result = mapDecisionToCodexResult(req.event, decision);
			manager?.respondToServerRequest(req.codexRequestId, result);
			notifyDecision(eventId, decision);
		},

		async sendPrompt(
			prompt: string,
			options?: {
				continuation?: TurnContinuation;
				model?: string;
				developerInstructions?: string;
				skillRoots?: string[];
				config?: Record<string, unknown>;
				ephemeral?: boolean;
				approvalPolicy?: string;
				sandbox?: string;
			},
		): Promise<void> {
			if (!manager || status !== 'running') {
				throw new Error('Codex runtime not running');
			}
			if (pendingTurnCompletion) {
				throw new Error('Codex turn already in progress');
			}

			try {
				const continuation = options?.continuation;
				const approvalPolicy = options?.approvalPolicy ?? 'on-request';
				const sandbox = options?.sandbox ?? 'workspace-write';
				const skillRoots = options?.skillRoots?.filter(Boolean) ?? [];
				const shouldResume =
					continuation?.mode === 'resume' && continuation.handle.length > 0;
				const shouldStartFresh =
					continuation?.mode === 'fresh' || continuation == null;
				const shouldReuseCurrent = continuation?.mode === 'reuse-current';
				const shouldConfigureThread =
					shouldResume || shouldStartFresh || (shouldReuseCurrent && !threadId);
				let skillInstructions: string | undefined;
				if (shouldConfigureThread) {
					configuredSkillRoots = skillRoots;
					try {
						const skillResolution = await resolveCodexSkillInstructions({
							manager,
							projectDir,
							skillRoots,
						});
						skillInstructions = skillResolution.instructions;
						if (skillRoots.length > 0) {
							emitNotification({
								hookName: M.SKILLS_LIST,
								title: 'Skills loaded',
								message: buildSkillLoadMessage({
									skillNames: skillResolution.skills.map(skill => skill.name),
									skillRoots,
								}),
								notificationType: 'skills.loaded',
								payload: {
									skillRoots,
									skills: skillResolution.skills,
								},
							});
						}
					} catch (error) {
						console.error(
							`[athena:codex] failed to scan workflow skills: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}
				const developerInstructions = shouldConfigureThread
					? combineDeveloperInstructions(
							options?.developerInstructions,
							skillInstructions,
						)
					: options?.developerInstructions;
				// Resume a thread or start a new one
				if (shouldResume) {
					const result = await manager.sendRequest(M.THREAD_RESUME, {
						threadId: continuation.handle,
						approvalPolicy,
						sandbox,
						cwd: projectDir,
						...(options?.model ? {model: options.model} : {}),
						...(developerInstructions ? {developerInstructions} : {}),
						...(options?.config ? {config: options.config} : {}),
						persistExtendedHistory: !options?.ephemeral,
					});
					const response = asRecord(result);
					const thread = asRecord(response['thread'] ?? result);
					threadId = requireThreadId(thread['id'], M.THREAD_RESUME);
					threadModel =
						typeof response['model'] === 'string'
							? response['model']
							: threadModel;
				} else if (shouldStartFresh || !threadId) {
					threadId = null;
					turnId = null;
					const result = await manager.sendRequest(M.THREAD_START, {
						approvalPolicy,
						sandbox,
						cwd: projectDir,
						...(options?.model ? {model: options.model} : {}),
						...(developerInstructions ? {developerInstructions} : {}),
						...(options?.config ? {config: options.config} : {}),
						experimentalRawEvents: false,
						...(options?.ephemeral ? {ephemeral: true} : {}),
						persistExtendedHistory: !options?.ephemeral,
					});
					const response = asRecord(result);
					const thread = asRecord(response['thread'] ?? result);
					threadId = requireThreadId(thread['id'], M.THREAD_START);
					threadModel =
						typeof response['model'] === 'string'
							? response['model']
							: threadModel;
				}

				const turnCompletion = createPendingTurnCompletion();
				pendingTurnCompletion = turnCompletion;
				pendingTurnPrompt = prompt;

				// Start a turn with the user prompt.
				// Note: sandbox is intentionally omitted here. The Codex protocol's
				// TurnStartParams accepts `sandboxPolicy` (a structured SandboxPolicy
				// union type), which is different from the simple SandboxMode string
				// accepted by thread/start and thread/resume. The sandbox is already
				// configured at thread creation/resume time, and turns inherit it.
				// The per-turn `sandboxPolicy` override is for fine-grained control
				// that we don't currently need.
				const result = await manager.sendRequest(M.TURN_START, {
					threadId,
					input: [{type: 'text', text: prompt, text_elements: []}],
					cwd: projectDir,
					approvalPolicy,
					...(options?.model ? {model: options.model} : {}),
				});
				const response = asRecord(result);
				const turn = asRecord(response['turn'] ?? result);
				if (turn['id']) {
					turnId = String(turn['id']);
				}

				await turnCompletion.promise;
			} catch (error) {
				clearPendingTurn();
				throw error;
			}
		},

		sendInterrupt(): void {
			if (!manager || !threadId || !turnId) return;
			manager.sendNotification(M.TURN_INTERRUPT, {threadId, turnId});
			if (
				pendingTurnCompletion &&
				pendingTurnCompletion.interruptTimer === null
			) {
				pendingTurnCompletion.interruptTimer = setTimeout(() => {
					if (!pendingTurnCompletion) {
						return;
					}
					clearPendingTurn(new Error('Codex turn interrupt timed out'));
				}, INTERRUPT_SETTLE_TIMEOUT_MS);
			}
		},

		_getPendingCount() {
			return pending.size;
		},
	};

	return runtime;
}
