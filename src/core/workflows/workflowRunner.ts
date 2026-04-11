import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
	HarnessProcessOverride,
	TurnContinuation,
	TurnExecutionResult,
} from '../runtime/process';
import type {TokenUsage} from '../../shared/types/headerMetrics';
import type {AthenaHarness} from '../../infra/plugins/config';
import type {RunStatus, WorkflowConfig} from './types';
import type {WorkflowRunSnapshot} from '../../infra/sessions/types';
import {
	createWorkflowRunState,
	prepareWorkflowTurn,
	shouldContinueWorkflowRun,
	cleanupWorkflowRun,
	resolveTrackerPath,
} from './sessionPlan';
import {TRACKER_SKELETON_MARKER} from './loopManager';
import {substituteVariables} from './templateVars';

export type TurnInput = {
	prompt: string;
	continuation: TurnContinuation;
	configOverride?: HarnessProcessOverride;
};

export type WorkflowRunnerInput = {
	sessionId: string;
	projectDir: string;
	harness?: AthenaHarness;
	workflow?: WorkflowConfig;
	prompt: string;
	initialContinuation?: TurnContinuation;

	startTurn: (input: TurnInput) => Promise<TurnExecutionResult>;
	persistRunState: (snapshot: WorkflowRunSnapshot) => void;
	onIterationComplete?: (snapshot: WorkflowRunSnapshot) => void;
	abortCurrentTurn?: () => void;
	createTracker?: (trackerPath: string, content: string) => void;
};

export type WorkflowRunResult = {
	runId: string;
	status: RunStatus;
	iterations: number;
	stopReason?: string;
	tokens: TokenUsage;
};

export type WorkflowRunnerHandle = {
	readonly runId: string;
	result: Promise<WorkflowRunResult>;
	cancel: () => void;
	kill: () => void;
};

const NULL_TOKENS: TokenUsage = {
	input: null,
	output: null,
	cacheRead: null,
	cacheWrite: null,
	total: null,
	contextSize: null,
	contextWindowSize: null,
};

const TRACKER_SKELETON_TEMPLATE = `${TRACKER_SKELETON_MARKER}
# Workflow Tracker

**Session**: {sessionId}
**Tracker**: {trackerPath}
**Goal**: {input}

---

> This tracker was created by the runner. Update it as you work.
> See the Stateless Session Protocol for tracker conventions.

## Status

Orientation in progress.

## Plan

_To be created during orientation._

## Progress

_No progress yet._
`;

function mergeTokens(base: TokenUsage, next: TokenUsage): TokenUsage {
	const input = (base.input ?? 0) + (next.input ?? 0);
	const output = (base.output ?? 0) + (next.output ?? 0);
	const cacheRead = (base.cacheRead ?? 0) + (next.cacheRead ?? 0);
	const cacheWrite = (base.cacheWrite ?? 0) + (next.cacheWrite ?? 0);
	const hasAny =
		base.input !== null ||
		next.input !== null ||
		base.output !== null ||
		next.output !== null ||
		base.cacheRead !== null ||
		next.cacheRead !== null ||
		base.cacheWrite !== null ||
		next.cacheWrite !== null;
	if (!hasAny)
		return {
			...NULL_TOKENS,
			contextSize: next.contextSize,
			contextWindowSize: next.contextWindowSize,
		};
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
		contextSize: next.contextSize ?? base.contextSize,
		contextWindowSize: next.contextWindowSize ?? base.contextWindowSize,
	};
}

function defaultCreateTracker(trackerPath: string, content: string): void {
	fs.mkdirSync(path.dirname(trackerPath), {recursive: true});
	try {
		fs.writeFileSync(trackerPath, content, {encoding: 'utf-8', flag: 'wx'});
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
	}
}

