import {describe, it, expect} from 'vitest';
import {createTokenAccumulator} from './tokenAccumulator';

/** Build a newline-terminated NDJSON line from a stream event. */
function line(event: Record<string, unknown>): string {
	return JSON.stringify(event) + '\n';
}

/** Shorthand for a raw API message event with usage. */
function messageLine(
	usage: Record<string, number>,
	extra?: Record<string, unknown>,
): string {
	return line({type: 'message', usage, ...extra});
}

/** Shorthand for a CLI envelope assistant event with usage. */
function assistantLine(
	usage: Record<string, number>,
	extra?: Record<string, unknown>,
): string {
	return line({
		type: 'assistant',
		message: {type: 'message', usage},
		...extra,
	});
}

/** Shorthand for a result event with usage. */
function resultLine(usage: Record<string, number>): string {
	return line({type: 'result', usage});
}

function streamEventLine(event: Record<string, unknown>): string {
	return line({type: 'stream_event', event});
}

const USAGE_A = {
	input_tokens: 100,
	output_tokens: 50,
	cache_read_input_tokens: 10,
	cache_creation_input_tokens: 5,
};

const USAGE_B = {
	input_tokens: 200,
	output_tokens: 80,
	cache_read_input_tokens: 1000,
	cache_creation_input_tokens: 0,
};

