import {useCallback, useEffect, useRef} from 'react';
import {Box, Text, useInput} from 'ink';
import {useTextInput} from '../hooks/useTextInput';
import {
	renderInputLines,
	cursorToVisualPosition,
} from '../../shared/utils/format';

export type MultiLineInputProps = {
	/** Available width for the input content area */
	width: number;
	/** Placeholder text when empty */
	placeholder: string;
	/** Whether this input is active (receives keyboard events) */
	isActive: boolean;
	/** Called on every value change */
	onChange?: (value: string) => void;
	/** Called when Enter is pressed (without preceding backslash) */
	onSubmit?: (value: string) => void;
	/** Called when Up is pressed on the first visual line (history back). Returns recalled value or undefined. */
	onHistoryBack?: (currentValue: string) => string | undefined;
	/** Called when Down is pressed on the last visual line (history forward). Returns recalled value or undefined. */
	onHistoryForward?: () => string | undefined;
	/** Callback that receives the setValue function for programmatic updates */
	setValueRef?: (setValue: (value: string) => void) => void;
};

export function MultiLineInput({
	width,
	placeholder,
	isActive,
	onChange,
	onSubmit,
	onHistoryBack,
	onHistoryForward,
	setValueRef,
}: MultiLineInputProps) {
	const {value, cursorOffset, setValue, dispatch} = useTextInput({
		onChange,
		onSubmit,
		isActive,
	});

	// Expose setValue to parent via callback ref
	const setValueRefCb = useRef(setValueRef);
	setValueRefCb.current = setValueRef;
	useEffect(() => {
		setValueRefCb.current?.(setValue);
	}, [setValue]);

	// Keep refs for stable useInput callback
	const stateRef = useRef({value, cursorOffset});
	stateRef.current = {value, cursorOffset};
	const historyBackRef = useRef(onHistoryBack);
	historyBackRef.current = onHistoryBack;
	const historyForwardRef = useRef(onHistoryForward);
	historyForwardRef.current = onHistoryForward;

	const handleArrows = useCallback(
		(
			_input: string,
			key: {
				upArrow: boolean;
				downArrow: boolean;
				ctrl: boolean;
			},
		) => {
			const {value: val, cursorOffset: cursor} = stateRef.current;

			// Ctrl+P/N always trigger history
			if (key.ctrl) return; // handled by parent AppShell

			if (key.upArrow) {
				const {line: cursorLine} = cursorToVisualPosition(
					val,
					cursor,
					width,
				);
				if (cursorLine === 0) {
					// First visual line — delegate to history
					const recalled = historyBackRef.current?.(val);
					if (recalled !== undefined) setValue(recalled);
				} else {
					dispatch({type: 'move-up', width});
				}
				return;
			}

			if (key.downArrow) {
				const {line: cursorLine, totalLines} = cursorToVisualPosition(
					val,
					cursor,
					width,
				);
				if (cursorLine >= totalLines - 1) {
					// Last visual line — delegate to history
					const recalled = historyForwardRef.current?.();
					if (recalled !== undefined) setValue(recalled);
				} else {
					dispatch({type: 'move-down', width});
				}
			}
		},
		[width, setValue, dispatch],
	);

	useInput(handleArrows, {isActive});

	// Render via renderInputLines
	const lines = renderInputLines(
		value,
		cursorOffset,
		width,
		isActive,
		placeholder,
	);

	return (
		<Box flexDirection="column">
			{lines.map((line, i) => (
				<Text key={i}>{line}</Text>
			))}
		</Box>
	);
}
