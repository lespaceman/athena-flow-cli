import {useState, useCallback, useEffect, useMemo, useRef} from 'react';
import {
	type TodoPanelItem,
	type TodoPanelStatus,
	toTodoStatus,
} from '../../core/feed/todoPanel';
import {type TodoItem} from '../../core/feed/todo';

import {generateId} from '../../shared/utils/id';
import {formatElapsed} from '../../shared/utils/formatElapsed';

export type UseTodoPanelOptions = {
	tasks: TodoItem[];
	isWorking: boolean;
};

export type UseTodoPanelResult = {
	todoVisible: boolean;
	todoShowDone: boolean;
	todoCursor: number;
	todoScroll: number;
	extraTodos: TodoPanelItem[];
	todoStatusOverrides: Record<string, TodoPanelStatus>;
	todoItems: TodoPanelItem[];
	visibleTodoItems: TodoPanelItem[];
	doneCount: number;
	doingCount: number;
	blockedCount: number;
	openCount: number;
	failedCount: number;
	remainingCount: number;
	pausedAtMs: number | null;
	setTodoVisible: React.Dispatch<React.SetStateAction<boolean>>;
	setTodoShowDone: React.Dispatch<React.SetStateAction<boolean>>;
	setTodoCursor: React.Dispatch<React.SetStateAction<number>>;
	setTodoScroll: React.Dispatch<React.SetStateAction<number>>;
	setExtraTodos: React.Dispatch<React.SetStateAction<TodoPanelItem[]>>;
	setTodoStatusOverrides: React.Dispatch<
		React.SetStateAction<Record<string, TodoPanelStatus>>
	>;
	addTodo: (priority: 'P0' | 'P1' | 'P2', text: string) => void;
	toggleTodoStatus: (index: number) => void;
};

