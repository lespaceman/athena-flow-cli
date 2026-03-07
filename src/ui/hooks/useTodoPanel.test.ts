/** @vitest-environment jsdom */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {useTodoPanel} from './useTodoPanel';
import {type TodoItem} from '../../core/feed/todo';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2024-01-15T10:00:00Z'));
});

afterEach(() => {
	vi.useRealTimers();
});

function makeTasks(statuses: TodoItem['status'][]): TodoItem[] {
	return statuses.map((status, i) => ({
		id: `task-${i}`,
		content: `Task ${i}`,
		status,
	}));
}

type HookProps = {tasks: TodoItem[]; isWorking: boolean};

describe('useTodoPanel', () => {
	describe('elapsed times', () => {
		it('doing items produce elapsed after tick', () => {
			const tasks = makeTasks(['in_progress']);
			const {result, rerender} = renderHook(
				({tasks, isWorking}: HookProps) => useTodoPanel({tasks, isWorking}),
				{initialProps: {tasks, isWorking: true}},
			);

			expect(result.current.todoItems[0]!.elapsed).toBe('0s');

			act(() => {
				vi.advanceTimersByTime(5000);
			});
			rerender({tasks, isWorking: true});

			expect(result.current.todoItems[0]!.elapsed).toBe('5s');
		});

		it('completed items freeze their elapsed time', () => {
			const tasks = makeTasks(['in_progress']);
			const {result, rerender} = renderHook(
				({tasks, isWorking}: HookProps) => useTodoPanel({tasks, isWorking}),
				{initialProps: {tasks, isWorking: true}},
			);

			act(() => {
				vi.advanceTimersByTime(10_000);
			});
			rerender({tasks, isWorking: true});

			const completedTasks = makeTasks(['completed']);
			rerender({tasks: completedTasks, isWorking: true});

			expect(result.current.todoItems[0]!.elapsed).toBe('10s');

			act(() => {
				vi.advanceTimersByTime(5000);
			});
			rerender({tasks: completedTasks, isWorking: true});

			expect(result.current.todoItems[0]!.elapsed).toBe('10s');
		});

		it('re-opened items clear completedAt and resume counting', () => {
			const tasks = makeTasks(['in_progress']);
			const {result, rerender} = renderHook(
				({tasks, isWorking}: HookProps) => useTodoPanel({tasks, isWorking}),
				{initialProps: {tasks, isWorking: true}},
			);

			act(() => {
				vi.advanceTimersByTime(5000);
			});
			rerender({tasks, isWorking: true});
			rerender({tasks: makeTasks(['completed']), isWorking: true});
			expect(result.current.todoItems[0]!.elapsed).toBe('5s');

			rerender({tasks: makeTasks(['in_progress']), isWorking: true});

			act(() => {
				vi.advanceTimersByTime(3000);
			});
			rerender({tasks: makeTasks(['in_progress']), isWorking: true});
			expect(result.current.todoItems[0]!.elapsed).toBe('8s');
		});

		it('elapsed freezes when idle (not working)', () => {
			const tasks = makeTasks(['in_progress']);
			const {result, rerender} = renderHook(
				({tasks, isWorking}: HookProps) => useTodoPanel({tasks, isWorking}),
				{initialProps: {tasks, isWorking: true}},
			);

			act(() => {
				vi.advanceTimersByTime(5000);
			});
			rerender({tasks, isWorking: true});
			expect(result.current.todoItems[0]!.elapsed).toBe('5s');

			// Go idle
			rerender({tasks, isWorking: false});
			expect(result.current.todoItems[0]!.elapsed).toBe('5s');

			// Time passes while idle — should NOT grow
			act(() => {
				vi.advanceTimersByTime(10_000);
			});
			rerender({tasks, isWorking: false});
			expect(result.current.todoItems[0]!.elapsed).toBe('5s');

			// Resume working — timer should continue from where it left off
			rerender({tasks, isWorking: true});
			act(() => {
				vi.advanceTimersByTime(2000);
			});
			rerender({tasks, isWorking: true});
			expect(result.current.todoItems[0]!.elapsed).toBe('7s');
		});
	});

	describe('paused time state', () => {
		it('captures pausedAtMs when work becomes idle', () => {
			const tasks = makeTasks(['in_progress']);
			const {result, rerender} = renderHook(
				({tasks, isWorking}: HookProps) => useTodoPanel({tasks, isWorking}),
				{initialProps: {tasks, isWorking: true}},
			);

			expect(result.current.pausedAtMs).toBeNull();

			rerender({tasks, isWorking: false});

			expect(result.current.pausedAtMs).toBeTypeOf('number');
		});
	});

	describe('auto-scroll', () => {
		it('moves cursor to the active item', () => {
			const tasks = makeTasks([
				'completed',
				'completed',
				'completed',
				'in_progress',
				'pending',
				'pending',
			]);
			const {result} = renderHook(() => useTodoPanel({tasks, isWorking: true}));

			expect(result.current.todoCursor).toBe(3);
			expect(result.current.todoScroll).toBe(0);
		});

		it('moves cursor to the first incomplete item when no doing item exists', () => {
			const tasks = makeTasks([
				'completed',
				'completed',
				'completed',
				'completed',
				'completed',
				'pending',
				'pending',
			]);
			const {result} = renderHook(() =>
				useTodoPanel({tasks, isWorking: false}),
			);

			expect(result.current.todoCursor).toBe(5);
			expect(result.current.todoScroll).toBe(0);
		});
	});

	describe('toggleTodoStatus', () => {
		it('ignores stale indexes that no longer resolve to a visible todo', () => {
			const tasks = makeTasks(['pending']);
			const {result} = renderHook(() =>
				useTodoPanel({tasks, isWorking: false}),
			);

			expect(() => {
				act(() => {
					result.current.toggleTodoStatus(99);
				});
			}).not.toThrow();
		});
	});

	describe('todo item cache', () => {
		it('does not reuse cached items when linkedEventId changes', () => {
			const {result} = renderHook(() =>
				useTodoPanel({tasks: [], isWorking: false}),
			);

			act(() => {
				result.current.setExtraTodos([
					{
						id: 'local-1',
						text: 'Task 1',
						priority: 'P1',
						status: 'open',
						owner: 'main',
						linkedEventId: 'event-1',
					},
				]);
			});

			expect(result.current.todoItems[0]!.linkedEventId).toBe('event-1');

			act(() => {
				result.current.setExtraTodos([
					{
						id: 'local-1',
						text: 'Task 1',
						priority: 'P1',
						status: 'open',
						owner: 'main',
						linkedEventId: 'event-2',
					},
				]);
			});

			expect(result.current.todoItems[0]!.linkedEventId).toBe('event-2');
		});
	});
});
