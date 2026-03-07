import {useState, useCallback, useRef} from 'react';
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
	feedViewportStart: number;
};

function clampFeedCursor(
	cursor: number,
	maxCursor: number,
	staticFloor: number,
): number {
	return Math.max(staticFloor, Math.min(cursor, maxCursor));
}

function clampViewportStart(
	feedViewportStart: number,
	maxStart: number,
	staticFloor: number,
): number {
	return Math.max(staticFloor, Math.min(feedViewportStart, maxStart));
}

function resolveNavigationState(
	state: NavigationState,
	maxCursor: number,
	maxStart: number,
	feedContentRows: number,
	staticFloor: number,
): NavigationState {
	if (state.tailFollow) {
		return {
			feedCursor: maxCursor,
			tailFollow: true,
			feedViewportStart: maxStart,
		};
	}

	const feedCursor = clampFeedCursor(state.feedCursor, maxCursor, staticFloor);
	let feedViewportStart = clampViewportStart(
		state.feedViewportStart,
		maxStart,
		staticFloor,
	);
	if (feedCursor < feedViewportStart) {
		feedViewportStart = feedCursor;
	} else if (feedContentRows > 0) {
		const visibleEnd = feedViewportStart + feedContentRows - 1;
		if (feedCursor > visibleEnd) {
			feedViewportStart = feedCursor - feedContentRows + 1;
		}
	}

	return {
		feedCursor,
		tailFollow: false,
		feedViewportStart: clampViewportStart(
			feedViewportStart,
			maxStart,
			staticFloor,
		),
	};
}

export function useFeedNavigation({
	filteredEntries,
	feedContentRows,
	staticFloor = 0,
}: UseFeedNavigationOptions): UseFeedNavigationResult {
	const [navigation, setNavigation] = useState<NavigationState>({
		feedCursor: 0,
		tailFollow: true,
		feedViewportStart: 0,
	});
	const maxCursor = Math.max(staticFloor, filteredEntries.length - 1);
	const maxStart =
		feedContentRows <= 0
			? 0
			: Math.max(0, filteredEntries.length - feedContentRows);
	const maxCursorRef = useRef(maxCursor);
	maxCursorRef.current = maxCursor;
	const maxStartRef = useRef(maxStart);
	maxStartRef.current = maxStart;
	const feedContentRowsRef = useRef(feedContentRows);
	feedContentRowsRef.current = feedContentRows;
	const staticFloorRef = useRef(staticFloor);
	staticFloorRef.current = staticFloor;

	const resolveCursor = useCallback(
		(state: NavigationState): NavigationState =>
			resolveNavigationState(
				state,
				maxCursorRef.current,
				maxStartRef.current,
				feedContentRowsRef.current,
				staticFloorRef.current,
			),
		[],
	);

	const resolvedNavigation = resolveCursor(navigation);
	const feedCursor = resolvedNavigation.feedCursor;
	const tailFollow = resolvedNavigation.tailFollow;
	const feedViewportStart = resolvedNavigation.feedViewportStart;

	const moveFeedCursor = useCallback((delta: number) => {
		setNavigation(prev => {
			const current = resolveCursor(prev);
			const nextCursor = clampFeedCursor(
				current.feedCursor + delta,
				maxCursorRef.current,
				staticFloorRef.current,
			);
			let nextViewportStart = current.feedViewportStart;
			if (nextCursor < nextViewportStart) {
				nextViewportStart = nextCursor;
			} else if (feedContentRowsRef.current > 0) {
				const visibleEnd = nextViewportStart + feedContentRowsRef.current - 1;
				if (nextCursor > visibleEnd) {
					nextViewportStart = nextCursor - feedContentRowsRef.current + 1;
				}
			}
			nextViewportStart = clampViewportStart(
				nextViewportStart,
				maxStartRef.current,
				staticFloorRef.current,
			);
			if (
				!prev.tailFollow &&
				prev.feedCursor === nextCursor &&
				prev.feedViewportStart === nextViewportStart
			) {
				return prev;
			}
			return {
				feedCursor: nextCursor,
				tailFollow: false,
				feedViewportStart: nextViewportStart,
			};
		});
	}, [resolveCursor]);

	const jumpToTail = useCallback(() => {
		setNavigation(prev => {
			const nextCursor = maxCursorRef.current;
			const nextViewportStart = maxStartRef.current;
			if (
				prev.tailFollow &&
				prev.feedCursor === nextCursor &&
				prev.feedViewportStart === nextViewportStart
			) {
				return prev;
			}
			return {
				feedCursor: nextCursor,
				tailFollow: true,
				feedViewportStart: nextViewportStart,
			};
		});
	}, []);

	const jumpToTop = useCallback(() => {
		setNavigation(prev => {
			const nextCursor = staticFloorRef.current;
			const nextViewportStart = clampViewportStart(
				staticFloorRef.current,
				maxStartRef.current,
				staticFloorRef.current,
			);
			if (
				!prev.tailFollow &&
				prev.feedCursor === nextCursor &&
				prev.feedViewportStart === nextViewportStart
			) {
				return prev;
			}
			return {
				feedCursor: nextCursor,
				tailFollow: false,
				feedViewportStart: nextViewportStart,
			};
		});
	}, []);

	const setFeedCursor = useCallback(
		(
			nextCursorOrUpdater: React.SetStateAction<number>,
		): void => {
			setNavigation(prev => {
				const current = resolveCursor(prev);
				const requestedCursor =
					typeof nextCursorOrUpdater === 'function'
						? nextCursorOrUpdater(current.feedCursor)
						: nextCursorOrUpdater;
				const nextCursor = clampFeedCursor(
					requestedCursor,
					maxCursorRef.current,
					staticFloorRef.current,
				);
				let nextViewportStart = current.feedViewportStart;
				if (nextCursor < nextViewportStart) {
					nextViewportStart = nextCursor;
				} else if (feedContentRowsRef.current > 0) {
					const visibleEnd = nextViewportStart + feedContentRowsRef.current - 1;
					if (nextCursor > visibleEnd) {
						nextViewportStart = nextCursor - feedContentRowsRef.current + 1;
					}
				}
				nextViewportStart = clampViewportStart(
					nextViewportStart,
					maxStartRef.current,
					staticFloorRef.current,
				);
				if (
					!prev.tailFollow &&
					prev.feedCursor === nextCursor &&
					prev.feedViewportStart === nextViewportStart
				) {
					return prev;
				}
				return {
					feedCursor: nextCursor,
					tailFollow: false,
					feedViewportStart: nextViewportStart,
				};
			});
		},
		[resolveCursor],
	);

	const setTailFollow = useCallback(
		(
			nextTailFollowOrUpdater: React.SetStateAction<boolean>,
		): void => {
			setNavigation(prev => {
				const current = resolveCursor(prev);
				const resolvedTailFollow =
					typeof nextTailFollowOrUpdater === 'function'
						? nextTailFollowOrUpdater(prev.tailFollow)
						: nextTailFollowOrUpdater;
				if (resolvedTailFollow === prev.tailFollow) {
					return prev;
				}
				if (resolvedTailFollow) {
					return {
						feedCursor: maxCursorRef.current,
						tailFollow: true,
						feedViewportStart: maxStartRef.current,
					};
				}
				return {...current, tailFollow: false};
			});
		},
		[resolveCursor],
	);

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
