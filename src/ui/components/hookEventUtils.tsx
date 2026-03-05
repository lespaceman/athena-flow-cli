import React from 'react';
import {Box, Text} from 'ink';
import {type Theme} from '../theme/index';
import ToolResultContainer from './ToolOutput/ToolResultContainer';
import {getGlyphs} from '../glyphs/index';
import {
	formatToolResponse,
	isBashToolResponse,
} from '../../shared/utils/toolResponse';

export type StatusKey = 'pending' | 'passthrough' | 'blocked' | 'json_output';

export function getStatusColors(theme: Theme) {
	return {
		pending: theme.status.warning,
		passthrough: theme.status.success,
		blocked: theme.status.error,
		json_output: theme.status.info,
	} as const;
}

const g = getGlyphs();

export const STATUS_SYMBOLS = {
	pending: g['status.pending'],
	passthrough: g['status.passthrough'],
	blocked: g['status.blocked'],
	json_output: g['tool.arrow'],
} as const;

export const SUBAGENT_SYMBOLS = {
	pending: g['subagent.pending'],
	passthrough: g['subagent.passthrough'],
	blocked: g['status.blocked'],
	json_output: g['tool.arrow'],
} as const;

export function truncateStr(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 3) + '...';
}

export function getPostToolText(payload: unknown): string {
	const p = payload as Record<string, unknown>;

	// PostToolUseFailure has 'error' field
	if (p.hook_event_name === 'PostToolUseFailure') {
		return p.error as string;
	}

	const toolName = p.tool_name as string | undefined;
	const toolResponse = p.tool_response;

	// Bash tool returns {stdout, stderr, interrupted, ...} — extract text content
	if (toolName === 'Bash' && isBashToolResponse(toolResponse)) {
		const {stdout, stderr} = toolResponse;
		const out = stdout.trim();
		const err = stderr.trim();
		if (err) return out ? `${out}\n${err}` : err;
		return out;
	}

	return formatToolResponse(toolResponse);
}

export function ResponseBlock({
	response,
	isFailed,
}: {
	response: string;
	isFailed: boolean;
}): React.ReactNode {
	if (!response) return null;
	return (
		<ToolResultContainer
			dimGutter={!isFailed}
			gutterColor={isFailed ? 'red' : undefined}
		>
			<Text color={isFailed ? 'red' : undefined} dimColor={!isFailed}>
				{response}
			</Text>
		</ToolResultContainer>
	);
}

export function StderrBlock({result}: {result: unknown}): React.ReactNode {
	const r = result as Record<string, unknown> | undefined;
	if (!r?.stderr) return null;
	return (
		<Box paddingLeft={3}>
			<Text color="red">{r.stderr as string}</Text>
		</Box>
	);
}
