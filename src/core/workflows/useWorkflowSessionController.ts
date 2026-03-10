import {useCallback, useEffect, useRef, useState} from 'react';
import type {HarnessProcessOverride} from '../runtime/process';
import type {UseSessionControllerResult} from '../../harnesses/contracts/session';
import {
	cleanupWorkflowRun,
	createWorkflowRunState,
	prepareWorkflowTurn,
	shouldContinueWorkflowRun,
} from './sessionPlan';
import type {WorkflowConfig} from './types';

export function useWorkflowSessionController(
	base: UseSessionControllerResult,
	input: {
		projectDir: string;
		workflow?: WorkflowConfig;
	},
): UseSessionControllerResult {
	const [isRunning, setIsRunning] = useState(false);
	const cancelledRef = useRef(false);
	const activeRunIdRef = useRef(0);
	const activeSpawnPromiseRef = useRef<Promise<void> | null>(null);

	const interrupt = useCallback((): void => {
		cancelledRef.current = true;
		base.interrupt();
	}, [base]);

	const kill = useCallback(async (): Promise<void> => {
		cancelledRef.current = true;
		activeRunIdRef.current += 1;
		setIsRunning(false);
		await base.kill();
	}, [base]);

	const spawn = useCallback(
		async (
			prompt: string,
			sessionId?: string,
			configOverride?: HarnessProcessOverride,
		): Promise<void> => {
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
				let nextSessionId = sessionId;

				try {
					while (!cancelledRef.current && activeRunIdRef.current === runId) {
						const prepared = prepareWorkflowTurn(workflowState, {
							prompt,
							configOverride,
						});
						for (const warning of prepared.warnings) {
							console.error(`[athena] ${warning}`);
						}

						await base.spawn(
							prepared.prompt,
							nextSessionId,
							prepared.configOverride,
						);
						if (
							cancelledRef.current ||
							activeRunIdRef.current !== runId ||
							!shouldContinueWorkflowRun(workflowState)
						) {
							break;
						}

						nextSessionId = undefined;
					}
				} finally {
					cleanupWorkflowRun(workflowState);
					if (activeSpawnPromiseRef.current === runPromise) {
						activeSpawnPromiseRef.current = null;
					}
					if (activeRunIdRef.current === runId) {
						setIsRunning(false);
					}
				}
			})();

			activeSpawnPromiseRef.current = runPromise;
			await runPromise;
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
		spawn,
		isRunning,
		interrupt,
		kill,
	};
}
