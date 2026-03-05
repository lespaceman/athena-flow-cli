/**
 * @vitest-environment jsdom
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {useCommandSuggestions} from './useCommandSuggestions';
import * as registry from '../../app/commands/registry';

beforeEach(() => {
	registry.clear();
	registry.register({
		name: 'clear',
		description: 'Clear screen',
		category: 'ui',
		execute: () => {},
	});
	registry.register({
		name: 'quit',
		description: 'Quit',
		category: 'ui',
		aliases: ['q'],
		execute: () => {},
	});
	registry.register({
		name: 'help',
		description: 'Show help',
		category: 'ui',
		execute: () => {},
	});
});

describe('useCommandSuggestions', () => {
	it('shows all commands for bare /', () => {
		const ref = {current: '/'};
		const {result} = renderHook(() => useCommandSuggestions(ref, true));
		expect(result.current.showSuggestions).toBe(true);
		expect(result.current.filteredCommands.length).toBe(3);
	});

	it('filters by prefix', () => {
		const ref = {current: '/cl'};
		const {result} = renderHook(() => useCommandSuggestions(ref, true));
		expect(result.current.filteredCommands.map(c => c.name)).toEqual(['clear']);
	});

	it('hides when not active', () => {
		const ref = {current: '/'};
		const {result} = renderHook(() => useCommandSuggestions(ref, false));
		expect(result.current.showSuggestions).toBe(false);
	});

	it('navigates with moveUp/moveDown', () => {
		const ref = {current: '/'};
		const {result} = renderHook(() => useCommandSuggestions(ref, true));
		act(() => result.current.moveDown());
		expect(result.current.selectedIndex).toBe(1);
		act(() => result.current.moveUp());
		expect(result.current.selectedIndex).toBe(0);
	});

	it('wraps around at boundaries', () => {
		const ref = {current: '/'};
		const {result} = renderHook(() => useCommandSuggestions(ref, true));
		act(() => result.current.moveUp());
		expect(result.current.selectedIndex).toBe(2); // wraps to last
	});

	it('resets selectedIndex when prefix changes on re-render', () => {
		const ref = {current: '/'};
		const {result, rerender} = renderHook(() =>
			useCommandSuggestions(ref, true),
		);
		// Navigate to index 1
		act(() => result.current.moveDown());
		expect(result.current.selectedIndex).toBe(1);

		// Simulate typing — ref changes, parent re-renders (via filterTick in production)
		ref.current = '/cl';
		rerender();
		expect(result.current.selectedIndex).toBe(0);
	});

	it('re-filters when notifyInputChanged is called after ref update', () => {
		const ref = {current: '/'};
		const {result} = renderHook(() => useCommandSuggestions(ref, true));
		expect(result.current.filteredCommands.length).toBe(3);

		// Simulate typing '/q' — ref updated + notifyInputChanged (as AppShell does)
		ref.current = '/q';
		act(() => result.current.notifyInputChanged());
		expect(result.current.filteredCommands.map(c => c.name)).toEqual(['quit']);
	});

	it('notifyInputChanged is a no-op when not in command mode', () => {
		const ref = {current: 'hello'};
		const {result} = renderHook(() => useCommandSuggestions(ref, true));
		// Not in command mode — notifyInputChanged should not trigger re-filter
		expect(result.current.filteredCommands.length).toBe(0);
		act(() => result.current.notifyInputChanged());
		expect(result.current.filteredCommands.length).toBe(0);
	});

	it('rerender alone without notifyInputChanged still re-reads ref', () => {
		const ref = {current: '/'};
		const {result, rerender} = renderHook(() =>
			useCommandSuggestions(ref, true),
		);
		expect(result.current.filteredCommands.length).toBe(3);

		// Parent re-render (e.g. unrelated state change) also picks up ref
		ref.current = '/q';
		rerender();
		expect(result.current.filteredCommands.map(c => c.name)).toEqual(['quit']);
	});
});
