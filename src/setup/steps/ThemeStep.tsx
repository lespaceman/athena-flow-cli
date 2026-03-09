import {Box, Text} from 'ink';
import StepSelector from '../components/StepSelector';
import {useTheme} from '../../ui/theme/index';

type Props = {
	onComplete: (theme: string) => void;
	onPreview?: (theme: string) => void;
};

export default function ThemeStep({onComplete, onPreview}: Props) {
	const theme = useTheme();

	return (
		<Box flexDirection="column">
			<Text bold color={theme.accent}>
				Choose your display theme
			</Text>
			<Text color={theme.textMuted}>
				This applies immediately after setup completes.
			</Text>
			<Box marginTop={1}>
				<StepSelector
					options={[
						{
							label: 'Dark',
							value: 'dark',
							description: 'Warm gray on dark background',
						},
						{
							label: 'Light',
							value: 'light',
							description: 'Dark text on light background',
						},
						{
							label: 'High Contrast',
							value: 'high-contrast',
							description: 'Maximum readability',
						},
					]}
					initialValue={theme.name}
					onHighlight={onPreview}
					onSelect={onComplete}
				/>
			</Box>
		</Box>
	);
}
