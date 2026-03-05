import React from 'react';
import {Box, Text} from 'ink';
import type {FeedEvent} from '../../core/feed/types';
import {useTheme} from '../theme/index';
import {getStatusColors} from './hookEventUtils';
import {truncateLine} from '../../shared/utils/truncate';
import {ToolResultContainer} from './ToolOutput/index';
import MarkdownText from './ToolOutput/MarkdownText';
import {getGlyphs} from '../glyphs/index';
import {termColumns} from '../../shared/utils/terminal';

const BULLET = getGlyphs()['tool.bullet'];

export default function TaskAgentEvent({
	event,
}: {
	event: FeedEvent;
}): React.ReactNode {
	const theme = useTheme();
	const statusColors = getStatusColors(theme);

	if (event.kind !== 'tool.pre') return null;

	const toolInput = event.data.tool_input;
	const agentType =
		(toolInput.subagent_type as string) ||
		(toolInput.description as string) ||
		'Agent';
	const description = (toolInput.description as string) || '';
	const prompt = (toolInput.prompt as string) || '';

	const terminalWidth = termColumns();
	const bulletWidth = 2; // "● "
	const nameWidth = agentType.length;
	const availableForDesc = terminalWidth - bulletWidth - nameWidth;
	const truncatedDesc = description
		? truncateLine(`(${description})`, Math.max(availableForDesc, 10))
		: '';

	return (
		<Box flexDirection="column" marginTop={1}>
			<Box>
				<Text color={statusColors.passthrough}>{BULLET} </Text>
				<Text color={statusColors.passthrough} bold>
					{agentType}
				</Text>
				{truncatedDesc ? <Text dimColor>{truncatedDesc}</Text> : null}
			</Box>
			{prompt ? (
				<ToolResultContainer>
					{availableWidth => (
						<MarkdownText
							content={prompt}
							maxLines={10}
							availableWidth={availableWidth}
						/>
					)}
				</ToolResultContainer>
			) : null}
		</Box>
	);
}