export function createWorkflowRunner(
	input: WorkflowRunnerInput,
): WorkflowRunnerHandle {
	const runId = crypto.randomUUID();
	let cancelled = false;
	let status: RunStatus = 'running';
	let iterations = 0;
	let cumulativeTokens: TokenUsage = {...NULL_TOKENS};
	let stopReason: string | undefined;

	const trackerResolved = resolveTrackerPath({
		projectDir: input.projectDir,
		sessionId: input.sessionId,
		workflow: input.workflow,
	});
	const trackerAbsPath = trackerResolved?.absolutePath ?? null;
	const trackerPromptPath = trackerResolved?.promptPath;

	function snapshot(): WorkflowRunSnapshot {
		return {
			runId,
			sessionId: input.sessionId,
			workflowName: input.workflow?.name,
			iteration: iterations,
			maxIterations: input.workflow?.loop?.maxIterations ?? 1,
			status,
			stopReason,
			trackerPath: trackerPromptPath,
		};
	}

	function persist(): void {
		try {
			input.persistRunState(snapshot());
		} catch {
			// Persistence failure is non-fatal for the runner
		}
	}

	const result = (async (): Promise<WorkflowRunResult> => {
		// Yield to the microtask queue so the caller can capture the handle
		// before we start executing turns. Without this, startTurn would be
		// invoked synchronously inside createWorkflowRunner, before the
		// returned handle is assigned.
		await Promise.resolve();

		// Create tracker skeleton if needed
		if (trackerAbsPath && input.workflow?.loop?.enabled) {
			const content = substituteVariables(TRACKER_SKELETON_TEMPLATE, {
				sessionId: input.sessionId,
				trackerPath: trackerPromptPath,
				input: input.prompt,
			});
			const write = input.createTracker ?? defaultCreateTracker;
			write(trackerAbsPath, content);
		}

		persist();

		const workflowState = createWorkflowRunState({
			projectDir: input.projectDir,
			sessionId: input.sessionId,
			workflow: input.workflow,
			harness: input.harness,
		});

		let nextContinuation: TurnContinuation = input.initialContinuation ?? {
			mode: 'fresh',
		};

		try {
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated externally during await
			while (!cancelled) {
				iterations++;
				const prepared = prepareWorkflowTurn(workflowState, {
					prompt: input.prompt,
					configOverride: undefined,
				});

				const turnResult = await input.startTurn({
					prompt: prepared.prompt,
					continuation: nextContinuation,
					configOverride: prepared.configOverride,
				});

				// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated externally during await
				if (cancelled) {
					status = 'cancelled';
					persist();
					break;
				}

				cumulativeTokens = mergeTokens(cumulativeTokens, turnResult.tokens);

				if (
					turnResult.error ||
					(turnResult.exitCode !== null && turnResult.exitCode !== 0)
				) {
					status = 'failed';
					const parts: string[] = [];
					if (turnResult.error?.message) {
						parts.push(turnResult.error.message);
					} else if (turnResult.exitCode !== null) {
						parts.push(`Process exited with code ${turnResult.exitCode}`);
					}
					if (turnResult.lastStderr) {
						parts.push(turnResult.lastStderr);
					}
					stopReason = parts.join(': ') || 'Turn failed';
					persist();
					break;
				}

				// Non-looped: single turn, done
				if (!input.workflow?.loop?.enabled) {
					status = 'completed';
					persist();
					break;
				}

				const loopStop = shouldContinueWorkflowRun(workflowState);
				if (loopStop) {
					if (loopStop.reason === 'completed') {
						status = 'completed';
					} else if (loopStop.reason === 'blocked') {
						status = 'blocked';
						stopReason = loopStop.blockedReason;
					} else if (loopStop.reason === 'max_iterations') {
						status = 'exhausted';
					} else {
						status = 'failed';
						stopReason = `Loop stopped: ${loopStop.reason}`;
					}
					persist();
					break;
				}

				// Continue loop
				persist();
				input.onIterationComplete?.(snapshot());
				nextContinuation = {mode: 'fresh'};
			}

			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated externally during await
			if (cancelled && status === 'running') {
				status = 'cancelled';
				persist();
			}
		} finally {
			cleanupWorkflowRun(workflowState);
		}

		return {
			runId,
			status,
			iterations,
			stopReason,
			tokens: cumulativeTokens,
		};
	})();

	return {
		runId,
		result,
		cancel() {
			cancelled = true;
		},
		kill() {
			cancelled = true;
			input.abortCurrentTurn?.();
		},
	};
}
