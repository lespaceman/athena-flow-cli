import {useState, useMemo, useRef, useCallback} from 'react';
import * as registry from '../../app/commands/registry';
import type {Command} from '../../app/commands/types';
import {isCommandPrefix} from '../../shared/utils/format';

const MAX_SUGGESTIONS = 6;

export type UseCommandSuggestionsResult = {
	filteredCommands: Command[];
	selectedIndex: number;
	showSuggestions: boolean;
	moveUp: () => void;
	moveDown: () => void;
	getSelectedCommand: () => Command | undefined;
	/** Call from onChange to trigger suggestion re-filter (only fires in command mode) */
	notifyInputChanged: () => void;
};

export function useCommandSuggestions(
	inputValueRef: React.RefObject<string>,
	isActive: boolean,
): UseCommandSuggestionsResult {
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [, setFilterTick] = useState(0);

	const notifyInputChanged = useCallback(() => {
		if (isCommandPrefix(inputValueRef.current)) {
			setFilterTick(t => t + 1);
		}
	}, [inputValueRef]);

	const inputValue = inputValueRef.current;
	const isCommandMode = isActive && isCommandPrefix(inputValue);
	const prefix = isCommandMode ? inputValue.slice(1) : '';

	const filteredCommands = useMemo(() => {
		if (!isCommandMode) return [];
		const all = registry.getAll();
		if (prefix === '') return all.slice(0, MAX_SUGGESTIONS);
		return all
			.filter(cmd =>
				[cmd.name, ...(cmd.aliases ?? [])].some(n => n.startsWith(prefix)),
			)
			.slice(0, MAX_SUGGESTIONS);
	}, [isCommandMode, prefix]);

	// Inline prefix tracking — resets selectedIndex synchronously during render
	// instead of via useEffect (which would cause an extra render cycle)
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

	const moveUp = () =>
		setSelectedIndex(i => (i <= 0 ? filteredCommands.length - 1 : i - 1));
	const moveDown = () =>
		setSelectedIndex(i => (i >= filteredCommands.length - 1 ? 0 : i + 1));
	const getSelectedCommand = () =>
		showSuggestions ? filteredCommands[safeIndex] : undefined;

	return {
		filteredCommands,
		selectedIndex: safeIndex,
		showSuggestions,
		moveUp,
		moveDown,
		getSelectedCommand,
		notifyInputChanged,
	};
}
