import React from 'react';
import {Box, Text} from 'ink';
import type {FeedEvent} from '../../core/feed/types';
import {getStatusColors, getPostToolText} from './hookEventUtils';
import {ToolOutputRenderer, ToolResultContainer} from './ToolOutput/index';
import {extractToolOutput} from '../tooling/toolExtractors';
import {useTheme} from '../theme/index';

type Props = {
	event: FeedEvent;
	verbose?: boolean;
	parentWidth?: number;
};

export default function PostToolResult({
	event,
	verbose,
	parentWidth,
}: Props): React.ReactNode {
	const theme = useTheme();
	const statusColors = getStatusColors(theme);

	if (event.kind !== 'tool.post' && event.kind !== 'tool.failure') {
		return null;
	}

	const toolName = event.data.tool_name;
	const toolInput = event.data.tool_input;
	const isFailed = event.kind === 'tool.failure';

	let responseNode: React.ReactNode;

	if (isFailed) {
		const errorText = event.data.error;
		responseNode = (
			<ToolResultContainer
				gutterColor={statusColors.blocked}
				dimGutter={false}
				parentWidth={parentWidth}
			>
				<Text color={statusColors.blocked}>{errorText}</Text>
			</ToolResultContainer>
		);
	} else {
		const toolResponse = event.data.tool_response;
		const outputMeta = extractToolOutput(toolName, toolInput, toolResponse);
		responseNode = (
			<ToolResultContainer
				previewLines={outputMeta.previewLines}
				totalLineCount={outputMeta.totalLineCount}
				toolId={event.data.tool_use_id}
				parentWidth={parentWidth}
			>
				{availableWidth => (
					<ToolOutputRenderer
						toolName={toolName}
						toolInput={toolInput}
						toolResponse={toolResponse}
						availableWidth={availableWidth}
					/>
				)}
			</ToolResultContainer>
		);
	}

	return (
		<Box flexDirection="column">
			{responseNode}
			{verbose && (
				<Box paddingLeft={3}>
					<Text dimColor>{getPostToolText(event.raw ?? event.data)}</Text>
				</Box>
			)}
		</Box>
	);
}
