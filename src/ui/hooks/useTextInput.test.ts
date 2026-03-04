/**
 * @vitest-environment jsdom
 */
import React from 'react';
import {describe, it, expect, vi} from 'vitest';
import {renderHook, act} from '@testing-library/react';
import {render} from 'ink-testing-library';
import {Text} from 'ink';
import {
	textInputReducer,
	useTextInput,
	type TextInputState,
} from './useTextInput';

describe('textInputReducer', () => {
	const initial: TextInputState = {value: '', cursorOffset: 0};

	describe('insert', () => {
		it('inserts character at cursor position', () => {
			const state = {value: 'hllo', cursorOffset: 1};
			const result = textInputReducer(state, {type: 'insert', char: 'e'});
			expect(result).toEqual({value: 'hello', cursorOffset: 2});
		});

		it('inserts at the beginning', () => {
			const result = textInputReducer(
				{value: 'ello', cursorOffset: 0},
				{type: 'insert', char: 'h'},
			);
			expect(result).toEqual({value: 'hello', cursorOffset: 1});
		});

		it('inserts at the end', () => {
			const result = textInputReducer(
				{value: 'hell', cursorOffset: 4},
				{type: 'insert', char: 'o'},
			);
			expect(result).toEqual({value: 'hello', cursorOffset: 5});
		});

		it('inserts into empty string', () => {
			const result = textInputReducer(initial, {type: 'insert', char: 'a'});
			expect(result).toEqual({value: 'a', cursorOffset: 1});
		});
	});

	describe('backspace', () => {
		it('deletes character before cursor', () => {
			const state = {value: 'hello', cursorOffset: 3};
			const result = textInputReducer(state, {type: 'backspace'});
			expect(result).toEqual({value: 'helo', cursorOffset: 2});
		});

		it('no-ops at beginning of string', () => {
			const state = {value: 'hello', cursorOffset: 0};
			const result = textInputReducer(state, {type: 'backspace'});
			expect(result).toBe(state);
		});

		it('deletes last character when cursor at end', () => {
			const state = {value: 'abc', cursorOffset: 3};
			const result = textInputReducer(state, {type: 'backspace'});
			expect(result).toEqual({value: 'ab', cursorOffset: 2});
		});
	});

	describe('delete-forward', () => {
		it('deletes character at cursor position', () => {
			const state = {value: 'hello', cursorOffset: 1};
			const result = textInputReducer(state, {type: 'delete-forward'});
			expect(result).toEqual({value: 'hllo', cursorOffset: 1});
		});

		it('no-ops at end of string', () => {
			const state = {value: 'hello', cursorOffset: 5};
			const result = textInputReducer(state, {type: 'delete-forward'});
			expect(result).toBe(state);
		});

		it('deletes first character when cursor at start', () => {
			const state = {value: 'abc', cursorOffset: 0};
			const result = textInputReducer(state, {type: 'delete-forward'});
			expect(result).toEqual({value: 'bc', cursorOffset: 0});
		});
	});

	describe('cursor movement', () => {
		it('move-left decrements cursor', () => {
			const state = {value: 'hello', cursorOffset: 3};
			const result = textInputReducer(state, {type: 'move-left'});
			expect(result.cursorOffset).toBe(2);
		});

		it('move-left no-ops at 0', () => {
			const state = {value: 'hello', cursorOffset: 0};
			const result = textInputReducer(state, {type: 'move-left'});
			expect(result).toBe(state);
		});

		it('move-right increments cursor', () => {
			const state = {value: 'hello', cursorOffset: 2};
			const result = textInputReducer(state, {type: 'move-right'});
			expect(result.cursorOffset).toBe(3);
		});

		it('move-right no-ops at end', () => {
			const state = {value: 'hello', cursorOffset: 5};
			const result = textInputReducer(state, {type: 'move-right'});
			expect(result).toBe(state);
		});

		it('move-home sets cursor to 0', () => {
			const state = {value: 'hello', cursorOffset: 3};
			const result = textInputReducer(state, {type: 'move-home'});
			expect(result.cursorOffset).toBe(0);
		});

		it('move-home no-ops at 0', () => {
			const state = {value: 'hello', cursorOffset: 0};
			const result = textInputReducer(state, {type: 'move-home'});
			expect(result).toBe(state);
		});

		it('move-end sets cursor to end', () => {
			const state = {value: 'hello', cursorOffset: 2};
			const result = textInputReducer(state, {type: 'move-end'});
			expect(result.cursorOffset).toBe(5);
		});

		it('move-end no-ops at end', () => {
			const state = {value: 'hello', cursorOffset: 5};
			const result = textInputReducer(state, {type: 'move-end'});
			expect(result).toBe(state);
		});
	});

	describe('delete-word-back', () => {
		it('deletes back to previous word boundary', () => {
			const state = {value: 'hello world', cursorOffset: 11};
			const result = textInputReducer(state, {type: 'delete-word-back'});
			expect(result).toEqual({value: 'hello ', cursorOffset: 6});
		});

		it('skips trailing spaces then deletes word', () => {
			const state = {value: 'hello  world', cursorOffset: 7};
			const result = textInputReducer(state, {type: 'delete-word-back'});
			expect(result).toEqual({value: 'world', cursorOffset: 0});
		});

		it('deletes entire single word', () => {
			const state = {value: 'hello', cursorOffset: 5};
			const result = textInputReducer(state, {type: 'delete-word-back'});
			expect(result).toEqual({value: '', cursorOffset: 0});
		});

		it('no-ops at beginning', () => {
			const state = {value: 'hello', cursorOffset: 0};
			const result = textInputReducer(state, {type: 'delete-word-back'});
			expect(result).toBe(state);
		});
	});

	describe('clear-line', () => {
		it('clears everything before cursor', () => {
			const state = {value: 'hello world', cursorOffset: 6};
			const result = textInputReducer(state, {type: 'clear-line'});
			expect(result).toEqual({value: 'world', cursorOffset: 0});
		});

		it('clears entire value when cursor at end', () => {
			const state = {value: 'hello', cursorOffset: 5};
			const result = textInputReducer(state, {type: 'clear-line'});
			expect(result).toEqual({value: '', cursorOffset: 0});
		});

		it('no-ops when cursor at beginning', () => {
			const state = {value: 'hello', cursorOffset: 0};
			const result = textInputReducer(state, {type: 'clear-line'});
			expect(result).toBe(state);
		});
	});

	describe('newline-escape', () => {
		it('replaces trailing backslash with newline', () => {
			const state = {value: 'hello\\', cursorOffset: 6};
			const result = textInputReducer(state, {type: 'newline-escape'});
			expect(result).toEqual({value: 'hello\n', cursorOffset: 6});
		});

		it('works mid-string when cursor follows a backslash', () => {
			const state = {value: 'ab\\cd', cursorOffset: 3};
			const result = textInputReducer(state, {type: 'newline-escape'});
			expect(result).toEqual({value: 'ab\ncd', cursorOffset: 3});
		});

		it('no-ops when cursor is at position 0', () => {
			const state = {value: '\\hello', cursorOffset: 0};
			const result = textInputReducer(state, {type: 'newline-escape'});
			expect(result).toBe(state);
		});

		it('no-ops when character before cursor is not backslash', () => {
			const state = {value: 'hello', cursorOffset: 5};
			const result = textInputReducer(state, {type: 'newline-escape'});
			expect(result).toBe(state);
		});
	});

	describe('move-up', () => {
		it('moves cursor to equivalent column on previous visual line', () => {
			// "abcdefghij" at width 5 wraps to: ["abcde", "fghij"]
			// cursor at offset 7 = line 1, col 2 → move up → line 0, col 2 = offset 2
			const state = {value: 'abcdefghij', cursorOffset: 7};
			const result = textInputReducer(state, {type: 'move-up', width: 5});
			expect(result.cursorOffset).toBe(2);
		});

		it('no-ops when already on first visual line', () => {
			const state = {value: 'abcdefghij', cursorOffset: 2};
			const result = textInputReducer(state, {type: 'move-up', width: 5});
			expect(result).toBe(state);
		});

		it('clamps column when target line is shorter', () => {
			// "abcdefgh" at width 5 wraps to: ["abcde", "fgh"]
			// cursor at offset 8 (line 1, col 3=end of "fgh") → move up → line 0, col 3
			const state = {value: 'abcdefgh', cursorOffset: 8};
			const result = textInputReducer(state, {type: 'move-up', width: 5});
			expect(result.cursorOffset).toBe(3);
		});

		it('no-ops on single-line text', () => {
			const state = {value: 'hello', cursorOffset: 3};
			const result = textInputReducer(state, {type: 'move-up', width: 20});
			expect(result).toBe(state);
		});

		it('works across newline boundaries', () => {
			// "abc\ndef" at width 20 → visual lines ["abc", "def"]
			// cursor at offset 5 ('e', line 1 col 1) → move up → line 0, col 1 = offset 1
			const state = {value: 'abc\ndef', cursorOffset: 5};
			const result = textInputReducer(state, {type: 'move-up', width: 20});
			expect(result.cursorOffset).toBe(1);
		});
	});

	describe('move-down', () => {
		it('moves cursor to equivalent column on next visual line', () => {
			// "abcdefghij" at width 5 → ["abcde", "fghij"]
			// cursor at offset 2 = line 0, col 2 → move down → line 1, col 2 = offset 7
			const state = {value: 'abcdefghij', cursorOffset: 2};
			const result = textInputReducer(state, {type: 'move-down', width: 5});
			expect(result.cursorOffset).toBe(7);
		});

		it('no-ops when already on last visual line', () => {
			const state = {value: 'abcdefghij', cursorOffset: 7};
			const result = textInputReducer(state, {type: 'move-down', width: 5});
			expect(result).toBe(state);
		});

		it('clamps column when target line is shorter', () => {
			// "abcdefgh" at width 5 → ["abcde", "fgh"]
			// cursor at offset 4 (line 0, col 4) → move down → line 1 has 3 chars → col 3 → offset 8
			const state = {value: 'abcdefgh', cursorOffset: 4};
			const result = textInputReducer(state, {type: 'move-down', width: 5});
			expect(result.cursorOffset).toBe(8);
		});

		it('no-ops on single-line text', () => {
			const state = {value: 'hello', cursorOffset: 3};
			const result = textInputReducer(state, {type: 'move-down', width: 20});
			expect(result).toBe(state);
		});

		it('works with three visual lines from wrapping', () => {
			// "abcdefghijklmno" at width 5 → ["abcde", "fghij", "klmno"]
			// cursor at offset 2 (line 0, col 2) → move down → line 1, col 2 = offset 7
			const state = {value: 'abcdefghijklmno', cursorOffset: 2};
			const result = textInputReducer(state, {type: 'move-down', width: 5});
			expect(result.cursorOffset).toBe(7);
		});

		it('works across newline boundaries', () => {
			// "abc\ndef" at width 20 → visual lines ["abc", "def"]
			// cursor at offset 1 ('b', line 0 col 1) → move down → line 1, col 1 = offset 5
			const state = {value: 'abc\ndef', cursorOffset: 1};
			const result = textInputReducer(state, {type: 'move-down', width: 20});
			expect(result.cursorOffset).toBe(5);
		});
	});

	describe('set-value', () => {
		it('replaces value and moves cursor to end', () => {
			const state = {value: 'old', cursorOffset: 1};
			const result = textInputReducer(state, {
				type: 'set-value',
				value: 'new value',
			});
			expect(result).toEqual({value: 'new value', cursorOffset: 9});
		});

		it('handles empty string', () => {
			const state = {value: 'hello', cursorOffset: 3};
			const result = textInputReducer(state, {type: 'set-value', value: ''});
			expect(result).toEqual({value: '', cursorOffset: 0});
		});

		it('returns same reference when value unchanged and cursor at end', () => {
			const state = {value: 'hello', cursorOffset: 5};
			const result = textInputReducer(state, {
				type: 'set-value',
				value: 'hello',
			});
			expect(result).toBe(state);
		});

		it('returns new state when same value but cursor not at end', () => {
			const state = {value: 'hello', cursorOffset: 2};
			const result = textInputReducer(state, {
				type: 'set-value',
				value: 'hello',
			});
			expect(result).toEqual({value: 'hello', cursorOffset: 5});
			expect(result).not.toBe(state);
		});
	});
});

