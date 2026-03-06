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
			const {result} = renderHook(() => useTodoPanel({tasks, isWorking: true}));

			expect(result.current.todoItems[0]!.elapsed).toBe('0s');

			act(() => {
				vi.advanceTimersByTime(5000);
			});

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
			rerender({tasks: makeTasks(['completed']), isWorking: true});
			expect(result.current.todoItems[0]!.elapsed).toBe('5s');

			rerender({tasks: makeTasks(['in_progress']), isWorking: true});

			act(() => {
				vi.advanceTimersByTime(3000);
			});
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
			expect(result.current.todoItems[0]!.elapsed).toBe('7s');
		});
	});

	describe('tick gating', () => {
		it('does not tick when panel is hidden', () => {
			const tasks = makeTasks(['in_progress']);
			const {result} = renderHook(() => useTodoPanel({tasks, isWorking: true}));

			// Hide the panel
			act(() => {
				result.current.setTodoVisible(false);
			});

			const elapsedBefore = result.current.todoItems[0]!.elapsed;

			// Advance 5 seconds — tick should NOT fire because panel is hidden
			act(() => {
				vi.advanceTimersByTime(5000);
			});

			expect(result.current.todoItems[0]!.elapsed).toBe(elapsedBefore);
		});

		it('resumes ticking when panel becomes visible again', () => {
			const tasks = makeTasks(['in_progress']);
			const {result} = renderHook(() => useTodoPanel({tasks, isWorking: true}));

			expect(result.current.todoItems[0]!.elapsed).toBe('0s');

			// Hide, wait, show
			act(() => {
				result.current.setTodoVisible(false);
			});
			act(() => {
				vi.advanceTimersByTime(3000);
			});
			act(() => {
				result.current.setTodoVisible(true);
			});

			// After re-showing, ticking should resume
			act(() => {
				vi.advanceTimersByTime(2000);
			});

			// Elapsed should reflect time after re-show (the 3s hidden gap
			// still counts in Date.now, so elapsed = 5s total)
			expect(result.current.todoItems[0]!.elapsed).toBe('5s');
		});
	});

	describe('auto-scroll', () => {
		it('keeps active and next pending item within visible window', () => {
			const tasks = makeTasks([
				'completed',
				'completed',
				'completed',
				'in_progress',
				'pending',
				'pending',
			]);
			const {result} = renderHook(() => useTodoPanel({tasks, isWorking: true}));

			expect(result.current.todoScroll).toBe(2);
		});

		it('scrolls to first incomplete item when no doing item exists', () => {
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

			expect(result.current.todoScroll).toBe(4);
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
});
