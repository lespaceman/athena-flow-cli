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

	const footerRows = (frame.footerHelp !== null ? 1 : 0) + 1;

	const glyphs = useMemo(() => frameGlyphs(ascii), [ascii]);

	const {topBorder, bottomBorder, sectionBorder} = useMemo(
		() => ({
			topBorder: `${glyphs.topLeft}${glyphs.horizontal.repeat(innerWidth)}${glyphs.topRight}`,
			bottomBorder: `${glyphs.bottomLeft}${glyphs.horizontal.repeat(innerWidth)}${glyphs.bottomRight}`,
			sectionBorder: `${glyphs.teeLeft}${glyphs.horizontal.repeat(innerWidth)}${glyphs.teeRight}`,
		}),
		[glyphs, innerWidth],
	);

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
