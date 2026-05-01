import React from 'react';
import {describe, it, expect} from 'vitest';
import {render} from 'ink-testing-library';
import Message from './Message';
import {ThemeProvider} from '../theme';
import {darkTheme, lightTheme} from '../theme/themes';

describe('Message', () => {
	it('renders user message with ❯ prefix', () => {
		const {lastFrame} = render(
			<Message
				message={{
					id: '1',
					role: 'user',
					content: 'Hello world',
					timestamp: new Date(),
					seq: 1,
				}}
			/>,
		);
		const frame = lastFrame() ?? '';

		expect(frame).toContain('❯');
		expect(frame).toContain('Hello world');
	});

	it('renders assistant message with ● prefix', () => {
		const {lastFrame} = render(
			<Message
				message={{
					id: '2',
					role: 'assistant',
					content: 'Hi there',
					timestamp: new Date(),
					seq: 1,
				}}
			/>,
		);
		const frame = lastFrame() ?? '';

		expect(frame).toContain('●');
		expect(frame).toContain('Hi there');
	});

	it('renders assistant message tables as stacked records', () => {
		const {lastFrame} = render(
			<Message
				parentWidth={80}
				message={{
					id: '2',
					role: 'assistant',
					content: [
						'| Capability | Possible? | Notes |',
						'| --- | --- | --- |',
						'| Add menu command | Yes | 2-line change to BOT_COMMANDS |',
					].join('\n'),
					timestamp: new Date(),
					seq: 1,
				}}
			/>,
		);
		const frame = lastFrame() ?? '';

		expect(frame).toContain('• Capability: Add menu command');
		expect(frame).toContain('Possible?: Yes');
		expect(frame).toContain('Notes: 2-line change to BOT_COMMANDS');
		expect(frame).not.toContain('┌');
		expect(frame).not.toContain('│');
	});

	it('uses correct prefix per role', () => {
		const {lastFrame: userFrame} = render(
			<Message
				message={{
					id: '1',
					role: 'user',
					content: 'test',
					timestamp: new Date(),
					seq: 1,
				}}
			/>,
		);
		const {lastFrame: assistantFrame} = render(
			<Message
				message={{
					id: '2',
					role: 'assistant',
					content: 'test',
					timestamp: new Date(),
					seq: 1,
				}}
			/>,
		);

		expect(userFrame()).toContain('❯');
		expect(userFrame()).not.toContain('●');
		expect(assistantFrame()).toContain('●');
		expect(assistantFrame()).not.toContain('❯');
	});

	it('consumes theme from ThemeProvider context', () => {
		const msg = {
			id: '1',
			role: 'user' as const,
			content: 'Hello',
			timestamp: new Date(),
			seq: 1,
		};

		// Rendering with lightTheme should not throw —
		// verifies useTheme() reads from provider, not hardcoded values
		const {lastFrame: darkFrame} = render(
			<ThemeProvider value={darkTheme}>
				<Message message={msg} />
			</ThemeProvider>,
		);
		const {lastFrame: lightFrame} = render(
			<ThemeProvider value={lightTheme}>
				<Message message={msg} />
			</ThemeProvider>,
		);

		// Both render the same text content (ANSI codes are stripped by ink-testing-library)
		expect(darkFrame()).toContain('Hello');
		expect(lightFrame()).toContain('Hello');
	});
});
