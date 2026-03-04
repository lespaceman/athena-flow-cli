import React from 'react';
import {Text} from 'ink';
import {type TimelineEntry} from '../../core/feed/timeline';
import {type Theme} from '../theme/types';
import {frameGlyphs} from '../glyphs/index';
import {fitAnsi, spaces} from '../../shared/utils/format';
import {type FeedColumnWidths, formatFeedRowLine} from './FeedRow';
import {formatFeedHeaderLine} from './FeedHeader';

type Props = {
	feedHeaderRows: number;
	feedContentRows: number;
	feedViewportStart: number;
	filteredEntries: TimelineEntry[];
	feedCursor: number;
	focusMode: string;
	searchMatchSet: Set<number>;
	ascii: boolean;
	theme: Theme;
	innerWidth: number;
	cols: FeedColumnWidths;
};

function FeedGridImpl({
	feedHeaderRows,
	feedContentRows,
	feedViewportStart,
	filteredEntries,
	feedCursor,
	focusMode,
	searchMatchSet,
	ascii,
	theme,
	innerWidth,
	cols,
}: Props) {
	const rows: React.ReactNode[] = [];
	const fr = frameGlyphs(ascii);
	const blankLine = spaces(innerWidth);
	const frameLine = (content: string): string =>
		`${fr.vertical}${content}${fr.vertical}`;

	// Header row
	if (feedHeaderRows > 0) {
		rows.push(
			<Text key="feed-header">
				{frameLine(formatFeedHeaderLine(cols, theme, innerWidth))}
			</Text>,
		);
	}

	if (feedContentRows <= 0) return <>{rows}</>;

	if (filteredEntries.length === 0) {
		rows.push(
			<Text key="feed-empty">
				{frameLine(fitAnsi('(no feed events)', innerWidth))}
			</Text>,
		);
		for (let i = 1; i < feedContentRows; i++) {
			rows.push(<Text key={`feed-pad-${i}`}>{frameLine(blankLine)}</Text>);
		}
		return <>{rows}</>;
	}

	let feedLinesEmitted = 0;
	let entryOffset = 0;

	while (feedLinesEmitted < feedContentRows) {
		const idx = feedViewportStart + entryOffset;
		const entry = filteredEntries[idx];
		if (!entry) {
			// Pad remaining rows
			while (feedLinesEmitted < feedContentRows) {
				rows.push(
					<Text key={`feed-pad-${feedLinesEmitted}`}>
						{frameLine(blankLine)}
					</Text>,
				);
				feedLinesEmitted++;
			}
			break;
		}

		const isDuplicateActor = entry.duplicateActor;

		const isFocused = focusMode === 'feed' && idx === feedCursor;
		const isMatched = searchMatchSet.has(idx);

		rows.push(
			<Text key={`feed-row-${entry.id}`}>
				{frameLine(
					formatFeedRowLine({
						entry,
						cols,
						focused: isFocused,
						expanded: false,
						matched: isMatched,
						isDuplicateActor,
						ascii,
						theme,
						innerWidth,
					}),
				)}
			</Text>,
		);
		feedLinesEmitted++;
		entryOffset++;
	}

	return <>{rows}</>;
}

export const FeedGrid = React.memo(FeedGridImpl);
