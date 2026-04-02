import {useState, useCallback} from 'react';

const TOTAL_STEPS = 2;

export type StepState = 'selecting' | 'verifying' | 'success' | 'error';

export function useSetupState() {
	const [stepIndex, setStepIndex] = useState(0);
	const [stepState, setStepState] = useState<StepState>('selecting');

	const startVerifying = useCallback(() => setStepState('verifying'), []);
	const markSuccess = useCallback(() => setStepState('success'), []);
	const markError = useCallback(() => setStepState('error'), []);
	const retry = useCallback(() => setStepState('selecting'), []);

	const advance = useCallback(() => {
		setStepIndex(prev => prev + 1);
		setStepState('selecting');
	}, []);

	const retreat = useCallback(() => {
		setStepIndex(prev => Math.max(0, prev - 1));
		setStepState('selecting');
	}, []);

	return {
		stepIndex,
		stepState,
		isComplete: stepIndex >= TOTAL_STEPS,
		startVerifying,
		markSuccess,
		markError,
		retry,
		advance,
		retreat,
	};
}
