import {useCallback, useEffect, useRef, useState} from 'react';
import {type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
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
import {
	applyPromptTemplate,
	createLoopManager,
	buildContinuePrompt,
	cleanupTrackerFile,
	type LoopManager,
} from '../../../core/workflows/index';
import path from 'node:path';
import type {
	HarnessProcessLifecycleEvent,
	HarnessProcessFailureCode,
	TokenUsageParserFactory,
} from '../../../core/runtime/process';

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
		a.contextSize === b.contextSize
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
	const loopManagerRef = useRef<LoopManager | null>(null);
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

		const loopManager = loopManagerRef.current;

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

		loopManager?.deactivate();
		loopManagerRef.current = null;

		// Wait for exit or timeout
		await Promise.race([exitPromise, timeoutPromise]);

		// Clean up timeout to prevent memory leak
		clearTimeout(timeoutId!);

		if (loopManager) {
			cleanupTrackerFile(loopManager.trackerPath);
		}

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
			sessionId?: string,
			perCallIsolation?: Partial<IsolationConfig>,
		): Promise<void> => {
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

			// Apply workflow: transform prompt and arm loop
			let effectivePrompt = prompt;
			if (workflow) {
				if (
					workflow.loop &&
					loopManagerRef.current &&
					loopManagerRef.current.getState().iteration > 0
				) {
					// Iteration 2+: use continue prompt instead of original template
					effectivePrompt = buildContinuePrompt(workflow.loop);
				} else {
					effectivePrompt = applyPromptTemplate(
						workflow.promptTemplate,
						prompt,
					);
				}

				if (workflow.loop?.enabled && !loopManagerRef.current) {
					const trackerPath = path.resolve(
						projectDir,
						workflow.loop.trackerPath ?? 'tracker.md',
					);
					loopManagerRef.current = createLoopManager(
						trackerPath,
						workflow.loop,
					);
				}
			}

			// Thread workflow's systemPromptFile into isolation config
			const resolvedSystemPromptFile = workflow?.systemPromptFile
				? path.resolve(projectDir, workflow.systemPromptFile)
				: undefined;
			const appendSystemPromptFile =
				resolvedSystemPromptFile && fs.existsSync(resolvedSystemPromptFile)
					? resolvedSystemPromptFile
					: undefined;
			if (workflow?.systemPromptFile && !appendSystemPromptFile) {
				console.error(
					`[athena] Workflow "${workflow.name}" system prompt file not found: ${workflow.systemPromptFile}. Continuing without --append-system-prompt-file.`,
				);
			}
			const effectivePerCallIsolation: Partial<IsolationConfig> | undefined =
				perCallIsolation || appendSystemPromptFile
					? {
							...perCallIsolation,
							...(appendSystemPromptFile && {
								appendSystemPromptFile,
							}),
						}
					: undefined;

			try {
				const child = spawnClaude({
					prompt: effectivePrompt,
					projectDir,
					instanceId,
					sessionId,
					isolation: mergeIsolation(
						isolation,
						pluginMcpConfig,
						effectivePerCallIsolation,
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
						// Parse stream-json for token usage — merge with cumulative base
						tokenAccRef.current.feed(data);
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
									(acc.output ?? 0) || null,
							contextSize: acc.contextSize,
						});

						if (!trackOutputRef.current) return;
						setOutput(prev => {
							const updated = [...prev, data];
							// Limit output size to prevent memory issues
							if (updated.length > MAX_OUTPUT) {
								return updated.slice(-MAX_OUTPUT);
							}
							return updated;
						});
					},
					onStderr: (data: string) => {
						if (abortRef.current.signal.aborted) return;
						lastStderrRef.current = data.trim() || lastStderrRef.current;
						if (!trackOutputRef.current) return;
						setOutput(prev => {
							const updated = [...prev, `[stderr] ${data}`];
							if (updated.length > MAX_OUTPUT) {
								return updated.slice(-MAX_OUTPUT);
							}
							return updated;
						});
					},
					onExit: (code: number | null) => {
						// Flush any remaining buffered data for final token count
						tokenAccRef.current.flush();
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
											(finalAcc.output ?? 0) || null,
									contextSize: finalAcc.contextSize,
								},
								true,
							);
						}
						// Persist this process's own tokens (not cumulative)
						onExitTokensRef.current?.(finalAcc);

						// Resolve any pending kill promise
						if (exitResolverRef.current) {
							exitResolverRef.current();
							exitResolverRef.current = null;
						}
						if (abortRef.current.signal.aborted) return;
						processRef.current = null;

						// Loop respawn: spawn next iteration if not terminal and the workflow
						// actually started (tracker file exists). This prevents accidental
						// "continue task" loops for non-workflow prompts.
						// Never respawn on non-zero exit (process error) to avoid infinite loops.
						const loopManager = loopManagerRef.current;
						const loopConfig = workflow?.loop;
						const canContinueLoop =
							loopConfig &&
							loopManager &&
							code === 0 &&
							fs.existsSync(loopManager.trackerPath) &&
							!loopManager.isTerminal();
						if (canContinueLoop) {
							loopManager.incrementIteration();
							spawn(buildContinuePrompt(loopConfig)).catch(() => {
								loopManagerRef.current?.deactivate();
								loopManagerRef.current = null;
								if (!abortRef.current.signal.aborted) {
									setIsRunning(false);
								}
							});
							return;
						}

						// Loop reached terminal state — deactivate
						if (loopManagerRef.current) {
							if (
								code === 0 &&
								fs.existsSync(loopManagerRef.current.trackerPath) &&
								loopManagerRef.current.isTerminal()
							) {
								cleanupTrackerFile(loopManagerRef.current.trackerPath);
							}
							loopManagerRef.current.deactivate();
							loopManagerRef.current = null;
						}

						setIsRunning(false);
						if (trackOutputRef.current && code !== 0 && code !== null) {
							setOutput(prev => [...prev, `[exit code: ${code}]`]);
						}
						if (code !== null && code !== 0 && !reportedFailureRef.current) {
							reportedFailureRef.current = true;
							const stderrDetail = lastStderrRef.current
								? ` Stderr: ${lastStderrRef.current}`
								: '';
							onLifecycleEventRef.current?.({
								type: 'exit_nonzero',
								code,
								message: `Claude exited with code ${code}.${stderrDetail}`,
								failureCode: inferFailureCodeFromMessage(lastStderrRef.current),
							});
						}
					},
					onError: (error: Error) => {
						// Resolve any pending kill promise
						if (exitResolverRef.current) {
							exitResolverRef.current();
							exitResolverRef.current = null;
						}
						if (abortRef.current.signal.aborted) return;
						processRef.current = null;
						setIsRunning(false);
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
						if (!trackOutputRef.current) return;
						setOutput(prev => [...prev, `[error] ${error.message}`]);
					},
				});

				processRef.current = child;
			} catch (error) {
				if (exitResolverRef.current) {
					exitResolverRef.current();
					exitResolverRef.current = null;
				}
				if (abortRef.current.signal.aborted) return;
				processRef.current = null;
				setIsRunning(false);
				if (!reportedFailureRef.current) {
					reportedFailureRef.current = true;
					onLifecycleEventRef.current?.({
						type: 'spawn_error',
						message:
							error instanceof Error ? error.message : 'Unknown spawn failure',
						failureCode:
							extractFailureCode(error) ??
							(error instanceof Error
								? inferFailureCodeFromMessage(error.message)
								: 'unknown'),
					});
				}
				if (!trackOutputRef.current) return;
				setOutput(prev => [
					...prev,
					`[error] ${error instanceof Error ? error.message : 'Unknown spawn failure'}`,
				]);
			}
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
			if (loopManagerRef.current) {
				cleanupTrackerFile(loopManagerRef.current.trackerPath);
				loopManagerRef.current.deactivate();
				loopManagerRef.current = null;
			}
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
