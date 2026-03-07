import {describe, test, expect} from 'vitest';
import {paintFeedSurface, type StdoutLike} from './feedSurfacePainter';

// ── Helpers ────────────────────────────────────────────────────────

/** Create a mock stdout that captures all written data. */
function mockStdout(): StdoutLike & {written: string[]} {
	const written: string[] = [];
	return {
		written,
		write(data: string) {
			written.push(data);
			return true;
		},
	};
}

/** Extract the raw content written between save/restore cursor sequences. */
function getWrittenBuffer(stdout: ReturnType<typeof mockStdout>): string {
	return stdout.written.join('');
}

/** Check that save/restore cursor bookend the write. */
function assertCursorSaveRestore(buf: string): void {
	expect(buf.startsWith('\x1b7')).toBe(true);
	expect(buf.endsWith('\x1b8')).toBe(true);
}

/**
 * Parse the written buffer into individual operations.
 * Each operation is a cursor-move + clear-line + optional content.
 */
function parseOps(buf: string): Array<{row: number; content: string | null}> {
	// Strip save/restore cursor
	const inner = buf.slice('\x1b7'.length, buf.length - '\x1b8'.length);

	const ops: Array<{row: number; content: string | null}> = [];
	// Pattern: ESC[row;1H ESC[2K (optional content until next ESC or end)
	const ESC = String.fromCharCode(0x1b);

	const regex = new RegExp(`${ESC}\\[(\\d+);1H${ESC}\\[2K([^${ESC}]*)`, 'g');
	let match: RegExpExecArray | null;
	while ((match = regex.exec(inner)) !== null) {
		const row = parseInt(match[1]!, 10);
		const content = match[2]!;
		ops.push({row, content: content.length > 0 ? content : null});
	}
	return ops;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('paintFeedSurface', () => {
	const FEED_START = 5; // Feed starts at terminal row 5

	test('identical buffers produce no stdout write', () => {
		const stdout = mockStdout();
		const lines = ['HEADER', '---', 'row-0', 'row-1'];

		const result = paintFeedSurface(lines, lines, FEED_START, stdout);

		expect(result.linesChanged).toBe(0);
		expect(result.linesCleared).toBe(0);
		expect(result.linesRendered).toBe(0);
		expect(stdout.written).toHaveLength(0);
	});

	test('focus move repaints only the old and new focused rows', () => {
		const stdout = mockStdout();
		const prev = ['HEADER', '---', 'row-0', 'ROW-1-FOCUSED', 'row-2'];
		const next = ['HEADER', '---', 'row-0', 'row-1', 'ROW-2-FOCUSED'];

		const result = paintFeedSurface(prev, next, FEED_START, stdout);

		expect(result.linesChanged).toBe(2);
		expect(result.linesCleared).toBe(0);

		const buf = getWrittenBuffer(stdout);
		assertCursorSaveRestore(buf);

		const ops = parseOps(buf);
		expect(ops).toHaveLength(2);
		// Rows are 1-based: FEED_START + index
		expect(ops[0]).toEqual({row: FEED_START + 3, content: 'row-1'});
		expect(ops[1]).toEqual({row: FEED_START + 4, content: 'ROW-2-FOCUSED'});
	});

	test('header update repaints header lines only', () => {
		const stdout = mockStdout();
		const body = ['row-0', 'row-1', 'row-2'];
		const prev = ['HEADER-v1', '---', ...body];
		const next = ['HEADER-v2', '---', ...body];

		const result = paintFeedSurface(prev, next, FEED_START, stdout);

		expect(result.linesChanged).toBe(1);
		expect(result.linesCleared).toBe(0);

		const ops = parseOps(getWrittenBuffer(stdout));
		expect(ops).toHaveLength(1);
		expect(ops[0]).toEqual({row: FEED_START + 0, content: 'HEADER-v2'});
	});

	test('empty-to-nonempty transition paints all new lines', () => {
		const stdout = mockStdout();
		const prev: string[] = [];
		const next = ['HEADER', '---', 'row-0', 'row-1'];

		const result = paintFeedSurface(prev, next, FEED_START, stdout);

		expect(result.linesChanged).toBe(4);
		expect(result.linesCleared).toBe(0);

		const ops = parseOps(getWrittenBuffer(stdout));
		expect(ops).toHaveLength(4);
		expect(ops[0]).toEqual({row: FEED_START + 0, content: 'HEADER'});
		expect(ops[1]).toEqual({row: FEED_START + 1, content: '---'});
		expect(ops[2]).toEqual({row: FEED_START + 2, content: 'row-0'});
		expect(ops[3]).toEqual({row: FEED_START + 3, content: 'row-1'});
	});

	test('nonempty-to-empty transition clears all stale lines', () => {
		const stdout = mockStdout();
		const prev = ['HEADER', '---', 'row-0', 'row-1'];
		const next: string[] = [];

		const result = paintFeedSurface(prev, next, FEED_START, stdout);

		expect(result.linesChanged).toBe(0);
		expect(result.linesCleared).toBe(4);

		const ops = parseOps(getWrittenBuffer(stdout));
		expect(ops).toHaveLength(4);
		// All should be clear-only (no content)
		for (let i = 0; i < 4; i++) {
			expect(ops[i]).toEqual({row: FEED_START + i, content: null});
		}
	});

	test('resize shorter clears trailing lines', () => {
		const stdout = mockStdout();
		const prev = ['HEADER', '---', 'row-0', 'row-1', 'row-2', 'row-3'];
		const next = ['HEADER', '---', 'row-0', 'row-1'];

		const result = paintFeedSurface(prev, next, FEED_START, stdout);

		expect(result.linesChanged).toBe(0);
		expect(result.linesCleared).toBe(2);

		const ops = parseOps(getWrittenBuffer(stdout));
		expect(ops).toHaveLength(2);
		// Cleared lines at indexes 4 and 5
		expect(ops[0]).toEqual({row: FEED_START + 4, content: null});
		expect(ops[1]).toEqual({row: FEED_START + 5, content: null});
	});

	test('resize taller paints only newly exposed lines plus changed content', () => {
		const stdout = mockStdout();
		const prev = ['HEADER', '---', 'row-0'];
		const next = ['HEADER', '---', 'ROW-0-CHANGED', 'row-1-new', 'row-2-new'];

		const result = paintFeedSurface(prev, next, FEED_START, stdout);

		// Index 2 changed content, indexes 3 and 4 are new
		expect(result.linesChanged).toBe(3);
		expect(result.linesCleared).toBe(0);

		const ops = parseOps(getWrittenBuffer(stdout));
		expect(ops).toHaveLength(3);
		expect(ops[0]).toEqual({row: FEED_START + 2, content: 'ROW-0-CHANGED'});
		expect(ops[1]).toEqual({row: FEED_START + 3, content: 'row-1-new'});
		expect(ops[2]).toEqual({row: FEED_START + 4, content: 'row-2-new'});
	});

	test('resize taller with no content change paints only new lines', () => {
		const stdout = mockStdout();
		const prev = ['HEADER', '---', 'row-0', 'row-1'];
		const next = ['HEADER', '---', 'row-0', 'row-1', 'row-2', 'row-3'];

		const result = paintFeedSurface(prev, next, FEED_START, stdout);

		expect(result.linesChanged).toBe(2);
		expect(result.linesCleared).toBe(0);

		const ops = parseOps(getWrittenBuffer(stdout));
		expect(ops).toHaveLength(2);
		expect(ops[0]).toEqual({row: FEED_START + 4, content: 'row-2'});
		expect(ops[1]).toEqual({row: FEED_START + 5, content: 'row-3'});
	});

	test('cursor position uses feedStartRow offset correctly', () => {
		const stdout = mockStdout();
		const startRow = 10;
		const prev = ['old-line'];
		const next = ['new-line'];

		paintFeedSurface(prev, next, startRow, stdout);

		const ops = parseOps(getWrittenBuffer(stdout));
		expect(ops).toHaveLength(1);
		expect(ops[0]!.row).toBe(10); // startRow + 0
	});

	test('single write call for multiple changed lines', () => {
		const stdout = mockStdout();
		const prev = ['a', 'b', 'c'];
		const next = ['x', 'y', 'z'];

		paintFeedSurface(prev, next, 1, stdout);

		// Should be exactly one write call (batched)
		expect(stdout.written).toHaveLength(1);
	});

	test('combined shrink with content change', () => {
		const stdout = mockStdout();
		const prev = ['H', 'D', 'A', 'B', 'C'];
		const next = ['H', 'D', 'X'];

		const result = paintFeedSurface(prev, next, FEED_START, stdout);

		expect(result.linesChanged).toBe(1); // A -> X
		expect(result.linesCleared).toBe(2); // B, C cleared
		expect(result.linesRendered).toBe(3);

		const ops = parseOps(getWrittenBuffer(stdout));
		expect(ops).toHaveLength(3);
		// Changed line
		expect(ops[0]).toEqual({row: FEED_START + 2, content: 'X'});
		// Cleared lines
		expect(ops[1]).toEqual({row: FEED_START + 3, content: null});
		expect(ops[2]).toEqual({row: FEED_START + 4, content: null});
	});

	test('linesRendered equals linesChanged + linesCleared', () => {
		const stdout = mockStdout();
		const prev = ['a', 'b', 'c', 'd'];
		const next = ['a', 'X', 'Y'];

		const result = paintFeedSurface(prev, next, 1, stdout);

		expect(result.linesRendered).toBe(
			result.linesChanged + result.linesCleared,
		);
	});
});

describe('feedStartRow shift (vertical region move)', () => {
	test('unchanged content at new feedStartRow must clear old position and repaint at new position', () => {
		const stdout = mockStdout();
		const lines = ['HEADER', '---', 'row-0', 'row-1'];
		const OLD_START = 5;
		const NEW_START = 8;

		// Simulate what IncrementalFeedSurface does when feedStartRow changes:
		// 1. Clear all lines at the old position
		const clearResult = paintFeedSurface(lines, [], OLD_START, stdout);
		expect(clearResult.linesCleared).toBe(4);

		// 2. Repaint everything at the new position (prev = empty)
		const repaintResult = paintFeedSurface([], lines, NEW_START, stdout);
		expect(repaintResult.linesChanged).toBe(4);

		// Verify the clear operations target old rows
		const clearBuf = stdout.written[0]!;
		const clearOps = parseOps(clearBuf);
		for (const op of clearOps) {
			expect(op.row).toBeGreaterThanOrEqual(OLD_START);
			expect(op.row).toBeLessThan(OLD_START + lines.length);
			expect(op.content).toBeNull(); // cleared, no content
		}

		// Verify the repaint operations target new rows
		const repaintBuf = stdout.written[1]!;
		const repaintOps = parseOps(repaintBuf);
		for (const op of repaintOps) {
			expect(op.row).toBeGreaterThanOrEqual(NEW_START);
			expect(op.row).toBeLessThan(NEW_START + lines.length);
			expect(op.content).not.toBeNull(); // content written
		}
	});

	test('partially changed content at new feedStartRow clears old and repaints all at new', () => {
		const stdout = mockStdout();
		const prevLines = ['HEADER', '---', 'row-0', 'row-1'];
		const nextLines = ['HEADER', '---', 'row-0', 'row-1-CHANGED'];
		const OLD_START = 5;
		const NEW_START = 8;

		// 1. Clear at old position
		paintFeedSurface(prevLines, [], OLD_START, stdout);

		// 2. Full repaint at new position (not a diff — everything is "new")
		const result = paintFeedSurface([], nextLines, NEW_START, stdout);
		expect(result.linesChanged).toBe(4); // All 4 lines painted, not just the 1 that changed

		const repaintOps = parseOps(stdout.written[1]!);
		expect(repaintOps).toHaveLength(4);
		expect(repaintOps[0]!.row).toBe(NEW_START);
		expect(repaintOps[3]!.row).toBe(NEW_START + 3);
	});
});
