import {useState, useCallback, useRef} from 'react';
import {computeInputRows} from '../../shared/utils/format';
import {parseInput} from '../commands/parser';
import {type TimelineEntry} from '../../core/feed/timeline';
import {type UseFeedNavigationResult} from '../../ui/hooks/useFeedNavigation';

type InputMode = 'normal' | 'search';
type FocusMode = 'feed' | 'input' | 'todo';

function deriveInputMode(value: string): InputMode {
	return value.startsWith('/') ? 'search' : 'normal';
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
	feedNav: Pick<UseFeedNavigationResult, 'setFeedCursor' | 'setTailFollow'>;
	setSearchMatchPos: React.Dispatch<React.SetStateAction<number>>;
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
	setFocusMode,
	setSearchQuery,
	submitPromptOrSlashCommand,
	filteredEntriesRef,
	staticHwmRef,
	feedNav,
	setSearchMatchPos,
}: UseShellInputOptions): UseShellInputResult {
	const setInputValueRef = useRef<(value: string) => void>(() => {});
	const inputValueRef = useRef('');
	const [inputRows, setInputRows] = useState(1);

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
				} else if (trimmed.startsWith('/') || inputMode === 'search') {
					const query = trimmed.replace(/^\//, '').trim();
					setSearchQuery(query);
					if (query.length > 0) {
						const firstIdx = findFirstSearchMatch(
							filteredEntriesRef.current,
							query,
							staticHwmRef.current,
						);
						if (firstIdx >= 0) {
							feedNav.setFeedCursor(firstIdx);
							feedNav.setTailFollow(false);
							setSearchMatchPos(0);
						}
					}
				} else {
					submitPromptOrSlashCommand(trimmed);
				}
			}

			// Always reset input state after submission
			setInputValueRef.current('');
			setInputMode('normal');
			setFocusMode('feed');
			setInputRows(1);
		},
		[
			inputMode,
			submitPromptOrSlashCommand,
			setInputMode,
			setFocusMode,
			setSearchQuery,
			filteredEntriesRef,
			staticHwmRef,
			feedNav,
			setSearchMatchPos,
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
