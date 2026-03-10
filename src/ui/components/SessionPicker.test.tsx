import {vi} from 'vitest';

vi.hoisted(() => {
	process.env['FORCE_COLOR'] = '1';
});

import React from 'react';
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {render} from 'ink-testing-library';
import SessionPicker from './SessionPicker';
import {type SessionEntry} from '../../shared/types/session';
import {formatRelativeTime} from '../../shared/utils/formatters';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const originalRows = process.stdout.rows;

const sessions: SessionEntry[] = [
	{
		sessionId: 'aaa',
		summary: 'Terminal UI Development',
		firstPrompt: 'is npm run dev working',
		modified: new Date(Date.now() - 3600_000).toISOString(),
		created: '2026-01-24T22:45:49.288Z',
		gitBranch: 'main',
		messageCount: 20,
	},
	{
		sessionId: 'bbb',
		summary: 'Hook-Forwarder Security Fixes',
		firstPrompt: 'fix the security issue',
		modified: new Date(Date.now() - 7200_000).toISOString(),
		created: '2026-01-24T23:03:02.886Z',
		gitBranch: 'feature/hook-forwarder',
		messageCount: 18,
	},
	{
		sessionId: 'ccc',
		summary: '',
		firstPrompt: 'API key auth error',
		modified: new Date(Date.now() - 18000_000).toISOString(),
		created: '2026-01-25T00:01:13.007Z',
		gitBranch: '',
		messageCount: 2,
	},
];

function makeSession(index: number): SessionEntry {
	return {
		sessionId: `session-${index.toString().padStart(3, '0')}`,
		summary: `Session ${index}`,
		firstPrompt: `prompt ${index}`,
		modified: new Date(Date.now() - index * 60_000).toISOString(),
		created: new Date(Date.now() - index * 60_000).toISOString(),
		gitBranch: '',
		messageCount: index,
	};
}

