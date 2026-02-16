import React from 'react';
import {Box, Text} from 'ink';

// Layout: [GUTTER 2 ("⎿ ")][CONTENT...][RIGHT_PAD 2]
const GUTTER_WIDTH = 2;
const RIGHT_PAD = 2;
const TOTAL_OVERHEAD = GUTTER_WIDTH + RIGHT_PAD;

const DEFAULT_COLLAPSE_THRESHOLD = 5;

type Props = {
	children: React.ReactNode | ((availableWidth: number) => React.ReactNode);
	dimGutter?: boolean;
	gutterColor?: string;
	parentWidth?: number;
	previewLines?: string[];
	totalLineCount?: number;
	toolId?: string;
	collapseThreshold?: number;
};

export default function ToolResultContainer({
	children,
	dimGutter = true,
	gutterColor,
	parentWidth,
	previewLines,
	totalLineCount,
	toolId,
	collapseThreshold = DEFAULT_COLLAPSE_THRESHOLD,
}: Props): React.ReactNode {
	if (children == null && !previewLines) return null;

	const baseWidth = parentWidth ?? process.stdout.columns ?? 80;
	const availableWidth = Math.max(baseWidth - TOTAL_OVERHEAD, 20);

	const shouldCollapse =
		previewLines !== undefined &&
		totalLineCount !== undefined &&
		totalLineCount > collapseThreshold;

	if (shouldCollapse) {
		const remaining = totalLineCount - previewLines.length;
		return (
			<Box>
				<Box width={GUTTER_WIDTH} flexShrink={0}>
					<Text dimColor={dimGutter} color={gutterColor}>
						{'\u23bf'}{' '}
					</Text>
				</Box>
				<Box flexDirection="column" width={availableWidth}>
					{previewLines.map((line, i) => (
						<Text key={i}>{line}</Text>
					))}
					<Text dimColor>
						(+{remaining} lines{toolId ? `, :open ${toolId} to expand` : ''})
					</Text>
				</Box>
			</Box>
		);
	}

	const content =
		typeof children === 'function' ? children(availableWidth) : children;

	if (content == null) return null;

	return (
		<Box>
			<Box width={GUTTER_WIDTH} flexShrink={0}>
				<Text dimColor={dimGutter} color={gutterColor}>
					{'\u23bf'}{' '}
				</Text>
			</Box>
			<Box flexDirection="column" width={availableWidth}>
				{content}
			</Box>
		</Box>
	);
}

export {TOTAL_OVERHEAD};
