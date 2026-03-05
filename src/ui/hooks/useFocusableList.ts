import {useState, useCallback, useMemo, useEffect} from 'react';

export type UseFocusableListResult = {
	cursor: number;
	focusedId: string | undefined;
	expandedSet: ReadonlySet<string>;
	moveUp: () => void;
	moveDown: () => void;
	toggleExpand: (id: string) => void;
	toggleFocused: () => void;
	expandById: (id: string) => void;
};

export function useFocusableList(
	focusableIds: string[],
): UseFocusableListResult {
	const [cursor, setCursor] = useState(0);
	const [expandedSet, setExpandedSet] = useState<Set<string>>(() => new Set());

	// Clamp cursor when list shrinks
	useEffect(() => {
		setCursor(prev => Math.min(prev, Math.max(0, focusableIds.length - 1)));
	}, [focusableIds.length]);

	const focusedId = focusableIds[cursor];

	const moveUp = useCallback(() => {
		setCursor(prev => Math.max(prev - 1, 0));
	}, []);

	const moveDown = useCallback(() => {
		setCursor(prev =>
			focusableIds.length === 0
				? 0
				: Math.min(prev + 1, focusableIds.length - 1),
		);
	}, [focusableIds.length]);

	const toggleExpand = useCallback((id: string) => {
		setExpandedSet(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const toggleFocused = useCallback(() => {
		const id = focusableIds[cursor];
		toggleExpand(id);
	}, [cursor, focusableIds, toggleExpand]);

	const expandById = useCallback(
		(id: string) => {
			const idx = focusableIds.indexOf(id);
			if (idx >= 0) {
				setCursor(idx);
				setExpandedSet(prev => {
					const next = new Set(prev);
					next.add(id);
					return next;
				});
			}
		},
		[focusableIds],
	);

	return useMemo(
		() => ({
			cursor,
			focusedId,
			expandedSet,
			moveUp,
			moveDown,
			toggleExpand,
			toggleFocused,
			expandById,
		}),
		[
			cursor,
			focusedId,
			expandedSet,
			moveUp,
			moveDown,
			toggleExpand,
			toggleFocused,
			expandById,
		],
	);
}
