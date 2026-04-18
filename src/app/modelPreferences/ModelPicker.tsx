import {useState, useEffect, useCallback} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import WizardFrame from '../../setup/components/WizardFrame';
import StepSelector from '../../setup/components/StepSelector';
import StepStatus from '../../setup/components/StepStatus';
import {useTheme} from '../../ui/theme/index';
import {getGlyphs} from '../../ui/glyphs/index';
import {
	writeProjectConfig,
	type AthenaHarness,
} from '../../infra/plugins/config';
import {
	listAvailableModels,
	type HarnessModelOption,
} from './listAvailableModels';
import type {Runtime} from '../../core/runtime/types';

type Phase =
	| {type: 'loading'}
	| {type: 'selecting'; options: HarnessModelOption[]}
	| {type: 'saving'; model: string}
	| {type: 'error'; message: string};

type Props = {
	projectDir: string;
	rows: number;
	harness: AthenaHarness;
	runtime: Runtime | null;
	currentModelName: string | null;
	onClose?: () => void;
	onComplete: (model: string) => void;
};

export default function ModelPicker({
	projectDir,
	rows,
	harness,
	runtime,
	currentModelName,
	onClose,
	onComplete,
}: Props) {
	const theme = useTheme();
	const g = getGlyphs();
	const {stdout} = useStdout();
	const frameWidth = Math.min(stdout.columns - 4, 72);
	const [phase, setPhase] = useState<Phase>({type: 'loading'});

	const loadModels = useCallback(() => {
		setPhase({type: 'loading'});
		setTimeout(() => {
			void listAvailableModels({harness, runtime})
				.then(options => {
					if (options.length === 0) {
						setPhase({
							type: 'error',
							message: `No model choices are exposed for ${harness}.`,
						});
						return;
					}
					setPhase({type: 'selecting', options});
				})
				.catch(error => {
					setPhase({
						type: 'error',
						message: `Unable to load models: ${(error as Error).message}`,
					});
				});
		}, 0);
	}, [harness, runtime]);

	useEffect(() => {
		loadModels();
	}, [loadModels]);

	useInput((input, key) => {
		if (key.escape && onClose) {
			onClose();
			return;
		}
		if (phase.type === 'error' && input.toLowerCase() === 'r') {
			loadModels();
		}
	});

	const handleSelect = useCallback(
		(value: string) => {
			setPhase({type: 'saving', model: value});
			setTimeout(() => {
				writeProjectConfig(projectDir, {model: value});
				onComplete(value);
			}, 0);
		},
		[onComplete, projectDir],
	);

	const hints: string[] = [];
	if (phase.type === 'selecting') {
		hints.push(`${g['hint.arrowsUpDown']} move`);
		hints.push(`${g['hint.enter']} select`);
		if (onClose) hints.push(`${g['hint.escape']} close`);
	} else if (phase.type === 'error') {
		hints.push('r retry');
		if (onClose) hints.push(`${g['hint.escape']} close`);
	}

	return (
		<Box
			flexDirection="column"
			alignItems="center"
			justifyContent="center"
			height={rows}
		>
			<Box width={frameWidth + 4}>
				<WizardFrame
					title="MODEL"
					header={
						<Box flexDirection="column">
							<Text color={theme.textMuted}>
								Choose the preferred model for this project.
							</Text>
							{currentModelName ? (
								<Text color={theme.textMuted}>Current: {currentModelName}</Text>
							) : null}
						</Box>
					}
					footer={<Text color={theme.textMuted}>{hints.join('  ')}</Text>}
				>
					{phase.type === 'loading' && (
						<StepStatus status="verifying" message="Loading models..." />
					)}

					{phase.type === 'selecting' && (
						<StepSelector
							options={phase.options.map(option => ({
								label: option.isDefault
									? `${option.label} (default)`
									: option.label,
								value: option.value,
								description: option.description,
							}))}
							initialValue={currentModelName ?? undefined}
							onSelect={handleSelect}
							gap={1}
						/>
					)}

					{phase.type === 'saving' && (
						<StepStatus
							status="verifying"
							message={`Saving model preference (${phase.model})...`}
						/>
					)}

					{phase.type === 'error' && (
						<Text color={theme.status.error}>{phase.message}</Text>
					)}
				</WizardFrame>
			</Box>
		</Box>
	);
}
