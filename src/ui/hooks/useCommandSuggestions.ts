import {useState, useMemo, useEffect} from 'react';
import * as registry from '../../app/commands/registry';
import type {Command} from '../../app/commands/types';

const MAX_SUGGESTIONS = 6;

export type UseCommandSuggestionsResult = {
	filteredCommands: Command[];
	selectedIndex: number;
	showSuggestions: boolean;
	moveUp: () => void;
	moveDown: () => void;
	getSelectedCommand: () => Command | undefined;
};

export function useCommandSuggestions(
	inputValue: string,
	isActive: boolean,
): UseCommandSuggestionsResult {
	const [selectedIndex, setSelectedIndex] = useState(0);

	const isCommandMode =
		isActive && inputValue.startsWith('/') && !inputValue.includes(' ');
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

	const showSuggestions = filteredCommands.length > 0;
	const safeIndex = showSuggestions
		? Math.min(selectedIndex, filteredCommands.length - 1)
		: 0;

	// Reset selection when the filter prefix changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [prefix]);

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
	};
}
