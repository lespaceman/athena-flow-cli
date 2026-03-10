import {useCallback, useEffect, useRef, useState} from 'react';
import type {Runtime} from '../../../core/runtime/types';
import type {
	HarnessProcessOptions,
	HarnessProcessOverride,
} from '../../../core/runtime/process';
import type {TokenUsage} from '../../../shared/types/headerMetrics';
import type {CodexRuntime} from '../runtime/server';
import {
	NULL_TOKENS,
	readTokenUsage,
} from '../runtime/tokenUsage';

/**
 * Hook-backed session controller for Codex.
 *
 * Codex runs as a long-lived app-server, so the shared runtime owns transport
 * and this hook only projects that into Athena's shell-friendly state shape.
 */
export function useCodexSessionController(
	runtime: Runtime | null,
	options?: HarnessProcessOptions,
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

	const codexRuntime = runtime as CodexRuntime | null;

	const sendInterrupt = useCallback((): void => {
		codexRuntime?.sendInterrupt();
	}, [codexRuntime]);

	const kill = useCallback(async (): Promise<void> => {
		codexRuntime?.sendInterrupt();
		if (!abortRef.current.signal.aborted) {
			setIsRunning(false);
		}
	}, [codexRuntime]);

	const spawn = useCallback(
		async (
			prompt: string,
			sessionId?: string,
			_configOverride?: HarnessProcessOverride,
		): Promise<void> => {
			if (!codexRuntime) {
				onLifecycleEventRef.current?.({
					type: 'spawn_error',
					message: 'Codex runtime not available',
					failureCode: 'spawn_error',
				});
				return;
			}

			setIsRunning(true);

			try {
				await codexRuntime.sendPrompt(prompt, sessionId);
			} catch (error) {
				if (!abortRef.current.signal.aborted) {
					onLifecycleEventRef.current?.({
						type: 'spawn_error',
						message:
							error instanceof Error
								? error.message
								: 'Unknown Codex error',
						failureCode: 'spawn_error',
					});
				}
			} finally {
				if (!abortRef.current.signal.aborted) {
					setIsRunning(false);
				}
			}
		},
		[codexRuntime],
	);

	useEffect(() => {
		if (!runtime) return;

		const unsub = runtime.onEvent(event => {
			if (abortRef.current.signal.aborted || event.kind !== 'usage.update') {
				return;
			}

			const data =
				typeof event.data === 'object' && event.data !== null
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

	return {spawn, isRunning, sendInterrupt, kill, tokenUsage};
}
