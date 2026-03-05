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

		// Quick stat check to avoid opening the file when nothing new was appended
		try {
			const stat = fs.statSync(transcriptPath);
			if (stat.size <= offset) return [];
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
			const stat = fs.fstatSync(fd);
			if (stat.size <= offset) return [];

			const buf = Buffer.alloc(stat.size - offset);
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

					if (typeof content === 'string') {
						if (content.trim()) {
							messages.push({text: content, timestamp: entry.timestamp});
						}
						continue;
					}

					// content is an array — extract text blocks
					const textParts = (content as TranscriptTextContent[])
						.filter((c): c is TranscriptTextContent => c.type === 'text')
						.map(c => c.text)
						.filter(t => t.trim().length > 0);

					if (textParts.length > 0) {
						messages.push({
							text: textParts.join('\n'),
							timestamp: entry.timestamp,
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