export function useTodoPanel({
	tasks,
	isWorking,
}: UseTodoPanelOptions): UseTodoPanelResult {
	const [todoVisible, setTodoVisible] = useState(true);
	const [todoShowDone, setTodoShowDone] = useState(true);
	const [todoCursor, setTodoCursor] = useState(0);
	const [todoScroll, setTodoScroll] = useState(0);
	const [extraTodos, setExtraTodos] = useState<TodoPanelItem[]>([]);
	const [todoStatusOverrides, setTodoStatusOverrides] = useState<
		Record<string, TodoPanelStatus>
	>({});
	const startedAtRef = useRef<Map<string, number>>(new Map());
	const completedAtRef = useRef<Map<string, number>>(new Map());
	const pausedAtRef = useRef<number | null>(null);
	const todoItemsCacheRef = useRef<TodoPanelItem[] | null>(null);

	const nextTodoItems = (() => {
		const fromTasks = tasks.map((task, index) => ({
			id: `task-${index}-${task.content.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`,
			text: task.content,
			priority: 'P1' as const,
			status: toTodoStatus(task.status),
			owner: 'main',
			linkedEventId: undefined,
			localOnly: undefined,
		}));
		const merged = [...fromTasks, ...extraTodos].map(todo => ({
			...todo,
			status: todoStatusOverrides[todo.id] ?? todo.status,
		}));

		// Track start times and compute elapsed.
		// When idle (not working), freeze elapsed at the paused timestamp.
		// On resume, shift all timestamps forward by idle gap so idle time
		// doesn't count toward elapsed.
		const now = Date.now();
		const currentIds = new Set(merged.map(todo => todo.id));
		for (const id of startedAtRef.current.keys()) {
			if (!currentIds.has(id)) startedAtRef.current.delete(id);
		}
		for (const id of completedAtRef.current.keys()) {
			if (!currentIds.has(id)) completedAtRef.current.delete(id);
		}
		if (!isWorking && pausedAtRef.current === null) {
			pausedAtRef.current = now;
		} else if (isWorking && pausedAtRef.current !== null) {
			const idleGap = now - pausedAtRef.current;
			for (const [id, ts] of startedAtRef.current) {
				startedAtRef.current.set(id, ts + idleGap);
			}
			for (const [id, ts] of completedAtRef.current) {
				completedAtRef.current.set(id, ts + idleGap);
			}
			pausedAtRef.current = null;
		}
		const effectiveNow = isWorking ? now : (pausedAtRef.current ?? now);
		const startedAt = startedAtRef.current;
		const completedAt = completedAtRef.current;
		return merged.map(todo => {
			if (todo.status === 'doing') {
				if (!startedAt.has(todo.id)) {
					startedAt.set(todo.id, effectiveNow);
				}
				// Clear completedAt if re-opened (doing→done→doing)
				completedAt.delete(todo.id);
			} else if (
				(todo.status === 'done' || todo.status === 'failed') &&
				startedAt.has(todo.id) &&
				!completedAt.has(todo.id)
			) {
				completedAt.set(todo.id, effectiveNow);
			}
			const startedAtMs = startedAt.get(todo.id);
			const completedAtMs = completedAt.get(todo.id);
			let elapsed: string | undefined;
			if (
				startedAtMs !== undefined &&
				(todo.status === 'doing' ||
					todo.status === 'done' ||
					todo.status === 'failed')
			) {
				const end = completedAtMs ?? effectiveNow;
				elapsed = formatElapsed(Math.max(0, end - startedAtMs));
			}
			return {...todo, startedAtMs, completedAtMs, elapsed};
		});
	})();
	const previousTodoItems = todoItemsCacheRef.current;
	const todoItems =
		previousTodoItems &&
		previousTodoItems.length === nextTodoItems.length &&
		previousTodoItems.every((item, index) => {
			const next = nextTodoItems[index]!;
			return (
				item.id === next.id &&
				item.text === next.text &&
				item.priority === next.priority &&
				item.status === next.status &&
				item.linkedEventId === next.linkedEventId &&
				item.owner === next.owner &&
				item.localOnly === next.localOnly &&
				item.startedAtMs === next.startedAtMs &&
				item.completedAtMs === next.completedAtMs &&
				item.elapsed === next.elapsed
			);
		})
			? previousTodoItems
			: nextTodoItems;
	todoItemsCacheRef.current = todoItems;

	const sortedItems = useMemo(() => {
		return todoShowDone
			? todoItems
			: todoItems.filter(todo => todo.status !== 'done');
	}, [todoItems, todoShowDone]);

	const visibleTodoItemsRef = useRef(sortedItems);
	visibleTodoItemsRef.current = sortedItems;

	const {
		doneCount,
		doingCount,
		blockedCount,
		openCount,
		failedCount,
		remainingCount,
	} = useMemo(() => {
		let done = 0;
		let doing = 0;
		let blocked = 0;
		let open = 0;
		let failed = 0;
		for (const todo of todoItems) {
			switch (todo.status) {
				case 'done':
					done++;
					break;
				case 'doing':
					doing++;
					break;
				case 'blocked':
					blocked++;
					break;
				case 'open':
					open++;
					break;
				case 'failed':
					failed++;
					break;
			}
		}
		return {
			doneCount: done,
			doingCount: doing,
			blockedCount: blocked,
			openCount: open,
			failedCount: failed,
			remainingCount: todoItems.length - done,
		};
	}, [todoItems]);

	// Clamp cursor when items shrink
	useEffect(() => {
		setTodoCursor(prev => Math.min(prev, Math.max(0, sortedItems.length - 1)));
	}, [sortedItems.length]);

	// Keep the cursor anchored on the most interesting item.
	// Scroll position is owned by useLayout because it knows the actual
	// rendered window height; duplicating that policy here causes churn.
	useEffect(() => {
		const activeIdx = sortedItems.findIndex(i => i.status === 'doing');
		const targetIdx =
			activeIdx >= 0
				? activeIdx
				: sortedItems.findIndex(
						i => i.status !== 'done' && i.status !== 'failed',
					);
		if (targetIdx < 0) return;
		setTodoCursor(targetIdx);
	}, [sortedItems]);

	const addTodo = useCallback((priority: 'P0' | 'P1' | 'P2', text: string) => {
		setExtraTodos(prev => [
			...prev,
			{
				id: `local-${generateId()}`,
				text,
				priority,
				status: 'open',
				owner: 'main',
				localOnly: true,
			},
		]);
		setTodoVisible(true);
	}, []);

	const toggleTodoStatus = useCallback((index: number) => {
		const selected = visibleTodoItemsRef.current[index] as
			| TodoPanelItem
			| undefined;
		if (!selected) return;
		if (selected.status === 'failed') return;
		setTodoStatusOverrides(prev => ({
			...prev,
			[selected.id]:
				(prev[selected.id] ?? selected.status) === 'done' ? 'open' : 'done',
		}));
	}, []);

	return {
		todoVisible,
		todoShowDone,
		todoCursor,
		todoScroll,
		extraTodos,
		todoStatusOverrides,
		todoItems,
		visibleTodoItems: sortedItems,
		doneCount,
		doingCount,
		blockedCount,
		openCount,
		failedCount,
		remainingCount,
		pausedAtMs: pausedAtRef.current,
		setTodoVisible,
		setTodoShowDone,
		setTodoCursor,
		setTodoScroll,
		setExtraTodos,
		setTodoStatusOverrides,
		addTodo,
		toggleTodoStatus,
	};
}
