import {useCallback, useEffect, useRef, useState} from 'react';
import type {Runtime} from '../../../core/runtime/types';
import type {
	HarnessProcessConfig,
	HarnessProcessOptions,
	HarnessProcessOverride,
	TurnContinuation,
	TurnExecutionResult,
} from '../../../core/runtime/process';
import type {WorkflowPlan} from '../../../core/workflows';
import type {TokenUsage} from '../../../shared/types/headerMetrics';
import type {CodexRuntime} from '../runtime/server';
import {NULL_TOKENS, readTokenUsage} from '../runtime/tokenUsage';
import {buildCodexPromptOptions} from './promptOptions';

/**
 * Hook-backed session controller for Codex.
 *
 * Codex runs as a long-lived app-server, so the shared runtime owns transport
 * and this hook only projects that into Athena's shell-friendly state shape.
 */
export function useCodexSessionController(
	runtime: Runtime | null,
	processConfig?: HarnessProcessConfig,
	workflowPlan?: WorkflowPlan,
	ephemeral?: boolean,
	options?: HarnessProcessOptions,
	pluginMcpConfig?: string,
) {
	const [isRunning, setIsRunning] = useState(false);
	const [tokenUsage, setTokenUsage] = useState<TokenUsage>(
		() => options?.initialTokens ?? NULL_TOKENS,
	);
	const abortRef = useRef<AbortController>(new AbortController());
	const onExitTokensRef = useRef(options?.onExitTokens);
	onExitTokensRef.current = options?.onExitTokens;
	const onLifecycleEventRef = useRef(options?.onLifecycleEvent);
	onLifecycleEventRef.current = options?.onLifecycleEvent;
	const activeTurnPromiseRef = useRef<Promise<TurnExecutionResult> | null>(
		null,
	);

	const codexRuntime = runtime as CodexRuntime | null;

	const sendInterrupt = useCallback((): void => {
		codexRuntime?.sendInterrupt();
	}, [codexRuntime]);

	const kill = useCallback(async (): Promise<void> => {
		codexRuntime?.sendInterrupt();
		await activeTurnPromiseRef.current?.catch(() => {});
		if (!abortRef.current.signal.aborted) {
			setIsRunning(false);
		}
	}, [codexRuntime]);

	const spawn = useCallback(
		async (
			prompt: string,
			continuation?: TurnContinuation,
			_configOverride?: HarnessProcessOverride,
		): Promise<TurnExecutionResult> => {
			if (!codexRuntime) {
				onLifecycleEventRef.current?.({
					type: 'spawn_error',
					message: 'Codex runtime not available',
					failureCode: 'spawn_error',
				});
				return {
					exitCode: null,
					error: new Error('Codex runtime not available'),
					tokens: {...NULL_TOKENS},
					streamMessage: null,
				};
			}

			setIsRunning(true);
			let streamedMessage = '';
			let turnTokens = {...NULL_TOKENS};
			const unsubscribe = codexRuntime.onEvent(event => {
				const data =
					typeof event.data === 'object'
						? (event.data as Record<string, unknown>)
						: {};

				if (event.kind === 'message.delta') {
					const delta = typeof data['delta'] === 'string' ? data['delta'] : '';
					streamedMessage += delta;
				}

				if (event.kind === 'usage.update') {
					turnTokens = readTokenUsage(data['delta']);
				}
			});

			const turnPromise = (async (): Promise<TurnExecutionResult> => {
				try {
					await codexRuntime.sendPrompt(
						prompt,
						buildCodexPromptOptions({
							processConfig,
							continuation,
							configOverride: _configOverride,
							workflowPlan,
							pluginMcpConfig,
							ephemeral,
						}),
					);
					return {
						exitCode: 0,
						error: null,
						tokens: turnTokens,
						streamMessage: streamedMessage || null,
					};
				} catch (error) {
					if (!abortRef.current.signal.aborted) {
						onLifecycleEventRef.current?.({
							type: 'spawn_error',
							message:
								error instanceof Error ? error.message : 'Unknown Codex error',
							failureCode: 'spawn_error',
						});
					}
					return {
						exitCode: null,
						error:
							error instanceof Error ? error : new Error('Unknown Codex error'),
						tokens: turnTokens,
						streamMessage: streamedMessage || null,
					};
				} finally {
					activeTurnPromiseRef.current = null;
					unsubscribe();
					if (!abortRef.current.signal.aborted) {
						setIsRunning(false);
					}
				}
			})();

			activeTurnPromiseRef.current = turnPromise;
			return await turnPromise;
		},
		[codexRuntime, processConfig, workflowPlan, pluginMcpConfig, ephemeral],
	);

	useEffect(() => {
		if (!runtime) return;

		const unsub = runtime.onEvent(event => {
			if (abortRef.current.signal.aborted || event.kind !== 'usage.update') {
				return;
			}

			const data =
				typeof event.data === 'object'
					? (event.data as Record<string, unknown>)
					: {};
			const next = readTokenUsage(data['usage']);
			setTokenUsage(next);
			onExitTokensRef.current?.(next);
		});

		return unsub;
	}, [runtime]);

	useEffect(() => {
		abortRef.current = new AbortController();
		return () => {
			abortRef.current.abort();
		};
	}, []);

	return {startTurn: spawn, isRunning, sendInterrupt, kill, tokenUsage};
}
