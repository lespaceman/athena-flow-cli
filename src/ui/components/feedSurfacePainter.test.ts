import {describe, test, expect} from 'vitest';
import {paintFeedSurface, type StdoutLike} from './feedSurfacePainter';

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

function getWrittenBuffer(stdout: ReturnType<typeof mockStdout>): string {
	return stdout.written.join('');
}

function assertCursorSaveRestore(buf: string): void {
	expect(buf.startsWith('\x1b7')).toBe(true);
	expect(buf.endsWith('\x1b8')).toBe(true);
}

function parseOps(
	buf: string,
): Array<{row: number; col: number; content: string | null}> {
	const inner = buf.slice('\x1b7'.length, buf.length - '\x1b8'.length);
	const ESC = String.fromCharCode(0x1b);
	const cursorRe = new RegExp(`${ESC}\\[(\\d+);(\\d+)H`, 'g');
	const ops: Array<{row: number; col: number; content: string | null}> = [];
	const matches = Array.from(inner.matchAll(cursorRe));
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i]!;
		const next = matches[i + 1];
		const row = Number.parseInt(match[1]!, 10);
		const col = Number.parseInt(match[2]!, 10);
		if (
			next &&
			Number.parseInt(next[1]!, 10) === row &&
			Number.parseInt(next[2]!, 10) === col
		) {
			const contentStart = next.index! + next[0].length;
			const contentEnd =
				i + 2 < matches.length ? matches[i + 2]!.index! : inner.length;
			ops.push({
				row,
				col,
				content: inner.slice(contentStart, contentEnd),
			});
			i += 1;
			continue;
		}
		ops.push({
			row,
			col,
			content: null,
		});
	}
	return ops;
}

describe('paintFeedSurface', () => {
	const FEED_START = 5;
	const FEED_COL = 7;
	const LINE_WIDTH = 12;

	test('identical buffers produce no stdout write', () => {
		const stdout = mockStdout();
		const lines = ['HEADER', '---', 'row-0', 'row-1'];

		const result = paintFeedSurface(
			lines,
			lines,
			FEED_START,
			FEED_COL,
			LINE_WIDTH,
			stdout,
		);

		expect(result.linesChanged).toBe(0);
		expect(result.linesCleared).toBe(0);
		expect(result.linesRendered).toBe(0);
		expect(stdout.written).toHaveLength(0);
	});

	test('focus move repaints only the old and new focused rows', () => {
		const stdout = mockStdout();
		const prev = ['HEADER', '---', 'row-0', 'ROW-1-FOCUSED', 'row-2'];
		const next = ['HEADER', '---', 'row-0', 'row-1', 'ROW-2-FOCUSED'];

		const result = paintFeedSurface(
			prev,
			next,
			FEED_START,
			FEED_COL,
			LINE_WIDTH,
			stdout,
		);

		expect(result.linesChanged).toBe(2);
		expect(result.linesCleared).toBe(0);

		const buf = getWrittenBuffer(stdout);
		assertCursorSaveRestore(buf);

		expect(parseOps(buf)).toEqual([
			{row: FEED_START + 3, col: FEED_COL, content: 'row-1'},
			{row: FEED_START + 4, col: FEED_COL, content: 'ROW-2-FOCUSED'},
		]);
	});

	test('nonempty-to-empty transition clears only the feed rectangle', () => {
		const stdout = mockStdout();
		const prev = ['HEADER', '---', 'row-0', 'row-1'];

		const result = paintFeedSurface(
			prev,
			[],
			FEED_START,
			FEED_COL,
			LINE_WIDTH,
			stdout,
		);

		expect(result.linesChanged).toBe(0);
		expect(result.linesCleared).toBe(4);
		expect(parseOps(getWrittenBuffer(stdout))).toEqual([
			{row: FEED_START + 0, col: FEED_COL, content: null},
			{row: FEED_START + 1, col: FEED_COL, content: null},
			{row: FEED_START + 2, col: FEED_COL, content: null},
			{row: FEED_START + 3, col: FEED_COL, content: null},
		]);
	});

	test('uses the requested column offset instead of repainting from column 1', () => {
		const stdout = mockStdout();

		paintFeedSurface(
			['old-line'],
			['new-line'],
			FEED_START,
			FEED_COL,
			LINE_WIDTH,
			stdout,
		);

		const ops = parseOps(getWrittenBuffer(stdout));
		expect(ops).toEqual([
			{row: FEED_START, col: FEED_COL, content: 'new-line'},
		]);
		expect(getWrittenBuffer(stdout)).not.toContain(`\x1b[${FEED_START};1H`);
	});

	test('single write call for multiple changed lines', () => {
		const stdout = mockStdout();

		paintFeedSurface(
			['a', 'b', 'c'],
			['x', 'y', 'z'],
			1,
			FEED_COL,
			LINE_WIDTH,
			stdout,
		);

		expect(stdout.written).toHaveLength(1);
	});
});

describe('feedStartRow shift (vertical region move)', () => {
	test('clears the old region and repaints at the new region', () => {
		const stdout = mockStdout();
		const lines = ['HEADER', '---', 'row-0', 'row-1'];
		const oldStart = 5;
		const newStart = 8;
		const col = 4;

		const clearResult = paintFeedSurface(lines, [], oldStart, col, 10, stdout);
		expect(clearResult.linesCleared).toBe(4);

		const repaintResult = paintFeedSurface(
			[],
			lines,
			newStart,
			col,
			10,
			stdout,
		);
		expect(repaintResult.linesChanged).toBe(4);

		for (const op of parseOps(stdout.written[0]!)) {
			expect(op.row).toBeGreaterThanOrEqual(oldStart);
			expect(op.row).toBeLessThan(oldStart + lines.length);
			expect(op.col).toBe(col);
			expect(op.content).toBeNull();
		}

		for (const op of parseOps(stdout.written[1]!)) {
			expect(op.row).toBeGreaterThanOrEqual(newStart);
			expect(op.row).toBeLessThan(newStart + lines.length);
			expect(op.col).toBe(col);
			expect(op.content).not.toBeNull();
		}
	});
});
