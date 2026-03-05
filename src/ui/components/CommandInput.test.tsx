import React from 'react';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {render} from 'ink-testing-library';
import CommandInput from './CommandInput';
import * as registryModule from '../../app/commands/registry';

// ANSI escape sequences for special keys
const KEY = {
	UP: '\x1b[A',
	DOWN: '\x1b[B',
	LEFT: '\x1b[D',
	ESCAPE: '\x1b',
	TAB: '\t',
	ENTER: '\r',
	DELETE: '\x1b[3~',
} as const;

const noop = () => {};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Write to stdin and wait for React to process the update. */
async function typeAndWait(
	stdin: {write: (data: string) => void},
	text: string,
	ms = 50,
): Promise<void> {
	stdin.write(text);
	await delay(ms);
}

/** Get the current frame, defaulting to empty string if null. */
function frame(lastFrame: () => string | undefined): string {
	return lastFrame() ?? '';
}

/** Find the line containing `text` and assert it includes `marker`. */
function expectLineContaining(
	output: string,
	text: string,
	marker: string,
): void {
	const line = output.split('\n').find(l => l.includes(text));
	expect(line).toContain(marker);
}

async function waitForLineContainingMarker(
	lastFrame: () => string | undefined,
	text: string,
	marker: string,
	timeoutMs = 500,
): Promise<void> {
	const intervalMs = 25;
	for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
		const output = frame(lastFrame);
		const line = output.split('\n').find(l => l.includes(text));
		if (line?.includes(marker)) {
			return;
		}
		await delay(intervalMs);
	}
	throw new Error(
		`Timed out waiting for line containing "${text}" to include marker "${marker}"`,
	);
}

beforeEach(() => {
	registryModule.clear();
	registryModule.register({
		name: 'help',
		description: 'Show help',
		category: 'ui',
		execute: noop,
	});
	registryModule.register({
		name: 'clear',
		description: 'Clear screen',
		category: 'ui',
		execute: noop,
	});
	registryModule.register({
		name: 'commit',
		description: 'Commit changes',
		category: 'prompt',
		session: 'new',
		buildPrompt: () => 'commit',
	});
});

afterEach(() => {
	registryModule.clear();
});

