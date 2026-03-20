import {useCallback, useEffect, useRef, useState} from 'react';
import {type ChildProcess} from 'node:child_process';
import {spawnClaude} from './spawn';
import {type UseClaudeProcessResult} from './types';
import {
	type IsolationConfig,
	type IsolationPreset,
	resolveIsolationConfig,
} from '../config/isolation';
import type {TokenUsage} from '../../../shared/types/headerMetrics';
import {createTokenAccumulator} from './tokenAccumulator';
import type {WorkflowConfig} from '../../../core/workflows/types';
import type {
	HarnessProcessLifecycleEvent,
	HarnessProcessFailureCode,
	TokenUsageParserFactory,
	TurnContinuation,
	TurnExecutionResult,
} from '../../../core/runtime/process';
import {createAssistantMessageAccumulator} from '../session/assistantMessageAccumulator';

export type {UseClaudeProcessResult};

/**
 * Merge isolation layers: base preset -> per-command override -> workflow/plugin MCP config.
 * Workflow/plugin mcpConfig must win to ensure selected workflow MCP settings are always applied.
 * Returns the original preset unchanged when no overrides are needed.
 */
function mergeIsolation(
	base: IsolationConfig | IsolationPreset | undefined,
	pluginMcpConfig: string | undefined,
	perCommand: Partial<IsolationConfig> | undefined,
): IsolationConfig | IsolationPreset | undefined {
	if (!pluginMcpConfig && !perCommand) return base;

	return {
		...resolveIsolationConfig(base),
		...(perCommand ?? {}),
		...(pluginMcpConfig ? {mcpConfig: pluginMcpConfig} : {}),
	};
}

// Maximum output lines to keep in memory to prevent unbounded growth
const MAX_OUTPUT = 1000;
// Timeout for waiting for process to exit during kill
const KILL_TIMEOUT_MS = 3000;

const NULL_TOKENS: TokenUsage = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
	contextWindowSize: null,
};

function extractFailureCode(
	error: unknown,
): HarnessProcessFailureCode | undefined {
	if (
		error &&
		typeof error === 'object' &&
		'failureCode' in error &&
		typeof (error as {failureCode?: unknown}).failureCode === 'string'
	) {
		return (error as {failureCode: HarnessProcessFailureCode}).failureCode;
	}
	return undefined;
}

function inferFailureCodeFromMessage(
	message: string,
): HarnessProcessFailureCode | undefined {
	const normalized = message.toLowerCase();
	if (normalized.includes('socket path is too long')) {
		return 'socket_path_too_long';
	}
	if (normalized.includes('hook forwarder')) {
		return 'hook_forwarder_missing';
	}
	if (
		normalized.includes('socket not found') ||
		normalized.includes('stale socket')
	) {
		return 'hook_server_unavailable';
	}
	return undefined;
}

function tokenUsageEquals(a: TokenUsage, b: TokenUsage): boolean {
	return (
		a.input === b.input &&
		a.output === b.output &&
		a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite &&
		a.total === b.total &&
		a.contextSize === b.contextSize &&
		a.contextWindowSize === b.contextWindowSize
	);
}

/**
 * React hook to manage Claude headless process lifecycle.
 *
 * Spawns Claude Code with `-p` flag and tracks its state.
 * Hook events are received via the separate hook server (useHookServer).
 *
 * By default, uses strict isolation (user settings only, athena hooks injected).
 */
// jq filter that extracts text content from assistant messages
const JQ_ASSISTANT_TEXT_FILTER =
	'select(.type == "message" and .role == "assistant") | .content[] | select(.type == "text") | .text';

function resolveClaudeSessionId(
	continuation: TurnContinuation | undefined,
): string | undefined {
	if (!continuation || continuation.mode === 'fresh') {
		return undefined;
	}

	if (continuation.mode === 'resume') {
		return continuation.handle;
	}

	throw new Error(
		'Claude process hook does not support reuse-current continuation',
	);
}

export type UseClaudeProcessOptions = {
	initialTokens?: TokenUsage | null;
	onExitTokens?: (tokens: TokenUsage) => void;
	onLifecycleEvent?: (event: HarnessProcessLifecycleEvent) => void;
	/** Keep raw stdout/stderr lines in React state (expensive for high-volume streams). */
	trackOutput?: boolean;
	/** Keep jq-filtered assistant text in React state (debug-only). */
	trackStreamingText?: boolean;
	/** Minimum interval for tokenUsage state updates. 0 = update on every chunk. */
	tokenUpdateMs?: number;
	/** Parser strategy for streaming token usage extraction. */
	tokenParserFactory?: TokenUsageParserFactory;
};

