import {useMemo, useRef} from 'react';
import {type TimelineEntry} from '../../core/feed/timeline';
import {startPerfStage} from '../../shared/utils/perf';

export type FeedColumns = {
	toolW: number;
	detailsW: number;
	resultW: number;
	gapW: number;
	detailsResultGapW: number;
};

function areFeedColumnsEqual(left: FeedColumns, right: FeedColumns): boolean {
	return (
		left.toolW === right.toolW &&
		left.detailsW === right.detailsW &&
		left.resultW === right.resultW &&
		left.gapW === right.gapW &&
		left.detailsResultGapW === right.detailsResultGapW
	);
}

const GUTTER_W = 1;
const TIME_W = 5;
const ACTOR_W = 10;
// Suffix glyph column removed (no chevrons in table rows).
const SUFFIX_W = 0;
/** Fixed non-gap overhead: gutter + time + actor + suffix. */
const BASE_FIXED = GUTTER_W + TIME_W + ACTOR_W + SUFFIX_W;
const GAP_COUNT = 3;

export function computeFeedColumns(
	entries: TimelineEntry[],
	innerWidth: number,
): FeedColumns {
	let maxToolLen = 0;
	let maxResultLen = 0;
	for (const e of entries) {
		const len = e.toolColumn.length;
		if (len > maxToolLen) maxToolLen = len;
		const outcomeLen = (e.summaryOutcome ?? '').length;
		if (outcomeLen > maxResultLen) maxResultLen = outcomeLen;
	}

	const gapW = innerWidth >= 120 ? 2 : 1;
	// Pill rendering adds visual overhead (" label " padding), so reserve
	// a wider TOOL column to avoid truncating labels like "General Purpose".
	const toolW = Math.min(24, Math.max(12, maxToolLen + 4));
	const resultMaxW =
		innerWidth >= 240
			? 48
			: innerWidth >= 220
				? 42
				: innerWidth >= 180
					? 34
					: innerWidth >= 140
						? 26
						: 18;
	const resultW =
		maxResultLen > 0 ? Math.min(resultMaxW, Math.max(8, maxResultLen)) : 0;
	const detailsResultGapW = resultW > 0 ? Math.max(2, gapW) : 0;
	const fixedWithoutDetails =
		BASE_FIXED +
		toolW +
		(resultW > 0 ? resultW : 0) +
		GAP_COUNT * gapW +
		detailsResultGapW;
	const availableForDetails = Math.max(0, innerWidth - fixedWithoutDetails);
	return {
		toolW,
		detailsW: availableForDetails,
		resultW,
		gapW,
		detailsResultGapW,
	};
}

export function stabilizeFeedColumns(
	previous: FeedColumns,
	next: FeedColumns,
	innerWidth: number,
): FeedColumns {
	const gapW = Math.max(previous.gapW, next.gapW);
	const toolW = Math.max(previous.toolW, next.toolW);
	const resultW = Math.max(previous.resultW, next.resultW);
	const detailsResultGapW =
		resultW > 0
			? Math.max(previous.detailsResultGapW, next.detailsResultGapW, 2)
			: 0;
	const fixedWithoutDetails =
		BASE_FIXED +
		toolW +
		(resultW > 0 ? resultW : 0) +
		GAP_COUNT * gapW +
		detailsResultGapW;
	const stabilized = {
		toolW,
		detailsW: Math.max(0, innerWidth - fixedWithoutDetails),
		resultW,
		gapW,
		detailsResultGapW,
	};
	return areFeedColumnsEqual(previous, stabilized) ? previous : stabilized;
}

export function useFeedColumns(
	entries: TimelineEntry[],
	innerWidth: number,
): FeedColumns {
	const cacheRef = useRef<{
		entries: TimelineEntry[];
		innerWidth: number;
		cols: FeedColumns;
	} | null>(null);

	return useMemo(() => {
		const previous = cacheRef.current;
		if (
			!previous ||
			previous.innerWidth !== innerWidth ||
			entries.length < previous.entries.length
		) {
			const done = startPerfStage('feed.columns', {
				op: 'full',
				entries: entries.length,
				inner_width: innerWidth,
			});
			const cols = computeFeedColumns(entries, innerWidth);
			done();
			cacheRef.current = {entries, innerWidth, cols};
			return cols;
		}

		let appendedOnly = true;
		for (let i = 0; i < previous.entries.length; i++) {
			if (previous.entries[i] !== entries[i]) {
				appendedOnly = false;
				break;
			}
		}

		if (!appendedOnly) {
			const done = startPerfStage('feed.columns', {
				op: 'recompute',
				entries: entries.length,
				inner_width: innerWidth,
			});
			const cols = computeFeedColumns(entries, innerWidth);
			done();
			const stableCols = areFeedColumnsEqual(previous.cols, cols)
				? previous.cols
				: cols;
			cacheRef.current = {entries, innerWidth, cols: stableCols};
			return stableCols;
		}

		if (entries.length === previous.entries.length) {
			cacheRef.current = {entries, innerWidth, cols: previous.cols};
			return previous.cols;
		}

		const done = startPerfStage('feed.columns', {
			op: 'append-full',
			entries: entries.length,
			inner_width: innerWidth,
		});
		// Compute from ALL entries so that existing entries whose
		// summaryOutcome appeared after the initial computation (e.g. via
		// paired tool.post merge) are accounted for in resultW / toolW.
		const nextCols = computeFeedColumns(entries, innerWidth);
		const cols = stabilizeFeedColumns(previous.cols, nextCols, innerWidth);
		done();
		cacheRef.current = {entries, innerWidth, cols};
		return cols;
	}, [entries, innerWidth]);
}