describe('CommandInput', () => {
	it('renders placeholder text', () => {
		const {lastFrame} = render(<CommandInput onSubmit={noop} />);
		expect(frame(lastFrame)).toContain('Type a message or /command...');
	});

	it('does not show suggestions when input is empty', () => {
		const {lastFrame} = render(<CommandInput onSubmit={noop} />);
		const output = frame(lastFrame);
		expect(output).not.toContain('/help');
		expect(output).not.toContain('/clear');
	});

	it('shows suggestions when / is typed', async () => {
		const {lastFrame, stdin} = render(<CommandInput onSubmit={noop} />);

		await typeAndWait(stdin, '/');

		const output = frame(lastFrame);
		expect(output).toContain('/help');
		expect(output).toContain('/clear');
		expect(output).toContain('/commit');
	});

	it('filters suggestions by prefix', async () => {
		const {lastFrame, stdin} = render(<CommandInput onSubmit={noop} />);

		await typeAndWait(stdin, '/c');

		const output = frame(lastFrame);
		expect(output).toContain('/clear');
		expect(output).toContain('/commit');
		expect(output).not.toContain('/help');
	});

	it('hides suggestions after space is typed', async () => {
		const {lastFrame, stdin} = render(<CommandInput onSubmit={noop} />);

		await typeAndWait(stdin, '/help ');

		expect(frame(lastFrame)).not.toContain('Show help');
	});

	it('navigates suggestions with down arrow', async () => {
		const {lastFrame, stdin} = render(<CommandInput onSubmit={noop} />);

		await typeAndWait(stdin, '/');
		await waitForLineContainingMarker(lastFrame, '/help', '>');

		await typeAndWait(stdin, KEY.DOWN, 100);
		await waitForLineContainingMarker(lastFrame, '/clear', '>');
	});

	it('wraps around when navigating past last suggestion', async () => {
		const {lastFrame, stdin} = render(<CommandInput onSubmit={noop} />);

		await typeAndWait(stdin, '/');

		// Press down 3 times (3 commands total) to wrap back to first
		await typeAndWait(stdin, KEY.DOWN, 20);
		await typeAndWait(stdin, KEY.DOWN, 20);
		await typeAndWait(stdin, KEY.DOWN);

		expectLineContaining(frame(lastFrame), '/help', '>');
	});

	it('completes selected command on tab', async () => {
		const {lastFrame, stdin} = render(<CommandInput onSubmit={noop} />);

		await typeAndWait(stdin, '/');
		await typeAndWait(stdin, KEY.DOWN);
		await typeAndWait(stdin, KEY.TAB);

		expect(frame(lastFrame)).toContain('/clear');
	});

	it('calls onSubmit when Enter is pressed', async () => {
		const onSubmit = vi.fn();
		const {stdin} = render(<CommandInput onSubmit={onSubmit} />);

		await typeAndWait(stdin, 'hello world');
		await typeAndWait(stdin, KEY.ENTER);

		expect(onSubmit).toHaveBeenCalledWith('hello world');
	});

	it('clears input after submit', async () => {
		const onSubmit = vi.fn();
		const {lastFrame, stdin} = render(<CommandInput onSubmit={onSubmit} />);

		await typeAndWait(stdin, 'hello');
		await typeAndWait(stdin, KEY.ENTER);

		expect(onSubmit).toHaveBeenCalledWith('hello');

		const output = frame(lastFrame);
		expect(output).toContain('Type a message or /command...');
		expect(output).not.toContain('hello');
	});

	it('shows all commands including plugin commands when / is typed', async () => {
		for (let i = 0; i < 8; i++) {
			registryModule.register({
				name: `builtin-${i}`,
				description: `Builtin ${i}`,
				category: 'ui',
				execute: noop,
			});
		}
		registryModule.register({
			name: 'explore-website',
			description: 'Explore a site',
			category: 'prompt',
			session: 'new' as const,
			buildPrompt: () => 'explore',
		});

		const {lastFrame, stdin} = render(<CommandInput onSubmit={noop} />);

		await typeAndWait(stdin, '/');

		expect(frame(lastFrame)).toContain('/explore-website');
	});

	it('shows disabled placeholder when disabled', () => {
		const {lastFrame} = render(<CommandInput onSubmit={noop} disabled />);
		expect(lastFrame()).toContain('Waiting for permission decision');
	});

	it('calls onEscape when Escape is pressed without suggestions', async () => {
		const onEscape = vi.fn();
		const {stdin} = render(
			<CommandInput onSubmit={noop} onEscape={onEscape} />,
		);

		await typeAndWait(stdin, 'hello');
		await typeAndWait(stdin, KEY.ESCAPE);

		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it('does not call onEscape when Escape dismisses suggestions', async () => {
		const onEscape = vi.fn();
		const {lastFrame, stdin} = render(
			<CommandInput onSubmit={noop} onEscape={onEscape} />,
		);

		await typeAndWait(stdin, '/');
		expect(frame(lastFrame)).toContain('/help');

		await typeAndWait(stdin, KEY.ESCAPE);

		expect(onEscape).not.toHaveBeenCalled();
		expect(frame(lastFrame)).not.toContain('/help');
	});

	it('calls onArrowUp with current value when no suggestions', async () => {
		const onArrowUp = vi.fn().mockReturnValue('previous');
		const {lastFrame, stdin} = render(
			<CommandInput onSubmit={noop} onArrowUp={onArrowUp} />,
		);

		await typeAndWait(stdin, 'current');
		await typeAndWait(stdin, KEY.UP);

		expect(onArrowUp).toHaveBeenCalledWith('current');
		expect(frame(lastFrame)).toContain('previous');
	});

	it('calls onArrowDown when no suggestions', async () => {
		const onArrowDown = vi.fn().mockReturnValue('next');
		const {lastFrame, stdin} = render(
			<CommandInput onSubmit={noop} onArrowDown={onArrowDown} />,
		);

		await typeAndWait(stdin, KEY.DOWN);

		expect(onArrowDown).toHaveBeenCalledTimes(1);
		expect(frame(lastFrame)).toContain('next');
	});

	it('navigates suggestions with arrows when suggestions showing (not history)', async () => {
		const onArrowUp = vi.fn();
		const onArrowDown = vi.fn();
		const {lastFrame, stdin} = render(
			<CommandInput
				onSubmit={noop}
				onArrowUp={onArrowUp}
				onArrowDown={onArrowDown}
			/>,
		);

		await typeAndWait(stdin, '/');
		await typeAndWait(stdin, KEY.DOWN);

		expect(onArrowDown).not.toHaveBeenCalled();
		expectLineContaining(frame(lastFrame), '/clear', '>');
	});

	it('Delete key removes character at cursor, not before it', async () => {
		const {lastFrame, stdin} = render(<CommandInput onSubmit={noop} />);

		await typeAndWait(stdin, 'abc');
		// Move cursor left → on 'c'
		await typeAndWait(stdin, KEY.LEFT);
		// Press Delete → should remove 'c' (at cursor), leaving "ab"
		await typeAndWait(stdin, KEY.DELETE);

		expect(frame(lastFrame)).toContain('ab');
		expect(frame(lastFrame)).not.toContain('abc');
	});

	it('does not accept input when disabled', async () => {
		const onSubmit = vi.fn();
		const {lastFrame, stdin} = render(
			<CommandInput onSubmit={onSubmit} disabled />,
		);

		await typeAndWait(stdin, 'hello');
		await typeAndWait(stdin, KEY.ENTER);

		expect(onSubmit).not.toHaveBeenCalled();
		expect(lastFrame()).toContain('Waiting for permission decision');
	});

	it('dismisses suggestions on Escape', async () => {
		const {lastFrame, stdin} = render(<CommandInput onSubmit={noop} />);

		await typeAndWait(stdin, '/');
		expect(frame(lastFrame)).toContain('/help');

		await typeAndWait(stdin, KEY.ESCAPE);
		expect(frame(lastFrame)).not.toContain('/help');
	});

	it('does not show suggestions when slash command is recalled from history', async () => {
		// Simulate: onArrowUp returns a slash command from history
		const onArrowUp = vi.fn().mockReturnValue('/help');
		const {lastFrame, stdin} = render(
			<CommandInput onSubmit={noop} onArrowUp={onArrowUp} />,
		);

		// Press Up to recall "/help" from history
		await typeAndWait(stdin, KEY.UP);

		// The value should be "/help" but suggestions should NOT appear
		const output = frame(lastFrame);
		expect(output).toContain('/help');
		expect(output).not.toContain('Show help'); // suggestion description
	});

	it('continues navigating history after recalling a slash command', async () => {
		let callCount = 0;
		const onArrowUp = vi.fn().mockImplementation(() => {
			callCount++;
			return callCount === 1 ? '/help' : 'older message';
		});
		const {lastFrame, stdin} = render(
			<CommandInput onSubmit={noop} onArrowUp={onArrowUp} />,
		);

		// First Up → recalls "/help"
		await typeAndWait(stdin, KEY.UP);
		expect(frame(lastFrame)).toContain('/help');

		// Second Up → should go further back in history, not cycle suggestions
		await typeAndWait(stdin, KEY.UP);
		expect(onArrowUp).toHaveBeenCalledTimes(2);
		expect(frame(lastFrame)).toContain('older message');
	});

	it('submits selected command on Enter when suggestions are showing', async () => {
		const onSubmit = vi.fn();
		const {stdin} = render(<CommandInput onSubmit={onSubmit} />);

		// Type "/" to show suggestions, then navigate to "clear"
		await typeAndWait(stdin, '/');
		await typeAndWait(stdin, KEY.DOWN); // select "clear"
		await typeAndWait(stdin, KEY.ENTER);

		expect(onSubmit).toHaveBeenCalledWith('/clear');
	});

	it('submits selected command when partial prefix is typed', async () => {
		const onSubmit = vi.fn();
		const {stdin} = render(<CommandInput onSubmit={onSubmit} />);

		// Type "/c" to filter, first match should be "clear"
		await typeAndWait(stdin, '/c');
		await typeAndWait(stdin, KEY.ENTER);

		expect(onSubmit).toHaveBeenCalledWith('/clear');
	});

	it('backslash + Enter inserts newline instead of submitting', async () => {
		const onSubmit = vi.fn();
		const {lastFrame, stdin} = render(<CommandInput onSubmit={onSubmit} />);

		await typeAndWait(stdin, 'hello\\');
		await typeAndWait(stdin, KEY.ENTER);

		expect(onSubmit).not.toHaveBeenCalled();
		// Cursor should be on a new line after the newline character
		const output = frame(lastFrame);
		const lines = output.split('\n');
		const helloLine = lines.find(l => l.includes('hello'));
		expect(helloLine).toBeDefined();
		// The cursor (inverse block) should NOT be on the same line as "hello"
		// — it should be on the next line
		const helloLineIndex = lines.indexOf(helloLine!);
		const nextLine = lines[helloLineIndex + 1];
		expect(nextLine).toBeDefined();
	});

	it('shows suggestions again when user types after history recall', async () => {
		const onArrowUp = vi.fn().mockReturnValue('/help');
		const {lastFrame, stdin} = render(
			<CommandInput onSubmit={noop} onArrowUp={onArrowUp} />,
		);

		// Recall "/help" from history — no suggestions
		await typeAndWait(stdin, KEY.UP);
		expect(frame(lastFrame)).not.toContain('Show help');

		// Clear with Ctrl+U, then type "/" manually — suggestions should appear
		await typeAndWait(stdin, '\x15'); // Ctrl+U = clear line
		await typeAndWait(stdin, '/');
		expect(frame(lastFrame)).toContain('Show help');
	});
});
