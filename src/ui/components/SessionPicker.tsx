import {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {type SessionEntry} from '../../shared/types/session';
import {formatRelativeTime} from '../../shared/utils/formatters';
import {compactText} from '../../shared/utils/format';
import {useTheme} from '../theme/index';
import {startInputMeasure} from '../../shared/utils/perf';

type Props = {
	sessions: SessionEntry[];
	loading?: boolean;
	onSelect: (sessionId: string) => void;
	onCancel: () => void;
};

const VISIBLE_COUNT = 15;

export default function SessionPicker({
	sessions,
	loading,
	onSelect,
	onCancel,
}: Props) {
	const theme = useTheme();
	const [focusIndex, setFocusIndex] = useState(0);

	useInput((input, key) => {
		if (loading) {
			if (key.escape) onCancel();
			return;
		}
		const done = startInputMeasure('session.picker', input, key);
		try {
			if (key.downArrow) {
				setFocusIndex(i => Math.min(i + 1, sessions.length - 1));
			} else if (key.upArrow) {
				setFocusIndex(i => Math.max(i - 1, 0));
			} else if (key.return) {
				const session = sessions[focusIndex];
				onSelect(session.sessionId);
			} else if (key.escape) {
				onCancel();
			}
		} finally {
			done();
		}
	});

	if (loading) {
		return (
			<Box flexDirection="column" padding={1}>
				<Box marginBottom={1}>
					<Text bold color={theme.accent}>
						Sessions
					</Text>
				</Box>
				<Text dimColor>Loading sessions…</Text>
			</Box>
		);
	}

	if (sessions.length === 0) {
		return (
			<Box flexDirection="column" padding={1}>
				<Text dimColor>No previous sessions found.</Text>
			</Box>
		);
	}

	const scrollStart = Math.max(
		0,
		Math.min(
			focusIndex - Math.floor(VISIBLE_COUNT / 2),
			sessions.length - VISIBLE_COUNT,
		),
	);
	const visible = sessions.slice(scrollStart, scrollStart + VISIBLE_COUNT);

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color={theme.accent}>
					Sessions
				</Text>
			</Box>

			{visible.map((session, vi) => {
				const realIndex = scrollStart + vi;
				const isFocused = realIndex === focusIndex;

				const shortId = session.sessionId.slice(0, 8);
				const hasBranch =
					session.gitBranch && session.gitBranch !== 'no branch';
				const branch = hasBranch ? ` · ⎇ ${session.gitBranch}` : '';
				const time = formatRelativeTime(session.modified);
				const msgs =
					session.messageCount > 0
						? ` · ≡ ${session.messageCount} messages`
						: ' · 0 messages';
				const meta = `${shortId}${branch} · ${time}${msgs}`;

				const titleRaw =
					session.summary || session.firstPrompt || `Session ${shortId}`;
				const title = compactText(titleRaw.replace(/\n/g, ' ').trim(), 60);

				return (
					<Box key={session.sessionId} flexDirection="column" marginBottom={1}>
						<Box>
							<Text color={isFocused ? 'cyan' : undefined} bold={isFocused}>
								{isFocused ? '❯ ' : '  '}
								{title}
							</Text>
						</Box>
						<Box paddingLeft={2}>
							<Text dimColor>{meta}</Text>
						</Box>
					</Box>
				);
			})}

			<Box marginTop={1}>
				<Text dimColor>↑/↓ Navigate · Enter Select · Esc Cancel</Text>
			</Box>
		</Box>
	);
}
