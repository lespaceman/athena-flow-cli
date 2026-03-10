/**
 * Renders an AskUserQuestion event.
 *
 * Shows a minimal "Question (N questions)" indicator. The QuestionDialog
 * handles the full interactive UI. After the user answers, a separate
 * decision event handles that state.
 */

import React from 'react';
import {Box, Text} from 'ink';
import type {FeedEvent} from '../../core/feed/types';
import {getStatusColors, STATUS_SYMBOLS} from './hookEventUtils';
import {useTheme} from '../theme/index';

type Props = {
	event: FeedEvent;
};

export default function AskUserQuestionEvent({event}: Props): React.ReactNode {
	const theme = useTheme();
	const statusColors = getStatusColors(theme);
	const color = statusColors.passthrough;
	const symbol = STATUS_SYMBOLS.passthrough;

	if (event.kind !== 'tool.pre' && event.kind !== 'permission.request') {
		return null;
	}

	const toolInput = event.data.tool_input;
	const questions = toolInput.questions as
		| Array<{question: string; header: string}>
		| undefined;

	return (
		<Box marginTop={1}>
			<Text color={color}>{symbol} </Text>
			<Text color={theme.accent} bold>
				Question
			</Text>
			{questions && questions.length > 0 && (
				<Text dimColor>
					{' '}
					({questions.length} question{questions.length > 1 ? 's' : ''})
				</Text>
			)}
		</Box>
	);
}
