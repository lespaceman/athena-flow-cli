import React from 'react';
import {Box, Text} from 'ink';
import {type Tokens} from 'marked';
import chalk from 'chalk';
import {createMarkedInstance} from '../../../shared/utils/markedFactory';
import {termColumns} from '../../../shared/utils/terminal';

type Props = {
	content: string;
	maxLines?: number;
	availableWidth?: number;
};

function createMarked(width: number) {
	const m = createMarkedInstance(width, {
		heading({tokens, depth}: Tokens.Heading): string {
			const text = m.parser(tokens);
			const styled =
				depth === 1 ? chalk.bold.underline(text) : chalk.bold(text);
			return styled + '\n';
		},
		hr(): string {
			return chalk.dim('───') + '\n';
		},
	});
	return m;
}

export default function MarkdownText({
	content,
	maxLines,
	availableWidth,
}: Props): React.ReactNode {
	if (!content) return null;

	const width = availableWidth ?? termColumns();
	const marked = createMarked(width);

	let rendered: string;
	try {
		const result = marked.parse(content);
		rendered = typeof result === 'string' ? result.trimEnd() : content;
		rendered = rendered.replace(/\n{3,}/g, '\n');
	} catch {
		rendered = content;
	}

	if (maxLines != null) {
		const lines = rendered.split('\n');
		if (lines.length > maxLines) {
			const omitted = lines.length - maxLines;
			rendered = lines.slice(0, maxLines).join('\n');
			return (
				<Box flexDirection="column">
					<Text>{rendered}</Text>
					<Text dimColor>({omitted} more lines)</Text>
				</Box>
			);
		}
	}

	return <Text>{rendered}</Text>;
}
