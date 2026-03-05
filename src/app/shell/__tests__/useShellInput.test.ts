/** @vitest-environment jsdom */
import {describe, it, expect, vi} from 'vitest';
import {renderHook, act} from '@testing-library/react';

// Mock parseInput — return 'command' for /clear, 'prompt' for everything else
vi.mock('../../commands/parser', () => ({
	parseInput: (input: string) => {
		if (input === '/clear') {
			return {
				type: 'command',
				name: 'clear',
				rawArgs: '',
				args: {},
				command: {name: 'clear', description: '', handler: vi.fn()},
			};
		}
		return {type: 'prompt', text: input};
	},
}));

import {useShellInput, type UseShellInputOptions} from '../useShellInput';

function makeOptions(
	overrides: Partial<UseShellInputOptions> = {},
): UseShellInputOptions {
	return {
		inputMode: 'normal' as const,
		setInputMode: vi.fn(),
		setFocusMode: vi.fn(),
		setSearchQuery: vi.fn(),
		submitPromptOrSlashCommand: vi.fn(),
		filteredEntriesRef: {current: []},
		staticHwmRef: {current: 0},
		setFeedCursorRef: {current: vi.fn()},
		setTailFollowRef: {current: vi.fn()},
		setSearchMatchPos: vi.fn(),
		...overrides,
	};
}

describe('useShellInput', () => {
	it('starts with inputRows=1', () => {
		const opts = makeOptions();
		const {result} = renderHook(() => useShellInput(opts));
		expect(result.current.inputRows).toBe(1);
	});

	it('empty submit resets state without routing', () => {
		const submitSpy = vi.fn();
		const setInputMode = vi.fn();
		const setFocusMode = vi.fn();
		const opts = makeOptions({
			submitPromptOrSlashCommand: submitSpy,
			setInputMode,
			setFocusMode,
		});
		const {result} = renderHook(() => useShellInput(opts));
		act(() => {
			result.current.handleInputSubmit('   ');
		});
		expect(submitSpy).not.toHaveBeenCalled();
		expect(setInputMode).toHaveBeenCalledWith('normal');
		expect(setFocusMode).toHaveBeenCalledWith('feed');
	});

	it('slash command routes to submitPromptOrSlashCommand', () => {
		const submitSpy = vi.fn();
		const opts = makeOptions({submitPromptOrSlashCommand: submitSpy});
		const {result} = renderHook(() => useShellInput(opts));
		act(() => {
			result.current.handleInputSubmit('/clear');
		});
		expect(submitSpy).toHaveBeenCalledWith('/clear');
	});

	it('plain text routes to submitPromptOrSlashCommand', () => {
		const submitSpy = vi.fn();
		const opts = makeOptions({submitPromptOrSlashCommand: submitSpy});
		const {result} = renderHook(() => useShellInput(opts));
		act(() => {
			result.current.handleInputSubmit('hello world');
		});
		expect(submitSpy).toHaveBeenCalledWith('hello world');
	});

	it('search query routes to setSearchQuery and feedNav', () => {
		const setSearchQuery = vi.fn();
		const setFeedCursor = vi.fn();
		const setTailFollow = vi.fn();
		const setSearchMatchPos = vi.fn();
		const entries = [
			{searchText: 'foo bar', id: 'e1'},
			{searchText: 'baz qux', id: 'e2'},
		] as never[];
		const opts = makeOptions({
			inputMode: 'search',
			setSearchQuery,
			setFeedCursorRef: {current: setFeedCursor},
			setTailFollowRef: {current: setTailFollow},
			filteredEntriesRef: {current: entries},
			setSearchMatchPos,
		});
		const {result} = renderHook(() => useShellInput(opts));
		act(() => {
			result.current.handleInputSubmit(':baz');
		});
		expect(setSearchQuery).toHaveBeenCalledWith('baz');
		expect(setFeedCursor).toHaveBeenCalledWith(1);
		expect(setTailFollow).toHaveBeenCalledWith(false);
		expect(setSearchMatchPos).toHaveBeenCalledWith(0);
	});

	it('handleMainInputChange updates inputValueRef', () => {
		const opts = makeOptions();
		const {result} = renderHook(() => useShellInput(opts));
		act(() => {
			result.current.handleMainInputChange('test value');
		});
		expect(result.current.inputValueRef.current).toBe('test value');
	});

	it('handleMainInputChange triggers setInputMode for search prefix', () => {
		const setInputMode = vi.fn();
		const opts = makeOptions({setInputMode});
		const {result} = renderHook(() => useShellInput(opts));
		act(() => {
			result.current.handleMainInputChange('/search term');
		});
		// setInputMode should be called with functional updater
		expect(setInputMode).toHaveBeenCalled();
	});

	it('does not expose inputValue state — only inputValueRef', () => {
		const opts = makeOptions();
		const {result} = renderHook(() => useShellInput(opts));
		// inputValue as reactive state causes unnecessary re-renders;
		// the ref is sufficient for consumers
		expect(result.current).not.toHaveProperty('inputValue');
		expect(result.current).toHaveProperty('inputValueRef');
	});

	it('does not expose filterTick — suggestion state belongs in useCommandSuggestions to avoid flickering', () => {
		const opts = makeOptions();
		const {result} = renderHook(() => useShellInput(opts));
		expect(result.current).not.toHaveProperty('filterTick');
	});

	it('command mode submit uses getSelectedCommand when no exact match', () => {
		const submitSpy = vi.fn();
		const getSelectedCommand = vi.fn().mockReturnValue({name: 'help'});
		const opts = makeOptions({
			inputMode: 'command',
			submitPromptOrSlashCommand: submitSpy,
			getSelectedCommand,
		});
		const {result} = renderHook(() => useShellInput(opts));
		act(() => {
			result.current.handleInputSubmit('/he');
		});
		expect(getSelectedCommand).toHaveBeenCalled();
		expect(submitSpy).toHaveBeenCalledWith('/help');
	});
});
