import {useCallback, useEffect, useRef, useState} from 'react';
import type {
	HarnessProcess,
	HarnessProcessOverride,
	TurnContinuation,
	TurnExecutionResult,
} from '../runtime/process';
import {
	createWorkflowRunner,
	type WorkflowRunnerHandle,
} from './workflowRunner';
import type {WorkflowConfig} from './types';
import type {WorkflowRunSnapshot} from '../../infra/sessions/types';
import type {AthenaHarness} from '../../infra/plugins/config';

export type UseWorkflowSessionControllerInput = {
	projectDir: string;
	sessionId?: string;
	harness?: AthenaHarness;
	workflow?: WorkflowConfig;
	persistRunState?: (snapshot: WorkflowRunSnapshot) => void;
};

export function useWorkflowSessionController(
	base: HarnessProcess<HarnessProcessOverride>,
	input: UseWorkflowSessionControllerInput,
): HarnessProcess<HarnessProcessOverride> & {
	readonly activeRunId: string | null;
} {
	const [isRunning, setIsRunning] = useState(false);
	const runnerRef = useRef<WorkflowRunnerHandle | null>(null);
	const activeRunIdRef = useRef<string | null>(null);

	const cancelCurrentRun = useCallback(async (): Promise<void> => {
		const runner = runnerRef.current;
		if (runner) {
			runner.kill();
			await runner.result.catch(() => {});
			runnerRef.current = null;
			activeRunIdRef.current = null;
		}
	}, []);

	const interrupt = useCallback((): void => {
		const runner = runnerRef.current;
		if (runner) {
			runner.kill();
			runnerRef.current = null;
			activeRunIdRef.current = null;
		} else {
			void base.kill().catch(() => {});
		}
		setIsRunning(false);
	}, [base]);

	const kill = useCallback(async (): Promise<void> => {
		if (runnerRef.current) {
			await cancelCurrentRun();
		} else {
			await base.kill();
		}
		setIsRunning(false);
	}, [base, cancelCurrentRun]);

	const spawn = useCallback(
		async (
			prompt: string,
			continuation?: TurnContinuation,
			_configOverride?: HarnessProcessOverride,
		): Promise<TurnExecutionResult> => {
			await cancelCurrentRun();
			setIsRunning(true);

			const handle = createWorkflowRunner({
				sessionId: input.sessionId ?? '',
				projectDir: input.projectDir,
				harness: input.harness,
				workflow: input.workflow,
				prompt,
				initialContinuation: continuation,
				startTurn: turnInput =>
					base.startTurn(
						turnInput.prompt,
						turnInput.continuation,
						turnInput.configOverride,
					),
				persistRunState: input.persistRunState ?? (() => {}),
				abortCurrentTurn: () => void base.kill().catch(() => {}),
			});

			runnerRef.current = handle;
			activeRunIdRef.current = handle.runId;

			try {
				const runResult = await handle.result;
				return {
					exitCode: runResult.status === 'failed' ? 1 : 0,
					error:
						runResult.status === 'failed'
							? new Error(runResult.stopReason ?? 'Run failed')
							: null,
					tokens: runResult.tokens,
					streamMessage: null,
				};
			} finally {
				if (runnerRef.current === handle) {
					runnerRef.current = null;
					activeRunIdRef.current = null;
					setIsRunning(false);
				}
			}
		},
		[
			base,
			cancelCurrentRun,
			input.projectDir,
			input.sessionId,
			input.harness,
			input.workflow,
			input.persistRunState,
		],
	);

	useEffect(() => {
		return () => {
			runnerRef.current?.kill();
			runnerRef.current = null;
			activeRunIdRef.current = null;
		};
	}, []);

	return {
		...base,
		startTurn: spawn,
		isRunning,
		interrupt,
		kill,
		get activeRunId() {
			return activeRunIdRef.current;
		},
	};
}
