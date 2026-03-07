import {describe, test, expect} from 'vitest';
import {diffFeedSurface} from './feedSurfaceDiff';

// ── Helpers ────────────────────────────────────────────────────────

/** Build a simple viewport: header + divider + N body rows. */
function makeLines(header: string, body: string[]): string[] {
	return [header, '---divider---', ...body];
}

// ── Tests ──────────────────────────────────────────────────────────

describe('diffFeedSurface', () => {
	test('identical arrays produce no changes', () => {
		const lines = makeLines('HEADER', ['row-0', 'row-1', 'row-2']);
		const diff = diffFeedSurface(lines, lines);

		expect(diff.changedIndexes).toEqual([]);
		expect(diff.clearedIndexes).toEqual([]);
		expect(diff.unchangedCount).toBe(lines.length);
	});

	test('completely different arrays report all indexes as changed', () => {
		const prev = ['aaa', 'bbb', 'ccc'];
		const next = ['xxx', 'yyy', 'zzz'];
		const diff = diffFeedSurface(prev, next);

		expect(diff.changedIndexes).toEqual([0, 1, 2]);
		expect(diff.clearedIndexes).toEqual([]);
		expect(diff.unchangedCount).toBe(0);
	});

	test('both arrays empty produces empty diff', () => {
		const diff = diffFeedSurface([], []);
		expect(diff.changedIndexes).toEqual([]);
		expect(diff.clearedIndexes).toEqual([]);
		expect(diff.unchangedCount).toBe(0);
	});

	// ── Checklist: Focus movement where only two lines change ──────

	test('focus move changes only old and new focused rows', () => {
		const header = 'HEADER';
		const divider = '---';
		const prevBody = ['row-0', 'ROW-1-FOCUSED', 'row-2', 'row-3'];
		const nextBody = ['row-0', 'row-1', 'ROW-2-FOCUSED', 'row-3'];

		const prev = [header, divider, ...prevBody];
		const next = [header, divider, ...nextBody];
		const diff = diffFeedSurface(prev, next);

		// Only body indexes 1 and 2 changed (absolute indexes 3 and 4)
		expect(diff.changedIndexes).toEqual([3, 4]);
		expect(diff.clearedIndexes).toEqual([]);
		expect(diff.unchangedCount).toBe(4); // header + divider + row-0 + row-3
	});

	// ── Checklist: Resize shorter reports trailing clears ──────────

	test('resize shorter reports trailing clears', () => {
		const prev = makeLines('HEADER', ['row-0', 'row-1', 'row-2', 'row-3']);
		const next = makeLines('HEADER', ['row-0', 'row-1']);

		const diff = diffFeedSurface(prev, next);

		// Shared lines (header, divider, row-0, row-1) are unchanged
		expect(diff.unchangedCount).toBe(4);
		expect(diff.changedIndexes).toEqual([]);
		// The two trailing lines from prev that no longer exist
		expect(diff.clearedIndexes).toEqual([4, 5]);
	});

	test('resize shorter with content change reports both changes and clears', () => {
		const prev = makeLines('HEADER', ['row-0', 'row-1', 'row-2']);
		const next = makeLines('HEADER', ['ROW-0-CHANGED']);

		const diff = diffFeedSurface(prev, next);

		// Index 2 (first body line) changed content
		expect(diff.changedIndexes).toEqual([2]);
		// Indexes 3 and 4 were cleared (existed in prev, not in next)
		expect(diff.clearedIndexes).toEqual([3, 4]);
		// header + divider unchanged
		expect(diff.unchangedCount).toBe(2);
	});

	// ── Checklist: Resize taller reports only newly exposed lines ──

	test('resize taller reports only newly exposed lines', () => {
		const prev = makeLines('HEADER', ['row-0', 'row-1']);
		const next = makeLines('HEADER', ['row-0', 'row-1', 'row-2', 'row-3']);

		const diff = diffFeedSurface(prev, next);

		// All shared lines are identical
		expect(diff.unchangedCount).toBe(4); // header, divider, row-0, row-1
		// Newly exposed lines
		expect(diff.changedIndexes).toEqual([4, 5]);
		expect(diff.clearedIndexes).toEqual([]);
	});

	test('resize taller with content change in existing lines', () => {
		const prev = makeLines('HEADER', ['row-0']);
		const next = makeLines('HEADER', ['ROW-0-UPDATED', 'row-1-new']);

		const diff = diffFeedSurface(prev, next);

		// Index 2 changed (body row content differs)
		expect(diff.changedIndexes).toEqual([2, 3]);
		expect(diff.clearedIndexes).toEqual([]);
		// header + divider unchanged
		expect(diff.unchangedCount).toBe(2);
	});

	// ── Checklist: Full viewport shift ─────────────────────────────

	test('full viewport shift reports the expected changed range', () => {
		const prev = makeLines('HEADER', ['entry-0', 'entry-1', 'entry-2']);
		const next = makeLines('HEADER', ['entry-5', 'entry-6', 'entry-7']);

		const diff = diffFeedSurface(prev, next);

		// Header and divider unchanged, all 3 body rows changed
		expect(diff.changedIndexes).toEqual([2, 3, 4]);
		expect(diff.clearedIndexes).toEqual([]);
		expect(diff.unchangedCount).toBe(2);
	});

	// ── Checklist: Header-only changes ─────────────────────────────

	test('header-only change reports single changed index', () => {
		const body = ['row-0', 'row-1', 'row-2'];
		const prev = makeLines('HEADER-v1', body);
		const next = makeLines('HEADER-v2', body);

		const diff = diffFeedSurface(prev, next);

		expect(diff.changedIndexes).toEqual([0]);
		expect(diff.clearedIndexes).toEqual([]);
		expect(diff.unchangedCount).toBe(4); // divider + 3 body rows
	});

	// ── Checklist: Content change vs trailing clear ────────────────

	test('distinguish content change from trailing line clear', () => {
		// Prev: 5 lines, Next: 3 lines with one changed
		const prev = ['H', 'D', 'A', 'B', 'C'];
		const next = ['H', 'D', 'X'];

		const diff = diffFeedSurface(prev, next);

		// Index 2 is a content change (A -> X)
		expect(diff.changedIndexes).toEqual([2]);
		// Indexes 3, 4 are cleared (existed in prev only)
		expect(diff.clearedIndexes).toEqual([3, 4]);
		// H and D are unchanged
		expect(diff.unchangedCount).toBe(2);
	});

	// ── Edge cases ─────────────────────────────────────────────────

	test('prev empty, next has lines (initial render)', () => {
		const next = ['H', 'D', 'row-0', 'row-1'];
		const diff = diffFeedSurface([], next);

		expect(diff.changedIndexes).toEqual([0, 1, 2, 3]);
		expect(diff.clearedIndexes).toEqual([]);
		expect(diff.unchangedCount).toBe(0);
	});

	test('prev has lines, next empty (full clear)', () => {
		const prev = ['H', 'D', 'row-0', 'row-1'];
		const diff = diffFeedSurface(prev, []);

		expect(diff.changedIndexes).toEqual([]);
		expect(diff.clearedIndexes).toEqual([0, 1, 2, 3]);
		expect(diff.unchangedCount).toBe(0);
	});

	test('single line change in the middle', () => {
		const prev = ['a', 'b', 'c', 'd', 'e'];
		const next = ['a', 'b', 'X', 'd', 'e'];
		const diff = diffFeedSurface(prev, next);

		expect(diff.changedIndexes).toEqual([2]);
		expect(diff.clearedIndexes).toEqual([]);
		expect(diff.unchangedCount).toBe(4);
	});

	test('changedIndexes + clearedIndexes + unchangedCount equals total lines touched', () => {
		const prev = ['a', 'b', 'c', 'd'];
		const next = ['a', 'X', 'Y'];
		const diff = diffFeedSurface(prev, next);

		// Total lines considered = max(prev.length, next.length)
		const totalLines = Math.max(prev.length, next.length);
		expect(
			diff.changedIndexes.length +
				diff.clearedIndexes.length +
				diff.unchangedCount,
		).toBe(totalLines);
	});

	test('invariant: changed + cleared + unchanged = max(prev, next) for various sizes', () => {
		const cases: [string[], string[]][] = [
			[[], ['a']],
			[['a'], []],
			[
				['a', 'b'],
				['a', 'b', 'c', 'd'],
			],
			[
				['a', 'b', 'c', 'd'],
				['x', 'y'],
			],
			[['a'], ['a']],
		];

		for (const [prev, next] of cases) {
			const diff = diffFeedSurface(prev, next);
			const total = Math.max(prev.length, next.length);
			expect(
				diff.changedIndexes.length +
					diff.clearedIndexes.length +
					diff.unchangedCount,
			).toBe(total);
		}
	});
});
