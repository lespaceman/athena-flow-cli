import {describe, expect, it, vi} from 'vitest';
import {createStreamJsonToolParser} from './streamJsonToolParser';

describe('createStreamJsonToolParser', () => {
	it('extracts tool results from top-level stream-json records', () => {
		const onToolResult = vi.fn();
		const parser = createStreamJsonToolParser(onToolResult);

		parser.feed(
			JSON.stringify({
				type: 'message',
				role: 'assistant',
				content: [{type: 'tool_use', id: 'tool-1', name: 'browser'}],
			}) + '\n',
		);
		parser.feed(
			JSON.stringify({
				type: 'tool_result',
				tool_use_id: 'tool-1',
				content: [{type: 'text', text: 'hello'}],
			}) + '\n',
		);

		expect(onToolResult).toHaveBeenCalledWith({
			tool_use_id: 'tool-1',
			tool_name: 'browser',
			content: 'hello',
		});
	});

	it('unwraps stream_event envelopes emitted by include-partial-messages mode', () => {
		const onToolResult = vi.fn();
		const parser = createStreamJsonToolParser(onToolResult);

		parser.feed(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'message',
					role: 'assistant',
					content: [{type: 'tool_use', id: 'tool-2', name: 'search'}],
				},
			}) + '\n',
		);
		parser.feed(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'tool_result',
					tool_use_id: 'tool-2',
					content: [{type: 'text', text: 'partial output'}],
				},
			}) + '\n',
		);

		expect(onToolResult).toHaveBeenCalledWith({
			tool_use_id: 'tool-2',
			tool_name: 'search',
			content: 'partial output',
		});
	});
});
