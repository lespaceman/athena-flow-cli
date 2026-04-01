/**
 * Parses Claude Code's stream-json stdout for tool result events.
 *
 * Claude Code outputs NDJSON when run with `--output-format stream-json`.
 * This parser extracts tool_result entries and emits them so the runtime
 * can translate them into tool.delta RuntimeEvents.
 *
 * Only handles tool-related events — token usage and assistant messages
 * are parsed elsewhere (tokenAccumulator, assistantMessageAccumulator).
 */

export type StreamToolResult = {
	tool_use_id: string | undefined;
	tool_name: string | undefined;
	content: string;
};

type StreamToolResultCallback = (result: StreamToolResult) => void;

type StreamJsonMessage = {
	type?: string;
	role?: string;
	tool_use_id?: string;
	content?: unknown;
	subtype?: string;
	name?: string;
	// Nested message envelope (type: "assistant" wraps message)
	message?: {
		role?: string;
		content?: unknown[];
		[key: string]: unknown;
	};
	event?: StreamJsonMessage;
	[key: string]: unknown;
};

/**
 * Extract text from a tool_result content field.
 * Content can be a string or an array of content blocks.
 */
function extractResultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === 'object' && block !== null) {
			const rec = block as Record<string, unknown>;
			if (rec['type'] === 'text' && typeof rec['text'] === 'string') {
				parts.push(rec['text']);
			}
		}
	}
	return parts.join('\n');
}

/**
 * Track active tool uses so we can resolve tool_name for tool_result events.
 * stream-json outputs assistant messages with tool_use content blocks before
 * the corresponding tool_result events.
 */
export function createStreamJsonToolParser(
	onToolResult: StreamToolResultCallback,
) {
	let buffer = '';
	const toolNameById = new Map<string, string>();

	function processLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;

		let parsed: StreamJsonMessage;
		try {
			parsed = JSON.parse(trimmed) as StreamJsonMessage;
		} catch {
			return;
		}

		const record =
			parsed.type === 'stream_event' && parsed.event ? parsed.event : parsed;

		// Track tool_use blocks from assistant messages to resolve tool names
		// Format: {type: "assistant", message: {content: [{type: "tool_use", id, name, ...}]}}
		// or: {type: "message", role: "assistant", content: [{type: "tool_use", id, name, ...}]}
		const contentBlocks =
			(record.type === 'assistant'
				? record.message?.content
				: record.type === 'message' && record.role === 'assistant'
					? (record.content as unknown[] | undefined)
					: undefined) ?? [];

		for (const block of contentBlocks) {
			if (typeof block !== 'object' || block === null) continue;
			const rec = block as Record<string, unknown>;
			if (
				rec['type'] === 'tool_use' &&
				typeof rec['id'] === 'string' &&
				typeof rec['name'] === 'string'
			) {
				toolNameById.set(rec['id'], rec['name']);
			}
		}

		// Emit tool_result events
		if (record.type === 'tool_result') {
			const toolUseId =
				typeof record.tool_use_id === 'string' ? record.tool_use_id : undefined;
			const text = extractResultText(record.content);
			if (text) {
				onToolResult({
					tool_use_id: toolUseId,
					tool_name: toolUseId ? toolNameById.get(toolUseId) : undefined,
					content: text,
				});
			}
		}
	}

	return {
		feed(chunk: string): void {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				processLine(line);
			}
		},
		flush(): void {
			if (buffer.trim()) {
				processLine(buffer);
				buffer = '';
			}
		},
	};
}
