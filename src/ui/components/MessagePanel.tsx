import React, {useMemo} from 'react';
import {Text} from 'ink';
import chalk from 'chalk';
import {type TimelineEntry} from '../../core/feed/timeline';
import {classifyEntry, messageText} from '../../core/feed/panelFilter';
import {renderMarkdown} from '../../shared/utils/markedFactory';
import {type Theme} from '../theme/types';
import {fitAnsi, spaces} from '../../shared/utils/format';

type Props = {
	entries: TimelineEntry[];
	width: number;
	contentRows: number;
	viewportStart: number;
	cursor: number;
	focused: boolean;
	theme: Theme;
	borderColor?: string;
};

function buildRenderedLines(
	entries: TimelineEntry[],
	width: number,
	theme: Theme,
): {text: string; entryIndex: number}[] {
	const result: {text: string; entryIndex: number}[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const isUser = classifyEntry(entry) === 'user';
		const raw = messageText(entry);
		const rendered = renderMarkdown(raw, width);
		for (const line of rendered) {
			const styled = isUser ? chalk.hex(theme.textMuted)(line) : line;
			result.push({
				text: fitAnsi(styled, width),
				entryIndex: i,
			});
		}
		if (i < entries.length - 1) {
			result.push({text: spaces(width), entryIndex: i});
		}
	}
	return result;
}

function sliceViewport(
	wrapped: {text: string; entryIndex: number}[],
	contentRows: number,
	viewportStart: number,
	borderColor: string | undefined,
	theme: Theme,
	width: number,
): string[] {
	const outputLines: string[] = [];
	const leftBorder = borderColor ? chalk.hex(borderColor)('\u2502') : '';

	if (wrapped.length === 0) {
		const emptyMsg = chalk.hex(theme.textMuted)('No messages yet');
		outputLines.push(leftBorder + fitAnsi(`  ${emptyMsg}`, width));
		for (let i = 1; i < contentRows; i++) {
			outputLines.push(leftBorder + spaces(width));
		}
		return outputLines;
	}

	const totalLines = wrapped.length;
	const start = Math.min(viewportStart, Math.max(0, totalLines - contentRows));
	const end = Math.min(start + contentRows, totalLines);
	const rendered = end - start;

	for (let i = start; i < end; i++) {
		outputLines.push(leftBorder + fitAnsi(wrapped[i]!.text, width));
	}

	for (let i = rendered; i < contentRows; i++) {
		outputLines.push(leftBorder + spaces(width));
	}

	return outputLines;
}

function MessagePanelImpl(props: Props) {
	const {entries, width, contentRows, viewportStart, theme, borderColor} =
		props;

	// Expensive: only recomputes when entries/width/theme change (not on scroll)
	const wrapped = useMemo(
		() => buildRenderedLines(entries, width, theme),
		[entries, width, theme],
	);

	// Cheap: viewport slicing on scroll/resize
	const lines = useMemo(
		() =>
			sliceViewport(
				wrapped,
				contentRows,
				viewportStart,
				borderColor,
				theme,
				width,
			),
		[wrapped, contentRows, viewportStart, borderColor, theme, width],
	);

	return <Text>{lines.join('\n')}</Text>;
}

export const MessagePanel = React.memo(MessagePanelImpl);
