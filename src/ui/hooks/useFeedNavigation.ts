import {useState, useCallback, useMemo, useRef} from 'react';
import {type TimelineEntry} from '../../core/feed/timeline';

export type UseFeedNavigationOptions = {
	filteredEntries: TimelineEntry[];
	feedContentRows: number;
	/** Minimum valid cursor index — entries below this are in static scrollback. */
	staticFloor?: number;
};

export type UseFeedNavigationResult = {
	feedCursor: number;
	tailFollow: boolean;
	feedViewportStart: number;
	moveFeedCursor: (delta: number) => void;
	jumpToTail: () => void;
	jumpToTop: () => void;
	setFeedCursor: React.Dispatch<React.SetStateAction<number>>;
	setTailFollow: React.Dispatch<React.SetStateAction<boolean>>;
};

type NavigationState = {
	feedCursor: number;
	tailFollow: boolean;
};

function clampFeedCursor(
	cursor: number,
	maxCursor: number,
	staticFloor: number,
): number {
	return Math.max(staticFloor, Math.min(cursor, maxCursor));
}

export function useFeedNavigation({
	filteredEntries,
	feedContentRows,
	staticFloor = 0,
}: UseFeedNavigationOptions): UseFeedNavigationResult {
	const [navigation, setNavigation] = useState<NavigationState>({
		feedCursor: 0,
		tailFollow: true,
	});
	const maxCursor = Math.max(staticFloor, filteredEntries.length - 1);
	const maxCursorRef = useRef(maxCursor);
	maxCursorRef.current = maxCursor;
	const staticFloorRef = useRef(staticFloor);
	staticFloorRef.current = staticFloor;

	const resolveCursor = useCallback(
		(state: NavigationState): number =>
			state.tailFollow
				? maxCursorRef.current
				: clampFeedCursor(
						state.feedCursor,
						maxCursorRef.current,
						staticFloorRef.current,
					),
		[],
	);

	const feedCursor = resolveCursor(navigation);
	const tailFollow = navigation.tailFollow;

	const moveFeedCursor = useCallback((delta: number) => {
		setNavigation(prev => {
			const nextCursor = clampFeedCursor(
				resolveCursor(prev) + delta,
				maxCursorRef.current,
				staticFloorRef.current,
			);
			if (!prev.tailFollow && prev.feedCursor === nextCursor) {
				return prev;
			}
			return {feedCursor: nextCursor, tailFollow: false};
		});
	}, [resolveCursor]);

	const jumpToTail = useCallback(() => {
		setNavigation(prev => {
			const nextCursor = maxCursorRef.current;
			if (prev.tailFollow && prev.feedCursor === nextCursor) {
				return prev;
			}
			return {feedCursor: nextCursor, tailFollow: true};
		});
	}, []);

	const jumpToTop = useCallback(() => {
		setNavigation(prev => {
			const nextCursor = staticFloorRef.current;
			if (!prev.tailFollow && prev.feedCursor === nextCursor) {
				return prev;
			}
			return {feedCursor: nextCursor, tailFollow: false};
		});
	}, []);

	const setFeedCursor = useCallback(
		(
			nextCursorOrUpdater: React.SetStateAction<number>,
		): void => {
			setNavigation(prev => {
				const currentCursor = resolveCursor(prev);
				const requestedCursor =
					typeof nextCursorOrUpdater === 'function'
						? nextCursorOrUpdater(currentCursor)
						: nextCursorOrUpdater;
				const nextCursor = clampFeedCursor(
					requestedCursor,
					maxCursorRef.current,
					staticFloorRef.current,
				);
				if (prev.feedCursor === nextCursor) {
					return prev;
				}
				return {...prev, feedCursor: nextCursor};
			});
		},
		[resolveCursor],
	);

	const setTailFollow = useCallback(
		(
			nextTailFollowOrUpdater: React.SetStateAction<boolean>,
		): void => {
			setNavigation(prev => {
				const resolvedTailFollow =
					typeof nextTailFollowOrUpdater === 'function'
						? nextTailFollowOrUpdater(prev.tailFollow)
						: nextTailFollowOrUpdater;
				if (resolvedTailFollow === prev.tailFollow) {
					return prev;
				}
				return {
					feedCursor: resolveCursor(prev),
					tailFollow: resolvedTailFollow,
				};
			});
		},
		[resolveCursor],
	);

	const feedViewportStart = useMemo(() => {
		const total = filteredEntries.length;
		if (feedContentRows <= 0) return 0;
		if (total <= feedContentRows) return 0;

		const maxStart = Math.max(0, total - feedContentRows);

		let start: number;
		if (tailFollow) {
			start = maxStart;
		} else {
			// Center cursor in viewport, then clamp
			start = Math.max(
				0,
				Math.min(feedCursor - Math.floor(feedContentRows / 2), maxStart),
			);
		}

		// Ensure cursor is visible
		if (feedCursor < start) start = feedCursor;
		const end = start + feedContentRows - 1;
		if (feedCursor > end) {
			start = feedCursor - feedContentRows + 1;
		}

		return Math.max(staticFloor, Math.min(start, maxStart));
	}, [filteredEntries, feedCursor, feedContentRows, tailFollow, staticFloor]);

	return {
		feedCursor,
		tailFollow,
		feedViewportStart,
		moveFeedCursor,
		jumpToTail,
		jumpToTop,
		setFeedCursor,
		setTailFollow,
	};
}
