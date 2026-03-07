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

type FeedGridRowProps = {
	entry: TimelineEntry;
	idx: number;
	feedCursor: number;
	focusMode: string;
	matched: boolean;
	ascii: boolean;
	theme: Theme;
	innerWidth: number;
	cols: FeedColumnWidths;
	verticalGlyph: string;
	borderColor: string;
	stripeBg?: string;
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

function FeedGridRowImpl({
	entry,
	idx,
	feedCursor,
	focusMode,
	matched,
	ascii,
	theme,
	innerWidth,
	cols,
	verticalGlyph,
	borderColor,
	stripeBg,
}: FeedGridRowProps) {
	const line = React.useMemo(() => {
		const isDuplicateActor = entry.duplicateActor;
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
				isDuplicateActor,
				ascii,
				theme,
				innerWidth,
			}),
		);
		return `${border(verticalGlyph)}${content}${border(verticalGlyph)}`;
	}, [
		entry,
		idx,
		feedCursor,
		focusMode,
		matched,
		ascii,
		theme,
		innerWidth,
		cols,
		verticalGlyph,
		borderColor,
		stripeBg,
	]);

	return <Text>{line}</Text>;
}

const FeedGridRow = React.memo(FeedGridRowImpl, (prev, next) => {
	const prevFocused = prev.focusMode === 'feed' && prev.idx === prev.feedCursor;
	const nextFocused = next.focusMode === 'feed' && next.idx === next.feedCursor;
	return (
		prev.entry === next.entry &&
		prev.idx === next.idx &&
		prevFocused === nextFocused &&
		prev.matched === next.matched &&
		prev.ascii === next.ascii &&
		prev.theme === next.theme &&
		prev.innerWidth === next.innerWidth &&
		prev.cols === next.cols &&
		prev.verticalGlyph === next.verticalGlyph &&
		prev.borderColor === next.borderColor &&
		prev.stripeBg === next.stripeBg
	);
});

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
	const borderColor = theme.border;
	const border = chalk.hex(borderColor);
	const frameLine = (content: string): string =>
		`${border(fr.vertical)}${content}${border(fr.vertical)}`;
	const stripeBg = theme.feed.stripeBackground ?? undefined;
	const dividerLine = chalk.hex(theme.border)(fr.horizontal.repeat(innerWidth));
	const showHeaderDivider = feedHeaderRows > 0 && feedContentRows > 1;
	const visibleContentRows = feedContentRows - (showHeaderDivider ? 1 : 0);
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

	// Header row
	if (feedHeaderRows > 0) {
		rows.push(
			<Text key="feed-header">
				{frameLine(formatFeedHeaderLine(cols, theme, innerWidth))}
			</Text>,
		);
		if (showHeaderDivider) {
			rows.push(
				<Text key="feed-header-divider">{frameLine(dividerLine)}</Text>,
			);
		}
	}

	if (visibleContentRows <= 0) return <>{rows}</>;

	if (filteredEntries.length === 0) {
		rows.push(
			<Text key="feed-empty">
				{frameLine(fitAnsi('(no feed events)', innerWidth))}
			</Text>,
		);
		for (let i = 1; i < visibleContentRows; i++) {
			rows.push(<Text key={`feed-pad-${i}`}>{frameLine(blankLine)}</Text>);
		}
		return <>{rows}</>;
	}

	let feedLinesEmitted = 0;
	let entryOffset = 0;

	while (feedLinesEmitted < visibleContentRows) {
		const idx = feedViewportStart + entryOffset;
		if (idx >= filteredEntries.length) {
			// Pad remaining rows
			while (feedLinesEmitted < visibleContentRows) {
				rows.push(
					<Text key={`feed-pad-${feedLinesEmitted}`}>
						{frameLine(blankLine)}
					</Text>,
				);
				feedLinesEmitted++;
			}
			break;
		}
		const entry = filteredEntries[idx]!;
		rows.push(
			<FeedGridRow
				key={`feed-row-${entry.id}`}
				entry={entry}
				idx={idx}
				feedCursor={feedCursor}
				focusMode={focusMode}
				matched={searchMatchSet.has(idx)}
				ascii={ascii}
				theme={theme}
				innerWidth={innerWidth}
				cols={cols}
				verticalGlyph={fr.vertical}
				borderColor={borderColor}
				stripeBg={stripeBg}
			/>,
		);
		feedLinesEmitted++;
		entryOffset++;
	}

	return <>{rows}</>;
}

export const FeedGrid = React.memo(FeedGridImpl);
