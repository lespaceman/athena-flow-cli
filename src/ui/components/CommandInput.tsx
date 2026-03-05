import process from 'node:process';
import React, {useState, useMemo, useEffect, useCallback, useRef} from 'react';
import {Box, Text, useInput} from 'ink';
import {useTextInput} from '../hooks/useTextInput';
import * as registry from '../../app/commands/registry';
import {type Command} from '../../app/commands/types';
import CommandSuggestions from './CommandSuggestions';
import {useTheme} from '../theme/index';

const MAX_FILTERED_SUGGESTIONS = 6;
const PLACEHOLDER = 'Type a message or /command...';

type Props = {
	onSubmit: (value: string) => void;
	disabled?: boolean;
	disabledMessage?: string;
	onEscape?: () => void;
	onArrowUp?: (currentValue: string) => string | undefined;
	onArrowDown?: () => string | undefined;
};

/**
 * Holds mutable "latest" values so that stable useCallback/useInput handlers
 * can read current state without re-registering on every render.
 */
type LatestValues = {
	showSuggestions: boolean;
	filteredCommands: Command[];
	safeIndex: number;
	disabled: boolean | undefined;
	value: string;
	onEscape: Props['onEscape'];
	onArrowUp: Props['onArrowUp'];
	onArrowDown: Props['onArrowDown'];
	setValue: (v: string) => void;
};

