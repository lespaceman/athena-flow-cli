import {useCallback, useEffect, useRef, useState} from 'react';
import type {
	HarnessProcess,
	HarnessProcessOverride,
	TurnContinuation,
	TurnExecutionResult,
} from '../runtime/process';
import {
	cleanupWorkflowRun,
	createWorkflowRunState,
	prepareWorkflowTurn,
	shouldContinueWorkflowRun,
} from './sessionPlan';
import type {WorkflowConfig} from './types';

export function useWorkflowSessionController(
	base: HarnessProcess<HarnessProcessOverride>,
	input: {
		projectDir: string;
		workflow?: WorkflowConfig;
	},
): HarnessProcess<HarnessProcessOverride> {
	const [isRunning, setIsRunning] = useState(false);
	const cancelledRef = useRef(false);
	const activeRunIdRef = useRef(0);
	const activeSpawnPromiseRef = useRef<Promise<TurnExecutionResult> | null>(
		null,
	);
	const isCancelled = (): boolean => cancelledRef.current;

	const interrupt = useCallback((): void => {
		cancelledRef.current = true;
		base.interrupt();
	}, [base]);

	const kill = useCallback(async (): Promise<void> => {
		cancelledRef.current = true;
		activeRunIdRef.current += 1;
		setIsRunning(false);
		await base.kill();
		await activeSpawnPromiseRef.current?.catch(() => {});
	}, [base]);

	const spawn = useCallback(
		async (
			prompt: string,
			continuation?: TurnContinuation,
			configOverride?: HarnessProcessOverride,
		): Promise<TurnExecutionResult> => {
			const previousSpawn = activeSpawnPromiseRef.current;
			if (previousSpawn) {
				cancelledRef.current = true;
				activeRunIdRef.current += 1;
				setIsRunning(false);
				await base.kill();
				await previousSpawn.catch(() => {});
			}

			cancelledRef.current = false;
			const runId = activeRunIdRef.current + 1;
			activeRunIdRef.current = runId;
			setIsRunning(true);

			const runPromise = (async () => {
				const workflowState = createWorkflowRunState({
					projectDir: input.projectDir,
					workflow: input.workflow,
				});
				let nextContinuation = continuation;
				let lastResult: TurnExecutionResult = {
					exitCode: 0,
					error: null,
					tokens: base.usage,
					streamMessage: null,
				};

				try {
					while (!isCancelled() && activeRunIdRef.current === runId) {
						const prepared = prepareWorkflowTurn(workflowState, {
							prompt,
							configOverride,
						});
						for (const warning of prepared.warnings) {
							console.error(`[athena] ${warning}`);
						}

						lastResult = await base.startTurn(
							prepared.prompt,
							nextContinuation,
							prepared.configOverride,
						);
						if (
							isCancelled() ||
							activeRunIdRef.current !== runId ||
							lastResult.error !== null ||
							(lastResult.exitCode !== null && lastResult.exitCode !== 0) ||
							!shouldContinueWorkflowRun(workflowState)
						) {
							break;
						}

						nextContinuation = {mode: 'fresh'};
					}
					return lastResult;
				} finally {
					cleanupWorkflowRun(workflowState);
					if (activeRunIdRef.current === runId) {
						activeSpawnPromiseRef.current = null;
						setIsRunning(false);
					}
				}
			})();

			activeSpawnPromiseRef.current = runPromise;
			return await runPromise;
		},
		[base, input.projectDir, input.workflow],
	);

	useEffect(() => {
		return () => {
			cancelledRef.current = true;
			activeRunIdRef.current += 1;
			activeSpawnPromiseRef.current = null;
		};
	}, []);

	return {
		...base,
		startTurn: spawn,
		isRunning,
		interrupt,
		kill,
	};
}
