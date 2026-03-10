import React from 'react';
import {describe, it, expect} from 'vitest';
import {render} from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import MergedToolCallEvent from './MergedToolCallEvent';
import type {FeedEvent} from '../../core/feed/types';

// invariant-waiver: #2 (mapper is sole constructor) — test helper for unit testing MergedToolCallEvent
function makeFeedEvent(
	kind: FeedEvent['kind'],
	data: Record<string, unknown>,
	overrides: Partial<FeedEvent> = {},
): FeedEvent {
	return {
		event_id: 'test-1',
		seq: 1,
		ts: Date.now(),
		session_id: 's1',
		run_id: 's1:R1',
		kind,
		level: 'info',
		actor_id: 'agent:root',
		title: 'test',
		data,
		...overrides,
	} as FeedEvent;
}

describe('MergedToolCallEvent', () => {
	it('renders pending state with streaming glyph when no postEvent', () => {
		const event = makeFeedEvent('tool.pre', {
			tool_name: 'Bash',
			tool_input: {command: 'npm test'},
		});
		const {lastFrame} = render(<MergedToolCallEvent event={event} />);
		const frame = stripAnsi(lastFrame() ?? '');
		expect(frame).toContain('◐');
		expect(frame).toContain('Bash');
	});

	it('renders success state with checkmark when postEvent is tool.post', () => {
		const preEvent = makeFeedEvent('tool.pre', {
			tool_name: 'Bash',
			tool_input: {command: 'echo hi'},
			tool_use_id: 'tu-1',
		});
		const postEvent = makeFeedEvent('tool.post', {
			tool_name: 'Bash',
			tool_input: {command: 'echo hi'},
			tool_use_id: 'tu-1',
			tool_response: {stdout: 'hi\n', stderr: '', exitCode: 0},
		});
		const {lastFrame} = render(
			<MergedToolCallEvent event={preEvent} postEvent={postEvent} />,
		);
		const frame = stripAnsi(lastFrame() ?? '');
		expect(frame).toContain('✔');
		expect(frame).toContain('Bash');
		expect(frame).toContain('exit 0');
	});

	it('renders failure state with cross when postEvent is tool.failure', () => {
		const preEvent = makeFeedEvent('tool.pre', {
			tool_name: 'Bash',
			tool_input: {command: 'bad'},
			tool_use_id: 'tu-2',
		});
		const postEvent = makeFeedEvent('tool.failure', {
			tool_name: 'Bash',
			tool_input: {command: 'bad'},
			tool_use_id: 'tu-2',
			error: 'command not found',
		});
		const {lastFrame} = render(
			<MergedToolCallEvent event={preEvent} postEvent={postEvent} />,
		);
		const frame = stripAnsi(lastFrame() ?? '');
		expect(frame).toContain('✘');
		expect(frame).toContain('Bash');
		expect(frame).toContain('command not found');
	});

	it('keeps pending state while showing streamed output for tool.delta', () => {
		const preEvent = makeFeedEvent('tool.pre', {
			tool_name: 'Bash',
			tool_input: {command: 'npm test'},
			tool_use_id: 'tu-stream',
		});
		const deltaEvent = makeFeedEvent('tool.delta', {
			tool_name: 'Bash',
			tool_input: {},
			tool_use_id: 'tu-stream',
			delta: 'PASS src/example.test.ts\n',
		});
		const {lastFrame} = render(
			<MergedToolCallEvent event={preEvent} postEvent={deltaEvent} expanded />,
		);
		const frame = stripAnsi(lastFrame() ?? '');
		expect(frame).toContain('◐');
		expect(frame).toContain('PASS src/example.test.ts');
		expect(frame).not.toContain('exit 0');
	});

	it('shows input + output when expanded and postEvent present', () => {
		const preEvent = makeFeedEvent('tool.pre', {
			tool_name: 'Bash',
			tool_input: {command: 'echo hi'},
			tool_use_id: 'tu-3',
		});
		const postEvent = makeFeedEvent('tool.post', {
			tool_name: 'Bash',
			tool_input: {command: 'echo hi'},
			tool_use_id: 'tu-3',
			tool_response: {stdout: 'hi\n', stderr: '', exitCode: 0},
		});
		const {lastFrame} = render(
			<MergedToolCallEvent event={preEvent} postEvent={postEvent} expanded />,
		);
		const frame = stripAnsi(lastFrame() ?? '');
		// Input section
		expect(frame).toContain('command');
		// Output section
		expect(frame).toContain('hi');
	});

	it('renders permission.request events (no merge, same as pending)', () => {
		const event = makeFeedEvent('permission.request', {
			tool_name: 'Bash',
			tool_input: {command: 'rm -rf /'},
		});
		const {lastFrame} = render(<MergedToolCallEvent event={event} />);
		const frame = stripAnsi(lastFrame() ?? '');
		expect(frame).toContain('Bash');
	});

	it('returns null for non-tool.pre/permission.request events', () => {
		const event = makeFeedEvent('tool.post', {
			tool_name: 'Bash',
			tool_input: {},
			tool_response: 'hello',
		});
		const {lastFrame} = render(<MergedToolCallEvent event={event} />);
		expect(lastFrame()).toBe('');
	});
});
