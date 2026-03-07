import {useState, useCallback, useRef} from 'react';
import {computeInputRows} from '../../shared/utils/format';
import {parseInput} from '../commands/parser';
import {type TimelineEntry} from '../../core/feed/timeline';
import type {Command} from '../commands/types';
import type {InputMode} from './types';
import {getTimelineEntrySearchText} from '../../ui/hooks/useTimeline';

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
		if (getTimelineEntrySearchText(entries[i]!).toLowerCase().includes(q)) {
			return i;
		}
	}
	return -1;
}

export type UseShellInputOptions = {
	inputMode: InputMode;
	setInputMode: (mode: InputMode) => void;
	setSearchQuery: (query: string) => void;
	closeInput: () => void;
	submitSearchQuery: (query: string, firstMatchIndex: number | null) => void;
	submitPromptOrSlashCommand: (value: string) => void;
	filteredEntriesRef: React.RefObject<TimelineEntry[]>;
	getSelectedCommand?: () => Command | undefined;
};

export type UseShellInputResult = {
	inputRows: number;
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
	setSearchQuery,
	closeInput,
	submitSearchQuery,
	submitPromptOrSlashCommand,
	filteredEntriesRef,
	getSelectedCommand,
}: UseShellInputOptions): UseShellInputResult {
	const setInputValueRef = useRef<(value: string) => void>(() => {});
	const inputValueRef = useRef('');
	const [inputRows, setInputRows] = useState(1);

	const syncInputModeFromValue = useCallback(
		(value: string) => {
			const nextMode = deriveInputMode(value);
			setInputMode(nextMode);
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
					const firstIdx =
						query.length > 0
							? findFirstSearchMatch(filteredEntriesRef.current, query, 0)
							: -1;
					submitSearchQuery(query, firstIdx >= 0 ? firstIdx : null);
				} else {
					submitPromptOrSlashCommand(trimmed);
				}
			}

			setInputValueRef.current('');
			if (inputMode !== 'search') {
				closeInput();
			}
			setInputRows(1);
		},
		[
			inputMode,
			submitPromptOrSlashCommand,
			getSelectedCommand,
			closeInput,
			submitSearchQuery,
			filteredEntriesRef,
		],
	);

	const handleMainInputChange = useCallback(
		(value: string) => {
			inputValueRef.current = value;
			syncInputModeFromValue(value);
			setInputRows(computeInputRows(value, inputContentWidthRef.current));
		},
		[syncInputModeFromValue],
	);

	return {
		inputRows,
		inputValueRef,
		setInputValueRef,
		inputContentWidthRef,
		handleMainInputChange,
		handleInputSubmit,
		handleSetValueRef,
	};
}
