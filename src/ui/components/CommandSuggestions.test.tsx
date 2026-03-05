import React from 'react';
import {describe, it, expect} from 'vitest';
import {render} from 'ink-testing-library';
import CommandSuggestions from './CommandSuggestions';
import {type Command} from '../../app/commands/types';

const makeCommand = (name: string, description: string): Command => ({
	name,
	description,
	category: 'ui',
	execute: () => {},
});

const defaultProps = {
	innerWidth: 80,
	wrapLine: (line: string) => `│${line}│`,
};

describe('CommandSuggestions', () => {
	const commands: Command[] = [
		makeCommand('help', 'Show available commands'),
		makeCommand('clear', 'Clear the screen'),
		makeCommand('quit', 'Exit athena-cli'),
	];

	it('returns null when commands list is empty', () => {
		const {lastFrame} = render(
			<CommandSuggestions commands={[]} selectedIndex={0} {...defaultProps} />,
		);
		expect(lastFrame()).toBe('');
	});

	it('renders all command names with / prefix', () => {
		const {lastFrame} = render(
			<CommandSuggestions
				commands={commands}
				selectedIndex={0}
				{...defaultProps}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('/help');
		expect(frame).toContain('/clear');
		expect(frame).toContain('/quit');
	});

	it('renders command descriptions', () => {
		const {lastFrame} = render(
			<CommandSuggestions
				commands={commands}
				selectedIndex={0}
				{...defaultProps}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Show available commands');
		expect(frame).toContain('Clear the screen');
		expect(frame).toContain('Exit athena-cli');
	});

	it('shows > indicator on selected item', () => {
		const {lastFrame} = render(
			<CommandSuggestions
				commands={commands}
				selectedIndex={1}
				{...defaultProps}
			/>,
		);
		const frame = lastFrame() ?? '';
		const lines = frame.split('\n');

		// Line at index 1 (second command) should have > indicator
		const clearLine = lines.find(l => l.includes('/clear'));
		expect(clearLine).toContain('>');

		// Other lines should not have > indicator (they have space instead)
		const helpLine = lines.find(l => l.includes('/help'));
		expect(helpLine).not.toContain('>');
	});

	it('highlights selected item differently from unselected', () => {
		const {lastFrame} = render(
			<CommandSuggestions
				commands={commands}
				selectedIndex={0}
				{...defaultProps}
			/>,
		);
		const frame = lastFrame() ?? '';
		// Selected item (help) should have > indicator
		const lines = frame.split('\n');
		const helpLine = lines.find(l => l.includes('/help'));
		expect(helpLine).toContain('>');
	});

	describe('column alignment', () => {
		const mixedCommands: Command[] = [
			makeCommand('h', 'Short name'),
			makeCommand('explore-website', 'Longer name'),
		];

		it('aligns descriptions to same column regardless of name length', () => {
			const {lastFrame} = render(
				<CommandSuggestions
					commands={mixedCommands}
					selectedIndex={0}
					{...defaultProps}
				/>,
			);
			const frame = lastFrame() ?? '';
			const lines = frame.split('\n').filter(l => l.includes('/'));

			// Both descriptions should start at the same column
			const descStart = (line: string, desc: string) => line.indexOf(desc);
			const pos0 = descStart(lines[0]!, 'Short name');
			const pos1 = descStart(lines[1]!, 'Longer name');
			expect(pos0).toBe(pos1);
		});
	});

	describe('description truncation', () => {
		it('truncates long descriptions in narrow width', () => {
			const longDesc =
				'This is a very long description that should be truncated';
			const cmds: Command[] = [makeCommand('test', longDesc)];
			const {lastFrame} = render(
				<CommandSuggestions
					commands={cmds}
					selectedIndex={0}
					innerWidth={30}
					wrapLine={defaultProps.wrapLine}
				/>,
			);
			const frame = lastFrame() ?? '';
			expect(frame).not.toContain(longDesc);
		});

		it('does not truncate short descriptions', () => {
			const cmds: Command[] = [makeCommand('test', 'Short desc')];
			const {lastFrame} = render(
				<CommandSuggestions
					commands={cmds}
					selectedIndex={0}
					innerWidth={120}
					wrapLine={defaultProps.wrapLine}
				/>,
			);
			const frame = lastFrame() ?? '';
			expect(frame).toContain('Short desc');
			expect(frame).not.toContain('\u2026');
		});
	});

	it('wraps each line with wrapLine callback', () => {
		const {lastFrame} = render(
			<CommandSuggestions
				commands={[makeCommand('test', 'A command')]}
				selectedIndex={0}
				innerWidth={80}
				wrapLine={(line: string) => `[${line}]`}
			/>,
		);
		const frame = lastFrame() ?? '';
		// Every line should be wrapped with [ and ]
		for (const line of frame.split('\n').filter(Boolean)) {
			expect(line.startsWith('[')).toBe(true);
			expect(line.endsWith(']')).toBe(true);
		}
	});
});
