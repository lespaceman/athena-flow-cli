import {useState, useCallback} from 'react';
import {Box, Text} from 'ink';
import StepSelector from '../components/StepSelector';
import StepStatus from '../components/StepStatus';
import {useTheme} from '../../ui/theme/index';
import type {AthenaHarness} from '../../infra/plugins/config';
import {listHarnessCapabilities} from '../../harnesses/registry';

type Props = {
	onComplete: (harness: AthenaHarness) => void;
	onError: (message: string) => void;
};

export default function HarnessStep({onComplete, onError}: Props) {
	const theme = useTheme();
	const capabilities = listHarnessCapabilities();
	const [status, setStatus] = useState<
		'selecting' | 'verifying' | 'success' | 'error'
	>('selecting');
	const [message, setMessage] = useState('');

	const handleSelect = useCallback(
		(value: AthenaHarness) => {
			const capability = capabilities.find(c => c.id === value);
			if (!capability || !capability.enabled) return;
			setStatus('verifying');
			// Run verification asynchronously to not block render
			setTimeout(() => {
				const verifyResult = capability.verify?.() ?? {
					ok: true,
					message: `${capability.label} ready`,
				};
				setMessage(verifyResult.message);
				if (verifyResult.ok) {
					setStatus('success');
					onComplete(value);
				} else {
					setStatus('error');
					onError(verifyResult.message);
				}
			}, 0);
		},
		[capabilities, onComplete, onError],
	);

	return (
		<Box flexDirection="column">
			<Text bold color={theme.accent}>
				Select harness
			</Text>
			<Text color={theme.textMuted}>
				Choose your coding harness. You can skip this step with S.
			</Text>
			{status === 'selecting' && (
				<Box marginTop={1}>
					<StepSelector
						options={capabilities.map((capability, index) => ({
							label: `${index + 1}. ${capability.label}`,
							value: capability.id,
							disabled: !capability.enabled,
							description: capability.enabled
								? `Connect to ${capability.label}`
								: 'Not available',
						}))}
						onSelect={value => handleSelect(value as AthenaHarness)}
					/>
				</Box>
			)}
			{(status === 'verifying' ||
				status === 'success' ||
				status === 'error') && (
				<StepStatus
					status={status}
					message={message || 'Verifying harness...'}
				/>
			)}
		</Box>
	);
}
