import {useState, useCallback, useRef} from 'react';
import {computeInputRows} from '../../shared/utils/format';
import {parseInput} from '../commands/parser';
import {type TimelineEntry} from '../../core/feed/timeline';
import type {Command} from '../commands/types';
import type {FocusMode, InputMode} from './types';

function deriveInputMode(value: string): InputMode {
	if (value.startsWith('/')) return 'command';
	if (value.startsWith(':')) return 'search';
	return 'normal';
}

function findFirstSearchMatch(
	entries: TimelineEntry[],
	query: string,
	startIndex: number,
): number {
	const q = query.toLowerCase();
	for (let i = startIndex; i < entries.length; i++) {
		if (entries[i]!.searchText.toLowerCase().includes(q)) {
			return i;
		}
	}
	return -1;
}

export type UseShellInputOptions = {
	inputMode: InputMode;
	setInputMode: React.Dispatch<React.SetStateAction<InputMode>>;
	setFocusMode: (mode: FocusMode) => void;
	setSearchQuery: (query: string) => void;
	submitPromptOrSlashCommand: (value: string) => void;
	filteredEntriesRef: React.RefObject<TimelineEntry[]>;
	staticHwmRef: React.RefObject<number>;
	setFeedCursorRef: React.MutableRefObject<(cursor: number) => void>;
	setTailFollowRef: React.MutableRefObject<(follow: boolean) => void>;
	setSearchMatchPos: React.Dispatch<React.SetStateAction<number>>;
	getSelectedCommand?: () => Command | undefined;
};

export type UseShellInputResult = {
	inputRows: number;
	inputValue: string;
	inputValueRef: React.RefObject<string>;
	setInputValueRef: React.RefObject<(value: string) => void>;
	inputContentWidthRef: React.RefObject<number>;
	handleMainInputChange: (value: string) => void;
	handleInputSubmit: (value: string) => void;
	handleSetValueRef: (setValue: (value: string) => void) => void;
};

export function useShellInput({
	inputMode,
	setInputMode,
	setFocusMode,
	setSearchQuery,
	submitPromptOrSlashCommand,
	filteredEntriesRef,
	staticHwmRef,
	setFeedCursorRef,
	setTailFollowRef,
	setSearchMatchPos,
	getSelectedCommand,
}: UseShellInputOptions): UseShellInputResult {
	const setInputValueRef = useRef<(value: string) => void>(() => {});
	const inputValueRef = useRef('');
	const [inputRows, setInputRows] = useState(1);
	const [inputValue, setInputValueState] = useState('');

	const syncInputModeFromValue = useCallback(
		(value: string) => {
			const nextMode = deriveInputMode(value);
			setInputMode(prev => (prev === nextMode ? prev : nextMode));
			if (value.length === 0) {
				setSearchQuery('');
			}
		},
		[setInputMode, setSearchQuery],
	);

	const inputContentWidthRef = useRef(1);

	const handleSetValueRef = useCallback(
		(setValue: (value: string) => void) => {
			setInputValueRef.current = (value: string) => {
				inputValueRef.current = value;
				setInputValueState(value);
				syncInputModeFromValue(value);
				setValue(value);
				setInputRows(computeInputRows(value, inputContentWidthRef.current));
			};
		},
		[syncInputModeFromValue],
	);

	const handleInputSubmit = useCallback(
		(rawValue: string) => {
			const trimmed = rawValue.trim();

			if (trimmed) {
				const parsed = parseInput(trimmed);
				if (parsed.type === 'command') {
					submitPromptOrSlashCommand(trimmed);
				} else if (inputMode === 'command') {
					// Bare '/' or partial that didn't match a full command — use selected suggestion
					const cmd = getSelectedCommand?.();
					if (cmd) {
						submitPromptOrSlashCommand(`/${cmd.name}`);
					}
				} else if (inputMode === 'search') {
					const query = trimmed.replace(/^:/, '').trim();
					setSearchQuery(query);
					if (query.length > 0) {
						const firstIdx = findFirstSearchMatch(
							filteredEntriesRef.current,
							query,
							staticHwmRef.current,
						);
						if (firstIdx >= 0) {
							setFeedCursorRef.current(firstIdx);
							setTailFollowRef.current(false);
							setSearchMatchPos(0);
						}
					}
				} else {
					submitPromptOrSlashCommand(trimmed);
				}
			}

			setInputValueRef.current('');
			setInputValueState('');
			setInputMode('normal');
			setFocusMode('feed');
			setInputRows(1);
		},
		[
			inputMode,
			submitPromptOrSlashCommand,
			getSelectedCommand,
			setInputMode,
			setFocusMode,
			setSearchQuery,
			filteredEntriesRef,
			staticHwmRef,
			setFeedCursorRef,
			setTailFollowRef,
			setSearchMatchPos,
		],
	);

	const handleMainInputChange = useCallback(
		(value: string) => {
			inputValueRef.current = value;
			setInputValueState(value);
			syncInputModeFromValue(value);
			setInputRows(computeInputRows(value, inputContentWidthRef.current));
		},
		[syncInputModeFromValue],
	);

	return {
		inputRows,
		inputValue,
		inputValueRef,
		setInputValueRef,
		inputContentWidthRef,
		handleMainInputChange,
		handleInputSubmit,
		handleSetValueRef,
	};
}
