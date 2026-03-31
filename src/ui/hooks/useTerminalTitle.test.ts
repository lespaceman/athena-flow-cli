/**
 * @vitest-environment jsdom
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {renderHook} from '@testing-library/react';

// Capture stdout.write calls via the Ink useStdout mock.
const mockWrite = vi.fn();
const mockStdout = {write: mockWrite};

vi.mock('ink', () => ({
	useStdout: () => ({stdout: mockStdout}),
}));

// Import after mock is in place.
const {useTerminalTitle} = await import('./useTerminalTitle');

/** Build the expected OSC 1 + OSC 2 escape sequence for a given title. */
function osc(title: string): string {
	return `\x1b]1;${title}\x07\x1b]2;${title}\x07`;
}

describe('useTerminalTitle', () => {
	beforeEach(() => {
		mockWrite.mockClear();
	});

	it('sets base title when no workflow name is provided', () => {
		renderHook(() => useTerminalTitle(undefined, false));
		expect(mockWrite).toHaveBeenCalledWith(osc('Athena'));
	});

	it('includes workflow name in title', () => {
		renderHook(() => useTerminalTitle('code-review', false));
		expect(mockWrite).toHaveBeenCalledWith(osc('Athena - code-review'));
	});

	it('prefixes * when harness is running', () => {
		renderHook(() => useTerminalTitle('code-review', true));
		expect(mockWrite).toHaveBeenCalledWith(osc('* Athena - code-review'));
	});

	it('clears * prefix when harness stops', () => {
		const {rerender} = renderHook(
			({running}) => useTerminalTitle('code-review', running),
			{initialProps: {running: true}},
		);
		mockWrite.mockClear();
		rerender({running: false});
		expect(mockWrite).toHaveBeenCalledWith(osc('Athena - code-review'));
	});

	it('does not write when title has not changed', () => {
		const {rerender} = renderHook(
			({name, running}) => useTerminalTitle(name, running),
			{
				initialProps: {
					name: 'my-workflow' as string | undefined,
					running: false,
				},
			},
		);
		mockWrite.mockClear();
		// Re-render with identical values — should skip the write.
		rerender({name: 'my-workflow', running: false});
		expect(mockWrite).not.toHaveBeenCalled();
	});

	it('restores empty title on unmount', () => {
		const {unmount} = renderHook(() => useTerminalTitle(undefined, false));
		mockWrite.mockClear();
		unmount();
		expect(mockWrite).toHaveBeenCalledWith(osc(''));
	});
});
