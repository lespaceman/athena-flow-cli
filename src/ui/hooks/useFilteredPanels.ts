import {useMemo} from 'react';
import {type TimelineEntry} from '../../core/feed/timeline';
import {
	type MessageTab,
	classifyEntry,
	partitionEntries,
	filterByTab,
	messageText,
} from '../../core/feed/panelFilter';
import {renderMarkdown} from '../../shared/markdown/renderMarkdown';
import {wrapText} from '../../shared/utils/format';
import {INDICATOR_OVERHEAD} from '../components/MessagePanel';

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
		// Count rendered lines (including separator blank lines between messages).
		// Must match buildRenderedLines in MessagePanel: use the content width
		// (after indicator overhead) and the same renderer per entry kind.
		const contentWidth = messagePanelWidth - INDICATOR_OVERHEAD;
		let lineCount = 0;
		for (let i = 0; i < tabFiltered.length; i++) {
			const entry = tabFiltered[i]!;
			const text = messageText(entry);
			const kind = classifyEntry(entry) === 'user' ? 'user' : 'agent';
			const lines =
				kind === 'user'
					? wrapText(text, contentWidth)
					: renderMarkdown({
							content: text,
							width: contentWidth,
							mode: 'inline-feed',
						}).lines;
			lineCount += lines.length;
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
