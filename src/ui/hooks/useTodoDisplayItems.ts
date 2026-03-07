import {useEffect, useMemo, useState} from 'react';
import {type TodoPanelItem} from '../../core/feed/todoPanel';
import {formatElapsed} from '../../shared/utils/formatElapsed';
import {startPerfCycle} from '../../shared/utils/perf';

type UseTodoDisplayItemsOptions = {
	items: TodoPanelItem[];
	isWorking: boolean;
	pausedAtMs: number | null;
	active: boolean;
	tickMs?: number;
};

export function hasTickingElapsedItems(items: TodoPanelItem[]): boolean {
	return items.some(
		item => item.status === 'doing' && item.startedAtMs !== undefined,
	);
}

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
	tickMs = 1000,
}: UseTodoDisplayItemsOptions): TodoPanelItem[] {
	const [nowMs, setNowMs] = useState(() => Date.now());
	const hasDoingItems = useMemo(() => hasTickingElapsedItems(items), [items]);

	useEffect(() => {
		if (!active || !isWorking || !hasDoingItems) return;
		startPerfCycle('timer:todo-header', {
			scope: 'todo.elapsed',
			items: items.length,
		});
		setNowMs(Date.now());
		const id = setInterval(() => {
			startPerfCycle('timer:todo-header', {
				scope: 'todo.elapsed',
				items: items.length,
			});
			setNowMs(Date.now());
		}, tickMs);
		return () => clearInterval(id);
	}, [active, isWorking, hasDoingItems, items.length, tickMs]);

	return useMemo(
		() => buildTodoDisplayItems(items, nowMs, isWorking, pausedAtMs),
		[items, nowMs, isWorking, pausedAtMs],
	);
}
