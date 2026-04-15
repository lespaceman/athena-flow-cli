import React, {useMemo} from 'react';
import {Text} from 'ink';
import chalk from 'chalk';
import {type TimelineEntry} from '../../core/feed/timeline';
import {classifyEntry, messageText} from '../../core/feed/panelFilter';
import {renderMarkdown} from '../../shared/markdown/renderMarkdown';
import {type Theme} from '../theme/types';
import {messageGlyphs} from '../glyphs/index';
import {fitAnsi, spaces, wrapText} from '../../shared/utils/format';

type Props = {
	entries: TimelineEntry[];
	width: number;
	contentRows: number;
	viewportStart: number;
	theme: Theme;
	borderColor?: string;
};

type WrappedLine = {
	text: string;
	entryIndex: number;
	kind: 'user' | 'agent';
	isSeparator: boolean;
};

/** [frame border][indicator ┃][ ][content...] — indicator + space = 2 columns */
export const INDICATOR_OVERHEAD = 2;

function buildRenderedLines(
	entries: TimelineEntry[],
	width: number,
	theme: Theme,
): WrappedLine[] {
	const contentWidth = width - INDICATOR_OVERHEAD;
	const result: WrappedLine[] = [];
	let prevKind: 'user' | 'agent' | undefined;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const kind = classifyEntry(entry) === 'user' ? 'user' : 'agent';

		if (prevKind !== undefined) {
			result.push({
				text: spaces(contentWidth),
				entryIndex: i - 1,
				kind: prevKind,
				isSeparator: true,
			});
		}

		const raw = messageText(entry);
		const rendered =
			kind === 'user'
				? wrapText(raw, contentWidth)
				: renderMarkdown({
						content: raw,
						width: contentWidth,
						mode: 'inline-feed',
					}).lines;
		for (const line of rendered) {
			const styled =
				kind === 'user' ? chalk.hex(theme.userMessage.text)(line) : line;
			result.push({
				text: fitAnsi(styled, contentWidth),
				entryIndex: i,
				kind,
				isSeparator: false,
			});
		}

		prevKind = kind;
	}
	return result;
}

function sliceViewport(
	wrapped: WrappedLine[],
	contentRows: number,
	viewportStart: number,
	frameBorder: string,
	userIndicator: string,
	agentIndicator: string,
	theme: Theme,
	width: number,
): string[] {
	const outputLines: string[] = [];
	const contentWidth = width - INDICATOR_OVERHEAD;
	const blankRow = frameBorder + spaces(width);

	if (wrapped.length === 0) {
		const emptyMsg = chalk.hex(theme.textMuted)('No messages yet');
		outputLines.push(frameBorder + '  ' + fitAnsi(emptyMsg, contentWidth));
		for (let i = 1; i < contentRows; i++) {
			outputLines.push(blankRow);
		}
		return outputLines;
	}

	const totalLines = wrapped.length;
	const start = Math.min(viewportStart, Math.max(0, totalLines - contentRows));
	const end = Math.min(start + contentRows, totalLines);
	const rendered = end - start;

	let scrollIndicator = '';
	if (totalLines > contentRows) {
		const above = start;
		const below = totalLines - end;
		if (above > 0 || below > 0) {
			const parts: string[] = [];
			if (above > 0) parts.push(`\u2191${above}`);
			if (below > 0) parts.push(`\u2193${below}`);
			scrollIndicator = parts.join(' ');
		}
	}

	for (let lineIdx = start; lineIdx < end; lineIdx++) {
		const line = wrapped[lineIdx]!;

		if (line.isSeparator) {
			outputLines.push(blankRow);
			continue;
		}

		const indicator = line.kind === 'agent' ? agentIndicator : userIndicator;
		const content = line.text;

		let row = frameBorder + indicator + ' ' + content;

		if (scrollIndicator && lineIdx === start) {
			const indicatorStyled = chalk.hex(theme.textMuted)(scrollIndicator);
			const padded = fitAnsi(
				line.text,
				contentWidth - scrollIndicator.length - 1,
			);
			row = frameBorder + indicator + ' ' + padded + ' ' + indicatorStyled;
		}

		outputLines.push(row);
	}

	for (let i = rendered; i < contentRows; i++) {
		outputLines.push(blankRow);
	}

	return outputLines;
}

function MessagePanelImpl(props: Props) {
	const {entries, width, contentRows, viewportStart, theme, borderColor} =
		props;

	const wrapped = useMemo(
		() => buildRenderedLines(entries, width, theme),
		[entries, width, theme],
	);

	const glyphChar = messageGlyphs().indicator;
	const frameBorder = borderColor ? chalk.hex(borderColor)('\u2502') : '';
	const userIndicator = chalk.hex(theme.userMessage.border)(glyphChar);
	const agentIndicator = chalk.hex(theme.userMessage.agentBorder)(glyphChar);

	const lines = useMemo(
		() =>
			sliceViewport(
				wrapped,
				contentRows,
				viewportStart,
				frameBorder,
				userIndicator,
				agentIndicator,
				theme,
				width,
			),
		[
			wrapped,
			contentRows,
			viewportStart,
			frameBorder,
			userIndicator,
			agentIndicator,
			theme,
			width,
		],
	);

	return <Text>{lines.join('\n')}</Text>;
}

export const MessagePanel = React.memo(MessagePanelImpl);
