import React from 'react';
import {Box, Text} from 'ink';
import type {FeedEvent} from '../../core/feed/types';
import {useTheme} from '../theme/index';
import {truncateLine} from '../../shared/utils/truncate';
import {termColumns} from '../../shared/utils/terminal';

type Props = {
	event: FeedEvent;
};

export default function SubagentStartEvent({event}: Props): React.ReactNode {
	const theme = useTheme();
	if (event.kind !== 'subagent.start') return null;

	const terminalWidth = termColumns();
	const label = `▸ ${event.data.agent_type}`;
	return (
		<Box marginTop={1}>
			<Text color={theme.accentSecondary}>
				{truncateLine(label, terminalWidth - 2)}
			</Text>
		</Box>
	);
}
