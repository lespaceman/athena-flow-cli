import React from 'react';
import {render} from 'ink-testing-library';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {act} from '@testing-library/react';
import McpOptionsStep from '../McpOptionsStep';
import type {McpServerWithOptions} from '../../../infra/plugins/mcpOptions';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

const TWO_SERVERS: McpServerWithOptions[] = [
	{
		serverName: 'agent-web-interface',
		options: [
			{label: 'Visible browser', args: []},
			{label: 'Headless browser', args: ['--headless']},
		],
	},
	{
		serverName: 'db-server',
		options: [
			{label: 'Local DB', args: ['--local']},
			{label: 'Remote DB', args: ['--remote']},
		],
	},
];

describe('McpOptionsStep', () => {
	it('renders first server options', () => {
		const {lastFrame} = render(
			<McpOptionsStep servers={TWO_SERVERS} onComplete={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('agent-web-interface');
		expect(frame).toContain('Visible browser (default)');
		expect(frame).toContain('Headless browser');
		expect(frame).toContain('Server 1 of 2');
	});

	it('advances to second server after selecting first', async () => {
		const {stdin, lastFrame} = render(
			<McpOptionsStep servers={TWO_SERVERS} onComplete={() => {}} />,
		);

		// Select first option (Visible browser) for first server
		act(() => stdin.write('\r'));

		await vi.waitFor(() => {
			const frame = lastFrame()!;
			expect(frame).toContain('db-server');
			expect(frame).toContain('Server 2 of 2');
		});
	});

	it('calls onComplete with choices after selecting all servers', () => {
		const onComplete = vi.fn();
		const {stdin} = render(
			<McpOptionsStep servers={TWO_SERVERS} onComplete={onComplete} />,
		);

		// Select first option for first server
		act(() => stdin.write('\r'));
		// Select second option for second server
		act(() => stdin.write('\u001B[B')); // down arrow
		act(() => stdin.write('\r'));

		expect(onComplete).toHaveBeenCalledWith({
			'agent-web-interface': [],
			'db-server': ['--remote'],
		});
	});

	it('auto-calls onComplete with empty choices when no servers', () => {
		const onComplete = vi.fn();
		render(<McpOptionsStep servers={[]} onComplete={onComplete} />);

		expect(onComplete).toHaveBeenCalledWith({});
	});

	it('renders nothing when servers is empty', () => {
		const {lastFrame} = render(
			<McpOptionsStep servers={[]} onComplete={() => {}} />,
		);
		// Should render null (empty frame)
		expect(lastFrame()!.trim()).toBe('');
	});
});
