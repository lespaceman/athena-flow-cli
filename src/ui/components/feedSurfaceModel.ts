/**
 * Pure helpers that build the feed viewport as a structured line buffer.
 *
 * These functions are data-in / strings-out with no React dependency,
 * producing byte-identical output to the current FeedGrid useMemo block.
 */
import chalk from 'chalk';
import {type TimelineEntry} from '../../core/feed/timeline';
import {type Theme} from '../theme/types';
import {frameGlyphs} from '../glyphs/index';
import {fitAnsi, spaces} from '../../shared/utils/format';
import {type FeedColumnWidths, formatFeedRowLine} from './FeedRow';
import {formatFeedHeaderLine} from './FeedHeader';
import {RowCache} from './rowCache';

// ── Public types ───────────────────────────────────────────────────

/** Maps a body-line index to the filteredEntries index it represents. */
export type LineToEntryMap = Map<number, number>;

export type FeedSurface = {
	headerLines: string[];
	bodyLines: string[];
	allLines: string[];
	visibleContentRows: number;
	startIndex: number;
	lineToEntry: LineToEntryMap;
};

// ── Input contract ─────────────────────────────────────────────────

export type BuildFeedSurfaceParams = {
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
	rowCache?: RowCache;
};

// ── Internal helpers ───────────────────────────────────────────────

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

// ── Public API ─────────────────────────────────────────────────────

/**
 * Build a complete feed viewport as a structured line buffer.
 *
 * The output is identical to what FeedGrid's useMemo currently produces —
 * same header, divider, visible rows, blank fill, and empty-state placement.
 */
export function buildFeedSurface(params: BuildFeedSurfaceParams): FeedSurface {
	const {
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
		rowCache,
	} = params;

	const fr = frameGlyphs(ascii);
	const borderColor = theme.border;
	const stripeBg = theme.feed.stripeBackground ?? undefined;
	const showHeaderDivider = feedHeaderRows > 0 && feedContentRows > 1;
	const visibleContentRows = feedContentRows - (showHeaderDivider ? 1 : 0);

	const border = chalk.hex(borderColor);
	const vGlyph = fr.vertical;
	const fl = (content: string): string =>
		`${border(vGlyph)}${content}${border(vGlyph)}`;
	const blank = spaces(innerWidth);

	const headerLines: string[] = [];
	const bodyLines: string[] = [];
	const lineToEntry: LineToEntryMap = new Map();

	// Header row
	if (feedHeaderRows > 0) {
		headerLines.push(fl(formatFeedHeaderLine(cols, theme, innerWidth)));
		if (showHeaderDivider) {
			headerLines.push(
				fl(chalk.hex(borderColor)(fr.horizontal.repeat(innerWidth))),
			);
		}
	}

	if (visibleContentRows <= 0) {
		return {
			headerLines,
			bodyLines,
			allLines: [...headerLines],
			visibleContentRows,
			startIndex: feedViewportStart,
			lineToEntry,
		};
	}

	if (filteredEntries.length === 0) {
		bodyLines.push(fl(fitAnsi('(no feed events)', innerWidth)));
		for (let i = 1; i < visibleContentRows; i++) {
			bodyLines.push(fl(blank));
		}
		return {
			headerLines,
			bodyLines,
			allLines: [...headerLines, ...bodyLines],
			visibleContentRows,
			startIndex: feedViewportStart,
			lineToEntry,
		};
	}

	let feedLinesEmitted = 0;
	let entryOffset = 0;

	while (feedLinesEmitted < visibleContentRows) {
		const idx = feedViewportStart + entryOffset;
		if (idx >= filteredEntries.length) {
			while (feedLinesEmitted < visibleContentRows) {
				bodyLines.push(fl(blank));
				feedLinesEmitted++;
			}
			break;
		}
		const entry = filteredEntries[idx]!;
		const isFocused = focusMode === 'feed' && idx === feedCursor;
		const isStriped = idx % 2 === 1;
		const isMatched = searchMatchSet.has(idx);

		let rowLine: string;
		if (rowCache) {
			const cacheKey = RowCache.key(
				entry.id,
				isFocused,
				isStriped,
				isMatched,
				rowCache.getGeneration(),
				entry.summaryOutcome ?? '',
			);
			const cached = rowCache.get(cacheKey);
			if (cached !== undefined) {
				rowLine = cached;
			} else {
				rowLine = formatRow(
					entry,
					idx,
					feedCursor,
					focusMode,
					isMatched,
					ascii,
					theme,
					innerWidth,
					cols,
					vGlyph,
					borderColor,
					stripeBg,
				);
				rowCache.set(cacheKey, rowLine);
			}
		} else {
			rowLine = formatRow(
				entry,
				idx,
				feedCursor,
				focusMode,
				isMatched,
				ascii,
				theme,
				innerWidth,
				cols,
				vGlyph,
				borderColor,
				stripeBg,
			);
		}
		bodyLines.push(rowLine);
		lineToEntry.set(feedLinesEmitted, idx);
		feedLinesEmitted++;
		entryOffset++;
	}

	return {
		headerLines,
		bodyLines,
		allLines: [...headerLines, ...bodyLines],
		visibleContentRows,
		startIndex: feedViewportStart,
		lineToEntry,
	};
}
