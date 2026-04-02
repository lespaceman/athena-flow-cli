import {useState, useCallback, useEffect} from 'react';
import {Box, Text, useInput, useStdout} from 'ink';
import StepSelector from '../../setup/components/StepSelector';
import StepStatus from '../../setup/components/StepStatus';
import McpOptionsStep from '../../setup/steps/McpOptionsStep';
import WizardFrame from '../../setup/components/WizardFrame';
import {
	installWorkflow,
	resolveWorkflow,
	installWorkflowPlugins,
} from '../../core/workflows/index';
import {
	loadWorkflowOptions,
	type WorkflowOption,
} from '../../core/workflows/workflowOptions';
import {
	writeProjectConfig,
	type McpServerChoices,
} from '../../infra/plugins/config';
import {
	collectMcpServersWithOptions,
	type McpServerWithOptions,
} from '../../infra/plugins/mcpOptions';
import {useTheme} from '../../ui/theme/index';
import {getGlyphs} from '../../ui/glyphs/index';

const DEFAULT_WORKFLOW_OPTION: WorkflowOption = {
	label: 'default',
	value: 'default',
	description: 'Built-in default workflow',
};

type PickerPhase =
	| {type: 'loading'}
	| {type: 'selecting'; options: WorkflowOption[]}
	| {type: 'installing'; workflowValue: string}
	| {
			type: 'mcp-options';
			workflowName: string;
			servers: McpServerWithOptions[];
	  }
	| {type: 'done'}
	| {type: 'error'; message: string};

type Props = {
	projectDir: string;
	rows: number;
	onClose?: () => void;
	onComplete: (
		workflowName: string,
		mcpServerOptions?: McpServerChoices,
	) => void;
};

export default function WorkflowPicker({
	projectDir,
	rows,
	onClose,
	onComplete,
}: Props) {
	const theme = useTheme();
	const g = getGlyphs();
	const {stdout} = useStdout();
	const frameWidth = Math.min(stdout.columns - 4, 60);
	const [phase, setPhase] = useState<PickerPhase>({type: 'loading'});

	useEffect(() => {
		try {
			const marketplaceOptions = loadWorkflowOptions();
			const options = [DEFAULT_WORKFLOW_OPTION, ...marketplaceOptions];
			setPhase({type: 'selecting', options});
		} catch {
			setPhase({type: 'selecting', options: [DEFAULT_WORKFLOW_OPTION]});
		}
	}, []);

	useInput((_input, key) => {
		if (key.escape && onClose && phase.type === 'selecting') {
			onClose();
		}
	});

	const handleSelect = useCallback(
		(value: string) => {
			if (value === 'default') {
				writeProjectConfig(projectDir, {activeWorkflow: 'default'});
				setPhase({type: 'done'});
				onComplete('default');
				return;
			}

			setPhase({type: 'installing', workflowValue: value});
			setTimeout(() => {
				try {
					const name = installWorkflow(value);
					const resolved = resolveWorkflow(name);
					const pluginDirs = installWorkflowPlugins(resolved);
					const servers = collectMcpServersWithOptions(pluginDirs);

					if (servers.length > 0) {
						setPhase({
							type: 'mcp-options',
							workflowName: name,
							servers,
						});
					} else {
						writeProjectConfig(projectDir, {activeWorkflow: name});
						setPhase({type: 'done'});
						onComplete(name);
					}
				} catch (err) {
					setPhase({
						type: 'error',
						message: `Installation failed: ${(err as Error).message}`,
					});
				}
			}, 0);
		},
		[projectDir, onComplete],
	);

	const handleMcpComplete = useCallback(
		(choices: McpServerChoices) => {
			if (phase.type !== 'mcp-options') return;
			const {workflowName} = phase;
			writeProjectConfig(projectDir, {
				activeWorkflow: workflowName,
				workflowSelections: {
					[workflowName]: {mcpServerOptions: choices},
				},
			});
			setPhase({type: 'done'});
			onComplete(workflowName, choices);
		},
		[phase, projectDir, onComplete],
	);

	const hints: string[] = [];
	if (phase.type === 'selecting') {
		hints.push(`${g['hint.arrowsUpDown']} move`);
		hints.push(`${g['hint.enter']} select`);
		if (onClose) hints.push(`${g['hint.escape']} close`);
	} else if (phase.type === 'error') {
		hints.push('r retry');
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
					title="WORKFLOW"
					header={
						<Text color={theme.textMuted}>
							Choose a workflow for this project.
						</Text>
					}
					footer={<Text color={theme.textMuted}>{hints.join('  ')}</Text>}
				>
					{phase.type === 'loading' && (
						<StepStatus status="verifying" message="Loading workflows..." />
					)}

					{phase.type === 'selecting' && (
						<StepSelector
							options={phase.options}
							onSelect={handleSelect}
							gap={1}
						/>
					)}

					{phase.type === 'installing' && (
						<StepStatus status="verifying" message="Installing workflow..." />
					)}

					{phase.type === 'mcp-options' && (
						<McpOptionsStep
							servers={phase.servers}
							onComplete={handleMcpComplete}
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
