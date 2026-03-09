import type {
	Runtime,
	RuntimeEvent,
	RuntimeDecision,
	RuntimeEventHandler,
	RuntimeDecisionHandler,
	RuntimeStartupError,
} from '../../../core/runtime/types';
import {AppServerManager} from './appServerManager';
import {
	mapNotificationToRuntimeEvent,
	mapServerRequestToRuntimeEvent,
} from './mapper';
import {mapDecisionToCodexResult} from './decisionMapper';

type CodexServerOptions = {
	projectDir: string;
	instanceId: number;
	binaryPath?: string;
};

type PendingApproval = {
	event: RuntimeEvent;
	codexRequestId: number;
	timer: ReturnType<typeof setTimeout> | undefined;
};

export function createCodexServer(opts: CodexServerOptions) {
	const {projectDir, binaryPath} = opts;
	const handlers = new Set<RuntimeEventHandler>();
	const decisionHandlers = new Set<RuntimeDecisionHandler>();
	const pending = new Map<string, PendingApproval>();
	let manager: AppServerManager | null = null;
	let status: 'stopped' | 'running' = 'stopped';
	let lastError: RuntimeStartupError | null = null;
	let threadId: string | null = null;

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

	const runtime: Runtime & {_getPendingCount: () => number} = {
		async start(): Promise<void> {
			if (status === 'running') return;

			try {
				manager = new AppServerManager(binaryPath ?? 'codex', projectDir);

				manager.on('notification', msg => {
					const event = mapNotificationToRuntimeEvent(
						msg,
						threadId ?? '',
						projectDir,
					);
					emit(event);
				});

				manager.on('serverRequest', msg => {
					const event = mapServerRequestToRuntimeEvent(
						msg,
						threadId ?? '',
						projectDir,
					);

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
			for (const req of pending.values()) {
				if (req.timer) clearTimeout(req.timer);
			}
			pending.clear();

			if (manager) {
				manager.stop().catch(() => {});
				manager = null;
			}
			status = 'stopped';
			lastError = null;
			threadId = null;
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

		_getPendingCount() {
			return pending.size;
		},
	};

	return runtime;
}
