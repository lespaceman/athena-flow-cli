import {useState, useCallback} from 'react';
import {Box, Text} from 'ink';
import StepSelector from '../components/StepSelector';
import StepStatus from '../components/StepStatus';
import {
	installWorkflow,
	resolveWorkflow,
	installWorkflowPlugins,
} from '../../core/workflows/index';
import {useTheme} from '../../ui/theme/index';

// Marketplace ref for the e2e-test-builder workflow
const E2E_WORKFLOW_REF =
	'e2e-test-builder@lespaceman/athena-workflow-marketplace';

type Props = {
	onComplete: (workflowName: string, pluginDirs: string[]) => void;
	onError: (message: string) => void;
};

export default function WorkflowStep({onComplete, onError}: Props) {
	const theme = useTheme();
	const [status, setStatus] = useState<
		'selecting' | 'verifying' | 'success' | 'error'
	>('selecting');
	const [message, setMessage] = useState('');

	const handleSelect = useCallback(
		(_value: string) => {
			setStatus('verifying');
			setTimeout(() => {
				try {
					const name = installWorkflow(E2E_WORKFLOW_REF);
					// Verify it resolves
					const resolved = resolveWorkflow(name);
					const pluginDirs = installWorkflowPlugins(resolved);
					setMessage(`Workflow "${name}" installed`);
					setStatus('success');
					onComplete(name, pluginDirs);
				} catch (err) {
					const msg = (err as Error).message;
					setMessage(`Installation failed: ${msg}`);
					setStatus('error');
					onError(msg);
				}
			}, 0);
		},
		[onComplete, onError],
	);

	return (
		<Box flexDirection="column">
			<Text bold color={theme.accent}>
				Install a starter workflow
			</Text>
			<Text color={theme.textMuted}>Select a workflow to continue.</Text>
			<Text color={theme.textMuted}>
				Workflow defaults apply as soon as setup finishes.
			</Text>
			{status === 'selecting' && (
				<Box marginTop={1}>
					<StepSelector
						options={[
							{label: 'e2e-test-builder', value: 'e2e-test-builder'},
							{
								label: 'bug-triage (coming soon)',
								value: 'bug-triage',
								disabled: true,
							},
						]}
						onSelect={handleSelect}
					/>
				</Box>
			)}
			{(status === 'verifying' ||
				status === 'success' ||
				status === 'error') && (
				<StepStatus
					status={status}
					message={message || 'Installing workflow...'}
				/>
			)}
		</Box>
	);
}
