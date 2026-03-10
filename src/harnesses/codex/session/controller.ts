import type {Runtime} from '../../../core/runtime/types';
import type {
	CreateSessionControllerInput,
	SessionController,
	SessionControllerTurnResult,
} from '../../contracts/session';
import type {CodexRuntime} from '../runtime/server';
import {
	NULL_TOKENS,
	readTokenUsage,
} from '../runtime/tokenUsage';

export function createCodexSessionController(
	input: CreateSessionControllerInput,
): SessionController {
	const runtime = input.runtime as (Runtime & Partial<CodexRuntime>) | null;

	return {
		async startTurn({
			prompt,
			sessionId,
		}): Promise<SessionControllerTurnResult> {
			if (!runtime || typeof runtime.sendPrompt !== 'function') {
				return {
					exitCode: null,
					error: new Error('Codex runtime not available'),
					tokens: {...NULL_TOKENS},
					streamMessage: null,
				};
			}

			let message = '';
			let tokenDelta = {...NULL_TOKENS};
			const unsubscribe = runtime.onEvent(event => {
				const data =
					typeof event.data === 'object' && event.data !== null
						? (event.data as Record<string, unknown>)
						: {};

				if (event.kind === 'message.delta') {
					const delta = typeof data['delta'] === 'string' ? data['delta'] : '';
					message += delta;
				}

				if (event.kind === 'usage.update') {
					tokenDelta = readTokenUsage(data['delta']);
				}
			});

			try {
				await runtime.sendPrompt(prompt, sessionId);
				return {
					exitCode: 0,
					error: null,
					tokens: tokenDelta,
					streamMessage: message || null,
				};
			} catch (error) {
				return {
					exitCode: null,
					error: error instanceof Error ? error : new Error(String(error)),
					tokens: tokenDelta,
					streamMessage: message || null,
				};
			} finally {
				unsubscribe();
			}
		},

		interrupt(): void {
			runtime?.sendInterrupt?.();
		},

		async kill(): Promise<void> {
			runtime?.sendInterrupt?.();
		},
	};
}
