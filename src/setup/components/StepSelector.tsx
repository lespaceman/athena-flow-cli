import {useEffect, useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {useTheme} from '../../ui/theme/index';

export type SelectorOption = {
	label: string;
	value: string;
	disabled?: boolean;
};

type Props = {
	options: SelectorOption[];
	onSelect: (value: string) => void;
	isActive?: boolean;
	initialValue?: string;
	onHighlight?: (value: string) => void;
};

function getInitialCursor(
	options: SelectorOption[],
	initialValue: string | undefined,
): number {
	if (initialValue) {
		const initialIndex = options.findIndex(
			option => option.value === initialValue && !option.disabled,
		);
		if (initialIndex >= 0) {
			return initialIndex;
		}
	}
	const firstEnabled = options.findIndex(option => !option.disabled);
	return firstEnabled >= 0 ? firstEnabled : 0;
}

export default function StepSelector({
	options,
	onSelect,
	isActive = true,
	initialValue,
	onHighlight,
}: Props) {
	const theme = useTheme();
	const [cursor, setCursor] = useState(() =>
		getInitialCursor(options, initialValue),
	);
	const highlightedRef = useRef<string | undefined>(undefined);

	const moveCursor = (direction: -1 | 1) => {
		setCursor(prev => {
			if (options.length <= 1) {
				return prev;
			}
			let next = prev;
			for (let i = 0; i < options.length; i += 1) {
				const candidate = Math.max(
					0,
					Math.min(next + direction, options.length - 1),
				);
				if (candidate === next) {
					return prev;
				}
				next = candidate;
				if (!options[next]?.disabled) {
					return next;
				}
			}
			return prev;
		});
	};

	useInput(
		(_input, key) => {
			if (key.downArrow) {
				moveCursor(1);
			} else if (key.upArrow) {
				moveCursor(-1);
			} else if (key.return) {
				const opt = options[cursor];
				if (!opt.disabled) {
					onSelect(opt.value);
				}
			}
		},
		{isActive},
	);

	useEffect(() => {
		if (!onHighlight) {
			return;
		}
		const option = options[cursor];
		if (option.disabled) {
			return;
		}
		if (highlightedRef.current === option.value) {
			return;
		}
		highlightedRef.current = option.value;
		onHighlight(option.value);
	}, [cursor, options, onHighlight]);

	return (
		<Box flexDirection="column">
			{options.map((opt, i) => {
				const isCursor = i === cursor;
				const prefix = isCursor ? '>' : ' ';
				return (
					<Text
						key={opt.value}
						color={
							opt.disabled
								? theme.textMuted
								: isCursor
									? theme.accent
									: theme.text
						}
						bold={isCursor && !opt.disabled}
					>
						{prefix} {opt.label}
					</Text>
				);
			})}
		</Box>
	);
}
