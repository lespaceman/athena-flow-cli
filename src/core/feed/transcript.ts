// src/feed/transcript.ts
//
// Incremental transcript reader — extracts new assistant text messages
// from Claude Code's JSONL transcript file using byte-offset tracking.

import * as fs from 'node:fs';
import type {
	TranscriptEntry,
	TranscriptTextContent,
} from '../../shared/types/transcript';

export type TranscriptMessage = {
	text: string;
	timestamp?: string;
	model?: string;
};

export type TranscriptReader = {
	readNewAssistantMessages(transcriptPath: string): TranscriptMessage[];
	/** Exposed for testing */
	getOffset(transcriptPath: string): number;
};

export function createTranscriptReader(): TranscriptReader {
	const offsets = new Map<string, number>();

	function readNewAssistantMessages(
		transcriptPath: string,
	): TranscriptMessage[] {
		const offset = offsets.get(transcriptPath) ?? 0;

		// Quick stat to avoid opening the file when nothing new was appended
		let fileSize: number;
		try {
			fileSize = fs.statSync(transcriptPath).size;
			if (fileSize <= offset) return [];
		} catch {
			return [];
		}

		let fd: number;
		try {
			fd = fs.openSync(transcriptPath, 'r');
		} catch {
			return [];
		}

		try {
			const buf = Buffer.alloc(fileSize - offset);
			const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
			offsets.set(transcriptPath, offset + bytesRead);

			const chunk = buf.toString('utf8', 0, bytesRead);
			const lines = chunk.split('\n').filter(l => l.trim().length > 0);

			const messages: TranscriptMessage[] = [];
			for (const line of lines) {
				try {
					const entry = JSON.parse(line) as TranscriptEntry;
					if (entry.type !== 'assistant') continue;

					const content = entry.message?.content;
					if (!content) continue;

					const messageRecord = entry.message as
						| Record<string, unknown>
						| undefined;
					const model =
						typeof messageRecord?.['model'] === 'string'
							? (messageRecord['model'] as string)
							: undefined;

					if (typeof content === 'string') {
						if (content.trim()) {
							messages.push({
								text: content,
								timestamp: entry.timestamp,
								model,
							});
						}
						continue;
					}

					// content is an array — extract text blocks
					const textParts = content
						.filter((c): c is TranscriptTextContent => c.type === 'text')
						.map(c => c.text)
						.filter(t => t.trim().length > 0);

					if (textParts.length > 0) {
						messages.push({
							text: textParts.join('\n'),
							timestamp: entry.timestamp,
							model,
						});
					}
				} catch {
					// Skip malformed lines
				}
			}

			return messages;
		} finally {
			fs.closeSync(fd);
		}
	}

	function getOffset(transcriptPath: string): number {
		return offsets.get(transcriptPath) ?? 0;
	}

	return {readNewAssistantMessages, getOffset};
}
