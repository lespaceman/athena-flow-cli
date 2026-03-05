import React from 'react';
import {Box, Text} from 'ink';
import {useTheme} from '../../theme/index';
import {type DiffHunk, type DiffLine} from '../../../shared/types/toolOutput';
import {fileLink} from '../../../shared/utils/hyperlink';
import {termColumns} from '../../../shared/utils/terminal';

type Props = {
	oldText: string;
	newText: string;
	hunks?: DiffHunk[];
	filePath?: string;
	maxLines?: number;
	availableWidth?: number;
};

const LINE_NO_WIDTH = 4;

function formatLineNo(n: number | undefined): string {
	if (n == null) return ' '.repeat(LINE_NO_WIDTH);
	const s = String(n);
	return s.length >= LINE_NO_WIDTH ? s : s.padStart(LINE_NO_WIDTH);
}

function UnifiedLine({
	line,
	errorColor,
	successColor,
}: {
	line: DiffLine;
	errorColor: string;
	successColor: string;
}): React.ReactNode {
	let prefix: string;
	let color: string | undefined;
	if (line.type === 'add') {
		prefix = '+';
		color = successColor;
	} else if (line.type === 'remove') {
		prefix = '-';
		color = errorColor;
	} else {
		prefix = ' ';
		color = undefined;
	}
	return (
		<Text>
			<Text dimColor>
				{formatLineNo(line.oldLineNo)} {formatLineNo(line.newLineNo)}
				{' │ '}
			</Text>
			<Text color={color}>
				{prefix} {line.content}
			</Text>
		</Text>
	);
}

function SideBySideLine({
	left,
	right,
	halfWidth,
	errorColor,
	successColor,
}: {
	left?: DiffLine;
	right?: DiffLine;
	halfWidth: number;
	errorColor: string;
	successColor: string;
}): React.ReactNode {
	const leftText = left
		? `${formatLineNo(left.oldLineNo)} │ - ${left.content}`
		: '';
	const rightText = right
		? `${formatLineNo(right.newLineNo)} │ + ${right.content}`
		: '';
	const padded = leftText.padEnd(halfWidth);
	return (
		<Text>
			<Text color={left ? errorColor : undefined}>{padded}</Text>
			<Text dimColor>{' ║ '}</Text>
			<Text color={right ? successColor : undefined}>{rightText}</Text>
		</Text>
	);
}

function HunkView({
	hunk,
	availableWidth,
	errorColor,
	successColor,
}: {
	hunk: DiffHunk;
	availableWidth: number;
	errorColor: string;
	successColor: string;
}): React.ReactNode {
	const sideBySide = availableWidth >= 120;

	if (sideBySide) {
		const halfWidth = Math.floor((availableWidth - 3) / 2); // 3 for ║ separator
		const removes: DiffLine[] = [];
		const adds: DiffLine[] = [];
		const rows: React.ReactNode[] = [];

		const flushPairs = () => {
			const count = Math.max(removes.length, adds.length);
			for (let i = 0; i < count; i++) {
				rows.push(
					<SideBySideLine
						key={rows.length}
						left={removes[i]}
						right={adds[i]}
						halfWidth={halfWidth}
						errorColor={errorColor}
						successColor={successColor}
					/>,
				);
			}
			removes.length = 0;
			adds.length = 0;
		};

		for (const line of hunk.lines) {
			if (line.type === 'context') {
				flushPairs();
				rows.push(
					<Text key={rows.length} dimColor>
						{formatLineNo(line.oldLineNo)} │ {'  '}
						{line.content}
						<Text dimColor>{' ║ '}</Text>
						{formatLineNo(line.newLineNo)} │ {'  '}
						{line.content}
					</Text>,
				);
			} else if (line.type === 'remove') {
				removes.push(line);
			} else {
				adds.push(line);
			}
		}
		flushPairs();

		return (
			<Box flexDirection="column">
				<Text dimColor>{hunk.header}</Text>
				{rows}
			</Box>
		);
	}

	// Unified view
	return (
		<Box flexDirection="column">
			<Text dimColor>{hunk.header}</Text>
			{hunk.lines.map((line, i) => (
				<UnifiedLine
					key={i}
					line={line}
					errorColor={errorColor}
					successColor={successColor}
				/>
			))}
		</Box>
	);
}

export default function DiffBlock({
	oldText,
	newText,
	hunks,
	filePath,
	maxLines,
	availableWidth,
}: Props): React.ReactNode {
	const theme = useTheme();

	// Rich hunk-based rendering
	if (hunks && hunks.length > 0) {
		const width = availableWidth ?? termColumns();
		return (
			<Box flexDirection="column">
				{filePath && <Text dimColor>{fileLink(filePath)}</Text>}
				{hunks.map((hunk, i) => (
					<HunkView
						key={i}
						hunk={hunk}
						availableWidth={width}
						errorColor={theme.status.error}
						successColor={theme.status.success}
					/>
				))}
			</Box>
		);
	}

	// Legacy old/new text fallback
	if (!oldText && !newText) return null;

	const oldLines = oldText.split('\n');
	const newLines = newText.split('\n');
	const allLines = [
		...oldLines.map(line => ({prefix: '- ', line, color: theme.status.error})),
		...newLines.map(line => ({
			prefix: '+ ',
			line,
			color: theme.status.success,
		})),
	];

	const truncated = maxLines != null && allLines.length > maxLines;
	const displayLines = truncated ? allLines.slice(0, maxLines) : allLines;
	const omitted = truncated ? allLines.length - maxLines! : 0;

	return (
		<Box flexDirection="column">
			{displayLines.map((entry, i) => (
				<Text key={i} color={entry.color}>
					{entry.prefix}
					{entry.line}
				</Text>
			))}
			{truncated && <Text dimColor>({omitted} more lines)</Text>}
		</Box>
	);
}
