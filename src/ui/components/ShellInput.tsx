import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react';
import {Box, Text, useInput} from 'ink';
import * as registry from '../../app/commands/registry';
import {type Command} from '../../app/commands/types';
import {
	cursorToVisualPosition,
	isCommandPrefix,
	renderInputLines,
} from '../../shared/utils/format';
import {useTextInput} from '../hooks/useTextInput';
import CommandSuggestions from './CommandSuggestions';
import {FrameRow} from './FrameRow';

const MAX_SUGGESTIONS = 6;

export type ShellInputHandle = {
	moveUp: () => void;
	moveDown: () => void;
	getSelectedCommand: () => Command | undefined;
	readonly showSuggestions: boolean;
};

type Props = {
	innerWidth: number;
	useAscii: boolean;
	borderColor: string;
	inputRows: number;
	inputPrefix: string;
	inputPromptStyled: string;
	inputContentWidth: number;
	textInputPlaceholder: string;
	textColor: string;
	inputPlaceholderColor: string;
	isInputActive: boolean;
	onChange?: (value: string) => void;
	onSubmit?: (value: string) => void;
	onHistoryBack?: (currentValue: string) => string | undefined;
	onHistoryForward?: () => string | undefined;
	suppressArrows?: boolean;
	setValueRef?: (setValue: (value: string) => void) => void;
	badgeText: string;
	runBadgeStyled: string;
	modeBadgeStyled: string;
	border: (text: string) => string;
	bottomBorder: string;
	commandSuggestionsEnabled: boolean;
	wrapSuggestionLine: (line: string) => string;
};

const ShellInputImpl = forwardRef<ShellInputHandle, Props>(function ShellInput(
	{
		innerWidth,
		useAscii,
		borderColor,
		inputRows,
		inputPrefix,
		inputPromptStyled,
		inputContentWidth,
		textInputPlaceholder,
		textColor,
		inputPlaceholderColor,
		isInputActive,
		onChange,
		onSubmit,
		onHistoryBack,
		onHistoryForward,
		suppressArrows,
		setValueRef,
		badgeText,
		runBadgeStyled,
		modeBadgeStyled,
		border,
		bottomBorder,
		commandSuggestionsEnabled,
		wrapSuggestionLine,
	},
	ref,
) {
	const {value, cursorOffset, setValue, dispatch} = useTextInput({
		onChange,
		onSubmit,
		isActive: isInputActive,
	});

	const setValueRefCb = useRef(setValueRef);
	setValueRefCb.current = setValueRef;
	useEffect(() => {
		setValueRefCb.current?.(setValue);
	}, [setValue]);

	const stateRef = useRef({value, cursorOffset});
	stateRef.current = {value, cursorOffset};
	const historyBackRef = useRef(onHistoryBack);
	historyBackRef.current = onHistoryBack;
	const historyForwardRef = useRef(onHistoryForward);
	historyForwardRef.current = onHistoryForward;
	const suppressArrowsRef = useRef(suppressArrows);
	suppressArrowsRef.current = suppressArrows;

	const [selectedIndex, setSelectedIndex] = useState(0);
	const isCommandMode = commandSuggestionsEnabled && isCommandPrefix(value);
	const prefix = isCommandMode ? value.slice(1) : '';
	const filteredCommands = useMemo(() => {
		if (!isCommandMode) return [];
		const all = registry.getAll();
		if (prefix === '') return all.slice(0, MAX_SUGGESTIONS);
		return all
			.filter(cmd =>
				[cmd.name, ...(cmd.aliases ?? [])].some(name => name.startsWith(prefix)),
			)
			.slice(0, MAX_SUGGESTIONS);
	}, [isCommandMode, prefix]);

	const prevPrefixRef = useRef(prefix);
	let effectiveIndex = selectedIndex;
	if (prevPrefixRef.current !== prefix) {
		prevPrefixRef.current = prefix;
		effectiveIndex = 0;
		if (selectedIndex !== 0) {
			setSelectedIndex(0);
		}
	}

	const showSuggestions = filteredCommands.length > 0;
	const safeIndex = showSuggestions
		? Math.min(effectiveIndex, filteredCommands.length - 1)
		: 0;

	const moveUp = useCallback(() => {
		if (filteredCommands.length === 0) return;
		setSelectedIndex(i => (i <= 0 ? filteredCommands.length - 1 : i - 1));
	}, [filteredCommands.length]);

	const moveDown = useCallback(() => {
		if (filteredCommands.length === 0) return;
		setSelectedIndex(i => (i >= filteredCommands.length - 1 ? 0 : i + 1));
	}, [filteredCommands.length]);

	const getSelectedCommand = useCallback(
		() => (showSuggestions ? filteredCommands[safeIndex] : undefined),
		[filteredCommands, safeIndex, showSuggestions],
	);

	useImperativeHandle(
		ref,
		() => ({
			moveUp,
			moveDown,
			getSelectedCommand,
			get showSuggestions() {
				return showSuggestions;
			},
		}),
		[getSelectedCommand, moveDown, moveUp, showSuggestions],
	);

	const handleArrows = useCallback(
		(
			_input: string,
			key: {
				upArrow: boolean;
				downArrow: boolean;
				ctrl: boolean;
			},
		) => {
			const {value: currentValue, cursorOffset: currentCursor} = stateRef.current;

			if (key.ctrl) return;
			if (suppressArrowsRef.current && (key.upArrow || key.downArrow)) return;

			if (key.upArrow) {
				const {line: cursorLine} = cursorToVisualPosition(
					currentValue,
					currentCursor,
					inputContentWidth,
				);
				if (cursorLine === 0) {
					const recalled = historyBackRef.current?.(currentValue);
					if (recalled !== undefined) setValue(recalled);
				} else {
					dispatch({type: 'move-up', width: inputContentWidth});
				}
				return;
			}

			if (key.downArrow) {
				const {line: cursorLine, totalLines} = cursorToVisualPosition(
					currentValue,
					currentCursor,
					inputContentWidth,
				);
				if (cursorLine >= totalLines - 1) {
					const recalled = historyForwardRef.current?.();
					if (recalled !== undefined) setValue(recalled);
				} else {
					dispatch({type: 'move-down', width: inputContentWidth});
				}
			}
		},
		[inputContentWidth, setValue, dispatch],
	);

	useInput(handleArrows, {isActive: isInputActive});

	const lines = renderInputLines(
		value,
		cursorOffset,
		inputContentWidth,
		isInputActive,
		textInputPlaceholder,
	);

	return (
		<>
			{showSuggestions && (
				<CommandSuggestions
					commands={filteredCommands}
					selectedIndex={safeIndex}
					innerWidth={innerWidth}
					wrapLine={wrapSuggestionLine}
				/>
			)}
			<FrameRow
				innerWidth={innerWidth}
				ascii={useAscii}
				borderColor={borderColor}
				height={inputRows}
			>
				<Box width={inputPrefix.length} flexShrink={0}>
					<Text>{inputPromptStyled}</Text>
				</Box>
				<Box width={inputContentWidth} flexShrink={0} flexDirection="column">
					{lines.map((line, index) => (
						<Text
							key={index}
							color={value.length === 0 ? inputPlaceholderColor : textColor}
						>
							{line}
						</Text>
					))}
				</Box>
				<Box width={badgeText.length} flexShrink={0}>
					<Text>{runBadgeStyled + modeBadgeStyled}</Text>
				</Box>
			</FrameRow>
			<Text>{border(bottomBorder)}</Text>
		</>
	);
});

ShellInputImpl.displayName = 'ShellInput';

export const ShellInput = React.memo(ShellInputImpl);
