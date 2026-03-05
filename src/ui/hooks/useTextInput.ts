import {useReducer, useCallback, useEffect, useRef} from 'react';
import {useInput, useStdin} from 'ink';
import {startInputMeasure} from '../../shared/utils/perf';
import {
	cursorToVisualPosition,
	visualPositionToOffset,
} from '../../shared/utils/format';

export type TextInputState = {
	value: string;
	cursorOffset: number;
};

export type TextInputAction =
	| {type: 'insert'; char: string}
	| {type: 'backspace'}
	| {type: 'delete-forward'}
	| {type: 'move-left'}
	| {type: 'move-right'}
	| {type: 'move-home'}
	| {type: 'move-end'}
	| {type: 'delete-word-back'}
	| {type: 'clear-line'}
	| {type: 'newline-escape'}
	| {type: 'move-up'; width: number}
	| {type: 'move-down'; width: number}
	| {type: 'set-value'; value: string};

export function textInputReducer(
	state: TextInputState,
	action: TextInputAction,
): TextInputState {
	const {value, cursorOffset} = state;

	switch (action.type) {
		case 'insert': {
			const before = value.slice(0, cursorOffset);
			const after = value.slice(cursorOffset);
			return {
				value: before + action.char + after,
				cursorOffset: cursorOffset + action.char.length,
			};
		}

		case 'backspace': {
			if (cursorOffset === 0) return state;
			const before = value.slice(0, cursorOffset - 1);
			const after = value.slice(cursorOffset);
			return {value: before + after, cursorOffset: cursorOffset - 1};
		}

		case 'delete-forward': {
			if (cursorOffset >= value.length) return state;
			const before = value.slice(0, cursorOffset);
			const after = value.slice(cursorOffset + 1);
			return {value: before + after, cursorOffset};
		}

		case 'move-left':
			if (cursorOffset === 0) return state;
			return {...state, cursorOffset: cursorOffset - 1};

		case 'move-right':
			if (cursorOffset >= value.length) return state;
			return {...state, cursorOffset: cursorOffset + 1};

		case 'move-home':
			if (cursorOffset === 0) return state;
			return {...state, cursorOffset: 0};

		case 'move-end':
			if (cursorOffset >= value.length) return state;
			return {...state, cursorOffset: value.length};

		case 'delete-word-back': {
			if (cursorOffset === 0) return state;
			// Skip trailing spaces, then delete until next space or start
			let i = cursorOffset;
			while (i > 0 && value[i - 1] === ' ') i--;
			while (i > 0 && value[i - 1] !== ' ') i--;
			const before = value.slice(0, i);
			const after = value.slice(cursorOffset);
			return {value: before + after, cursorOffset: i};
		}

		case 'clear-line':
			if (cursorOffset === 0) return state;
			return {value: value.slice(cursorOffset), cursorOffset: 0};

		case 'newline-escape': {
			if (cursorOffset === 0 || value[cursorOffset - 1] !== '\\') return state;
			const before = value.slice(0, cursorOffset - 1);
			const after = value.slice(cursorOffset);
			return {value: before + '\n' + after, cursorOffset};
		}

		case 'move-up':
		case 'move-down': {
			const {
				line: curLine,
				col: curCol,
				totalLines,
			} = cursorToVisualPosition(value, cursorOffset, action.width);
			if (totalLines <= 1) return state;
			const targetLine = action.type === 'move-up' ? curLine - 1 : curLine + 1;
			if (targetLine < 0 || targetLine >= totalLines) return state;
			const newOffset = visualPositionToOffset(
				value,
				targetLine,
				curCol,
				action.width,
			);
			return {...state, cursorOffset: newOffset};
		}

		case 'set-value':
			if (action.value === value && cursorOffset === action.value.length)
				return state;
			return {value: action.value, cursorOffset: action.value.length};
	}
}

type UseTextInputOptions = {
	/** Called on every value change */
	onChange?: (value: string) => void;
	/** Called when Enter is pressed */
	onSubmit?: (value: string) => void;
	/** Whether the input is active (receives keyboard events) */
	isActive?: boolean;
};

type UseTextInputReturn = {
	/** Current input value */
	value: string;
	/** Current cursor position */
	cursorOffset: number;
	/** Programmatically set the value (cursor moves to end) */
	setValue: (value: string) => void;
	/** Dispatch raw actions to the reducer (for move-up/move-down etc.) */
	dispatch: React.Dispatch<TextInputAction>;
};