describe('SessionPicker', () => {
	beforeEach(() => {
		Object.defineProperty(process.stdout, 'rows', {
			value: originalRows ?? 24,
			configurable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(process.stdout, 'rows', {
			value: originalRows,
			configurable: true,
		});
	});

	it('renders session summaries', () => {
		const {lastFrame} = render(
			<SessionPicker
				sessions={sessions}
				onSelect={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Terminal UI Development');
		expect(frame).toContain('Hook-Forwarder Security Fixes');
	});

	it('falls back to firstPrompt when summary is empty', () => {
		const {lastFrame} = render(
			<SessionPicker
				sessions={sessions}
				onSelect={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('API key auth error');
	});

	it('shows branch, relative time, and message count', () => {
		const {lastFrame} = render(
			<SessionPicker
				sessions={sessions}
				onSelect={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('main');
		expect(frame).toContain('20 messages');
	});

	it('omits branch indicator for empty gitBranch', () => {
		const {lastFrame} = render(
			<SessionPicker
				sessions={sessions}
				onSelect={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).not.toContain('⎇ ccc');
		expect(frame).toContain('ccc · '); // It should still have other metadata
	});

	it('shows empty state message when no sessions', () => {
		const {lastFrame} = render(
			<SessionPicker sessions={[]} onSelect={vi.fn()} onCancel={vi.fn()} />,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('No previous sessions found');
	});

	it('calls onSelect with sessionId on Enter', () => {
		const onSelect = vi.fn();
		const {stdin} = render(
			<SessionPicker
				sessions={sessions}
				onSelect={onSelect}
				onCancel={vi.fn()}
			/>,
		);
		stdin.write('\r');
		expect(onSelect).toHaveBeenCalledWith('aaa');
	});

	it('navigates down and selects correct session', async () => {
		const onSelect = vi.fn();
		const {stdin} = render(
			<SessionPicker
				sessions={sessions}
				onSelect={onSelect}
				onCancel={vi.fn()}
			/>,
		);
		stdin.write('\x1B[B');
		await delay(50);
		stdin.write('\r');
		expect(onSelect).toHaveBeenCalledWith('bbb');
	});

	it('calls onCancel on Escape', async () => {
		const onCancel = vi.fn();
		const {stdin} = render(
			<SessionPicker
				sessions={sessions}
				onSelect={vi.fn()}
				onCancel={onCancel}
			/>,
		);
		stdin.write('\x1B');
		await new Promise(resolve => setImmediate(resolve));
		expect(onCancel).toHaveBeenCalled();
	});

	it('does not scroll past the last item', async () => {
		const onSelect = vi.fn();
		const {stdin} = render(
			<SessionPicker
				sessions={sessions}
				onSelect={onSelect}
				onCancel={vi.fn()}
			/>,
		);
		// Press down 5 times (past the 3 items)
		for (let i = 0; i < 5; i++) {
			stdin.write('\x1B[B');
			await delay(20);
		}
		stdin.write('\r');
		expect(onSelect).toHaveBeenCalledWith('ccc');
	});

	it('shows keybinding hints', () => {
		const {lastFrame} = render(
			<SessionPicker
				sessions={sessions}
				onSelect={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Navigate');
		expect(frame).toContain('Select');
		expect(frame).toContain('Cancel');
	});

	it('shows loading state when loading prop is true', () => {
		const {lastFrame} = render(
			<SessionPicker
				sessions={[]}
				loading={true}
				onSelect={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Loading sessions');
		expect(frame).toContain('Sessions');
	});

	it('truncates long titles with compactText', () => {
		const longSessions: SessionEntry[] = [
			{
				sessionId: 'ddd',
				summary:
					'This is an extremely long session summary that should be truncated by compactText utility',
				firstPrompt: 'long prompt',
				modified: new Date().toISOString(),
				created: new Date().toISOString(),
				gitBranch: '',
				messageCount: 5,
			},
		];
		const {lastFrame} = render(
			<SessionPicker
				sessions={longSessions}
				onSelect={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain('...');
		expect(frame).not.toContain('compactText utility');
	});

	it('limits visible sessions to the terminal height', () => {
		Object.defineProperty(process.stdout, 'rows', {
			value: 14,
			configurable: true,
		});
		const shortViewportSessions = Array.from({length: 8}, (_, index) =>
			makeSession(index),
		);

		const {lastFrame} = render(
			<SessionPicker
				sessions={shortViewportSessions}
				onSelect={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);
		const frame = lastFrame() ?? '';

		expect(frame).toContain('Session 0');
		expect(frame).toContain('Session 1');
		expect(frame).toContain('Session 2');
		expect(frame).not.toContain('Session 3');
	});

	it('scrolls the visible window as the focused session moves', async () => {
		Object.defineProperty(process.stdout, 'rows', {
			value: 14,
			configurable: true,
		});
		const shortViewportSessions = Array.from({length: 8}, (_, index) =>
			makeSession(index),
		);

		const {stdin, lastFrame} = render(
			<SessionPicker
				sessions={shortViewportSessions}
				onSelect={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		for (let i = 0; i < 5; i++) {
			stdin.write('\x1B[B');
			await delay(20);
		}

		const frame = lastFrame() ?? '';
		expect(frame).toContain('Session 4');
		expect(frame).toContain('Session 5');
		expect(frame).toContain('Session 6');
		expect(frame).not.toContain('Session 0');
		expect(frame).toContain('❯ Session 5');
	});
});

describe('formatRelativeTime', () => {
	it('formats recent times', () => {
		expect(formatRelativeTime(new Date().toISOString())).toBe('just now');
		expect(
			formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString()),
		).toBe('5m ago');
		expect(
			formatRelativeTime(new Date(Date.now() - 3 * 3600_000).toISOString()),
		).toBe('3h ago');
		expect(
			formatRelativeTime(new Date(Date.now() - 2 * 86400_000).toISOString()),
		).toBe('2d ago');
	});
});
