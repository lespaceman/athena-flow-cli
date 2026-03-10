import React from 'react';
import {describe, it, expect, vi, afterEach} from 'vitest';
import chalk from 'chalk';
import {render} from 'ink-testing-library';
import PermissionDialog from './PermissionDialog';
import type {PermissionQueueItem} from '../../core/controller/permission';

function makePermissionEvent(
	toolName: string,
	toolInput: Record<string, unknown> = {},
): PermissionQueueItem {
	return {
		request_id: 'test-id',
		ts: Date.now(),
		hookName: 'PermissionRequest',
		tool_name: toolName,
		tool_input: toolInput,
	};
}

describe('PermissionDialog', () => {
	describe('title', () => {
		it('shows "Allow "{tool}"?" for built-in tools', () => {
			const event = makePermissionEvent('Edit', {file_path: '/test.ts'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			expect(lastFrame()).toContain('Allow "Edit"?');
		});

		it('shows "Allow "{tool}" ({server})?" for MCP tools', () => {
			const event = makePermissionEvent('mcp__agent-web-interface__click', {
				eid: 'btn-1',
			});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			const frame = lastFrame() ?? '';
			expect(frame).toContain('Allow "click" (agent-web-interface (MCP))?');
		});
	});

	describe('option list rendering', () => {
		it('shows Allow, Deny, Always allow for built-in tools', () => {
			const event = makePermissionEvent('Edit', {file_path: '/test.ts'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			const frame = lastFrame() ?? '';
			expect(frame).toContain('Allow');
			expect(frame).toContain('Deny');
			expect(frame).toContain('Always allow "Edit"');
			expect(frame).not.toContain('Always deny');
		});

		it('shows "Always allow all from server" option for MCP tools', () => {
			const event = makePermissionEvent('mcp__my-server__action', {});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			expect(lastFrame()).toContain('Always allow all from my-server (MCP)');
		});

		it('does not show server option for built-in tools', () => {
			const event = makePermissionEvent('Bash', {command: 'ls'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			expect(lastFrame()).not.toContain('Always allow all from');
		});

		it('shows option list for all tools (no type-to-confirm)', () => {
			const event = makePermissionEvent('Bash', {command: 'rm -rf /'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			const frame = lastFrame() ?? '';
			expect(frame).toContain('Allow');
			expect(frame).toContain('Deny');
			expect(frame).toContain('Navigate');
		});

		it('shows footer hint', () => {
			const event = makePermissionEvent('Edit', {file_path: '/test.ts'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			expect(lastFrame()).toContain('Navigate');
			expect(lastFrame()).toContain('Jump');
			expect(lastFrame()).toContain('Select');
			expect(lastFrame()).toContain('Cancel');
		});

		it('does not show "Show details" option', () => {
			const event = makePermissionEvent('Edit', {file_path: '/test.ts'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			expect(lastFrame()).not.toContain('Show details');
		});
	});

	describe('queue count', () => {
		it('shows +N when queue > 0', () => {
			const event = makePermissionEvent('Bash', {command: 'ls'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={2}
					onDecision={vi.fn()}
				/>,
			);

			expect(lastFrame()).toContain('+2');
		});

		it('does not show queue count when 0', () => {
			const event = makePermissionEvent('Bash', {command: 'ls'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			expect(lastFrame()).not.toContain('+');
		});
	});

	describe('keyboard interaction', () => {
		it('calls onDecision with "allow" when Enter is pressed on focused Allow option', () => {
			const onDecision = vi.fn();
			const event = makePermissionEvent('Edit', {file_path: '/test.ts'});
			const {stdin} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={onDecision}
				/>,
			);

			stdin.write('\r');
			expect(onDecision).toHaveBeenCalledWith('allow');
		});

		it('calls onDecision with "deny" via number key', () => {
			const onDecision = vi.fn();
			const event = makePermissionEvent('Edit', {file_path: '/test.ts'});
			const {stdin} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={onDecision}
				/>,
			);

			stdin.write('2');
			expect(onDecision).toHaveBeenCalledWith('deny');
		});

		it('calls onDecision with "deny" when Escape is pressed', async () => {
			const onDecision = vi.fn();
			const event = makePermissionEvent('Edit', {file_path: '/test.ts'});
			const {stdin} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={onDecision}
				/>,
			);
			stdin.write('\x1B');
			await new Promise(resolve => setImmediate(resolve));
			expect(onDecision).toHaveBeenCalledWith('deny');
		});

		it('calls onDecision with "always-allow" via number key', () => {
			const onDecision = vi.fn();
			const event = makePermissionEvent('Edit', {file_path: '/test.ts'});
			const {stdin} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={onDecision}
				/>,
			);

			stdin.write('3');
			expect(onDecision).toHaveBeenCalledWith('always-allow');
		});

		it('does not show option descriptions', () => {
			const event = makePermissionEvent('Edit', {file_path: '/test.ts'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);

			expect(lastFrame()).not.toContain('Allow this tool call');
		});
	});

	describe('separator styling', () => {
		const savedLevel = chalk.level;
		afterEach(() => {
			chalk.level = savedLevel;
		});

		it('uses themed horizontal rule separator instead of dim dashes', () => {
			chalk.level = 3;
			const event = makePermissionEvent('Bash', {command: 'ls'});
			const {lastFrame} = render(
				<PermissionDialog
					request={event}
					queuedCount={0}
					onDecision={vi.fn()}
				/>,
			);
			const output = lastFrame() ?? '';
			expect(output).toContain('─');
		});
	});
});
