import React from 'react';
import {Box, Text} from 'ink';
import type {FeedEvent} from '../../core/feed/types';
import {getGlyphs} from '../glyphs/index';
import {useTheme} from '../theme/index';
import {truncateLine} from '../../shared/utils/truncate';
import MarkdownText from './ToolOutput/MarkdownText';
import {termColumns} from '../../shared/utils/terminal';

type Props = {
	event: FeedEvent;
	expanded?: boolean;
	parentWidth?: number;
};

const MAX_COLLAPSED_CHARS = 120;

export default function AgentMessageEvent({
	event,
	expanded,
	parentWidth,
}: Props): React.ReactNode {
	const theme = useTheme();
	if (event.kind !== 'agent.message') return null;

	const width = parentWidth ?? termColumns();
	const {message, scope} = event.data;
	const g = getGlyphs();
	const glyph = g['message.agent'];
	const label =
		scope === 'subagent'
			? `${glyph} Subagent response`
			: `${glyph} Agent response`;

	if (expanded) {
		return (
			<Box flexDirection="column">
				<Text color={theme.accent} bold>
					{label}
				</Text>
				<Box paddingLeft={2}>
					<MarkdownText content={message} availableWidth={width - 4} />
				</Box>
			</Box>
		);
	}

	const preview = truncateLine(
		message.replace(/\n/g, ' '),
		MAX_COLLAPSED_CHARS,
	);

	return (
		<Box flexDirection="column">
			<Text color={theme.accent} bold>
				{label}
			</Text>
			<Box paddingLeft={2}>
				<Text dimColor>{preview}</Text>
			</Box>
		</Box>
	);
}
