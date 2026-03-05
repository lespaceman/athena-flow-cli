import React from 'react';
import {Box, Text} from 'ink';
import type {FeedEvent} from '../../core/feed/types';
import {useTheme} from '../theme/index';
import {truncateLine} from '../../shared/utils/truncate';
import PostToolResult from './PostToolResult';
import {termColumns} from '../../shared/utils/terminal';

type Props = {
	event: FeedEvent;
	verbose?: boolean;
};

/**
 * Combined rendering for PostToolUse(Task): "● AgentType — Done" header
 * followed by the tool result body. Keeps header and result as a single
 * Static item so they render together without gaps.
 */
export default function SubagentResultEvent({
	event,
	verbose,
}: Props): React.ReactNode {
	const theme = useTheme();

	if (event.kind !== 'tool.post' && event.kind !== 'tool.failure') {
		return null;
	}

	const toolInput = event.data.tool_input;
	const agentType =
		typeof toolInput.subagent_type === 'string'
			? toolInput.subagent_type
			: 'Agent';

	const terminalWidth = termColumns();
	const headerText = truncateLine(`${agentType} — Done`, terminalWidth - 4);

	return (
		<Box flexDirection="column" marginTop={1}>
			<Box>
				<Text color={theme.accentSecondary} bold>
					● {headerText}
				</Text>
			</Box>
			<PostToolResult event={event} verbose={verbose} />
		</Box>
	);
}
