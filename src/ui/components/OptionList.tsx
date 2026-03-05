import {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {useTheme} from '../theme/index';

export type OptionItem = {
	label: string;
	description?: string;
	value: string;
};

type Props = {
	options: OptionItem[];
	onSelect: (value: string) => void;
};

export default function OptionList({options, onSelect}: Props) {
	const theme = useTheme();
	const [focusIndex, setFocusIndex] = useState(0);

	useInput((input, key) => {
		if (key.downArrow) {
			setFocusIndex(i => (i + 1) % options.length);
		} else if (key.upArrow) {
			setFocusIndex(i => (i - 1 + options.length) % options.length);
		} else if (key.return) {
			const option = options[focusIndex];
			onSelect(option.value);
		} else {
			const num = parseInt(input, 10);
			if (num >= 1 && num <= options.length) {
				const option = options[num - 1];
				onSelect(option.value);
			}
		}
	});

	return (
		<Box flexDirection="column">
			{options.map((option, index) => {
				const isFocused = index === focusIndex;
				return (
					<Box key={option.value} flexDirection="column">
						<Box>
							<Text
								color={isFocused ? theme.accent : undefined}
								bold={isFocused}
								inverse={isFocused}
								dimColor={!isFocused}
							>
								{isFocused ? ' > ' : '   '}
								{option.label}
								{isFocused ? ' ' : ''}
							</Text>
						</Box>
						{isFocused && option.description ? (
							<Box paddingLeft={3}>
								<Text dimColor>{option.description}</Text>
							</Box>
						) : null}
					</Box>
				);
			})}
		</Box>
	);
}