describe('createTokenAccumulator', () => {
	it('returns null fields when no data has been fed', () => {
		const acc = createTokenAccumulator();
		const usage = acc.getUsage();

		expect(usage.input).toBeNull();
		expect(usage.output).toBeNull();
		expect(usage.total).toBeNull();
	});

	it('accumulates tokens from message objects across turns', () => {
		const acc = createTokenAccumulator();

		acc.feed(messageLine(USAGE_A));

		let usage = acc.getUsage();
		expect(usage.input).toBe(100);
		expect(usage.output).toBe(50);
		expect(usage.cacheRead).toBe(10);
		expect(usage.cacheWrite).toBe(5);
		expect(usage.total).toBe(165);

		acc.feed(messageLine(USAGE_B));

		usage = acc.getUsage();
		expect(usage.input).toBe(300);
		expect(usage.output).toBe(130);
		expect(usage.cacheRead).toBe(1010);
		expect(usage.cacheWrite).toBe(5);
		expect(usage.total).toBe(1445);
	});

	it('replaces totals from result objects (cumulative)', () => {
		const acc = createTokenAccumulator();

		acc.feed(messageLine({input_tokens: 100, output_tokens: 50}));
		acc.feed(
			resultLine({
				input_tokens: 500,
				output_tokens: 200,
				cache_read_input_tokens: 30,
				cache_creation_input_tokens: 10,
			}),
		);

		const usage = acc.getUsage();
		expect(usage.input).toBe(500);
		expect(usage.output).toBe(200);
		expect(usage.cacheRead).toBe(30);
		expect(usage.cacheWrite).toBe(10);
		expect(usage.total).toBe(740);
	});

	it('handles partial lines across chunks', () => {
		const acc = createTokenAccumulator();
		const fullLine = JSON.stringify({
			type: 'message',
			usage: {input_tokens: 42, output_tokens: 18},
		});

		const half = Math.floor(fullLine.length / 2);
		acc.feed(fullLine.slice(0, half));
		acc.feed(fullLine.slice(half) + '\n');

		expect(acc.getUsage().input).toBe(42);
		expect(acc.getUsage().output).toBe(18);
	});

	it('handles multiple lines in a single chunk', () => {
		const acc = createTokenAccumulator();

		acc.feed(
			messageLine({input_tokens: 10, output_tokens: 5}) +
				messageLine({input_tokens: 20, output_tokens: 8}),
		);

		expect(acc.getUsage().input).toBe(30);
		expect(acc.getUsage().output).toBe(13);
	});

	it('ignores non-message types and invalid JSON', () => {
		const acc = createTokenAccumulator();

		acc.feed('not valid json\n');
		acc.feed(line({type: 'ping'}));
		acc.feed(line({type: 'content_block_delta', delta: {text: 'hello'}}));

		expect(acc.getUsage().total).toBeNull();
	});

	it('captures root context usage from partial stream events before final message usage arrives', () => {
		const acc = createTokenAccumulator();

		acc.feed(
			streamEventLine({
				type: 'message_start',
				message: {
					usage: {
						input_tokens: 2048,
						cache_read_input_tokens: 8192,
						cache_creation_input_tokens: 256,
					},
				},
			}),
		);

		const usage = acc.getUsage();
		expect(usage.input).toBeNull();
		expect(usage.total).toBeNull();
		expect(usage.contextSize).toBe(2048 + 8192 + 256);
	});

	it('flush processes remaining buffered data', () => {
		const acc = createTokenAccumulator();

		// Feed without trailing newline — not yet processed
		acc.feed(
			JSON.stringify({
				type: 'message',
				usage: {input_tokens: 77, output_tokens: 33},
			}),
		);
		expect(acc.getUsage().total).toBeNull();

		acc.flush();
		expect(acc.getUsage().input).toBe(77);
		expect(acc.getUsage().output).toBe(33);
	});

	it('reset clears all state', () => {
		const acc = createTokenAccumulator();

		acc.feed(messageLine({input_tokens: 100, output_tokens: 50}));
		expect(acc.getUsage().total).toBe(150);

		acc.reset();
		expect(acc.getUsage().total).toBeNull();
	});

	it('extracts usage from assistant CLI envelope events', () => {
		const acc = createTokenAccumulator();

		acc.feed(
			assistantLine({
				input_tokens: 3,
				output_tokens: 23,
				cache_read_input_tokens: 23170,
				cache_creation_input_tokens: 11540,
			}),
		);

		const usage = acc.getUsage();
		expect(usage.input).toBe(3);
		expect(usage.output).toBe(23);
		expect(usage.cacheRead).toBe(23170);
		expect(usage.cacheWrite).toBe(11540);
		expect(usage.contextSize).toBe(3 + 23170 + 11540);
	});

	it('accumulates tokens across multiple assistant envelope events', () => {
		const acc = createTokenAccumulator();

		acc.feed(
			assistantLine({
				input_tokens: 100,
				output_tokens: 50,
				cache_read_input_tokens: 500,
				cache_creation_input_tokens: 20,
			}),
		);
		acc.feed(assistantLine(USAGE_B));

		const usage = acc.getUsage();
		expect(usage.input).toBe(300);
		expect(usage.output).toBe(130);
		expect(usage.cacheRead).toBe(1500);
		expect(usage.cacheWrite).toBe(20);
		// contextSize tracks latest turn only
		expect(usage.contextSize).toBe(200 + 1000 + 0);
	});

	describe('contextWindowSize extraction', () => {
		it('extracts contextWindowSize from message_start model', () => {
			const acc = createTokenAccumulator();
			acc.feed(
				JSON.stringify({
					type: 'stream_event',
					event: {
						type: 'message_start',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: {input_tokens: 1000, cache_read_input_tokens: 200},
						},
					},
				}) + '\n',
			);
			expect(acc.getUsage().contextWindowSize).toBe(200_000);
		});

		it('resolves 1M context window for extended context models', () => {
			const acc = createTokenAccumulator();
			acc.feed(
				JSON.stringify({
					type: 'stream_event',
					event: {
						type: 'message_start',
						message: {
							model: 'claude-opus-4-20250514[1m]',
							usage: {input_tokens: 500},
						},
					},
				}) + '\n',
			);
			expect(acc.getUsage().contextWindowSize).toBe(1_000_000);
		});

		it('preserves contextWindowSize across reset()', () => {
			const acc = createTokenAccumulator();
			acc.feed(
				JSON.stringify({
					type: 'stream_event',
					event: {
						type: 'message_start',
						message: {
							model: 'claude-sonnet-4-20250514',
							usage: {input_tokens: 1000},
						},
					},
				}) + '\n',
			);
			expect(acc.getUsage().contextWindowSize).toBe(200_000);
			acc.reset();
			expect(acc.getUsage().contextWindowSize).toBe(200_000);
		});
	});

	describe('contextSize tracking', () => {
		it('updates to latest per-turn value', () => {
			const acc = createTokenAccumulator();

			acc.feed(
				messageLine({
					input_tokens: 100,
					output_tokens: 50,
					cache_read_input_tokens: 500,
					cache_creation_input_tokens: 20,
				}),
			);
			expect(acc.getUsage().contextSize).toBe(620);

			acc.feed(messageLine(USAGE_B));
			expect(acc.getUsage().contextSize).toBe(1200);
		});

		it('includes input_tokens even without cache tokens', () => {
			const acc = createTokenAccumulator();
			acc.feed(messageLine({input_tokens: 100, output_tokens: 50}));
			expect(acc.getUsage().contextSize).toBe(100);
		});

		it('result does not overwrite per-turn contextSize', () => {
			const acc = createTokenAccumulator();

			acc.feed(assistantLine(USAGE_B));
			expect(acc.getUsage().contextSize).toBe(1200);

			acc.feed(
				resultLine({
					input_tokens: 500,
					output_tokens: 200,
					cache_read_input_tokens: 5000,
					cache_creation_input_tokens: 100,
				}),
			);
			expect(acc.getUsage().contextSize).toBe(1200);
		});

		it('result sets contextSize when no prior per-turn data exists', () => {
			const acc = createTokenAccumulator();

			acc.feed(
				resultLine({
					input_tokens: 3,
					output_tokens: 23,
					cache_read_input_tokens: 23170,
					cache_creation_input_tokens: 11540,
				}),
			);
			expect(acc.getUsage().contextSize).toBe(3 + 23170 + 11540);
		});

		it('subagent assistant events do not overwrite contextSize', () => {
			const acc = createTokenAccumulator();

			acc.feed(
				assistantLine({
					input_tokens: 5000,
					output_tokens: 200,
					cache_read_input_tokens: 140000,
					cache_creation_input_tokens: 5000,
				}),
			);
			expect(acc.getUsage().contextSize).toBe(150000);

			// Subagent has parent_tool_use_id — should not affect contextSize
			acc.feed(
				assistantLine(
					{
						input_tokens: 500,
						output_tokens: 50,
						cache_read_input_tokens: 2000,
						cache_creation_input_tokens: 0,
					},
					{parent_tool_use_id: 'toolu_abc123'},
				),
			);
			expect(acc.getUsage().contextSize).toBe(150000);

			// Tokens still accumulate from subagent
			expect(acc.getUsage().input).toBe(5500);
			expect(acc.getUsage().output).toBe(250);
		});

		it('subagent raw message events do not overwrite contextSize', () => {
			const acc = createTokenAccumulator();

			acc.feed(
				messageLine({
					input_tokens: 100000,
					output_tokens: 500,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				}),
			);
			expect(acc.getUsage().contextSize).toBe(100000);

			acc.feed(
				messageLine(
					{
						input_tokens: 1000,
						output_tokens: 100,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
					{parent_tool_use_id: 'toolu_xyz789'},
				),
			);
			expect(acc.getUsage().contextSize).toBe(100000);
		});

		it('subagent partial stream events do not overwrite contextSize', () => {
			const acc = createTokenAccumulator();

			acc.feed(
				streamEventLine({
					type: 'message_start',
					message: {
						usage: {
							input_tokens: 100000,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			);
			expect(acc.getUsage().contextSize).toBe(100000);

			acc.feed(
				line({
					type: 'stream_event',
					parent_tool_use_id: 'toolu_sub',
					event: {
						type: 'message_start',
						message: {
							usage: {
								input_tokens: 1000,
								cache_read_input_tokens: 500,
								cache_creation_input_tokens: 0,
							},
						},
					},
				}),
			);
			expect(acc.getUsage().contextSize).toBe(100000);
		});
	});
});
