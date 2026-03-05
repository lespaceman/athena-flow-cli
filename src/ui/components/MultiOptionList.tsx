import {useState, useCallback} from 'react';
import {Box, Text, useInput} from 'ink';
import {type OptionItem} from './OptionList';
import {useTheme} from '../theme/index';

type Props = {
	options: OptionItem[];
	onSubmit: (values: string[]) => void;
};

export default function MultiOptionList({options, onSubmit}: Props) {
	const theme = useTheme();
	const [focusIndex, setFocusIndex] = useState(0);
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const toggleOption = useCallback((value: string) => {
		setSelected(prev => {
			const next = new Set(prev);
			if (next.has(value)) {
				next.delete(value);
			} else {
				next.add(value);
			}
			return next;
		});
	}, []);

	useInput((input, key) => {
		if (key.downArrow) {
			setFocusIndex(i => (i + 1) % options.length);
		} else if (key.upArrow) {
			setFocusIndex(i => (i - 1 + options.length) % options.length);
		} else if (input === ' ') {
			const option = options[focusIndex];
			toggleOption(option.value);
		} else if (key.return) {
			onSubmit(options.filter(o => selected.has(o.value)).map(o => o.value));
		} else {
			const num = parseInt(input, 10);
			if (num >= 1 && num <= options.length) {
				const option = options[num - 1];
				toggleOption(option.value);
			}
		}
	});

	return (
		<Box flexDirection="column">
			{options.map((option, index) => {
				const isFocused = index === focusIndex;
				const isSelected = selected.has(option.value);
				const checkbox = isSelected ? 'x' : ' ';
				return (
					<Box key={option.value} flexDirection="column">
						<Box>
							<Text
								color={isFocused ? theme.accent : undefined}
								bold={isFocused}
								inverse={isFocused}
								dimColor={!isFocused}
							>
								{isFocused ? ' > ' : '   '}[{checkbox}] {option.label}
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
