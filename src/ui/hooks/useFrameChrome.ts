import {useMemo, useCallback} from 'react';
import {buildFrameLines, type FrameLines} from '../layout/buildFrameLines';
import {frameGlyphs} from '../glyphs/index';
import {fitAnsi} from '../../shared/utils/format';
import {type RunSummary} from '../../core/feed/timeline';

export type UseFrameChromeOptions = {
	innerWidth: number;
	focusMode: string;
	inputMode: string;
	searchQuery: string;
	searchMatches: number[];
	searchMatchPos: number;
	isHarnessRunning: boolean;
	dialogActive: boolean;
	dialogType: string;
	hintsForced: boolean | null;
	ascii: boolean;
	accentColor: string;
	runSummaries: RunSummary[];
	staticHighWaterMark: number;
	/**
	 * When set, splice junction characters into horizontal border strings at
	 * this column offset (0-based within the inner horizontal fill).  Used in
	 * split-panel layouts where a vertical divider needs to connect to the
	 * top, section, and bottom borders.
	 */
	dividerColumn?: number;
};

type LastRunStatus = 'completed' | 'failed' | 'aborted' | null;

const RUN_STATUS_MAP: Record<string, LastRunStatus> = {
	SUCCEEDED: 'completed',
	FAILED: 'failed',
	CANCELLED: 'aborted',
};

export type UseFrameChromeResult = {
	frame: FrameLines;
	footerRows: number;
	topBorder: string;
	bottomBorder: string;
	sectionBorder: string;
	frameLine: (content: string) => string;
	lastRunStatus: LastRunStatus;
	visibleSearchMatches: number[];
};

export function useFrameChrome({
	innerWidth,
	focusMode,
	inputMode,
	searchQuery,
	searchMatches,
	searchMatchPos,
	isHarnessRunning,
	dialogActive,
	dialogType,
	hintsForced,
	ascii,
	accentColor,
	runSummaries,
	staticHighWaterMark,
	dividerColumn,
}: UseFrameChromeOptions): UseFrameChromeResult {
	const lastRunStatus = useMemo((): LastRunStatus => {
		if (isHarnessRunning) return null;
		const last = runSummaries.at(-1);
		return last ? (RUN_STATUS_MAP[last.status] ?? null) : null;
	}, [isHarnessRunning, runSummaries]);

	const visibleSearchMatches = useMemo(
		() => searchMatches.filter(idx => idx >= staticHighWaterMark),
		[searchMatches, staticHighWaterMark],
	);

	const frame = useMemo(
		() =>
			buildFrameLines({
				innerWidth,
				focusMode,
				inputMode,
				searchQuery,
				searchMatches: visibleSearchMatches,
				searchMatchPos,
				isClaudeRunning: isHarnessRunning,
				inputValue: '',
				cursorOffset: 0,
				dialogActive,
				dialogType,
				accentColor,
				hintsForced,
				ascii,
				lastRunStatus,
				skipInputLines: true,
			}),
		[
			innerWidth,
			focusMode,
			inputMode,
			searchQuery,
			visibleSearchMatches,
			searchMatchPos,
			isHarnessRunning,
			dialogActive,
			dialogType,
			accentColor,
			hintsForced,
			ascii,
			lastRunStatus,
		],
	);

	// Budget: hints row + gap row (when hints visible) + input base row
	const footerRows = (frame.footerHelp !== null ? 2 : 0) + 1;

	const glyphs = useMemo(() => frameGlyphs(ascii), [ascii]);

	const {topBorder, bottomBorder, sectionBorder} = useMemo(() => {
		const hFill = glyphs.horizontal.repeat(innerWidth);
		const spliceJunction = (fill: string, junction: string): string => {
			if (
				dividerColumn === undefined ||
				dividerColumn < 0 ||
				dividerColumn >= innerWidth
			) {
				return fill;
			}
			return (
				fill.slice(0, dividerColumn) + junction + fill.slice(dividerColumn + 1)
			);
		};
		return {
			topBorder: `${glyphs.topLeft}${spliceJunction(hFill, glyphs.teeTop)}${glyphs.topRight}`,
			bottomBorder: `${glyphs.bottomLeft}${spliceJunction(hFill, glyphs.teeBottom)}${glyphs.bottomRight}`,
			sectionBorder: `${glyphs.teeLeft}${spliceJunction(hFill, glyphs.cross)}${glyphs.teeRight}`,
		};
	}, [glyphs, innerWidth, dividerColumn]);

	const frameLine = useCallback(
		(content: string): string =>
			`${glyphs.vertical}${fitAnsi(content, innerWidth)}${glyphs.vertical}`,
		[glyphs.vertical, innerWidth],
	);

	return {
		frame,
		footerRows,
		topBorder,
		bottomBorder,
		sectionBorder,
		frameLine,
		lastRunStatus,
		visibleSearchMatches,
	};
}
