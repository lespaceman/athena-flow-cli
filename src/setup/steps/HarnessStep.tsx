import {useState, useCallback} from 'react';
import {Box, Text} from 'ink';
import StepSelector from '../components/StepSelector';
import StepStatus from '../components/StepStatus';
import {useTheme} from '../../ui/theme/index';
import type {AthenaHarness} from '../../infra/plugins/config';
import {
	listHarnessCapabilities,
	type HarnessCapability,
} from '../../harnesses/registry';
import type {HarnessVerificationCheck} from '../../harnesses/types';

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
	const [checks, setChecks] = useState<HarnessVerificationCheck[]>([]);

	const renderCheckLine = useCallback(
		(check: HarnessVerificationCheck) => {
			const glyph =
				check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '!';
			const color =
				check.status === 'pass'
					? theme.status.success
					: check.status === 'fail'
						? theme.status.error
						: theme.status.warning;
			return (
				<Text key={check.label} color={color}>
					{`${glyph} ${check.label}: ${check.message}`}
				</Text>
			);
		},
		[theme.status.error, theme.status.success, theme.status.warning],
	);

	const handleSelect = useCallback(
		(value: AthenaHarness) => {
			const capability = capabilities.find(
				(c: HarnessCapability) => c.id === value,
			);
			if (!capability || !capability.enabled) return;
			setStatus('verifying');
			setChecks([]);
			setMessage('');
			// Run verification asynchronously to not block render
			setTimeout(() => {
				const verifyResult = capability.verify?.() ?? {
					ok: true,
					summary: `${capability.label} ready`,
					checks: [],
				};
				setMessage(verifyResult.summary);
				setChecks(verifyResult.checks);
				if (verifyResult.ok) {
					setStatus('success');
					onComplete(value);
				} else {
					setStatus('error');
					onError(verifyResult.summary);
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
				<Box flexDirection="column" marginTop={1}>
					<StepStatus
						status={status}
						message={message || 'Verifying harness...'}
					/>
					{checks.length > 0 && (
						<Box flexDirection="column" marginTop={1}>
							{checks.map(renderCheckLine)}
						</Box>
					)}
				</Box>
			)}
		</Box>
	);
}