export function useTextInput(
	options: UseTextInputOptions = {},
): UseTextInputReturn {
	const {onChange, onSubmit, isActive = true} = options;

	const [state, dispatch] = useReducer(textInputReducer, {
		value: '',
		cursorOffset: 0,
	});

	// Keep refs to avoid stale closures in useInput callback
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	const stateRef = useRef(state);
	stateRef.current = state;

	// Fire onChange whenever the value changes (skip the initial mount)
	const isFirstRender = useRef(true);
	useEffect(() => {
		if (isFirstRender.current) {
			isFirstRender.current = false;
			return;
		}
		onChangeRef.current?.(state.value);
	}, [state.value]);

	const setValue = useCallback((newValue: string) => {
		dispatch({type: 'set-value', value: newValue});
	}, []);

	// Ink's useInput cannot distinguish Backspace (\x7f) from forward-Delete
	// (\x1b[3~) — both fire as key.delete.  We prepend a `readable` listener
	// on stdin so we can peek at the raw data *before* Ink's App reads it.
	// If the pending data is the forward-Delete sequence, we set a flag that
	// the useInput handler checks to dispatch delete-forward instead of
	// backspace.
	//
	// The peek uses read() + unshift() which re-triggers `readable`.  A
	// re-entrance guard prevents the handler from consuming the data twice —
	// the second `readable` (from unshift) is a no-op for us, letting Ink's
	// handler consume the data normally.
	const {stdin} = useStdin();
	const isForwardDeleteRef = useRef(false);

	useEffect(() => {
		if (!isActive) return;

		const FORWARD_DELETE = '\x1b[3~';
		let peeking = false;

		const onReadable = () => {
			// Guard: unshift() re-triggers readable — skip re-entrant calls
			// so Ink's handler sees the data on the second emission.
			if (peeking) return;
			peeking = true;

			let raw: string | null = null;

			if (typeof (stdin as unknown as {data?: unknown}).data === 'string') {
				// ink-testing-library path
				raw = (stdin as unknown as {data: string}).data;
			} else if (typeof stdin.read === 'function') {
				// Real Node.js stream path: consume + put back
				const chunk = stdin.read();
				if (chunk !== null) {
					raw = chunk.toString();
					stdin.unshift(chunk);
				}
			}

			if (raw !== null && raw.includes(FORWARD_DELETE)) {
				isForwardDeleteRef.current = true;
			}

			peeking = false;
		};

		stdin.prependListener('readable', onReadable);
		return () => {
			stdin.removeListener('readable', onReadable);
		};
	}, [isActive, stdin]);

	useInput(
		(input, key) => {
			const done = startInputMeasure('text.input', input, key);
			try {
				// Leave navigation/control keys for parent handlers
				if (key.upArrow || key.downArrow || key.tab || key.escape) return;

				if (key.return) {
					const {value: val, cursorOffset: cur} = stateRef.current;
					if (cur > 0 && val[cur - 1] === '\\') {
						dispatch({type: 'newline-escape'});
					} else {
						onSubmitRef.current?.(val);
					}
					return;
				}

				if (key.leftArrow) {
					dispatch(key.ctrl ? {type: 'move-home'} : {type: 'move-left'});
					return;
				}
				if (key.rightArrow) {
					dispatch(key.ctrl ? {type: 'move-end'} : {type: 'move-right'});
					return;
				}

				if (key.home) {
					dispatch({type: 'move-home'});
					return;
				}
				if (key.end) {
					dispatch({type: 'move-end'});
					return;
				}

				// Readline shortcuts (Ctrl+key)
				if (key.ctrl) {
					if (input === 'a') dispatch({type: 'move-home'});
					else if (input === 'e') dispatch({type: 'move-end'});
					else if (input === 'w') dispatch({type: 'delete-word-back'});
					else if (input === 'u') dispatch({type: 'clear-line'});
					else if (input === 'd') dispatch({type: 'delete-forward'});
					return;
				}

				// Ink maps \x7f (Backspace on most terminals) to key.delete, not
				// key.backspace.  The forward-Delete key (\x1b[3~) also fires as
				// key.delete.  We use the isForwardDeleteRef flag (set by our
				// raw stdin peek) to distinguish the two.
				if (key.backspace || key.delete) {
					if (isForwardDeleteRef.current) {
						isForwardDeleteRef.current = false;
						dispatch({type: 'delete-forward'});
					} else {
						dispatch({type: 'backspace'});
					}
					return;
				}

				// Printable characters
				if (input && !key.meta) {
					dispatch({type: 'insert', char: input});
				}
			} finally {
				done();
			}
		},
		{isActive},
	);

	return {
		value: state.value,
		cursorOffset: state.cursorOffset,
		setValue,
		dispatch,
	};
}
