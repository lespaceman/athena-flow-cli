import React from 'react';
import {render} from 'ink-testing-library';
import {describe, it, expect} from 'vitest';
import StepSelector from '../StepSelector';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('StepSelector', () => {
	it('renders options with cursor on first item', () => {
		const {lastFrame} = render(
			<StepSelector
				options={[
					{label: 'Dark', value: 'dark'},
					{label: 'Light', value: 'light'},
				]}
				onSelect={() => {}}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('Dark');
		expect(frame).toContain('Light');
	});

	it('calls onSelect with value on Enter', () => {
		let selected = '';
		const {stdin} = render(
			<StepSelector
				options={[
					{label: 'Dark', value: 'dark'},
					{label: 'Light', value: 'light'},
				]}
				onSelect={v => {
					selected = v;
				}}
			/>,
		);
		stdin.write('\r');
		expect(selected).toBe('dark');
	});

	it('supports initialValue and emits highlight changes', async () => {
		const highlighted: string[] = [];
		const {stdin} = render(
			<StepSelector
				options={[
					{label: 'Dark', value: 'dark'},
					{label: 'Light', value: 'light'},
				]}
				initialValue="light"
				onHighlight={value => {
					highlighted.push(value);
				}}
				onSelect={() => {}}
			/>,
		);
		await delay(30);
		stdin.write('\u001B[A');
		await delay(30);
		expect(highlighted).toContain('light');
		expect(highlighted).toContain('dark');
	});

	it('skips disabled options while navigating', async () => {
		let selected = '';
		const {lastFrame, stdin} = render(
			<StepSelector
				options={[
					{label: 'Claude Code', value: 'claude-code'},
					{label: 'Codex (coming soon)', value: 'codex', disabled: true},
					{label: 'Skip for now', value: 'skip'},
				]}
				onSelect={v => {
					selected = v;
				}}
			/>,
		);
		stdin.write('\u001B[B');
		await delay(50);
		stdin.write('\r');
		expect(selected).toBe('skip');
		expect(lastFrame()!).toContain('coming soon');
	});

	it('renders focused item with > prefix', () => {
		const {lastFrame} = render(
			<StepSelector
				options={[
					{label: 'Alpha', value: 'a'},
					{label: 'Beta', value: 'b'},
				]}
				onSelect={() => {}}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('>');
		expect(frame).toContain('Alpha');
		expect(frame).toContain('Beta');
	});

	it('renders description for focused item when provided', () => {
		const {lastFrame} = render(
			<StepSelector
				options={[
					{label: 'Alpha', value: 'a', description: 'First letter'},
					{label: 'Beta', value: 'b', description: 'Second letter'},
				]}
				onSelect={() => {}}
			/>,
		);
		const frame = lastFrame()!;
		// Description of focused item (Alpha) should show
		expect(frame).toContain('First letter');
		// Description of non-focused (Beta) should not show
		expect(frame).not.toContain('Second letter');
	});
});
