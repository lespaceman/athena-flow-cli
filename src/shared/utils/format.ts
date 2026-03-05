import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';
import {parseToolName} from './toolNameParser';

const SIMPLE_ASCII_RE = /^[\x20-\x7E]*$/;
const WIDTH_CACHE_MAX = 2_000;
const WIDTH_CACHE_MAX_TEXT_LENGTH = 512;
const SPACE_CACHE_MAX = 128;
const widthCache = new Map<string, number>();
const spaceCache: string[] = [''];

function cachedStringWidth(text: string): number {
	if (text.length > WIDTH_CACHE_MAX_TEXT_LENGTH) {
		return stringWidth(text);
	}
	const cached = widthCache.get(text);
	if (cached !== undefined) {
		// Promote recently-used keys so oldest entries can be evicted first.
		widthCache.delete(text);
		widthCache.set(text, cached);
		return cached;
	}
	const measured = stringWidth(text);
	widthCache.set(text, measured);
	if (widthCache.size > WIDTH_CACHE_MAX) {
		const oldest = widthCache.keys().next().value;
		if (oldest !== undefined) {
			widthCache.delete(oldest);
		}
	}
	return measured;
}

export function spaces(count: number): string {
	if (count <= 0) return '';
	if (count < SPACE_CACHE_MAX) {
		if (count in spaceCache) {
			return spaceCache[count];
		}
		const generated = ' '.repeat(count);
		spaceCache[count] = generated;
		return generated;
	}
	return ' '.repeat(count);
}

function isSimpleAscii(text: string): boolean {
	return SIMPLE_ASCII_RE.test(text);
}

function fitAscii(text: string, width: number): string {
	if (width <= 0) return '';
	const len = text.length;
	if (len <= width) {
		const pad = width - len;
		return pad > 0 ? text + spaces(pad) : text;
	}
	if (width <= 3) return text.slice(0, width);
	return text.slice(0, width - 3) + '...';
}

export function compactText(value: string, max: number): string {
	const clean = value.replace(/\s+/g, ' ').trim();
	if (max <= 0) return '';
	if (isSimpleAscii(clean)) {
		if (clean.length <= max) return clean;
		if (max <= 3) return clean.slice(0, max);
		return clean.slice(0, max - 3) + '...';
	}
	const w = cachedStringWidth(clean);
	if (w <= max) return clean;
	if (max <= 3) return sliceAnsi(clean, 0, max);
	return sliceAnsi(clean, 0, max - 3) + '...';
}

export function fit(text: string, width: number): string {
	if (isSimpleAscii(text)) {
		return fitAscii(text, width);
	}
	if (width <= 0) return '';
	const w = cachedStringWidth(text);
	if (w <= width) {
		const pad = width - w;
		return pad > 0 ? text + spaces(pad) : text;
	}
	if (width <= 3) return sliceAnsi(text, 0, width);
	return sliceAnsi(text, 0, width - 3) + '...';
}

/**
 * ANSI-aware fit: truncates by visual width while preserving ANSI escape
 * codes and non-ASCII content characters. Uses string-width for measurement
 * and slice-ansi for truncation.
 *
 * Note: string-width may undercount some complex scripts (Devanagari, Tamil)
 * due to terminal rendering inconsistencies. This can cause slight padding
 * misalignment for those characters, but preserves readable content.
 */
export function fitAnsi(text: string, width: number): string {
	// Fast path for plain ASCII text with no ANSI escape sequences.
	if (isSimpleAscii(text)) {
		return fitAscii(text, width);
	}
	if (width <= 0) return '';
	const visualWidth = cachedStringWidth(text);
	if (visualWidth <= width) {
		const pad = width - visualWidth;
		return pad > 0 ? text + spaces(pad) : text;
	}
	if (width <= 3) return sliceAnsi(text, 0, width);
	return sliceAnsi(text, 0, width - 3) + '...';
}