describe('useTextInput', () => {
	it('starts with empty value', () => {
		const {result} = renderHook(() => useTextInput());
		expect(result.current.value).toBe('');
		expect(result.current.cursorOffset).toBe(0);
	});

	it('setValue updates value and moves cursor to end', () => {
		const onChange = vi.fn();
		const {result} = renderHook(() => useTextInput({onChange}));

		act(() => {
			result.current.setValue('hello');
		});

		expect(result.current.value).toBe('hello');
		expect(result.current.cursorOffset).toBe(5);
		expect(onChange).toHaveBeenCalledWith('hello');
	});

	it('setValue to empty clears the input', () => {
		const {result} = renderHook(() => useTextInput());

		act(() => {
			result.current.setValue('hello');
		});
		expect(result.current.value).toBe('hello');

		act(() => {
			result.current.setValue('');
		});
		expect(result.current.value).toBe('');
		expect(result.current.cursorOffset).toBe(0);
	});
});

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function TextInputTestHarness(props: {
	onChange?: (value: string) => void;
	onSubmit?: (value: string) => void;
	isActive?: boolean;
}) {
	const {value} = useTextInput(props);
	return React.createElement(Text, null, `[${value}]`);
}

describe('useInput keyboard handler', () => {
	it('onSubmit is called with accumulated value on Enter', async () => {
		const onSubmit = vi.fn();
		const {stdin} = render(
			React.createElement(TextInputTestHarness, {onSubmit}),
		);

		stdin.write('hello');
		await delay(50);
		stdin.write('\r');
		await delay(50);

		expect(onSubmit).toHaveBeenCalledWith('hello');
	});

	it('onChange fires on typing but not on mount', async () => {
		const onChange = vi.fn();
		const {stdin} = render(
			React.createElement(TextInputTestHarness, {onChange}),
		);

		// onChange should NOT have been called on mount
		expect(onChange).not.toHaveBeenCalled();

		stdin.write('a');
		await delay(50);

		expect(onChange).toHaveBeenCalledWith('a');
	});

	it('isActive false prevents input', async () => {
		const {lastFrame, stdin} = render(
			React.createElement(TextInputTestHarness, {isActive: false}),
		);

		stdin.write('hello');
		await delay(50);

		const frame = lastFrame() ?? '';
		expect(frame).toContain('[]');
	});

	it('backspace deletes character before cursor, not at cursor', async () => {
		const onChange = vi.fn();
		const {lastFrame, stdin} = render(
			React.createElement(TextInputTestHarness, {onChange}),
		);

		// Type "abc" → cursor at 3
		stdin.write('abc');
		await delay(50);
		expect(lastFrame()).toContain('[abc]');

		// Move cursor left once → cursor at 2 (visually on 'c')
		stdin.write('\x1b[D'); // left arrow
		await delay(50);

		// Press backspace → should delete 'b' (before cursor), NOT 'c' (at cursor)
		stdin.write('\x7f'); // backspace
		await delay(50);

		// Result should be "ac" (b deleted), not "ab" (c deleted)
		expect(lastFrame()).toContain('[ac]');
	});

	it('Delete key deletes character at cursor (forward delete)', async () => {
		const {lastFrame, stdin} = render(
			React.createElement(TextInputTestHarness),
		);

		// Type "abc" → cursor at 3
		stdin.write('abc');
		await delay(50);
		expect(lastFrame()).toContain('[abc]');

		// Move cursor left once → cursor at 2 (on 'c')
		stdin.write('\x1b[D'); // left arrow
		await delay(50);

		// Press Delete key → should delete 'c' (at cursor), not 'b' (before cursor)
		stdin.write('\x1b[3~'); // forward delete
		await delay(50);

		expect(lastFrame()).toContain('[ab]');
	});

	it('backslash + Enter inserts newline instead of submitting', async () => {
		const onSubmit = vi.fn();
		const {lastFrame, stdin} = render(
			React.createElement(TextInputTestHarness, {onSubmit}),
		);

		stdin.write('hello\\');
		await delay(50);
		stdin.write('\r');
		await delay(50);

		expect(onSubmit).not.toHaveBeenCalled();
		expect(lastFrame()).toContain('[hello\n]');
	});

	it('plain Enter still submits', async () => {
		const onSubmit = vi.fn();
		const {stdin} = render(
			React.createElement(TextInputTestHarness, {onSubmit}),
		);

		stdin.write('hello');
		await delay(50);
		stdin.write('\r');
		await delay(50);

		expect(onSubmit).toHaveBeenCalledWith('hello');
	});

	it('double backslash + Enter inserts newline (shell-like behavior)', async () => {
		const onSubmit = vi.fn();
		const {lastFrame, stdin} = render(
			React.createElement(TextInputTestHarness, {onSubmit}),
		);

		stdin.write('hello\\\\');
		await delay(50);
		stdin.write('\r');
		await delay(50);

		// The second \ is before cursor, so it gets replaced with \n
		expect(onSubmit).not.toHaveBeenCalled();
		expect(lastFrame()).toContain('[hello\\\n]');
	});

	it('ignored keys do not modify value', async () => {
		const {lastFrame, stdin} = render(
			React.createElement(TextInputTestHarness),
		);

		stdin.write('abc');
		await delay(50);

		// up arrow
		stdin.write('\x1b[A');
		await delay(50);
		// down arrow
		stdin.write('\x1b[B');
		await delay(50);
		// tab
		stdin.write('\t');
		await delay(50);
		// escape
		stdin.write('\x1b');
		await delay(50);

		const frame = lastFrame() ?? '';
		expect(frame).toContain('[abc]');
	});
});
