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
		const {result} = renderHook(() => useCommandSuggestions('/', true));
		expect(result.current.showSuggestions).toBe(true);
		expect(result.current.filteredCommands.length).toBe(3);
	});

	it('filters by prefix', () => {
		const {result} = renderHook(() => useCommandSuggestions('/cl', true));
		expect(result.current.filteredCommands.map(c => c.name)).toEqual([
			'clear',
		]);
	});

	it('hides when not active', () => {
		const {result} = renderHook(() => useCommandSuggestions('/', false));
		expect(result.current.showSuggestions).toBe(false);
	});

	it('navigates with moveUp/moveDown', () => {
		const {result} = renderHook(() => useCommandSuggestions('/', true));
		act(() => result.current.moveDown());
		expect(result.current.selectedIndex).toBe(1);
		act(() => result.current.moveUp());
		expect(result.current.selectedIndex).toBe(0);
	});

	it('wraps around at boundaries', () => {
		const {result} = renderHook(() => useCommandSuggestions('/', true));
		act(() => result.current.moveUp());
		expect(result.current.selectedIndex).toBe(2); // wraps to last
	});
});
