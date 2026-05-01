import React from 'react';
import {Box, Text} from 'ink';
import {type Message as MessageType} from '../../shared/types/common';
import {useTheme} from '../theme/index';
import {MarkdownText} from './ToolOutput/index';
import {getGlyphs} from '../glyphs/index';
import {termColumns} from '../../shared/utils/terminal';

const g = getGlyphs();

type Props = {
	message: MessageType;
	parentWidth?: number;
};

export default function Message({
	message,
	parentWidth,
}: Props): React.ReactNode {
	const theme = useTheme();
	const isUser = message.role === 'user';

	if (isUser) {
		return (
			<Box flexDirection="column" marginBottom={1}>
				<Text
					wrap="wrap"
					color={theme.userMessage.text}
					backgroundColor={theme.userMessage.background}
				>
					{`${g['message.user']} `}
					{message.content}
				</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<Text color={theme.accent}>{`${g['tool.bullet']} `}</Text>
				<MarkdownText
					content={message.content.trimStart()}
					availableWidth={Math.max(10, (parentWidth ?? termColumns()) - 2)}
					mode="inline-feed"
				/>
			</Box>
		</Box>
	);
}
