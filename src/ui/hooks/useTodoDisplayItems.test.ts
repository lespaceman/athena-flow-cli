/** @vitest-environment jsdom */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, renderHook} from '@testing-library/react';
import {
	buildTodoDisplayItems,
	useTodoDisplayItems,
} from './useTodoDisplayItems';
import {type TodoPanelItem} from '../../core/feed/todoPanel';

describe('buildTodoDisplayItems', () => {
	it('freezes doing items at pausedAtMs while idle', () => {
		const items: TodoPanelItem[] = [
			{
				id: '1',
				text: 'Task 1',
				priority: 'P1',
				status: 'doing',
				startedAtMs: 1000,
			},
		];

		const result = buildTodoDisplayItems(items, 9000, false, 6000);

		expect(result[0]!.elapsed).toBe('5s');
	});
});

describe('useTodoDisplayItems', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2024-01-15T10:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('ticks once per second when active with doing items', () => {
		const startedAtMs = Date.now();
		const items: TodoPanelItem[] = [
			{
				id: '1',
				text: 'Task 1',
				priority: 'P1',
				status: 'doing',
				startedAtMs,
			},
		];
		const {result} = renderHook(() =>
			useTodoDisplayItems({
				items,
				isWorking: true,
				pausedAtMs: null,
				active: true,
			}),
		);

		expect(result.current[0]!.elapsed).toBe('0s');

		act(() => {
			vi.advanceTimersByTime(3000);
		});

		expect(result.current[0]!.elapsed).toBe('3s');
	});

	it('does not tick when inactive', () => {
		const startedAtMs = Date.now();
		const items: TodoPanelItem[] = [
			{
				id: '1',
				text: 'Task 1',
				priority: 'P1',
				status: 'doing',
				startedAtMs,
			},
		];
		const {result} = renderHook(() =>
			useTodoDisplayItems({
				items,
				isWorking: true,
				pausedAtMs: null,
				active: false,
			}),
		);

		act(() => {
			vi.advanceTimersByTime(3000);
		});

		expect(result.current[0]!.elapsed).toBe('0s');
	});
});
