import React from 'react';
import {Box, Text} from 'ink';
import type {FeedEvent} from '../../core/feed/types';
import {
	parseToolName,
	formatInlineParams,
} from '../../shared/utils/toolNameParser';
import {truncateLine} from '../../shared/utils/truncate';
import {summarizeToolResult} from '../../core/feed/toolSummary';
import {termColumns} from '../../shared/utils/terminal';
import {useTheme} from '../theme/index';
import {getGlyphs} from '../glyphs/index';
import {ToolOutputRenderer, ToolResultContainer} from './ToolOutput/index';
import {extractToolOutput} from '../tooling/toolExtractors';

type Props = {
	event: FeedEvent;
	postEvent?: FeedEvent;
	verbose?: boolean;
	expanded?: boolean;
	parentWidth?: number;
};

const MAX_EXPANDED_LINES = 40;

export default function MergedToolCallEvent({
	event,
	postEvent,
	verbose,
	expanded,
	parentWidth,
}: Props): React.ReactNode {
	const theme = useTheme();
	const g = getGlyphs();

	if (event.kind !== 'tool.pre' && event.kind !== 'permission.request')
		return null;

	const toolName = event.data.tool_name;
	const toolInput = event.data.tool_input;
	const parsed = parseToolName(toolName);

	// Determine state: pending, success, or failure
	const isResolved = postEvent != null;
	const isFailed = postEvent?.kind === 'tool.failure';

	// Pick glyph and color
	let glyph: string;
	let color: string;
	if (!isResolved) {
		glyph = g['tool.pending'];
		color = theme.textMuted;
	} else if (isFailed) {
		glyph = g['tool.failure'];
		color = theme.status.error;
	} else {
		glyph = g['tool.success'];
		color = theme.status.success;
	}

	// Build summary text for resolved events
	let summary = '';
	if (postEvent?.kind === 'tool.failure') {
		summary = summarizeToolResult(
			toolName,
			toolInput,
			undefined,
			postEvent.data.error,
		);
	} else if (postEvent?.kind === 'tool.post') {
		summary = summarizeToolResult(
			toolName,
			toolInput,
			postEvent.data.tool_response,
		);
	}

	// Build header line
	const terminalWidth = parentWidth ?? termColumns();
	const glyphWidth = 2; // "✔ "
	const nameWidth = parsed.displayName.length;

	let headerSuffix: string;
	if (isResolved && summary) {
		headerSuffix = ` — ${summary}`;
		const maxLen = terminalWidth - glyphWidth - nameWidth;
		if (headerSuffix.length > maxLen) {
			headerSuffix = truncateLine(headerSuffix, maxLen);
		}
	} else {
		const inlineParams = formatInlineParams(toolInput);
		const availableForParams = terminalWidth - glyphWidth - nameWidth;
		headerSuffix = truncateLine(inlineParams, Math.max(availableForParams, 10));
	}

	// Expanded view: input JSON + output (if resolved)
	const jsonStr = JSON.stringify(toolInput, null, 2);
	const allLines = jsonStr.split('\n');
	const jsonTruncated = allLines.length > MAX_EXPANDED_LINES;
	const displayLines = jsonTruncated
		? allLines.slice(0, MAX_EXPANDED_LINES)
		: allLines;
	const omitted = allLines.length - displayLines.length;

	return (
		<Box flexDirection="column" marginTop={1}>
			{/* Header line */}
			<Box>
				<Text color={color}>{glyph} </Text>
				<Text color={color} bold>
					{parsed.displayName}
				</Text>
				<Text dimColor>{headerSuffix}</Text>
			</Box>

			{/* Expanded: input section */}
			{(verbose || expanded) && (
				<Box paddingLeft={3} flexDirection="column">
					<Text dimColor>{displayLines.join('\n')}</Text>
					{jsonTruncated && <Text dimColor>({omitted} more lines)</Text>}
				</Box>
			)}

			{/* Expanded: output section (only when resolved) */}
			{(verbose || expanded) &&
				postEvent &&
				renderOutput(postEvent, parentWidth)}
		</Box>
	);
}

function renderOutput(
	postEvent: FeedEvent,
	parentWidth?: number,
): React.ReactNode {
	if (postEvent.kind === 'tool.failure') {
		return (
			<ToolResultContainer
				gutterColor="red"
				dimGutter={false}
				parentWidth={parentWidth}
			>
				<Text color="red">{postEvent.data.error}</Text>
			</ToolResultContainer>
		);
	}
	if (postEvent.kind === 'tool.post') {
		const toolName = postEvent.data.tool_name;
		const toolInput = postEvent.data.tool_input;
		const toolResponse = postEvent.data.tool_response;
		const outputMeta = extractToolOutput(toolName, toolInput, toolResponse);
		return (
			<ToolResultContainer
				previewLines={outputMeta.previewLines}
				totalLineCount={outputMeta.totalLineCount}
				toolId={postEvent.data.tool_use_id}
				parentWidth={parentWidth}
			>
				{(availableWidth: number) => (
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
	return null;
}
