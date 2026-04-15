import {useMemo} from 'react';
import {type TimelineEntry} from '../../core/feed/timeline';
import {
	type MessageTab,
	partitionEntries,
	filterByTab,
	messageText,
} from '../../core/feed/panelFilter';
import {renderMarkdown} from '../../shared/utils/markedFactory';

export type FilteredPanels = {
	messageEntries: TimelineEntry[];
	feedEntries: TimelineEntry[];
	/** Total wrapped line count for message entries at the given width. */
	messageLineCount: number;
};

export function useFilteredPanels(
	filteredEntries: TimelineEntry[],
	messagePanelTab: MessageTab,
	splitMode: boolean,
	messagePanelWidth: number,
): FilteredPanels {
	return useMemo(() => {
		if (!splitMode) {
			return {
				messageEntries: [],
				feedEntries: filteredEntries,
				messageLineCount: 0,
			};
		}
		const {messageEntries, feedEntries} = partitionEntries(filteredEntries);
		const tabFiltered = filterByTab(messageEntries, messagePanelTab);
		// Count rendered lines (including separator blank lines between messages)
		let lineCount = 0;
		for (let i = 0; i < tabFiltered.length; i++) {
			const text = messageText(tabFiltered[i]!);
			lineCount += renderMarkdown(text, messagePanelWidth).length;
			if (i < tabFiltered.length - 1) {
				lineCount += 1; // separator
			}
		}
		return {
			messageEntries: tabFiltered,
			feedEntries,
			messageLineCount: lineCount,
		};
	}, [filteredEntries, messagePanelTab, splitMode, messagePanelWidth]);
}
