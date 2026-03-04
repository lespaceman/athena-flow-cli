import {useState, useEffect, useCallback, useRef} from 'react';
import {Box} from 'ink';
import McpOptionsStep from './McpOptionsStep';
import StepStatus from '../components/StepStatus';
import {
	installWorkflow,
	resolveWorkflow,
	installWorkflowPlugins,
} from '../../core/workflows/index';
import {
	writeGlobalConfig,
	type McpServerChoices,
} from '../../infra/plugins/config';
import {
	collectMcpServersWithOptions,
	type McpServerWithOptions,
} from '../../infra/plugins/mcpOptions';

type Props = {
	source: string;
	onDone: (exitCode: number) => void;
};

type Phase = 'installing' | 'mcp-options' | 'done' | 'error';

export default function WorkflowInstallWizard({source, onDone}: Props) {
	const [phase, setPhase] = useState<Phase>('installing');
	const [message, setMessage] = useState('');
	const [workflowName, setWorkflowName] = useState('');
	const [mcpServers, setMcpServers] = useState<McpServerWithOptions[]>([]);
	const doneCalledRef = useRef(false);

	useEffect(() => {
		if (phase !== 'installing') return;

		try {
			const name = installWorkflow(source);
			const resolved = resolveWorkflow(name);
			const pluginDirs = installWorkflowPlugins(resolved);
			const servers = collectMcpServersWithOptions(pluginDirs);

			setWorkflowName(name);
			setMessage(`Installed workflow: ${name}`);

			if (servers.length > 0) {
				setMcpServers(servers);
				setPhase('mcp-options');
			} else {
				setPhase('done');
			}
		} catch (err) {
			setMessage(`Error: ${(err as Error).message}`);
			setPhase('error');
		}
	}, [phase, source]);

	useEffect(() => {
		if (doneCalledRef.current) return;
		if (phase === 'done') {
			doneCalledRef.current = true;
			onDone(0);
		} else if (phase === 'error') {
			doneCalledRef.current = true;
			onDone(1);
		}
	}, [phase, onDone]);

	const handleMcpComplete = useCallback(
		(choices: McpServerChoices) => {
			if (Object.keys(choices).length > 0) {
				writeGlobalConfig({mcpServerOptions: choices});
			}
			setMessage(`Installed workflow: ${workflowName}`);
			setPhase('done');
		},
		[workflowName],
	);

	return (
		<Box flexDirection="column">
			{phase === 'installing' && (
				<StepStatus status="verifying" message="Installing workflow..." />
			)}
			{phase === 'mcp-options' && (
				<McpOptionsStep servers={mcpServers} onComplete={handleMcpComplete} />
			)}
			{phase === 'done' && <StepStatus status="success" message={message} />}
			{phase === 'error' && <StepStatus status="error" message={message} />}
		</Box>
	);
}
