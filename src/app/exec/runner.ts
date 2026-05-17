import crypto from 'node:crypto';
import path from 'node:path';
import type {ControllerCallbacks} from '../../core/controller/runtimeController';
import type {FeedEvent} from '../../core/feed/types';
import {createFeedMapper} from '../../core/feed/mapper';
import {
	ingestRuntimeDecision,
	ingestRuntimeEvent,
} from '../../core/feed/ingest';
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
import {
	createRelayPermissionCallback,
	createRelayQuestionCallback,
} from '../channels/relayAdapter';
import {startSessionBridge} from '../channels/sessionBridgeLifecycle';
import {createPairedFeedPublisher} from '../dashboard/pairedFeedPublisher';
import {findLastMappedAgentMessage, resolveFinalMessage} from './finalMessage';
import {createFailureLatch, exitCodeFromFailure} from './failureLatch';
import {createExecOutputWriter} from './output';
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
	const dashboardFeedPublisher =
		options.dashboardFeedPublisher ?? createPairedFeedPublisher();
	const dashboardOrigin = options.dashboardOrigin ?? 'local';

	const output = createExecOutputWriter({
		json,
		verbose,
		stdout: options.stdout ?? process.stdout,
		stderr: options.stderr ?? process.stderr,
		now,
	});

	// Exec does not pre-seed rules from isolation defaults; channel relay (or
	// the absence of one) governs approvals.
	const rules: import('../../core/controller/rules').HookRule[] = [];

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

	const latch = createFailureLatch(next => {
		output.error(next.message);
		output.emitJsonEvent('exec.error', {
			kind: next.kind,
			message: next.message,
		});
		void sessionController.kill();
	});

	const abortListener = (): void => {
		latch.register({kind: 'process', message: 'Execution cancelled.'});
	};
	if (options.signal?.aborted) {
		abortListener();
	} else {
		options.signal?.addEventListener('abort', abortListener, {once: true});
	}

	const currentAdapterSessionId = (): string | null => adapterSessionId;

	const bridgeFactory = options.bridgeFactory ?? startSessionBridge;
	const bridge =
		options.channels && options.channels.length > 0
			? await bridgeFactory({
					runtimeId: athenaSessionId,
					defaultAgentId: 'main',
					...(options.signal ? {signal: options.signal} : {}),
				})
			: null;

	const controllerCallbacks: ControllerCallbacks = {
		getRules: () => rules,
		// No UI queue in exec; with no bridge attached, the runtime never
		// receives a decision and the request blocks until timeoutMs (or abort).
		enqueuePermission: () => {},
		enqueueQuestion: () => {},
		...(bridge
			? {
					relayPermission: createRelayPermissionCallback(bridge, runtime),
					relayQuestion: createRelayQuestionCallback(bridge, runtime),
				}
			: {}),
		...(options.signal ? {signal: options.signal} : {}),
	};

	const dashboardDecisionInbox = options.dashboardDecisionInbox;
	const applyPendingDashboardDecisions = (): void => {
		if (!dashboardDecisionInbox) return;
		const rows = dashboardDecisionInbox.pendingForSession({
			athenaSessionId,
			limit: 25,
		});
		for (const row of rows) {
			try {
				runtime.sendDecision(row.requestId, row.decision);
				dashboardDecisionInbox.markConsumed({id: row.id});
			} catch (error) {
				output.warn(
					`dashboard decision failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	};

	const linkedAdapterSessions = new Set<string>();

	function publishFeedEvents(feedEvents: readonly FeedEvent[]): void {
		if (feedEvents.length === 0) return;
		dashboardFeedPublisher.publish({
			origin: dashboardOrigin,
			athenaSessionId,
			feedEvents,
		});
	}

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

		if (latch.hasFailure()) return;

		const {feedEvents, decision} = ingestRuntimeEvent(runtimeEvent, {
			mapper,
			store,
			controllerCallbacks,
			onPersistFailure: message => output.warn(message),
		});
		if (decision) {
			runtime.sendDecision(runtimeEvent.id, decision);
		}
		for (const event of feedEvents) {
			if (event.kind === 'agent.message') {
				mappedFinalMessage = event.data.message;
			}
		}
		publishFeedEvents(feedEvents);
	});

	const unsubscribeDecision = runtime.onDecision(
		(eventId: string, decision: RuntimeDecision) => {
			output.emitJsonEvent('runtime.decision', {
				eventId,
				decision,
			});
			const feedEvent = ingestRuntimeDecision(eventId, decision, {
				mapper,
				store,
				onPersistFailure: message => output.warn(message),
			});
			if (feedEvent) {
				publishFeedEvents([feedEvent]);
			}
		},
	);

	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let dashboardDecisionTimer: ReturnType<typeof setInterval> | undefined;
	if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
		timeoutTimer = setTimeout(() => {
			latch.register({
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
		if (dashboardDecisionInbox) {
			applyPendingDashboardDecisions();
			dashboardDecisionTimer = setInterval(
				applyPendingDashboardDecisions,
				options.dashboardDecisionPollIntervalMs ?? 1_000,
			);
			dashboardDecisionTimer.unref();
		}

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
		// External failures (from runtime event handler) take precedence — check !latch.hasFailure() first.
		if (!latch.hasFailure()) {
			if (runResult.status === 'blocked') {
				latch.register(
					workflowFailure(
						'blocked',
						runResult.stopReason
							? `Workflow blocked: ${runResult.stopReason}`
							: 'Workflow blocked.',
					),
				);
			} else if (runResult.status === 'exhausted') {
				latch.register(
					workflowFailure(
						'exhausted',
						`Workflow reached the maximum of ${workflow?.loop?.maxIterations ?? 0} iterations.`,
					),
				);
			} else if (runResult.status === 'failed') {
				latch.register({
					kind: 'process',
					message: runResult.stopReason ?? 'Workflow run failed.',
				});
			}
		}
	} catch (error) {
		latch.register({
			kind: 'process',
			message: error instanceof Error ? error.message : String(error),
		});
	} finally {
		options.signal?.removeEventListener('abort', abortListener);
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (dashboardDecisionTimer) {
			clearInterval(dashboardDecisionTimer);
		}
		await sessionController.kill();
		unsubscribeEvent();
		unsubscribeDecision();
		if (runtimeStarted) {
			runtime.stop();
		}
		await bridge?.stop();
		store.close();
	}

	const resolvedFinalMessage = resolveFinalMessage({
		streamMessage: streamFinalMessage,
		mappedMessage: mappedFinalMessage,
	});
	if (resolvedFinalMessage.source === 'empty' && !latch.hasFailure()) {
		const warning =
			'No assistant message found in stream or hook events; writing empty output.';
		output.warn(warning);
		output.emitJsonEvent('exec.warning', {message: warning});
	}

	if (!latch.hasFailure() && options.outputLastMessagePath) {
		try {
			await output.writeLastMessage(
				options.outputLastMessagePath,
				resolvedFinalMessage.message,
			);
		} catch (error) {
			latch.register({
				kind: 'output',
				message: `Failed writing --output-last-message: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	const failure = latch.current();
	const exitCode = exitCodeFromFailure(failure);
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
