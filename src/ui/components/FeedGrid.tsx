import React from 'react';
import {Text} from 'ink';
import chalk from 'chalk';
import {type TimelineEntry} from '../../core/feed/timeline';
import {type Theme} from '../theme/types';
import {frameGlyphs} from '../glyphs/index';
import {fitAnsi, spaces} from '../../shared/utils/format';
import {type FeedColumnWidths, formatFeedRowLine} from './FeedRow';
import {formatFeedHeaderLine} from './FeedHeader';
import {logFeedViewportDiff} from '../../shared/utils/perf';

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

export function shouldUseLiveFeedScrollback({
	tailFollow,
	inputMode,
	searchQuery,
}: {
	tailFollow: boolean;
	inputMode: string;
	searchQuery: string;
}): boolean {
	return (
		tailFollow && inputMode !== 'search' && searchQuery.trim().length === 0
	);
}

function formatRow(
	entry: TimelineEntry,
	idx: number,
	feedCursor: number,
	focusMode: string,
	matched: boolean,
	ascii: boolean,
	theme: Theme,
	innerWidth: number,
	cols: FeedColumnWidths,
	verticalGlyph: string,
	borderColor: string,
	stripeBg: string | undefined,
): string {
	const isFocused = focusMode === 'feed' && idx === feedCursor;
	const isStriped = idx % 2 === 1;
	const border = chalk.hex(borderColor);
	const rowBg =
		!isFocused && isStriped && stripeBg
			? chalk.bgHex(stripeBg)
			: (text: string) => text;
	const content = rowBg(
		formatFeedRowLine({
			entry,
			cols,
			focused: isFocused,
			expanded: false,
			matched,
			isDuplicateActor: entry.duplicateActor,
			ascii,
			theme,
			innerWidth,
		}),
	);
	return `${border(verticalGlyph)}${content}${border(verticalGlyph)}`;
}

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
	const fr = frameGlyphs(ascii);
	const borderColor = theme.border;
	const stripeBg = theme.feed.stripeBackground ?? undefined;
	const showHeaderDivider = feedHeaderRows > 0 && feedContentRows > 1;
	const visibleContentRows = feedContentRows - (showHeaderDivider ? 1 : 0);

	// Build signature array for perf tracking — same logic as before.
	const visibleRowSignatures = React.useMemo(() => {
		const signatures: string[] = [];
		if (visibleContentRows <= 0) return signatures;
		for (let offset = 0; offset < visibleContentRows; offset++) {
			const idx = feedViewportStart + offset;
			const entry = filteredEntries[idx];
			if (!entry) continue;
			signatures.push(
				[
					entry.id,
					entry.opTag,
					entry.toolColumn,
					entry.summary,
					entry.summaryOutcome ?? '',
					entry.error ? 'error' : 'ok',
					entry.duplicateActor ? 'dup' : 'solo',
					focusMode === 'feed' && idx === feedCursor ? 'focused' : 'plain',
					searchMatchSet.has(idx) ? 'matched' : 'unmatched',
				].join('|'),
			);
		}
		return signatures;
	}, [
		visibleContentRows,
		feedViewportStart,
		filteredEntries,
		focusMode,
		feedCursor,
		searchMatchSet,
	]);

	const prevViewportRef = React.useRef<{
		signatures: string[];
		feedViewportStart: number;
		feedCursor: number;
	} | null>(null);

	React.useEffect(() => {
		const previous = prevViewportRef.current;
		const current = {
			signatures: visibleRowSignatures,
			feedViewportStart,
			feedCursor,
		};
		prevViewportRef.current = current;

		if (!previous) {
			logFeedViewportDiff({
				visibleRows: visibleRowSignatures.length,
				rowsChanged: visibleRowSignatures.length,
				viewportShift: feedViewportStart,
				focusMoved: false,
			});
			return;
		}

		let rowsChanged = 0;
		const maxRows = Math.max(
			previous.signatures.length,
			visibleRowSignatures.length,
		);
		for (let i = 0; i < maxRows; i++) {
			if (previous.signatures[i] !== visibleRowSignatures[i]) {
				rowsChanged += 1;
			}
		}

		const viewportShift = Math.abs(
			feedViewportStart - previous.feedViewportStart,
		);
		const focusMoved = feedCursor !== previous.feedCursor;
		if (rowsChanged === 0 && viewportShift === 0 && !focusMoved) {
			return;
		}

		logFeedViewportDiff({
			visibleRows: visibleRowSignatures.length,
			rowsChanged,
			viewportShift,
			focusMoved,
		});
	}, [visibleRowSignatures, feedViewportStart, feedCursor]);

	// Pre-compute ALL rows as strings, then join into a single <Text> node.
	// This reduces the Ink element count from N+2 to 1, dramatically cutting
	// Ink's yoga layout + diff overhead which scales with node count.
	const output = React.useMemo(() => {
		const border = chalk.hex(borderColor);
		const vGlyph = fr.vertical;
		const fl = (content: string): string =>
			`${border(vGlyph)}${content}${border(vGlyph)}`;
		const blank = spaces(innerWidth);
		const lines: string[] = [];

		// Header row
		if (feedHeaderRows > 0) {
			lines.push(fl(formatFeedHeaderLine(cols, theme, innerWidth)));
			if (showHeaderDivider) {
				lines.push(
					fl(chalk.hex(borderColor)(fr.horizontal.repeat(innerWidth))),
				);
			}
		}

		if (visibleContentRows <= 0) return lines.join('\n');

		if (filteredEntries.length === 0) {
			lines.push(fl(fitAnsi('(no feed events)', innerWidth)));
			for (let i = 1; i < visibleContentRows; i++) {
				lines.push(fl(blank));
			}
			return lines.join('\n');
		}

		let feedLinesEmitted = 0;
		let entryOffset = 0;

		while (feedLinesEmitted < visibleContentRows) {
			const idx = feedViewportStart + entryOffset;
			if (idx >= filteredEntries.length) {
				while (feedLinesEmitted < visibleContentRows) {
					lines.push(fl(blank));
					feedLinesEmitted++;
				}
				break;
			}
			const entry = filteredEntries[idx]!;
			lines.push(
				formatRow(
					entry,
					idx,
					feedCursor,
					focusMode,
					searchMatchSet.has(idx),
					ascii,
					theme,
					innerWidth,
					cols,
					vGlyph,
					borderColor,
					stripeBg,
				),
			);
			feedLinesEmitted++;
			entryOffset++;
		}

		return lines.join('\n');
	}, [
		feedHeaderRows,
		visibleContentRows,
		showHeaderDivider,
		feedViewportStart,
		filteredEntries,
		feedCursor,
		focusMode,
		searchMatchSet,
		ascii,
		theme,
		innerWidth,
		cols,
		fr.vertical,
		fr.horizontal,
		borderColor,
		stripeBg,
	]);

	return <Text>{output}</Text>;
}

export const FeedGrid = React.memo(FeedGridImpl);
