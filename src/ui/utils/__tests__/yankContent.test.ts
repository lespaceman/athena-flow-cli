import {describe, it, expect} from 'vitest';
import {extractYankContent} from '../yankContent';
import type {TimelineEntry} from '../../../core/feed/timeline';
import type {FeedEvent} from '../../../core/feed/types';

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
	return {
		id: 'e1',
		ts: 0,
		op: 'Tool Call',
		opTag: 'tool.call',
		actor: 'Claude',
		actorId: 'c1',
		toolColumn: 'Read',
		summary: 'test summary',
		summarySegments: [],
		searchText: 'test',
		error: false,
		expandable: true,
		details: 'fallback details',
		duplicateActor: false,
		...overrides,
	};
}

describe('extractYankContent', () => {
	it('extracts agent.message as raw markdown', () => {
		const event = {
			kind: 'agent.message' as const,
			data: {message: '# Hello\n\nWorld', source: 'hook' as const, scope: 'root' as const},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		expect(extractYankContent(entry)).toBe('# Hello\n\nWorld');
	});

	it('extracts user.prompt as raw text', () => {
		const event = {
			kind: 'user.prompt' as const,
			data: {prompt: 'fix the bug', cwd: '/home'},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		expect(extractYankContent(entry)).toBe('fix the bug');
	});

	it('extracts tool.pre as JSON of tool_input', () => {
		const event = {
			kind: 'tool.pre' as const,
			data: {tool_name: 'Read', tool_input: {file_path: '/foo.ts'}},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		const result = extractYankContent(entry);
		expect(JSON.parse(result)).toEqual({file_path: '/foo.ts'});
	});

	it('extracts tool.post with paired response', () => {
		const preEvent = {
			kind: 'tool.pre' as const,
			data: {tool_name: 'Read', tool_input: {file_path: '/foo.ts'}},
		} as FeedEvent;
		const postEvent = {
			kind: 'tool.post' as const,
			data: {tool_name: 'Read', tool_input: {file_path: '/foo.ts'}, tool_response: 'file content here'},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: preEvent, pairedPostEvent: postEvent});
		const result = extractYankContent(entry);
		expect(result).toContain('"file_path": "/foo.ts"');
		expect(result).toContain('file content here');
	});

	it('extracts tool.failure error message', () => {
		const event = {
			kind: 'tool.failure' as const,
			data: {tool_name: 'Read', tool_input: {file_path: '/missing'}, error: 'File not found'},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		const result = extractYankContent(entry);
		expect(result).toContain('File not found');
	});

	it('extracts notification message', () => {
		const event = {
			kind: 'notification' as const,
			data: {message: 'Build succeeded'},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		expect(extractYankContent(entry)).toBe('Build succeeded');
	});

	it('falls back to entry.details when no feedEvent', () => {
		const entry = makeEntry({feedEvent: undefined, details: 'fallback text'});
		expect(extractYankContent(entry)).toBe('fallback text');
	});

	it('falls back to JSON.stringify for unknown event kinds', () => {
		const event = {
			kind: 'run.end' as const,
			data: {status: 'completed', counters: {tool_uses: 5, tool_failures: 0, permission_requests: 0, blocks: 0}},
		} as FeedEvent;
		const entry = makeEntry({feedEvent: event});
		const result = extractYankContent(entry);
		expect(JSON.parse(result)).toEqual(event.data);
	});
});
