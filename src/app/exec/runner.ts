import crypto from 'node:crypto';
import path from 'node:path';
import {
	handleEvent,
	type ControllerCallbacks,
} from '../../core/controller/runtimeController';
import {createFeedMapper} from '../../core/feed/mapper';
import {
	type RuntimeDecision,
	type RuntimeEvent,
} from '../../core/runtime/types';
import {createWorkflowRunner} from '../../core/workflows/workflowRunner';
import type {TurnContinuation} from '../../core/runtime/process';
import {
	createSessionStore,
	sessionsDir,
	type SessionStore,
} from '../../infra/sessions';
import {resolveHarnessAdapter} from '../../harnesses/registry';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import {createRuntime} from '../runtime/createRuntime';
import {findLastMappedAgentMessage, resolveFinalMessage} from './finalMessage';
import {createExecOutputWriter} from './output';
import {resolvePermissionPolicy} from './policies';
import {resolveQuestionPolicy, type PolicyResolution} from './policies';
import type {
	ExecRunFailure,
	ExecRunOptions,
	ExecRunResult,
	ExecWorkflowFailureState,
} from './types';
import {EXEC_EXIT_CODE} from './types';

const NULL_TOKENS: TokenUsage = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
	contextWindowSize: null,
};

function policyFailure(
	resolution: PolicyResolution,
	fallbackMessage: string,
): ExecRunFailure | null {
	if (resolution.action === 'respond') return null;
	return {
		kind: 'policy',
		message: resolution.reason || fallbackMessage,
	};
}

function workflowFailure(
	state: ExecWorkflowFailureState,
	message: string,
): ExecRunFailure {
	return {
		kind: 'workflow',
		state,
		message,
	};
}

function buildEarlyFailureResult(input: {
	now: () => number;
	startTs: number;
	athenaSessionId: string;
	ephemeral: boolean | undefined;
	message: string;
}): ExecRunResult {
	return {
		success: false,
		exitCode: EXEC_EXIT_CODE.RUNTIME,
		athenaSessionId: input.ephemeral ? null : input.athenaSessionId,
		adapterSessionId: null,
		finalMessage: null,
		tokens: {...NULL_TOKENS},
		durationMs: Math.max(0, input.now() - input.startTs),
		failure: {kind: 'process', message: input.message},
	};
}

