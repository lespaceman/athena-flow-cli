import {useState, useCallback, useEffect, useRef} from 'react';
import {Box, Text} from 'ink';
import StepSelector from '../components/StepSelector';
import {useTheme} from '../../ui/theme/index';
import type {McpServerWithOptions} from '../../infra/plugins/mcpOptions';
import type {McpServerChoices} from '../../infra/plugins/config';

type Props = {
	servers: McpServerWithOptions[];
	onComplete: (choices: McpServerChoices) => void;
};

export default function McpOptionsStep({servers, onComplete}: Props) {
	const theme = useTheme();
	const [serverIndex, setServerIndex] = useState(0);
	const choicesRef = useRef<McpServerChoices>({});
	const autoSkippedRef = useRef(false);

	// Auto-skip when there are no servers to configure
	useEffect(() => {
		if (servers.length === 0 && !autoSkippedRef.current) {
			autoSkippedRef.current = true;
			onComplete({});
		}
	}, [servers.length, onComplete]);

	const handleSelect = useCallback(
		(value: string) => {
			const server = servers[serverIndex];
			const selectedOption = server.options[Number(value)];

			choicesRef.current = {
				...choicesRef.current,
				[server.serverName]: selectedOption.args,
			};

			if (serverIndex + 1 < servers.length) {
				setServerIndex(prev => prev + 1);
			} else {
				onComplete(choicesRef.current);
			}
		},
		[serverIndex, servers, onComplete],
	);

	if (servers.length === 0) {
		return null;
	}

	const currentServer = servers[serverIndex];

	const selectorOptions = currentServer.options.map((opt, i) => ({
		label: i === 0 ? `${opt.label} (default)` : opt.label,
		value: String(i),
	}));

	return (
		<Box flexDirection="column">
			<Text bold color={theme.accent}>
				Configure MCP servers
			</Text>
			<Text color={theme.textMuted}>
				Server {serverIndex + 1} of {servers.length}:{' '}
				<Text bold>{currentServer.serverName}</Text>
			</Text>
			<Box marginTop={1}>
				<StepSelector
					key={currentServer.serverName}
					options={selectorOptions}
					onSelect={handleSelect}
				/>
			</Box>
		</Box>
	);
}
