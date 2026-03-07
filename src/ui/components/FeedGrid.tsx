import React from 'react';
import {Text} from 'ink';
import {type TimelineEntry} from '../../core/feed/timeline';
import {type Theme} from '../theme/types';
import {type FeedColumnWidths} from './FeedRow';
import {buildFeedSurface} from './feedSurfaceModel';
import {logFeedViewportDiff} from '../../shared/utils/perf';
import {FeedSurfaceView, resolveFeedBackend} from './FeedSurface';
import {type FeedSurfaceBackend} from '../../shared/utils/perf';

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
	/**
	 * 1-based terminal row where the feed region starts.
	 * Required when using the incremental backend.
	 */
	feedStartRow?: number;
	/** Override the feed rendering backend (defaults to env-var resolution). */
	backend?: FeedSurfaceBackend;
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
	feedStartRow,
	backend: backendProp,
}: Props) {
	const backend = resolveFeedBackend(backendProp);
	const isIncremental = backend === 'incremental';
	// Delegate all line rendering to the extracted surface model.
	const surface = React.useMemo(
		() =>
			buildFeedSurface({
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
			}),
		[
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
		],
	);

	const {visibleContentRows} = surface;

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

	// ── Incremental backend: render a placeholder to reserve space in Ink ──
	// The IncrementalFeedSurface renders `null` in Ink's tree and paints
	// directly to stdout.  Without a placeholder, Ink would collapse the
	// feed region to 0 rows, shifting footer/input up and causing the
	// incremental painter to overwrite them.
	//
	// The placeholder emits empty lines that occupy exactly the feed's
	// allocated rows so Ink's layout stays correct.  The incremental
	// painter writes over this space via ANSI cursor addressing.
	if (isIncremental) {
		const totalFeedRows = feedHeaderRows + feedContentRows;
		// Build placeholder content — empty lines that Ink will render,
		// reserving the vertical space without visible content.
		const placeholderLines = '\n'.repeat(Math.max(0, totalFeedRows - 1));
		return (
			<>
				<Text>{placeholderLines}</Text>
				<FeedSurfaceView
					surface={surface}
					backend={backend}
					feedStartRow={feedStartRow}
				/>
			</>
		);
	}

	// ── ink-full backend: normal rendering ──────────────────────────
	return <FeedSurfaceView surface={surface} backend={backend} />;
}

export const FeedGrid = React.memo(FeedGridImpl);
