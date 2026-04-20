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
import {centerAnsi, spaces} from '../../shared/utils/format';
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
	lineWidth: number;
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
	searchMatchSet: ReadonlySet<number>;
	ascii: boolean;
	theme: Theme;
	innerWidth: number;
	cols: FeedColumnWidths;
	rowCache?: RowCache;
	onboarding?: OnboardingInfo;
};

export type OnboardingInfo = {
	name?: string;
	description?: string;
	examplePrompts?: string[];
};

// ── Internal helpers ───────────────────────────────────────────────

function wordWrap(text: string, maxWidth: number): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length > maxWidth && current) {
			lines.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function buildOnboardingLines(
	innerWidth: number,
	visibleContentRows: number,
	theme: Theme,
	onboarding?: OnboardingInfo,
): string[] {
	const title = (t: string) => chalk.hex(theme.text).bold(t);
	const muted = (t: string) => chalk.hex(theme.textMuted)(t);
	const center = (t: string) => centerAnsi(t, innerWidth);
	const blank = spaces(innerWidth);
	const contentWidth = Math.min(innerWidth, 80);
	const lines: string[] = [];

	if (onboarding?.name) {
		lines.push(center(title(onboarding.name)));
	}
	if (onboarding?.description) {
		for (const wrapped of wordWrap(onboarding.description, contentWidth)) {
			lines.push(center(muted(wrapped)));
		}
	}
	if (lines.length > 0) {
		lines.push(blank);
	}

	if (onboarding?.examplePrompts && onboarding.examplePrompts.length > 0) {
		for (const example of onboarding.examplePrompts) {
			lines.push(center(muted(`"${example}"`)));
		}
		lines.push(blank);
	}

	lines.push(center(muted('Enter a prompt below to get started')));

	if (lines.length >= visibleContentRows) {
		return lines.slice(0, visibleContentRows);
	}
	const topPad = Math.floor((visibleContentRows - lines.length) / 2);
	const result: string[] = [];
	for (let i = 0; i < topPad; i++) result.push(blank);
	for (const line of lines) result.push(line);
	while (result.length < visibleContentRows) result.push(blank);
	return result;
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
		onboarding,
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
	const lineWidth = innerWidth + 2;

	// Header row
	if (feedHeaderRows > 0) {
		headerLines.push(fl(formatFeedHeaderLine(cols, theme, innerWidth)));
		if (showHeaderDivider) {
			headerLines.push(
				`${border(fr.teeLeft)}${chalk.hex(borderColor)(fr.horizontal.repeat(innerWidth))}${border(fr.teeRight)}`,
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
			lineWidth,
			lineToEntry,
		};
	}

	if (filteredEntries.length === 0) {
		const onboardingLines = buildOnboardingLines(
			innerWidth,
			visibleContentRows,
			theme,
			onboarding,
		);
		for (const line of onboardingLines) {
			bodyLines.push(fl(line));
		}
		return {
			headerLines,
			bodyLines,
			allLines: [...headerLines, ...bodyLines],
			visibleContentRows,
			startIndex: feedViewportStart,
			lineWidth,
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
		lineWidth,
		lineToEntry,
	};
}
