import {useRef} from 'react';
import {useInput} from 'ink';
import {type TodoPanelItem} from '../../core/feed/todoPanel';
import {type TimelineEntry} from '../../core/feed/timeline';
import {startInputMeasure} from '../../shared/utils/perf';

export type TodoKeyboardCallbacks = {
	setFocusMode: (mode: 'feed' | 'input' | 'todo') => void;
	setInputMode: (mode: 'normal' | 'search' | 'command') => void;
	setInputValue: (value: string) => void;
	setTodoCursor: React.Dispatch<React.SetStateAction<number>>;
	setFeedCursor: (cursor: number) => void;
	setTailFollow: (follow: boolean) => void;
	toggleTodoStatus: (index: number) => void;
	cycleFocus: () => void;
};

export type TodoKeyboardOptions = {
	isActive: boolean;
	todoCursor: number;
	visibleTodoItems: TodoPanelItem[];
	filteredEntries: TimelineEntry[];
	callbacks: TodoKeyboardCallbacks;
};

export function useTodoKeyboard({
	isActive,
	todoCursor,
	visibleTodoItems,
	filteredEntries,
	callbacks,
}: TodoKeyboardOptions): void {
	const visibleTodoItemsRef = useRef(visibleTodoItems);
	visibleTodoItemsRef.current = visibleTodoItems;
	const filteredEntriesRef = useRef(filteredEntries);
	filteredEntriesRef.current = filteredEntries;

	useInput(
		(input, key) => {
			const done = startInputMeasure('todo.keyboard', input, key);
			try {
				if (key.escape) {
					callbacks.setFocusMode('feed');
					return;
				}
				if (key.tab) {
					callbacks.cycleFocus();
					return;
				}
				if (key.upArrow) {
					callbacks.setTodoCursor(prev => Math.max(0, prev - 1));
					return;
				}
				if (key.downArrow) {
					callbacks.setTodoCursor(prev =>
						Math.min(
							Math.max(0, visibleTodoItemsRef.current.length - 1),
							prev + 1,
						),
					);
					return;
				}
				if (input === ' ') {
					callbacks.toggleTodoStatus(todoCursor);
					return;
				}
				if (key.return) {
					if (
						todoCursor < 0 ||
						todoCursor >= visibleTodoItemsRef.current.length
					) {
						return;
					}
					const selected = visibleTodoItemsRef.current[todoCursor]!;
					if (!selected.linkedEventId) return;
					const idx = filteredEntriesRef.current.findIndex(
						entry => entry.id === selected.linkedEventId,
					);
					if (idx >= 0) {
						callbacks.setFeedCursor(idx);
						callbacks.setTailFollow(false);
						callbacks.setFocusMode('feed');
					}
					return;
				}
				if (input.toLowerCase() === 'a') {
					callbacks.setFocusMode('input');
					callbacks.setInputMode('normal');
					callbacks.setInputValue('');
					return;
				}
			} finally {
				done();
			}
		},
		{isActive},
	);
}
