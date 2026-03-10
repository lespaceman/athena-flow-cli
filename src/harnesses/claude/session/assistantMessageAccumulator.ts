type StreamMessageRecord = Record<string, unknown>;

function asRecord(value: unknown): StreamMessageRecord | null {
	if (typeof value === 'object' && value !== null) {
		return value as StreamMessageRecord;
	}
	return null;
}

function readAssistantText(message: StreamMessageRecord): string | null {
	if (message['role'] !== 'assistant') return null;
	const content = message['content'];
	if (!Array.isArray(content)) return null;

	const parts: string[] = [];
	for (const block of content) {
		const rec = asRecord(block);
		if (!rec || rec['type'] !== 'text') continue;
		if (typeof rec['text'] === 'string' && rec['text'].length > 0) {
			parts.push(rec['text']);
		}
	}

	return parts.length > 0 ? parts.join('') : null;
}

export function createAssistantMessageAccumulator() {
	let buffer = '';
	let lastMessage: string | null = null;

	function processLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line.trim());
		} catch {
			return;
		}

		const record = asRecord(parsed);
		if (!record || record['parent_tool_use_id'] != null) {
			return;
		}

		let nextMessage: string | null = null;
		if (record['type'] === 'assistant') {
			nextMessage = readAssistantText(asRecord(record['message']) ?? {});
		} else if (record['type'] === 'message') {
			nextMessage = readAssistantText(record);
		}

		if (nextMessage && nextMessage.trim().length > 0) {
			lastMessage = nextMessage;
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
			if (!buffer.trim()) return;
			processLine(buffer);
			buffer = '';
		},
		getLastMessage(): string | null {
			return lastMessage;
		},
		reset(): void {
			buffer = '';
			lastMessage = null;
		},
	};
}
