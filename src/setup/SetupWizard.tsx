import {useState, useCallback, useEffect, useRef} from 'react';
import {Box, Text, useInput} from 'ink';
import {useSetupState} from './useSetupState';
import ThemeStep from './steps/ThemeStep';
import HarnessStep from './steps/HarnessStep';
import StepStatus from './components/StepStatus';
import WizardFrame from './components/WizardFrame';
import WizardHints from './components/WizardHints';
import {getGlyphs} from '../ui/glyphs/index';
import {writeGlobalConfig, type AthenaHarness} from '../infra/plugins/config';
import {useTheme} from '../ui/theme/index';

export type SetupResult = {
	theme: string;
	harness?: AthenaHarness;
};

type Props = {
	onComplete: (result: SetupResult) => void;
	onThemePreview?: (theme: string) => void;
};

const STEP_SUMMARIES = [
	{label: 'Theme', summarize: (r: SetupResult) => r.theme},
	{label: 'Harness', summarize: (r: SetupResult) => r.harness ?? 'skipped'},
];

export default function SetupWizard({onComplete, onThemePreview}: Props) {
	const theme = useTheme();
	const {
		stepIndex,
		stepState,
		isComplete,
		markSuccess,
		markError,
		retry,
		advance,
		retreat,
	} = useSetupState();
	const [result, setResult] = useState<SetupResult>({theme: theme.name});
	const [retryCount, setRetryCount] = useState(0);
	const [writeError, setWriteError] = useState<string | null>(null);
	const [writeRetryCount, setWriteRetryCount] = useState(0);
	const themePreviewRef = useRef(result.theme);
	const completedRef = useRef(false);

	const handleThemeComplete = useCallback(
		(theme: string) => {
			themePreviewRef.current = theme;
			setResult(prev => ({...prev, theme}));
			onThemePreview?.(theme);
			markSuccess();
		},
		[markSuccess, onThemePreview],
	);

	const handleThemePreview = useCallback(
		(nextTheme: string) => {
			themePreviewRef.current = nextTheme;
			onThemePreview?.(nextTheme);
		},
		[onThemePreview],
	);

	const handleHarnessComplete = useCallback(
		(harness: AthenaHarness) => {
			setResult(prev => ({...prev, harness}));
			markSuccess();
		},
		[markSuccess],
	);

	const handleHarnessSkip = useCallback(() => {
		setResult(prev => ({...prev, harness: undefined}));
		markSuccess();
	}, [markSuccess]);

	const handleSkipShortcut = useCallback(() => {
		if (stepState !== 'selecting' || isComplete) {
			return;
		}
		if (stepIndex === 0) {
			const selectedTheme = themePreviewRef.current;
			setResult(prev => ({...prev, theme: selectedTheme}));
			onThemePreview?.(selectedTheme);
			markSuccess();
			return;
		}
		if (stepIndex === 1) {
			handleHarnessSkip();
			return;
		}
	}, [
		stepState,
		isComplete,
		stepIndex,
		markSuccess,
		onThemePreview,
		handleHarnessSkip,
	]);

	useInput((input, key) => {
		const normalizedInput = input.toLowerCase();

		if (isComplete) {
			if (writeError && normalizedInput === 'r') {
				setWriteError(null);
				setWriteRetryCount(prev => prev + 1);
			}
			return;
		}

		if (stepState === 'error' && normalizedInput === 'r') {
			retry();
			setRetryCount(prev => prev + 1);
			return;
		}

		if (key.escape && stepIndex > 0 && stepState !== 'verifying') {
			retreat();
			return;
		}

		if (normalizedInput === 's') {
			handleSkipShortcut();
		}
	});

	// Auto-advance on success after short delay
	useEffect(() => {
		if (stepState === 'success' && !isComplete) {
			const timer = setTimeout(() => advance(), 500);
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [stepState, advance, isComplete]);

	// Write config and notify parent on completion
	useEffect(() => {
		if (isComplete && !completedRef.current) {
			try {
				completedRef.current = true;
				writeGlobalConfig({
					setupComplete: true,
					theme: result.theme,
					harness: result.harness,
					activeWorkflow: 'default',
				});
				onComplete(result);
			} catch (error) {
				completedRef.current = false;
				setWriteError(
					`Failed to write setup config: ${(error as Error).message}`,
				);
			}
		}
	}, [isComplete, result, onComplete, writeRetryCount]);

	return (
		<WizardFrame
			title="ATHENA SETUP"
			header={
				<Text color={theme.textMuted}>
					Configure your defaults in under a minute.
				</Text>
			}
			footer={
				<WizardHints
					stepState={
						isComplete ? (writeError ? 'error' : 'verifying') : stepState
					}
					stepIndex={stepIndex}
				/>
			}
		>
			{STEP_SUMMARIES.slice(
				0,
				isComplete ? STEP_SUMMARIES.length : stepIndex,
			).map((step, i) => (
				<Text key={i} color={theme.status.success}>
					{getGlyphs()['todo.done']} {step.label} · {step.summarize(result)}
				</Text>
			))}

			{stepIndex === 0 && !isComplete && (
				<ThemeStep
					onComplete={handleThemeComplete}
					onPreview={handleThemePreview}
				/>
			)}
			{stepIndex === 1 && !isComplete && (
				<Box marginTop={1}>
					<HarnessStep
						key={retryCount}
						onComplete={handleHarnessComplete}
						onError={() => markError()}
					/>
				</Box>
			)}
			{stepState === 'error' && !isComplete && (
				<Text color={theme.status.error}>Press r to retry this step.</Text>
			)}
			{isComplete && !writeError && (
				<StepStatus status="verifying" message="Saving setup..." />
			)}
			{isComplete && writeError && (
				<>
					<StepStatus status="error" message={writeError} />
					<Text color={theme.textMuted}>Press r to retry saving.</Text>
				</>
			)}
		</WizardFrame>
	);
}
