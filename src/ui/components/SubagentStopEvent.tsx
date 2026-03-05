import React from 'react';
import {Box, Text} from 'ink';
import type {FeedEvent} from '../../core/feed/types';
import {useTheme} from '../theme/index';
import {truncateLine} from '../../shared/utils/truncate';
import {termColumns} from '../../shared/utils/terminal';

type Props = {
	event: FeedEvent;
	expanded?: boolean;
	parentWidth?: number;
};

export default function SubagentStopEvent({
	event,
	expanded,
	parentWidth,
}: Props): React.ReactNode {
	const theme = useTheme();
	if (event.kind !== 'subagent.stop') return null;

	const width = parentWidth ?? termColumns();
	const label = `⏹ ${event.data.agent_type || 'Agent'} done`;

	return (
		<Box flexDirection="column">
			<Text color={theme.accentSecondary}>
				{truncateLine(label, width - 2)}
			</Text>
			{expanded && (
				<Box paddingLeft={2} flexDirection="column">
					<Text dimColor>agent_id: {event.data.agent_id}</Text>
					{event.data.agent_transcript_path && (
						<Text dimColor>transcript: {event.data.agent_transcript_path}</Text>
					)}
				</Box>
			)}
		</Box>
	);
}
