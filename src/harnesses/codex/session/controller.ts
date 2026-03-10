import type {Runtime} from '../../../core/runtime/types';
import type {HarnessProcessConfig} from '../../../core/runtime/process';
import type {
	CreateSessionControllerInput,
	SessionController,
	SessionControllerTurnResult,
} from '../../contracts/session';
import type {CodexRuntime} from '../runtime/server';
import {NULL_TOKENS, readTokenUsage} from '../runtime/tokenUsage';
import {buildCodexPromptOptions} from './promptOptions';

export function createCodexSessionController(
	input: CreateSessionControllerInput,
): SessionController {
	const runtime = input.runtime as (Runtime & CodexRuntime) | null;
	const processConfig = input.processConfig as HarnessProcessConfig | undefined;
	let activeTurnPromise: Promise<SessionControllerTurnResult> | null = null;

	return {
		async startTurn({
			prompt,
			continuation,
			configOverride,
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
					typeof event.data === 'object'
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

			const turnPromise = (async (): Promise<SessionControllerTurnResult> => {
				try {
					await runtime.sendPrompt(
						prompt,
						buildCodexPromptOptions({
							processConfig,
							continuation,
							configOverride,
							workflowPlan: input.workflowPlan,
							pluginMcpConfig: input.pluginMcpConfig,
							ephemeral: input.ephemeral,
						}),
					);
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
					activeTurnPromise = null;
				}
			})();
			activeTurnPromise = turnPromise;

			try {
				return await turnPromise;
			} finally {
				unsubscribe();
			}
		},

		interrupt(): void {
			runtime?.sendInterrupt();
		},

		async kill(): Promise<void> {
			runtime?.sendInterrupt();
			await activeTurnPromise?.catch(() => {});
		},
	};
}
