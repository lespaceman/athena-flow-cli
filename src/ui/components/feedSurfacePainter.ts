/**
 * Pure utility that incrementally paints only changed feed lines to stdout.
 *
 * The painter compares previous and next allLines buffers using
 * `diffFeedSurface()`, then emits ANSI escape sequences to overwrite
 * only the lines that actually changed and to clear lines that disappeared.
 *
 * It saves and restores cursor position so it does not interfere with
 * Ink's cursor management.
 */
import {diffFeedSurface} from './feedSurfaceDiff';

// ── ANSI helpers ───────────────────────────────────────────────────

/** Move cursor to an absolute position (1-based row and column). */
function cursorTo(row: number, col: number): string {
	return `\x1b[${row};${col}H`;
}

/** Save cursor position (DEC private). */
const SAVE_CURSOR = '\x1b7';

/** Restore cursor position (DEC private). */
const RESTORE_CURSOR = '\x1b8';

// ── Public types ───────────────────────────────────────────────────

export type PaintResult = {
	linesChanged: number;
	linesCleared: number;
	linesRendered: number;
};

export type StdoutLike = {
	write(data: string): boolean;
};

// ── Public API ─────────────────────────────────────────────────────

/**
 * Paint only the changed and cleared lines from a feed surface update.
 *
 * @param prevLines  The previously painted allLines buffer (empty on first render).
 * @param nextLines  The new allLines buffer to paint.
 * @param feedStartRow  The 1-based terminal row where the feed region starts.
 * @param stdout  A writable stream (typically `process.stdout`).
 * @returns Metrics about what was painted.
 */
export function paintFeedSurface(
	prevLines: readonly string[],
	nextLines: readonly string[],
	feedStartRow: number,
	feedStartCol: number,
	lineWidth: number,
	stdout: StdoutLike,
): PaintResult {
	const diff = diffFeedSurface(prevLines, nextLines);

	const {changedIndexes, clearedIndexes} = diff;
	const totalOps = changedIndexes.length + clearedIndexes.length;

	if (totalOps === 0) {
		return {linesChanged: 0, linesCleared: 0, linesRendered: 0};
	}

	// Build a single write buffer so we hit stdout.write() only once.
	let buf = SAVE_CURSOR;
	const clearRegion = ' '.repeat(Math.max(0, lineWidth));

	// Write changed lines (content that differs or is newly exposed).
	for (const idx of changedIndexes) {
		const row = feedStartRow + idx; // 1-based terminal row
		buf +=
			cursorTo(row, feedStartCol) +
			clearRegion +
			cursorTo(row, feedStartCol) +
			(nextLines[idx] ?? '');
	}

	// Clear lines that no longer exist (viewport shrank or content reduced).
	for (const idx of clearedIndexes) {
		const row = feedStartRow + idx;
		buf += cursorTo(row, feedStartCol) + clearRegion;
	}

	buf += RESTORE_CURSOR;

	stdout.write(buf);

	return {
		linesChanged: changedIndexes.length,
		linesCleared: clearedIndexes.length,
		linesRendered: changedIndexes.length + clearedIndexes.length,
	};
}
