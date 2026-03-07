import {useRef} from 'react';
import {type TimelineEntry, isEntryStable} from '../../core/feed/timeline';

const STATIC_BATCH_MIN_ENTRIES = 64;
const STATIC_FLUSH_BATCH_ROWS = 6;
const STATIC_RETAIN_ROWS = 2;

export type UseStaticFeedOptions = {
	filteredEntries: TimelineEntry[];
	feedViewportStart: number;
	tailFollow: boolean;
};

/**
 * Tracks a monotonic high-water mark — the index into `filteredEntries`
 * up to which entries have been emitted to `<Static>`.
 *
 * Uses `useRef` (not `useState`) to avoid triggering re-renders when
 * the mark advances — advancement is observed on the next natural render.
 */
export function useStaticFeed({
	filteredEntries,
	feedViewportStart,
	tailFollow,
}: UseStaticFeedOptions): number {
	const hwmRef = useRef(0);
	const previousViewportStartRef = useRef(0);
	hwmRef.current = Math.min(
		hwmRef.current,
		filteredEntries.length,
		Math.max(0, feedViewportStart),
	);

	// Only advance when tail-following and the viewport actually moves forward.
	// Stability changes alone can be frequent during tool.post patching; delaying
	// static emission until the viewport advances avoids large zero-delta writes.
	if (!tailFollow) {
		previousViewportStartRef.current = feedViewportStart;
		return hwmRef.current;
	}

	const previousViewportStart = previousViewportStartRef.current;
	previousViewportStartRef.current = feedViewportStart;
	if (feedViewportStart <= previousViewportStart) {
		return hwmRef.current;
	}

	let candidate = hwmRef.current;
	const useBatchedFlush =
		filteredEntries.length >= STATIC_BATCH_MIN_ENTRIES &&
		feedViewportStart > STATIC_FLUSH_BATCH_ROWS;
	const flushTarget = useBatchedFlush
		? Math.max(0, feedViewportStart - STATIC_RETAIN_ROWS)
		: feedViewportStart;
	if (
		useBatchedFlush &&
		flushTarget - hwmRef.current < STATIC_FLUSH_BATCH_ROWS
	) {
		return hwmRef.current;
	}

	// Advance consecutively while entries are below viewport and stable
	while (candidate < flushTarget && candidate < filteredEntries.length) {
		if (!isEntryStable(filteredEntries[candidate]!)) break;
		candidate++;
	}

	hwmRef.current = candidate;
	return candidate;
}
