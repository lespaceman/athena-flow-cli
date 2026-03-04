import React from 'react';
import {Box, Text} from 'ink';
import {frameGlyphs} from '../glyphs/index';

type Props = {
	children: React.ReactNode;
	innerWidth: number;
	ascii: boolean;
	/** Number of visual rows this frame row spans (default: 1) */
	height?: number;
};

export function FrameRow({children, innerWidth, ascii, height = 1}: Props) {
	const fr = frameGlyphs(ascii);
	const borderText =
		height <= 1 ? fr.vertical : Array(height).fill(fr.vertical).join('\n');
	return (
		<Box
			flexDirection="row"
			width={innerWidth + 2}
			flexShrink={0}
			height={height}
			flexWrap="nowrap"
			overflow="hidden"
			overflowY="hidden"
		>
			<Box width={1} flexShrink={0}>
				<Text wrap="truncate-end">{borderText}</Text>
			</Box>
			<Box
				width={innerWidth}
				height={height}
				flexShrink={0}
				flexDirection="row"
				flexWrap="nowrap"
				overflow="hidden"
				overflowY="hidden"
			>
				{children}
			</Box>
			<Box width={1} flexShrink={0}>
				<Text wrap="truncate-end">{borderText}</Text>
			</Box>
		</Box>
	);
}