function safePersist(
	store: SessionStore | undefined,
	action: () => void,
	onError: (message: string) => void,
	errorLabel: string,
): void {
	if (!store) return;
	try {
		action();
	} catch (error) {
		store.markDegraded(
			`${errorLabel}: ${error instanceof Error ? error.message : String(error)}`,
		);
		onError(
			`${errorLabel}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function runExec(options: ExecRunOptions): Promise<ExecRunResult> {
	const now = options.now ?? Date.now;
	const startTs = now();
	const verbose = options.verbose ?? false;
	const json = options.json ?? false;
	const instanceId = options.instanceId ?? process.pid;
	const runtimeFactory = options.runtimeFactory ?? createRuntime;
	const sessionStoreFactory = options.sessionStoreFactory ?? createSessionStore;
	const athenaSessionId = options.athenaSessionId ?? crypto.randomUUID();

	const output = createExecOutputWriter({
		json,
		verbose,
		stdout: options.stdout ?? process.stdout,
		stderr: options.stderr ?? process.stderr,
		now,
	});

	// Exec mode keeps permission behavior policy-driven. We intentionally do not
	// pre-seed approval rules from isolation defaults to avoid silent auto-allow.
	const rules: import('../../core/controller/rules').HookRule[] = [];

	let failure: ExecRunFailure | undefined;
	let runtimeStarted = false;
	let cumulativeTokens: TokenUsage = {...NULL_TOKENS};
	let streamFinalMessage: string | null = null;
	let mappedFinalMessage: string | null = null;
	let adapterSessionId: string | null = null;
	let activeRunId: string | null = null;

	let store: SessionStore;
	try {
		store = sessionStoreFactory({
			sessionId: athenaSessionId,
			projectDir: options.projectDir,
			dbPath: options.ephemeral
				? ':memory:'
				: path.join(sessionsDir(), athenaSessionId, 'session.db'),
		});
	} catch (error) {
		const message = `Failed to initialize session store: ${
			error instanceof Error ? error.message : String(error)
		}`;
		output.error(message);
		output.emitJsonEvent('exec.error', {kind: 'process', message});
		return buildEarlyFailureResult({
			now,
			startTs,
			athenaSessionId,
			ephemeral: options.ephemeral,
			message,
		});
	}
	const mapperBootstrap = store.toBootstrap();
	const mapper = createFeedMapper(mapperBootstrap);
	mappedFinalMessage = findLastMappedAgentMessage(
		mapperBootstrap?.feedEvents ?? [],
	);

	let runtime;
	try {
		runtime = runtimeFactory({
			harness: options.harness,
			projectDir: options.projectDir,
			instanceId,
			workflow: options.workflow,
		});
	} catch (error) {
		const message = `Failed to initialize runtime: ${
			error instanceof Error ? error.message : String(error)
		}`;
		store.close();
		output.error(message);
		output.emitJsonEvent('exec.error', {kind: 'process', message});
		return buildEarlyFailureResult({
			now,
			startTs,
			athenaSessionId,
			ephemeral: options.ephemeral,
			message,
		});
	}
	const harnessAdapter = resolveHarnessAdapter(options.harness);
	const sessionController = harnessAdapter.createSessionController({
		projectDir: options.projectDir,
		instanceId,
		processConfig: options.isolationConfig,
		pluginMcpConfig: options.pluginMcpConfig,
		verbose,
		workflow: options.workflow,
		workflowPlan: options.workflowPlan,
		ephemeral: options.ephemeral,
		runtime,
		spawnProcess: options.spawnProcess as
			| ((options: unknown) => import('node:child_process').ChildProcess)
			| undefined,
	});

	function registerFailure(next: ExecRunFailure): void {
		if (failure) return;
		failure = next;
		output.error(next.message);
		output.emitJsonEvent('exec.error', {
			kind: next.kind,
			message: next.message,
		});
		void sessionController.kill();
	}

	const hasFailure = (): boolean => failure !== undefined;
	const currentAdapterSessionId = (): string | null => adapterSessionId;

	const controllerCallbacks: ControllerCallbacks = {
		getRules: () => rules,
		enqueuePermission: (event: RuntimeEvent) => {
			const resolution = resolvePermissionPolicy(options.onPermission, event);
			const policyError = policyFailure(
				resolution,
				'Permission request cannot be resolved in non-interactive mode.',
			);
			if (policyError) {
				registerFailure(policyError);
				return;
			}
			if (resolution.action === 'respond') {
				runtime.sendDecision(event.id, resolution.decision);
			}
		},
		enqueueQuestion: (eventId: string) => {
			const resolution = resolveQuestionPolicy(options.onQuestion);
			const policyError = policyFailure(
				resolution,
				'Question request cannot be resolved in non-interactive mode.',
			);
			if (policyError) {
				registerFailure(policyError);
				return;
			}
			if (resolution.action === 'respond') {
				runtime.sendDecision(eventId, resolution.decision);
			}
		},
	};

	const linkedAdapterSessions = new Set<string>();

	const unsubscribeEvent = runtime.onEvent((runtimeEvent: RuntimeEvent) => {
		adapterSessionId = runtimeEvent.sessionId;

		// Link new adapter sessions to the active workflow run
		if (
			runtimeEvent.sessionId &&
			activeRunId &&
			!linkedAdapterSessions.has(runtimeEvent.sessionId)
		) {
			linkedAdapterSessions.add(runtimeEvent.sessionId);
			safePersist(
				store,
				() => store.linkAdapterSession(runtimeEvent.sessionId!, activeRunId!),
				message => output.warn(message),
				'linkAdapterSession failed',
			);
		}

		output.emitJsonEvent('runtime.event', {
			id: runtimeEvent.id,
			kind: runtimeEvent.kind,
			hookName: runtimeEvent.hookName,
			sessionId: runtimeEvent.sessionId,
			toolName: runtimeEvent.toolName ?? null,
			data: runtimeEvent.data,
		});

		if (hasFailure()) return;

		const controllerResult = handleEvent(runtimeEvent, controllerCallbacks);
		if (controllerResult.handled && controllerResult.decision) {
			runtime.sendDecision(runtimeEvent.id, controllerResult.decision);
		}

		const mapped = mapper.mapEvent(runtimeEvent);
		for (const event of mapped) {
			if (event.kind === 'agent.message') {
				mappedFinalMessage = event.data.message;
			}
		}

		safePersist(
			store,
			() => store.recordEvent(runtimeEvent, mapped),
			message => output.warn(message),
			'recordEvent failed',
		);
	});

	const unsubscribeDecision = runtime.onDecision(
		(eventId: string, decision: RuntimeDecision) => {
			output.emitJsonEvent('runtime.decision', {
				eventId,
				decision,
			});

			const mapped = mapper.mapDecision(eventId, decision);
			if (!mapped) return;

			safePersist(
				store,
				() => store.recordFeedEvents([mapped]),
				message => output.warn(message),
				'recordFeedEvents failed',
			);
		},
	);

	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
		timeoutTimer = setTimeout(() => {
			registerFailure({
				kind: 'timeout',
				message: `Execution timed out after ${options.timeoutMs}ms.`,
			});
		}, options.timeoutMs);
	}

	output.emitJsonEvent('exec.started', {
		projectDir: options.projectDir,
		harness: options.harness,
		athenaSessionId: options.ephemeral ? null : athenaSessionId,
	});

	try {
		await runtime.start();
		runtimeStarted = true;
		output.emitJsonEvent('runtime.started', {
			status: runtime.getStatus(),
		});

		const workflow = options.workflow;

		output.emitJsonEvent('run.started', {
			workflow: workflow?.name ?? null,
			loopEnabled: workflow?.loop?.enabled ?? false,
		});

		const nextContinuation: TurnContinuation = options.adapterResumeSessionId
			? {mode: 'resume', handle: options.adapterResumeSessionId}
			: {mode: 'fresh'};

		const handle = createWorkflowRunner({
			sessionId: athenaSessionId,
			projectDir: options.projectDir,
			harness: options.harness,
			workflow,
			prompt: options.prompt,
			initialContinuation: nextContinuation,
			startTurn: async turnInput => {
				const turnResult = await sessionController.startTurn({
					prompt: turnInput.prompt,
					continuation: turnInput.continuation,
					configOverride: turnInput.configOverride,
					onStderrLine: message => output.log(message),
				});

				if (turnResult.streamMessage) {
					streamFinalMessage = turnResult.streamMessage;
				}

				const sessionIdForTokens = currentAdapterSessionId();
				if (sessionIdForTokens !== null) {
					safePersist(
						store,
						() => store.recordTokens(sessionIdForTokens, turnResult.tokens),
						message => output.warn(message),
						'recordTokens failed',
					);
				}

				return turnResult;
			},
			persistRunState: runSnapshot => {
				safePersist(
					store,
					() => store.persistRun(runSnapshot),
					message => output.warn(message),
					'persistRun failed',
				);
			},
			abortCurrentTurn: () => void sessionController.kill(),
			onIterationComplete: runSnapshot => {
				output.emitJsonEvent('iteration.complete', {
					iteration: runSnapshot.iteration,
					status: runSnapshot.status,
				});
			},
		});

		activeRunId = handle.runId;

		const runResult = await handle.result;

		// Accumulate tokens from the runner result
		cumulativeTokens = runResult.tokens;

		// Map runner terminal status to exec failure if applicable.
		// External failures (from runtime event handler) take precedence — check !failure first.
		if (!failure) {
			if (runResult.status === 'blocked') {
				registerFailure(
					workflowFailure(
						'blocked',
						runResult.stopReason
							? `Workflow blocked: ${runResult.stopReason}`
							: 'Workflow blocked.',
					),
				);
			} else if (runResult.status === 'exhausted') {
				registerFailure(
					workflowFailure(
						'exhausted',
						`Workflow reached the maximum of ${workflow?.loop?.maxIterations ?? 0} iterations.`,
					),
				);
			} else if (runResult.status === 'failed') {
				registerFailure({
					kind: 'process',
					message: runResult.stopReason ?? 'Workflow run failed.',
				});
			}
		}
	} catch (error) {
		registerFailure({
			kind: 'process',
			message: error instanceof Error ? error.message : String(error),
		});
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		await sessionController.kill();
		unsubscribeEvent();
		unsubscribeDecision();
		if (runtimeStarted) {
			runtime.stop();
		}
		store.close();
	}

	const resolvedFinalMessage = resolveFinalMessage({
		streamMessage: streamFinalMessage,
		mappedMessage: mappedFinalMessage,
	});
	if (resolvedFinalMessage.source === 'empty' && !failure) {
		const warning =
			'No assistant message found in stream or hook events; writing empty output.';
		output.warn(warning);
		output.emitJsonEvent('exec.warning', {message: warning});
	}

	if (!failure && options.outputLastMessagePath) {
		try {
			await output.writeLastMessage(
				options.outputLastMessagePath,
				resolvedFinalMessage.message,
			);
		} catch (error) {
			failure = {
				kind: 'output',
				message: `Failed writing --output-last-message: ${error instanceof Error ? error.message : String(error)}`,
			};
			output.error(failure.message);
			output.emitJsonEvent('exec.error', {
				kind: failure.kind,
				message: failure.message,
			});
		}
	}

	let exitCode: ExecRunResult['exitCode'] = EXEC_EXIT_CODE.SUCCESS;
	if (failure?.kind === 'policy') {
		exitCode = EXEC_EXIT_CODE.POLICY;
	} else if (failure?.kind === 'timeout') {
		exitCode = EXEC_EXIT_CODE.TIMEOUT;
	} else if (failure?.kind === 'output') {
		exitCode = EXEC_EXIT_CODE.OUTPUT;
	} else if (failure?.kind === 'workflow') {
		exitCode =
			failure.state === 'exhausted'
				? EXEC_EXIT_CODE.WORKFLOW_EXHAUSTED
				: EXEC_EXIT_CODE.WORKFLOW_BLOCKED;
	} else if (failure) {
		exitCode = EXEC_EXIT_CODE.RUNTIME;
	}

	const success = exitCode === EXEC_EXIT_CODE.SUCCESS;
	const finalMessage = success ? resolvedFinalMessage.message : null;
	if (success && finalMessage !== null) {
		output.printFinalMessage(finalMessage);
	}

	const durationMs = Math.max(0, now() - startTs);
	const result: ExecRunResult = {
		success,
		exitCode,
		athenaSessionId: options.ephemeral ? null : athenaSessionId,
		adapterSessionId,
		finalMessage,
		tokens: cumulativeTokens,
		durationMs,
		...(failure ? {failure} : {}),
	};

	output.emitJsonEvent('exec.completed', {
		success: result.success,
		exitCode: result.exitCode,
		athenaSessionId: result.athenaSessionId,
		adapterSessionId: result.adapterSessionId,
		finalMessage: result.finalMessage,
		tokens: result.tokens,
		durationMs: result.durationMs,
		harnessExitCode: null,
	});

	return result;
}