export function formatClock(timestamp: number): string {
	const d = new Date(timestamp);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${hh}:${mm}`;
}

export function formatCount(value: number | null): string {
	if (value === null) return '--';
	return value.toLocaleString('en-US');
}

export function formatSessionLabel(sessionId: string | undefined): string {
	if (!sessionId) return 'S-';
	const tail = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-4);
	return `S${tail || '-'}`;
}

export function formatRunLabel(runId: string | undefined): string {
	if (!runId) return 'R-';
	const direct = runId.match(/^(R\d+)$/i);
	if (direct) return direct[1]!.toUpperCase();
	const tail = runId.replace(/[^a-zA-Z0-9]/g, '').slice(-4);
	return `R${tail || '-'}`;
}

export function actorLabel(actorId: string): string {
	if (actorId === 'user') return 'USER';
	if (actorId === 'agent:root') return 'AGENT';
	if (actorId === 'system') return 'SYSTEM';
	if (actorId.startsWith('subagent:')) {
		return 'SUB-AGENT';
	}
	return compactText(actorId.toUpperCase(), 12);
}

export function summarizeValue(value: unknown): string {
	if (typeof value === 'string') return compactText(JSON.stringify(value), 28);
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (value === null || value === undefined) return String(value);
	if (Array.isArray(value)) return `[${value.length}]`;
	if (typeof value === 'object') return '{...}';
	return compactText(String(value), 20);
}

export function summarizeToolInput(input: Record<string, unknown>): string {
	const entries = Object.entries(input);
	const pairs = entries
		.slice(0, 2)
		.map(([key, value]) => `${key}=${summarizeValue(value)}`);
	const overflow = entries.length - 2;
	if (overflow > 0) {
		pairs.push(`+${overflow}`);
	}
	return pairs.join(' ');
}

export function shortenPath(filePath: string): string {
	const segments = filePath.split('/').filter(Boolean);
	if (segments.length <= 2) return segments.join('/');
	return '…/' + segments.slice(-2).join('/');
}

/** Replace absolute paths in a command string with shortened form. */
export function compactCommandPaths(cmd: string): string {
	return cmd.replace(/\/(?:[\w.@-]+\/){2,}[\w.@-]+/g, match =>
		shortenPath(match),
	);
}

export type StructuredPath = {prefix: string; filename: string};

export function shortenPathStructured(filePath: string): StructuredPath {
	const segments = filePath.split('/').filter(Boolean);
	if (segments.length === 0) return {prefix: '', filename: filePath};
	const filename = segments[segments.length - 1]!;
	if (segments.length === 1) return {prefix: '', filename};
	if (segments.length === 2) return {prefix: segments[0] + '/', filename};
	return {prefix: '…/' + segments[segments.length - 2] + '/', filename};
}

const filePathExtractor = (input: Record<string, unknown>): string =>
	shortenPath(String(input.file_path ?? ''));

const PRIMARY_INPUT_EXTRACTORS: Record<
	string,
	(input: Record<string, unknown>) => string
> = {
	Read: filePathExtractor,
	Write: filePathExtractor,
	Edit: filePathExtractor,
	Bash: input =>
		compactText(compactCommandPaths(String(input.command ?? '')), 96),
	Glob: input => String(input.pattern ?? ''),
	Grep: input => {
		const p = `"${String(input.pattern ?? '')}"`;
		const g = input.glob ? ` ${String(input.glob)}` : '';
		return p + g;
	},
	Task: input => compactText(String(input.description ?? ''), 96),
	WebSearch: input => `"${String(input.query ?? '')}"`,
	WebFetch: input => compactText(String(input.url ?? ''), 96),
	Skill: input => {
		const name = String(input.skill ?? '');
		const colonIdx = name.indexOf(':');
		return compactText(colonIdx >= 0 ? name.slice(colonIdx + 1) : name, 80);
	},
	NotebookEdit: input => {
		const path = String(input.notebook_path ?? '');
		return path ? shortenPath(path) : '';
	},
	AskUserQuestion: input => {
		const questions = input.questions;
		const n = Array.isArray(questions) ? questions.length : 0;
		return `${n} question${n !== 1 ? 's' : ''}`;
	},
};

const eidExtractor = (input: Record<string, unknown>): string => {
	const eid = String(input.eid ?? '');
	return eid ? `eid:${eid.slice(0, 6)}…` : '';
};

/** Extractors keyed by MCP action name (for MCP tools). */
const MCP_INPUT_EXTRACTORS: Record<
	string,
	(input: Record<string, unknown>) => string
> = {
	navigate: input => {
		const url = String(input.url ?? '');
		try {
			const u = new URL(url);
			return u.hostname.replace(/^www\./, '');
		} catch {
			return compactText(url, 96);
		}
	},
	find_elements: input => {
		const parts: string[] = [];
		if (input.kind) parts.push(String(input.kind));
		if (input.label) parts.push(`"${String(input.label)}"`);
		if (parts.length === 0 && input.region) parts.push(String(input.region));
		return parts.join(' ') || 'elements';
	},
	get_element_details: eidExtractor,
	click: eidExtractor,
	type: input => {
		const text = String(input.text ?? '');
		const eid = input.eid ? String(input.eid).slice(0, 5) + '…' : '';
		const quoted = `"${compactText(text, 72)}"`;
		return eid ? `${quoted} → ${eid}` : quoted;
	},
	hover: eidExtractor,
	select: input => {
		const value = String(input.value ?? '');
		return value ? `"${compactText(value, 72)}"` : '';
	},
	press: input => String(input.key ?? ''),
	scroll_page: input => String(input.direction ?? ''),
	take_screenshot: () => '',
	close_session: () => 'session',
	close_page: () => '',
};

export function summarizeToolPrimaryInput(
	toolName: string,
	toolInput: Record<string, unknown>,
): string {
	if (toolName in PRIMARY_INPUT_EXTRACTORS) {
		if (Object.keys(toolInput).length === 0) return '';
		return PRIMARY_INPUT_EXTRACTORS[toolName](toolInput);
	}
	const parsed = parseToolName(toolName);
	if (parsed.isMcp && parsed.mcpAction) {
		if (parsed.mcpAction in MCP_INPUT_EXTRACTORS) {
			return MCP_INPUT_EXTRACTORS[parsed.mcpAction](toolInput);
		}
	}
	if (Object.keys(toolInput).length === 0) return '';
	return summarizeToolInput(toolInput);
}

export const MAX_INPUT_ROWS = 6;
const CURSOR_ON = '\x1b[7m';
const CURSOR_OFF = '\x1b[27m';

/**
 * Maps a flat cursor offset in the original string to a visual (line, col) position.
 * Accounts for `\n` characters that are consumed by wrapText but don't appear in any line.
 */
export function cursorToVisualPosition(
	value: string,
	cursorOffset: number,
	width: number,
): {line: number; col: number; totalLines: number} {
	if (width <= 0) return {line: 0, col: cursorOffset, totalLines: 1};

	const segments = value.split('\n');
	let visualLine = 0;
	let globalOffset = 0;

	for (let s = 0; s < segments.length; s++) {
		const seg = segments[s]!;
		const segEnd = globalOffset + seg.length;

		if (cursorOffset <= segEnd) {
			// Cursor is within this segment
			const posInSeg = cursorOffset - globalOffset;
			const totalLines =
				visualLine + countSegmentVisualLines(segments, s, width);
			if (seg.length === 0) {
				return {line: visualLine, col: 0, totalLines};
			}
			const lineInSeg = Math.min(
				Math.floor(posInSeg / width),
				segmentVisualLines(seg.length, width) - 1,
			);
			const colInLine = posInSeg - lineInSeg * width;
			return {line: visualLine + lineInSeg, col: colInLine, totalLines};
		}

		visualLine += segmentVisualLines(seg.length, width);
		globalOffset = segEnd + 1; // +1 for \n
	}

	// Fallback: cursor at very end
	const totalLines = wrapText(value, width).length;
	return {line: Math.max(0, totalLines - 1), col: 0, totalLines};
}

/** Visual lines occupied by a single segment at the given width. */
function segmentVisualLines(segLen: number, width: number): number {
	return segLen === 0 ? 1 : Math.ceil(segLen / width);
}

/** Count total visual lines from segment index onwards. */
function countSegmentVisualLines(
	segments: string[],
	fromIdx: number,
	width: number,
): number {
	let count = 0;
	for (let i = fromIdx; i < segments.length; i++) {
		count += segmentVisualLines(segments[i]!.length, width);
	}
	return count;
}

/**
 * Maps a visual (line, col) position back to a flat cursor offset in the original string.
 * Inverse of cursorToVisualPosition.
 */
export function visualPositionToOffset(
	value: string,
	targetLine: number,
	targetCol: number,
	width: number,
): number {
	if (width <= 0) return targetCol;

	const segments = value.split('\n');
	let visualLine = 0;
	let globalOffset = 0;

	for (let s = 0; s < segments.length; s++) {
		const seg = segments[s]!;
		const numWrappedLines = segmentVisualLines(seg.length, width);

		if (targetLine < visualLine + numWrappedLines) {
			// Target is within this segment
			const lineInSeg = targetLine - visualLine;
			const lineStart = lineInSeg * width;
			const lineLen = Math.min(width, seg.length - lineStart);
			return globalOffset + lineStart + Math.min(targetCol, lineLen);
		}

		visualLine += numWrappedLines;
		globalOffset += seg.length + 1; // +1 for \n
	}

	return value.length;
}

/**
 * Renders input text with ANSI block cursor, supporting multi-line wrapping.
 * Returns an array of strings (1 to MAX_INPUT_ROWS lines).
 */
export function renderInputLines(
	value: string,
	cursorOffset: number,
	width: number,
	showCursor: boolean,
	placeholder: string,
): string[] {
	if (width <= 0) return [''];

	if (value.length === 0) {
		if (!showCursor) return [fit(placeholder, width)];
		const cursor = `${CURSOR_ON} ${CURSOR_OFF}`;
		return [cursor + fit(placeholder, width - 1)];
	}

	if (!showCursor) {
		const rawLines = wrapText(value, width);
		const visible = rawLines.slice(0, MAX_INPUT_ROWS);
		return visible.map(line => fit(line, width));
	}

	const rawLines = wrapText(value, width);

	// Find which line the cursor is on using newline-aware mapping
	const {line: cursorLine, col: cursorCol} = cursorToVisualPosition(
		value,
		cursorOffset,
		width,
	);

	// Viewport scrolling when more than MAX_INPUT_ROWS
	let viewStart = 0;
	if (rawLines.length > MAX_INPUT_ROWS) {
		viewStart = Math.max(
			0,
			Math.min(
				cursorLine - Math.floor(MAX_INPUT_ROWS / 2),
				rawLines.length - MAX_INPUT_ROWS,
			),
		);
	}
	const visibleLines = rawLines.slice(viewStart, viewStart + MAX_INPUT_ROWS);

	// Render each line, inserting block cursor on the cursor line
	return visibleLines.map((line, i) => {
		const globalIdx = viewStart + i;
		if (globalIdx === cursorLine) {
			const before = line.slice(0, cursorCol);
			const charAtCursor = cursorCol < line.length ? line[cursorCol] : ' ';
			const after = cursorCol < line.length ? line.slice(cursorCol + 1) : '';
			const rendered = `${before}${CURSOR_ON}${charAtCursor}${CURSOR_OFF}${after}`;
			return fitAnsi(rendered, width);
		}
		return fit(line, width);
	});
}

export function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const lines: string[] = [];
	for (const segment of text.split('\n')) {
		if (segment.length === 0) {
			lines.push('');
			continue;
		}
		for (let i = 0; i < segment.length; i += width) {
			lines.push(segment.slice(i, i + width));
		}
	}
	return lines;
}

/**
 * Compute the number of visual rows an input value occupies at the given width.
 * Result is clamped between 1 and MAX_INPUT_ROWS.
 */
export function computeInputRows(value: string, width: number): number {
	if (!value || width <= 0) return 1;
	return Math.max(1, Math.min(wrapText(value, width).length, MAX_INPUT_ROWS));
}

export function formatInputBuffer(
	value: string,
	cursorOffset: number,
	width: number,
	showCursor: boolean,
	placeholder: string,
): string {
	if (width <= 0) return '';
	if (value.length === 0) {
		if (!showCursor) return fit(placeholder, width);
		return fit(`|${placeholder}`, width);
	}

	if (!showCursor) {
		return fit(value, width);
	}

	const withCursor =
		value.slice(0, cursorOffset) + '|' + value.slice(cursorOffset);
	if (withCursor.length <= width) return withCursor.padEnd(width, ' ');

	const desiredStart = Math.max(0, cursorOffset + 1 - Math.floor(width * 0.65));
	const start = Math.min(desiredStart, withCursor.length - width);
	return fit(withCursor.slice(start, start + width), width);
}

/** True when value is a slash-command prefix (starts with `/`, no spaces yet). */
export function isCommandPrefix(value: string): boolean {
	return value.startsWith('/') && !value.includes(' ');
}
