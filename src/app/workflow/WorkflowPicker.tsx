import {useState, useCallback, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import StepSelector from '../../setup/components/StepSelector';
import StepStatus from '../../setup/components/StepStatus';
import McpOptionsStep from '../../setup/steps/McpOptionsStep';
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

	const modalContent = (
		<Box flexDirection="column" paddingX={2} paddingY={1}>
			<Box justifyContent="center">
				<Text bold color={theme.accent}>
					Select a workflow
				</Text>
			</Box>
			<Box justifyContent="center">
				<Text color={theme.textMuted}>Choose a workflow for this project.</Text>
			</Box>

			{phase.type === 'loading' && (
				<Box marginTop={1} justifyContent="center">
					<StepStatus status="verifying" message="Loading workflows..." />
				</Box>
			)}

			{phase.type === 'selecting' && (
				<Box marginTop={1}>
					<StepSelector options={phase.options} onSelect={handleSelect} />
				</Box>
			)}

			{phase.type === 'installing' && (
				<Box marginTop={1} justifyContent="center">
					<StepStatus status="verifying" message="Installing workflow..." />
				</Box>
			)}

			{phase.type === 'mcp-options' && (
				<Box marginTop={1}>
					<McpOptionsStep
						servers={phase.servers}
						onComplete={handleMcpComplete}
					/>
				</Box>
			)}

			{phase.type === 'error' && (
				<Box marginTop={1} justifyContent="center">
					<Text color={theme.status.error}>{phase.message}</Text>
				</Box>
			)}

			<Box marginTop={1} justifyContent="center" gap={2}>
				<Text dimColor>
					<Text bold>Up/Down</Text> Navigate
				</Text>
				<Text dimColor>
					<Text bold>Enter</Text> Select
				</Text>
				{onClose && (
					<Text dimColor>
						<Text bold>Esc</Text> Close
					</Text>
				)}
			</Box>
		</Box>
	);

	return (
		<Box
			flexDirection="column"
			alignItems="center"
			justifyContent="center"
			height={rows}
		>
			<Box
				flexDirection="column"
				borderStyle="round"
				borderColor={theme.border}
			>
				{modalContent}
			</Box>
		</Box>
	);
}
