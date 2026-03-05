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

	it('resets selectedIndex synchronously when prefix changes', () => {
		const ref = {current: '/'};
		const {result, rerender} = renderHook(() =>
			useCommandSuggestions(ref, true),
		);
		// Navigate to index 1
		act(() => result.current.moveDown());
		expect(result.current.selectedIndex).toBe(1);

		// Change the ref prefix and rerender — should reset to 0 synchronously
		// (no useEffect cascade needed)
		ref.current = '/cl';
		rerender();
		expect(result.current.selectedIndex).toBe(0);
	});

	it('reads from ref (not reactive state) to avoid re-render cascades', () => {
		const ref = {current: '/'};
		const {result, rerender} = renderHook(() =>
			useCommandSuggestions(ref, true),
		);
		expect(result.current.filteredCommands.length).toBe(3);

		// Mutate ref and rerender — should pick up the new value
		ref.current = '/q';
		rerender();
		expect(result.current.filteredCommands.map(c => c.name)).toEqual(['quit']);
	});
});
