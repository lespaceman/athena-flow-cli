import fs from 'node:fs';
import {useState, useCallback, useEffect} from 'react';
import {Box, Text} from 'ink';
import StepSelector from '../components/StepSelector';
import StepStatus from '../components/StepStatus';
import {
	installWorkflow,
	resolveWorkflow,
	installWorkflowPlugins,
} from '../../core/workflows/index';
import {
	findMarketplaceRepoDir,
	isMarketplaceRef,
	listMarketplaceWorkflows,
	listMarketplaceWorkflowsFromRepo,
	resolveWorkflowMarketplaceSource,
	resolveMarketplaceWorkflow,
} from '../../infra/plugins/marketplace';
import {readGlobalConfig} from '../../infra/plugins/config';
import {useTheme} from '../../ui/theme/index';

const DEFAULT_MARKETPLACE_OWNER = 'lespaceman';
const DEFAULT_MARKETPLACE_REPO = 'athena-workflow-marketplace';

type WorkflowOption = {
	label: string;
	value: string;
	description: string;
};

function readLocalWorkflowOption(sourcePath: string): WorkflowOption {
	const raw = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as {
		name?: string;
		description?: string;
	};

	if (!raw.name) {
		throw new Error(
			`Workflow source at ${sourcePath} is missing a "name" field.`,
		);
	}

	return {
		label: raw.name,
		value: sourcePath,
		description: raw.description ?? 'Local workflow',
	};
}

function loadWorkflowOptions(): WorkflowOption[] {
	const sourceOverride = process.env.ATHENA_STARTER_WORKFLOW_SOURCE;

	if (!sourceOverride) {
		const configuredSource =
			readGlobalConfig().workflowMarketplaceSource ??
			`${DEFAULT_MARKETPLACE_OWNER}/${DEFAULT_MARKETPLACE_REPO}`;
		const marketplaceSource =
			resolveWorkflowMarketplaceSource(configuredSource);

		if (marketplaceSource.kind === 'remote') {
			return listMarketplaceWorkflows(
				marketplaceSource.owner,
				marketplaceSource.repo,
			).map(workflow => ({
				label: workflow.name,
				value: workflow.ref,
				description: workflow.description ?? 'Marketplace workflow',
			}));
		}

		return listMarketplaceWorkflowsFromRepo(marketplaceSource.repoDir).map(
			workflow => ({
				label: workflow.name,
				value: workflow.workflowPath,
				description: workflow.description ?? 'Local marketplace workflow',
			}),
		);
	}

	if (isMarketplaceRef(sourceOverride)) {
		const workflowPath = resolveMarketplaceWorkflow(sourceOverride);
		return [readLocalWorkflowOption(workflowPath)].map(option => ({
			...option,
			value: sourceOverride,
		}));
	}

	const repoDir = findMarketplaceRepoDir(sourceOverride);
	if (repoDir) {
		return listMarketplaceWorkflowsFromRepo(repoDir).map(workflow => ({
			label: workflow.name,
			value: workflow.workflowPath,
			description: workflow.description ?? 'Local marketplace workflow',
		}));
	}

	if (!fs.existsSync(sourceOverride)) {
		throw new Error(`Workflow source not found: ${sourceOverride}`);
	}

	return [readLocalWorkflowOption(sourceOverride)];
}

type Props = {
	onComplete: (workflowName: string, pluginDirs: string[]) => void;
	onError: (message: string) => void;
};

export default function WorkflowStep({onComplete, onError}: Props) {
	const theme = useTheme();
	const [status, setStatus] = useState<
		'loading' | 'selecting' | 'verifying' | 'success' | 'error'
	>('loading');
	const [message, setMessage] = useState('');
	const [options, setOptions] = useState<WorkflowOption[]>([]);

	useEffect(() => {
		try {
			const nextOptions = loadWorkflowOptions();
			if (nextOptions.length === 0) {
				throw new Error(
					'No workflows are currently published in the Athena marketplace.',
				);
			}
			setOptions(nextOptions);
			setStatus('selecting');
		} catch (err) {
			const msg = (err as Error).message;
			setMessage(`Workflow discovery failed: ${msg}`);
			setStatus('error');
			onError(msg);
		}
	}, [onError]);

	const handleSelect = useCallback(
		(value: string) => {
			setStatus('verifying');
			setTimeout(() => {
				try {
					const name = installWorkflow(value);
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
				Install a workflow
			</Text>
			<Text color={theme.textMuted}>Select a workflow to continue.</Text>
			<Text color={theme.textMuted}>
				Workflow defaults apply as soon as setup finishes.
			</Text>
			{status === 'loading' && (
				<StepStatus status="verifying" message="Loading workflows..." />
			)}
			{status === 'selecting' && (
				<Box marginTop={1}>
					<StepSelector options={options} onSelect={handleSelect} />
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
