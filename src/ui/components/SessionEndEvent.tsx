import {Box, Text} from 'ink';
import type {FeedEvent} from '../../core/feed/types';
import {getStatusColors} from './hookEventUtils';
import {useTheme} from '../theme/index';
import {getGlyphs} from '../glyphs/index';

const g = getGlyphs();

type Props = {
	event: FeedEvent;
};

export default function SessionEndEvent({event}: Props) {
	const theme = useTheme();
	const statusColors = getStatusColors(theme);
	const color = statusColors.passthrough;
	const symbol = g['task.completed'];

	// Format timestamp
	const time = new Date(event.ts).toLocaleTimeString('en-US', {
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});

	const reason = event.kind === 'session.end' ? event.data.reason : 'unknown';

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor={color}
			paddingX={1}
			marginY={0}
		>
			{/* Header row */}
			<Box>
				<Text color={color}>
					{symbol} [{time}] SessionEnd
				</Text>
			</Box>

			{/* Session end reason */}
			<Box marginTop={0}>
				<Text color={theme.textMuted}>Reason: </Text>
				<Text>{reason}</Text>
			</Box>
		</Box>
	);
}
