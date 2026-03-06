import {useEffect, useMemo, useState} from 'react';
import {type TodoPanelItem} from '../../core/feed/todoPanel';
import {formatElapsed} from '../../shared/utils/formatElapsed';

type UseTodoDisplayItemsOptions = {
	items: TodoPanelItem[];
	isWorking: boolean;
	pausedAtMs: number | null;
	active: boolean;
};

export function buildTodoDisplayItems(
	items: TodoPanelItem[],
	nowMs: number,
	isWorking: boolean,
	pausedAtMs: number | null,
): TodoPanelItem[] {
	return items.map(item => {
		const hasElapsed =
			item.startedAtMs !== undefined &&
			(item.status === 'doing' ||
				item.status === 'done' ||
				item.status === 'failed');
		const endMs =
			item.completedAtMs ?? (isWorking ? nowMs : (pausedAtMs ?? nowMs));
		const elapsed = hasElapsed
			? formatElapsed(Math.max(0, endMs - item.startedAtMs!))
			: undefined;
		if (elapsed === item.elapsed) return item;
		return {...item, elapsed};
	});
}

export function useTodoDisplayItems({
	items,
	isWorking,
	pausedAtMs,
	active,
}: UseTodoDisplayItemsOptions): TodoPanelItem[] {
	const [nowMs, setNowMs] = useState(() => Date.now());
	const hasDoingItems = useMemo(
		() =>
			items.some(
				item => item.status === 'doing' && item.startedAtMs !== undefined,
			),
		[items],
	);

	useEffect(() => {
		if (!active || !isWorking || !hasDoingItems) return;
		setNowMs(Date.now());
		const id = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active, isWorking, hasDoingItems]);

	return useMemo(
		() => buildTodoDisplayItems(items, nowMs, isWorking, pausedAtMs),
		[items, nowMs, isWorking, pausedAtMs],
	);
}
