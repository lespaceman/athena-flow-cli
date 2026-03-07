/**
 * IncrementalFeedSurface — React wrapper around the incremental line painter.
 *
 * Instead of rendering via Ink's <Text> node (which triggers a full-frame
 * diff), this component writes directly to stdout using ANSI escape
 * sequences, repainting only the lines that actually changed.
 *
 * It renders an empty Ink fragment so it participates in the React tree
 * without producing any Ink output.
 */
import React from 'react';
import {type FeedSurface} from './feedSurface';
import {paintFeedSurface} from './feedSurfacePainter';
import {logFeedSurfaceRender} from '../../shared/utils/perf';

// ── Props ──────────────────────────────────────────────────────────

type Props = {
	surface: FeedSurface;
	/**
	 * The 1-based terminal row where the feed rectangle starts.
	 * The painter uses this to position the cursor for each line write.
	 */
	feedStartRow: number;
	/**
	 * Writable stream to paint to. Defaults to `process.stdout`.
	 * Exposed as a prop for testability.
	 */
	stdout?: {write(data: string): boolean};
};

// ── Component ──────────────────────────────────────────────────────

function IncrementalFeedSurfaceImpl({
	surface,
	feedStartRow,
	stdout = process.stdout,
}: Props) {
	const prevLinesRef = React.useRef<readonly string[]>([]);
	const prevFeedStartRowRef = React.useRef(feedStartRow);
	const feedStartRowRef = React.useRef(feedStartRow);
	const stdoutRef = React.useRef(stdout);
	feedStartRowRef.current = feedStartRow;
	stdoutRef.current = stdout;

	// Use useEffect so painting happens after React commit, matching
	// the timing of Ink's own stdout writes.
	React.useEffect(() => {
		const prevLines = prevLinesRef.current;
		const nextLines = surface.allLines;
		const prevStartRow = prevFeedStartRowRef.current;

		// When the feed region moves vertically (e.g. todo panel toggled,
		// run overlay shown/hidden), clear all lines at the OLD position
		// first, then repaint everything at the NEW position. Without this,
		// unchanged lines would remain ghosted at the previous location.
		if (prevStartRow !== feedStartRow && prevLines.length > 0) {
			paintFeedSurface(prevLines, [], prevStartRow, stdout);
			// Force full repaint at the new position by treating prev as empty.
			const result = paintFeedSurface([], nextLines, feedStartRow, stdout);
			prevLinesRef.current = nextLines;
			prevFeedStartRowRef.current = feedStartRow;

			logFeedSurfaceRender({
				backend: 'incremental',
				linesVisible: surface.visibleContentRows,
				linesRendered: result.linesRendered,
				linesChanged: result.linesChanged,
				linesCleared: result.linesCleared,
			});
			return;
		}

		const result = paintFeedSurface(prevLines, nextLines, feedStartRow, stdout);

		prevLinesRef.current = nextLines;
		prevFeedStartRowRef.current = feedStartRow;

		logFeedSurfaceRender({
			backend: 'incremental',
			linesVisible: surface.visibleContentRows,
			linesRendered: result.linesRendered,
			linesChanged: result.linesChanged,
			linesCleared: result.linesCleared,
		});
	}, [surface, feedStartRow, stdout]);

	// Clear painted lines on unmount to avoid stale terminal artifacts.
	// Uses refs so cleanup always has the latest feedStartRow/stdout.
	React.useEffect(() => {
		return () => {
			if (prevLinesRef.current.length > 0) {
				paintFeedSurface(
					prevLinesRef.current,
					[],
					feedStartRowRef.current,
					stdoutRef.current,
				);
			}
		};
	}, []);

	// Render nothing into Ink — all output goes directly to stdout.
	return null;
}

export const IncrementalFeedSurface = React.memo(IncrementalFeedSurfaceImpl);