export default function CommandInput({
	onSubmit,
	disabled,
	disabledMessage,
	onEscape,
	onArrowUp,
	onArrowDown,
}: Props) {
	const [filterValue, setFilterValue] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	// When a value is recalled from history (Up/Down), suppress command
	// mode so suggestions don't appear and trap arrow-key navigation.
	// Cleared on any non-arrow keypress (typing, Escape, Tab, etc.).
	const suppressSuggestionsRef = useRef(false);

	const latest = useRef<LatestValues>({} as LatestValues);

	const handleSubmit = useCallback(
		(val: string) => {
			if (disabled) return;
			const cur = latest.current;
			// When suggestions are visible, submit the selected command
			let submitted = val;
			if (cur.showSuggestions) {
				const cmd = cur.filteredCommands[cur.safeIndex];
				submitted = `/${cmd.name}`;
			}
			if (!submitted.trim()) return;
			onSubmit(submitted);
			cur.setValue('');
		},
		[onSubmit, disabled],
	);

	const {value, cursorOffset, setValue} = useTextInput({
		onChange: setFilterValue,
		onSubmit: handleSubmit,
		isActive: !disabled,
	});

	// Determine if we're in command mode (input starts with / and no space yet).
	// Suppressed when the value was recalled from history so suggestions
	// don't trap arrow-key navigation.
	const isCommandMode =
		!suppressSuggestionsRef.current &&
		filterValue.startsWith('/') &&
		!filterValue.includes(' ');
	const prefix = isCommandMode ? filterValue.slice(1) : '';

	// Filter commands matching the typed prefix
	const filteredCommands = useMemo(() => {
		if (!isCommandMode) return [];
		if (prefix === '') return registry.getAll();

		return registry
			.getAll()
			.filter(cmd => {
				const names = [cmd.name, ...(cmd.aliases ?? [])];
				return names.some(n => n.startsWith(prefix));
			})
			.slice(0, MAX_FILTERED_SUGGESTIONS);
	}, [isCommandMode, prefix]);

	const showSuggestions = filteredCommands.length > 0;

	// Clamp selectedIndex to valid range synchronously
	const safeIndex = showSuggestions
		? Math.min(selectedIndex, filteredCommands.length - 1)
		: 0;

	// Reset selectedIndex when the filtered list changes
	const filteredKey = filteredCommands.map(c => c.name).join(',');
	useEffect(() => {
		setSelectedIndex(0);
	}, [filteredKey]);

	// Sync all latest values into a single ref for stable callbacks
	latest.current = {
		showSuggestions,
		filteredCommands,
		safeIndex,
		disabled,
		value,
		onEscape,
		onArrowUp,
		onArrowDown,
		setValue,
	};

	// Tab completion: insert selected command name into input
	const completeSelected = useCallback(() => {
		const {
			filteredCommands: cmds,
			safeIndex: idx,
			setValue: set,
		} = latest.current;
		const cmd = cmds[idx];
		set(`/${cmd.name} `);
	}, []);

	// Meta-key handler (up/down/tab/escape) -- zero overlap with useTextInput
	const handleKeyInput = useCallback(
		(
			_input: string,
			key: {
				tab: boolean;
				upArrow: boolean;
				downArrow: boolean;
				escape: boolean;
			},
		) => {
			const cur = latest.current;
			if (cur.disabled) return;

			// Any key other than Up/Down clears history-recall suppression
			// so the user can re-enter command mode by typing.
			if (!key.upArrow && !key.downArrow) {
				suppressSuggestionsRef.current = false;
			}

			if (key.escape) {
				if (cur.showSuggestions) {
					cur.setValue('');
				} else {
					cur.onEscape?.();
				}
				return;
			}

			if (key.upArrow) {
				if (cur.showSuggestions) {
					setSelectedIndex(i => {
						const len = cur.filteredCommands.length;
						return i <= 0 ? len - 1 : i - 1;
					});
				} else {
					const result = cur.onArrowUp?.(cur.value);
					if (result !== undefined) {
						suppressSuggestionsRef.current = true;
						cur.setValue(result);
					}
				}
				return;
			}

			if (key.downArrow) {
				if (cur.showSuggestions) {
					setSelectedIndex(i => {
						const len = cur.filteredCommands.length;
						return i >= len - 1 ? 0 : i + 1;
					});
				} else {
					const result = cur.onArrowDown?.();
					if (result !== undefined) {
						suppressSuggestionsRef.current = true;
						cur.setValue(result);
					}
				}
				return;
			}

			if (key.tab && cur.showSuggestions) {
				completeSelected();
			}
		},
		[completeSelected],
	);

	useInput(handleKeyInput, {isActive: !disabled});

	const theme = useTheme();
	const promptColor = isCommandMode ? theme.accent : theme.textMuted;

	return (
		<Box flexDirection="column">
			{showSuggestions && (
				<CommandSuggestions
					commands={filteredCommands}
					selectedIndex={safeIndex}
					innerWidth={process.stdout.columns || 80}
					wrapLine={(line: string) => line}
				/>
			)}
			<Box
				borderStyle="single"
				borderColor={theme.textMuted}
				borderTop
				borderBottom={false}
				borderLeft={false}
				borderRight={false}
				paddingX={1}
			>
				<Text color={promptColor}>{'>'} </Text>
				{renderInputContent(disabled, disabledMessage, value, cursorOffset)}
			</Box>
		</Box>
	);
}

function renderInputContent(
	disabled: boolean | undefined,
	disabledMessage: string | undefined,
	value: string,
	cursorOffset: number,
): React.ReactNode {
	if (disabled) {
		return (
			<Text dimColor>
				{disabledMessage ?? 'Waiting for permission decision...'}
			</Text>
		);
	}

	if (value.length === 0) {
		return (
			<>
				<Text dimColor inverse>
					{PLACEHOLDER[0]}
				</Text>
				<Text dimColor>{PLACEHOLDER.slice(1)}</Text>
			</>
		);
	}

	const beforeCursor = value.slice(0, cursorOffset);
	const cursorChar = cursorOffset < value.length ? value[cursorOffset] : ' ';
	const afterCursor =
		cursorOffset < value.length ? value.slice(cursorOffset + 1) : '';

	return (
		<Text>
			{beforeCursor}
			<Text inverse>{cursorChar}</Text>
			{afterCursor}
		</Text>
	);
}
