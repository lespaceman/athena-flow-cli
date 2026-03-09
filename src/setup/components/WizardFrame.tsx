import type {ReactNode} from 'react';
import {Box, Text, useStdout} from 'ink';
import {useTheme} from '../../ui/theme/index';
import {getGlyphs} from '../../ui/glyphs/index';

type Props = {
	title: string;
	header: ReactNode;
	footer: ReactNode;
	children: ReactNode;
};

const MAX_WIDTH = 60;

export default function WizardFrame({title, header, footer, children}: Props) {
	const theme = useTheme();
	const g = getGlyphs();
	const {stdout} = useStdout();
	const columns = stdout?.columns ?? 80;
	const frameWidth = Math.min(columns - 4, MAX_WIDTH);
	const h = g['frame.horizontal'];

	// Top border: ┌─── TITLE ───...───┐
	const titlePadded = ` ${title} `;
	const topFillCount = Math.max(0, frameWidth - 2 - titlePadded.length - 3);
	const topLine = `${g['frame.topLeft']}${h.repeat(3)}${titlePadded}${h.repeat(topFillCount)}${g['frame.topRight']}`;

	// Tee divider: ├───...───┤
	const teeLine = `${g['frame.teeLeft']}${h.repeat(frameWidth - 2)}${g['frame.teeRight']}`;

	// Bottom border: └───...───┘
	const bottomLine = `${g['frame.bottomLeft']}${h.repeat(frameWidth - 2)}${g['frame.bottomRight']}`;

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text color={theme.accent}>{topLine}</Text>

			{/* Header zone */}
			<Box flexDirection="column" paddingX={1} paddingY={1}>
				{header}
			</Box>

			<Text color={theme.accent}>{teeLine}</Text>

			{/* Content zone */}
			<Box flexDirection="column" paddingX={1} paddingY={1}>
				{children}
			</Box>

			<Text color={theme.accent}>{teeLine}</Text>

			{/* Footer zone */}
			<Box paddingX={1}>{footer}</Box>

			<Text color={theme.accent}>{bottomLine}</Text>
		</Box>
	);
}