export function useClaudeProcess(
	projectDir: string,
	instanceId: number,
	isolation?: IsolationConfig | IsolationPreset,
	pluginMcpConfig?: string,
	verbose?: boolean,
	workflow?: WorkflowConfig,
	options?: UseClaudeProcessOptions,
): UseClaudeProcessResult {
	const processRef = useRef<ChildProcess | null>(null);
	const abortRef = useRef<AbortController>(new AbortController());
	const exitResolverRef = useRef<(() => void) | null>(null);
	const tokenAccRef = useRef(
		(options?.tokenParserFactory ?? createTokenAccumulator)(),
	);
	const tokenBaseRef = useRef({
		input: options?.initialTokens?.input ?? 0,
		output: options?.initialTokens?.output ?? 0,
		cacheRead: options?.initialTokens?.cacheRead ?? 0,
		cacheWrite: options?.initialTokens?.cacheWrite ?? 0,
	});
	const [isRunning, setIsRunning] = useState(false);
	const [output, setOutput] = useState<string[]>([]);
	const [streamingText, setStreamingText] = useState('');
	const onExitTokensRef = useRef(options?.onExitTokens);
	onExitTokensRef.current = options?.onExitTokens;
	const onLifecycleEventRef = useRef(options?.onLifecycleEvent);
	onLifecycleEventRef.current = options?.onLifecycleEvent;
	const trackOutputRef = useRef(options?.trackOutput ?? true);
	trackOutputRef.current = options?.trackOutput ?? true;
	const trackStreamingTextRef = useRef(options?.trackStreamingText ?? true);
	trackStreamingTextRef.current = options?.trackStreamingText ?? true;
	const tokenUpdateMsRef = useRef(Math.max(0, options?.tokenUpdateMs ?? 0));
	tokenUpdateMsRef.current = Math.max(0, options?.tokenUpdateMs ?? 0);
	const [tokenUsage, setTokenUsage] = useState<TokenUsage>(
		() => options?.initialTokens ?? NULL_TOKENS,
	);
	const tokenUsageRef = useRef(tokenUsage);
	tokenUsageRef.current = tokenUsage;
	const pendingTokenUsageRef = useRef<TokenUsage | null>(null);
	const tokenUsageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastStderrRef = useRef('');
	const reportedFailureRef = useRef(false);

	const clearTokenUsageTimer = useCallback(() => {
		if (!tokenUsageTimerRef.current) return;
		clearTimeout(tokenUsageTimerRef.current);
		tokenUsageTimerRef.current = null;
	}, []);

	const publishTokenUsage = useCallback(
		(nextUsage: TokenUsage, forceImmediate = false) => {
			const intervalMs = tokenUpdateMsRef.current;
			if (!forceImmediate && intervalMs > 0) {
				pendingTokenUsageRef.current = nextUsage;
				if (tokenUsageTimerRef.current) return;
				tokenUsageTimerRef.current = setTimeout(() => {
					tokenUsageTimerRef.current = null;
					const pending = pendingTokenUsageRef.current;
					if (!pending || abortRef.current.signal.aborted) return;
					if (tokenUsageEquals(tokenUsageRef.current, pending)) {
						pendingTokenUsageRef.current = null;
						return;
					}
					setTokenUsage(pending);
					pendingTokenUsageRef.current = null;
				}, intervalMs);
				return;
			}

			clearTokenUsageTimer();
			pendingTokenUsageRef.current = null;
			if (abortRef.current.signal.aborted) return;
			if (tokenUsageEquals(tokenUsageRef.current, nextUsage)) return;
			setTokenUsage(nextUsage);
		},
		[clearTokenUsageTimer],
	);

	const sendInterrupt = useCallback((): void => {
		if (!processRef.current) return;
		processRef.current.kill('SIGINT');
	}, []);

	const kill = useCallback(async (): Promise<void> => {
		if (!processRef.current) {
			return;
		}

		// Create promise to wait for process exit
		const exitPromise = new Promise<void>(resolve => {
			exitResolverRef.current = resolve;
		});

		// Set a timeout fallback in case process doesn't exit cleanly
		let timeoutId: ReturnType<typeof setTimeout>;
		const timeoutPromise = new Promise<void>(resolve => {
			timeoutId = setTimeout(resolve, KILL_TIMEOUT_MS);
		});

		processRef.current.kill();

		// Wait for exit or timeout
		await Promise.race([exitPromise, timeoutPromise]);

		// Clean up timeout to prevent memory leak
		clearTimeout(timeoutId!);

		// Clean up
		exitResolverRef.current = null;
		processRef.current = null;
		if (!abortRef.current.signal.aborted) {
			setIsRunning(false);
		}
	}, []);

	const spawn = useCallback(
		async (
			prompt: string,
			continuation?: TurnContinuation,
			perCallIsolation?: Partial<IsolationConfig>,
		): Promise<TurnExecutionResult> => {
			// Kill existing process if running and wait for it to exit
			await kill();

			if (trackOutputRef.current) {
				setOutput([]);
			}
			if (trackStreamingTextRef.current) {
				setStreamingText('');
			}
			setIsRunning(true);
			tokenAccRef.current.reset();
			clearTokenUsageTimer();
			pendingTokenUsageRef.current = null;
			lastStderrRef.current = '';
			reportedFailureRef.current = false;
			// Capture cumulative base before this spawn (input/output/cache carry forward,
			// contextSize resets per-process since the new process reports its own).
			const current = tokenUsageRef.current;
			tokenBaseRef.current = {
				input: current.input ?? 0,
				output: current.output ?? 0,
				cacheRead: current.cacheRead ?? 0,
				cacheWrite: current.cacheWrite ?? 0,
			};
			const messageAccumulator = createAssistantMessageAccumulator();

			return await new Promise<TurnExecutionResult>(resolve => {
				const finalize = (exitCode: number | null, error: Error | null) => {
					tokenAccRef.current.flush();
					messageAccumulator.flush();
					const finalAcc = tokenAccRef.current.getUsage();
					if (!abortRef.current.signal.aborted) {
						const base = tokenBaseRef.current;
						publishTokenUsage(
							{
								input: (base.input || 0) + (finalAcc.input ?? 0) || null,
								output: (base.output || 0) + (finalAcc.output ?? 0) || null,
								cacheRead:
									(base.cacheRead || 0) + (finalAcc.cacheRead ?? 0) || null,
								cacheWrite:
									(base.cacheWrite || 0) + (finalAcc.cacheWrite ?? 0) || null,
								total:
									(base.input || 0) +
										(finalAcc.input ?? 0) +
										(base.output || 0) +
										(finalAcc.output ?? 0) +
										(base.cacheRead || 0) +
										(finalAcc.cacheRead ?? 0) +
										(base.cacheWrite || 0) +
										(finalAcc.cacheWrite ?? 0) || null,
								contextSize: finalAcc.contextSize,
								contextWindowSize: finalAcc.contextWindowSize,
							},
							true,
						);
					}
					onExitTokensRef.current?.(finalAcc);

					if (exitResolverRef.current) {
						exitResolverRef.current();
						exitResolverRef.current = null;
					}
					processRef.current = null;

					if (!abortRef.current.signal.aborted) {
						setIsRunning(false);
						if (trackOutputRef.current && exitCode !== 0 && exitCode !== null) {
							setOutput(prev => [...prev, `[exit code: ${exitCode}]`]);
						}
					}

					resolve({
						exitCode,
						error,
						tokens: finalAcc,
						streamMessage: messageAccumulator.getLastMessage(),
					});
				};

				try {
					const child = spawnClaude({
						prompt,
						projectDir,
						instanceId,
						sessionId: resolveClaudeSessionId(continuation),
						isolation: mergeIsolation(
							isolation,
							pluginMcpConfig,
							perCallIsolation,
						),
						env: workflow?.env,
						...(verbose
							? {
									jqFilter: JQ_ASSISTANT_TEXT_FILTER,
									onFilteredStdout: (data: string) => {
										if (abortRef.current.signal.aborted) return;
										if (!trackStreamingTextRef.current) return;
										setStreamingText(prev => prev + data);
									},
									onJqStderr: (data: string) => {
										if (abortRef.current.signal.aborted) return;
										if (!trackOutputRef.current) return;
										setOutput(prev => [...prev, `[jq] ${data}`]);
									},
								}
							: {}),
						onStdout: (data: string) => {
							if (abortRef.current.signal.aborted) return;
							tokenAccRef.current.feed(data);
							messageAccumulator.feed(data);
							const acc = tokenAccRef.current.getUsage();
							const base = tokenBaseRef.current;
							publishTokenUsage({
								input: (base.input || 0) + (acc.input ?? 0) || null,
								output: (base.output || 0) + (acc.output ?? 0) || null,
								cacheRead: (base.cacheRead || 0) + (acc.cacheRead ?? 0) || null,
								cacheWrite:
									(base.cacheWrite || 0) + (acc.cacheWrite ?? 0) || null,
								total:
									(base.input || 0) +
										(acc.input ?? 0) +
										(base.output || 0) +
										(acc.output ?? 0) +
										(base.cacheRead || 0) +
										(acc.cacheRead ?? 0) +
										(base.cacheWrite || 0) +
										(acc.cacheWrite ?? 0) || null,
								contextSize: acc.contextSize,
								contextWindowSize: acc.contextWindowSize,
							});

							if (!trackOutputRef.current) return;
							setOutput(prev => {
								const updated = [...prev, data];
								return updated.length > MAX_OUTPUT
									? updated.slice(-MAX_OUTPUT)
									: updated;
							});
						},
						onStderr: (data: string) => {
							if (abortRef.current.signal.aborted) return;
							// Keep the first stderr chunk as the root cause.
							// Later chunks (e.g. "Hook cancelled") are cascading failures.
							if (!lastStderrRef.current) {
								lastStderrRef.current = data.trim();
							}
							if (!trackOutputRef.current) return;
							setOutput(prev => {
								const updated = [...prev, `[stderr] ${data}`];
								return updated.length > MAX_OUTPUT
									? updated.slice(-MAX_OUTPUT)
									: updated;
							});
						},
						onExit: (code: number | null) => {
							if (code !== null && code !== 0 && !reportedFailureRef.current) {
								reportedFailureRef.current = true;
								const stderrDetail = lastStderrRef.current
									? ` Stderr: ${lastStderrRef.current}`
									: '';
								onLifecycleEventRef.current?.({
									type: 'exit_nonzero',
									code,
									message: `Claude exited with code ${code}.${stderrDetail}`,
									failureCode: inferFailureCodeFromMessage(
										lastStderrRef.current,
									),
								});
							}
							finalize(code, null);
						},
						onError: (error: Error) => {
							if (!reportedFailureRef.current) {
								reportedFailureRef.current = true;
								onLifecycleEventRef.current?.({
									type: 'spawn_error',
									message: error.message,
									failureCode:
										extractFailureCode(error) ??
										inferFailureCodeFromMessage(error.message),
								});
							}
							if (!abortRef.current.signal.aborted && trackOutputRef.current) {
								setOutput(prev => [...prev, `[error] ${error.message}`]);
							}
							finalize(null, error);
						},
					});

					processRef.current = child;
				} catch (error) {
					const resolvedError =
						error instanceof Error ? error : new Error('Unknown spawn failure');
					if (!reportedFailureRef.current) {
						reportedFailureRef.current = true;
						onLifecycleEventRef.current?.({
							type: 'spawn_error',
							message: resolvedError.message,
							failureCode:
								extractFailureCode(error) ??
								inferFailureCodeFromMessage(resolvedError.message) ??
								'unknown',
						});
					}
					if (!abortRef.current.signal.aborted && trackOutputRef.current) {
						setOutput(prev => [...prev, `[error] ${resolvedError.message}`]);
					}
					finalize(null, resolvedError);
				}
			});
		},
		[
			projectDir,
			instanceId,
			isolation,
			pluginMcpConfig,
			verbose,
			workflow,
			kill,
			clearTokenUsageTimer,
			publishTokenUsage,
		],
	);

	// Cleanup on unmount - kill any running process
	useEffect(() => {
		abortRef.current = new AbortController();

		return () => {
			abortRef.current.abort();
			clearTokenUsageTimer();
			if (processRef.current) {
				processRef.current.kill();
				processRef.current = null;
			}
		};
	}, [clearTokenUsageTimer]);

	return {
		spawn,
		isRunning,
		output,
		kill,
		sendInterrupt,
		streamingText,
		tokenUsage,
	};
}
