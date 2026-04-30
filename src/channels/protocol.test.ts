import {describe, expect, it} from 'vitest';
import {
	encodeLine,
	LineReader,
	parseEventMessage,
	parseMethodMessage,
} from './protocol';

describe('encodeLine', () => {
	it('produces a single line ending in newline', () => {
		const out = encodeLine({hello: 'world'});
		expect(out).toBe('{"hello":"world"}\n');
	});
});

describe('LineReader', () => {
	it('splits a single chunk on \\n', () => {
		const r = new LineReader();
		const lines = r.push('a\nb\nc\n');
		expect(lines).toEqual(['a', 'b', 'c']);
	});

	it('buffers partial lines across chunks', () => {
		const r = new LineReader();
		expect(r.push('hel')).toEqual([]);
		expect(r.push('lo\nworl')).toEqual(['hello']);
		expect(r.push('d\n')).toEqual(['world']);
	});

	it('tolerates \\r\\n', () => {
		const r = new LineReader();
		expect(r.push('a\r\nb\r\n')).toEqual(['a', 'b']);
	});

	it('drops empty lines', () => {
		const r = new LineReader();
		expect(r.push('\n\nhi\n\n')).toEqual(['hi']);
	});

	it('flush returns trailing buffer', () => {
		const r = new LineReader();
		r.push('partial');
		expect(r.flush()).toEqual(['partial']);
	});
});

describe('parseMethodMessage', () => {
	it('accepts a valid permission.request', () => {
		const result = parseMethodMessage({
			session_id: 'session-1',
			method: 'permission.request',
			params: {
				channel_request_id: 'abcde',
				tool_name: 'Bash',
				description: 'list files',
				input_preview: '{"command":"ls"}',
			},
		});
		expect(result.ok).toBe(true);
	});

	it('rejects method messages without session_id', () => {
		const result = parseMethodMessage({
			method: 'permission.request',
			params: {
				channel_request_id: 'abcde',
				tool_name: 'Bash',
				description: 'list files',
				input_preview: '{"command":"ls"}',
			},
		});
		expect(result.ok).toBe(false);
	});

	it('rejects unknown method', () => {
		const result = parseMethodMessage({
			session_id: 'session-1',
			method: 'wat',
			params: {},
		});
		expect(result.ok).toBe(false);
	});

	it('rejects bad channel_request_id', () => {
		const result = parseMethodMessage({
			session_id: 'session-1',
			method: 'permission.request',
			params: {
				channel_request_id: 'BADID', // uppercase
				tool_name: 'Bash',
				description: 'd',
				input_preview: '',
			},
		});
		expect(result.ok).toBe(false);
	});

	it('accepts a valid permission.cancel', () => {
		const result = parseMethodMessage({
			session_id: 'session-1',
			method: 'permission.cancel',
			params: {channel_request_id: 'abcde', reason: 'resolved_locally'},
		});
		expect(result.ok).toBe(true);
	});

	it('accepts a valid question.request', () => {
		const result = parseMethodMessage({
			session_id: 'session-1',
			method: 'question.request',
			params: {
				channel_request_id: 'abcde',
				title: 'Answer question',
				questions: [
					{
						key: 'Which branch?',
						header: 'Branch',
						question: 'Which branch should I push?',
						multi_select: false,
						options: [{label: 'main', description: 'Push main'}],
					},
				],
			},
		});
		expect(result.ok).toBe(true);
	});

	it('accepts a valid question.cancel', () => {
		const result = parseMethodMessage({
			session_id: 'session-1',
			method: 'question.cancel',
			params: {channel_request_id: 'abcde', reason: 'resolved_locally'},
		});
		expect(result.ok).toBe(true);
	});

	it('rejects unknown cancel reason', () => {
		const result = parseMethodMessage({
			session_id: 'session-1',
			method: 'permission.cancel',
			params: {channel_request_id: 'abcde', reason: 'whatever'},
		});
		expect(result.ok).toBe(false);
	});
});

describe('parseEventMessage', () => {
	it('accepts a valid permission.verdict', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'permission.verdict',
			params: {channel_request_id: 'abcde', behavior: 'allow'},
		});
		expect(result.ok).toBe(true);
	});

	it('rejects event messages without session_id', () => {
		const result = parseEventMessage({
			event: 'permission.verdict',
			params: {channel_request_id: 'abcde', behavior: 'allow'},
		});
		expect(result.ok).toBe(false);
	});

	it('accepts a valid question.answer', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'question.answer',
			params: {
				channel_request_id: 'abcde',
				answers: {'Which branch?': 'main'},
			},
		});
		expect(result.ok).toBe(true);
	});

	it('rejects question.answer with non-string answers', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'question.answer',
			params: {
				channel_request_id: 'abcde',
				answers: {'Which branch?': 123},
			},
		});
		expect(result.ok).toBe(false);
	});

	it('rejects bad behavior', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'permission.verdict',
			params: {channel_request_id: 'abcde', behavior: 'maybe'},
		});
		expect(result.ok).toBe(false);
	});

	it('accepts log with valid level', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'log',
			params: {level: 'warn', message: 'x'},
		});
		expect(result.ok).toBe(true);
	});

	it('rejects log with invalid level', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'log',
			params: {level: 'fatal', message: 'x'},
		});
		expect(result.ok).toBe(false);
	});

	it('accepts chat.message with sender_id meta', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'chat.message',
			params: {content: 'hi', meta: {sender_id: '12345'}},
		});
		expect(result.ok).toBe(true);
	});

	it('rejects chat.message missing sender_id', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'chat.message',
			params: {content: 'hi', meta: {}},
		});
		expect(result.ok).toBe(false);
	});

	it('rejects chat.message with empty sender_id', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'chat.message',
			params: {content: 'hi', meta: {sender_id: ''}},
		});
		expect(result.ok).toBe(false);
	});

	it('rejects unknown event', () => {
		const result = parseEventMessage({
			session_id: 'session-1',
			event: 'unknown',
			params: {},
		});
		expect(result.ok).toBe(false);
	});
});
