/**
 * Pure helper that compares two visible-line buffers (allLines arrays from
 * FeedSurface) and returns which lines changed, which were cleared, and
 * how many remained unchanged.
 *
 * This is a positional line-by-line string comparison, NOT a generic diff
 * algorithm. Each index is compared directly between prev and next.
 */

// ── Public types ───────────────────────────────────────────────────

export type FeedSurfaceDiff = {
	/** Indexes (in the next allLines) whose content differs from prev. */
	changedIndexes: number[];
	/** Indexes that existed in prev but not in next (trailing lines to erase). */
	clearedIndexes: number[];
	/** Count of lines that are identical between prev and next. */
	unchangedCount: number;
};

// ── Public API ─────────────────────────────────────────────────────

/**
 * Compare previous and next visible-line buffers and report what changed.
 *
 * - Lines present in both arrays are compared by strict string equality.
 * - Lines only in `next` (grow) appear in `changedIndexes`.
 * - Lines only in `prev` (shrink) appear in `clearedIndexes`.
 */
export function diffFeedSurface(
	prev: readonly string[],
	next: readonly string[],
): FeedSurfaceDiff {
	const changedIndexes: number[] = [];
	const clearedIndexes: number[] = [];
	let unchangedCount = 0;

	const sharedLen = Math.min(prev.length, next.length);

	// Compare lines that exist in both arrays
	for (let i = 0; i < sharedLen; i++) {
		if (prev[i] === next[i]) {
			unchangedCount++;
		} else {
			changedIndexes.push(i);
		}
	}

	// Lines only in next (viewport grew)
	for (let i = sharedLen; i < next.length; i++) {
		changedIndexes.push(i);
	}

	// Lines only in prev (viewport shrank)
	for (let i = sharedLen; i < prev.length; i++) {
		clearedIndexes.push(i);
	}

	return {changedIndexes, clearedIndexes, unchangedCount};
}
