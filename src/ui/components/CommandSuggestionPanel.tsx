import {forwardRef, useImperativeHandle} from 'react';
import {useCommandSuggestions} from '../hooks/useCommandSuggestions';
import CommandSuggestions from './CommandSuggestions';
import type {Command} from '../../app/commands/types';

export type CommandSuggestionPanelHandle = {
	moveUp: () => void;
	moveDown: () => void;
	getSelectedCommand: () => Command | undefined;
	notifyInputChanged: () => void;
	readonly showSuggestions: boolean;
};

type Props = {
	inputValueRef: React.RefObject<string>;
	isActive: boolean;
	innerWidth: number;
	wrapLine: (line: string) => string;
};

export const CommandSuggestionPanel = forwardRef<
	CommandSuggestionPanelHandle,
	Props
>(function CommandSuggestionPanel(
	{inputValueRef, isActive, innerWidth, wrapLine},
	ref,
) {
	const suggestions = useCommandSuggestions(inputValueRef, isActive);

	useImperativeHandle(
		ref,
		() => ({
			moveUp: suggestions.moveUp,
			moveDown: suggestions.moveDown,
			getSelectedCommand: suggestions.getSelectedCommand,
			notifyInputChanged: suggestions.notifyInputChanged,
			get showSuggestions() {
				return suggestions.showSuggestions;
			},
		}),
		[suggestions],
	);

	if (!suggestions.showSuggestions) return null;

	return (
		<CommandSuggestions
			commands={suggestions.filteredCommands}
			selectedIndex={suggestions.selectedIndex}
			innerWidth={innerWidth}
			wrapLine={wrapLine}
		/>
	);
});
