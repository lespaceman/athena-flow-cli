/**
 * Parity tests: verify that the ink-full backend (allLines.join('\n')) and
 * the incremental painter (paintFeedSurface) produce equivalent visible
 * output for representative feed scenes.
 *
 * These tests exercise buildFeedSurface() to build a surface, then verify:
 * 1. The ink-full output produces the expected frame
 * 2. The incremental painter writes the correct content for the same surface
 * 3. Both backends produce equivalent visible output
 */
import {describe, test, expect} from 'vitest';
import stripAnsi from 'strip-ansi';
import {darkTheme} from '../../theme/themes';
import type {TimelineEntry} from '../../../core/feed/timeline';
import type {FeedColumnWidths} from '../FeedRow';
import {
	buildFeedSurface,
	type BuildFeedSurfaceParams,
} from '../feedSurfaceModel';
import {paintFeedSurface, type StdoutLike} from '../feedSurfacePainter';

// ── Fixtures ───────────────────────────────────────────────────────

const theme = darkTheme;
const FIXED_TS = 1700000000000;

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
	return {
		id: 'e1',
		ts: FIXED_TS,
		op: 'Tool Call',
		opTag: 'tool.call',
		actor: 'AGENT',
		actorId: 'agent:root',
		toolColumn: 'Read',
		summary: 'Read file.ts',
		summarySegments: [
			{role: 'verb', text: 'Read'},
			{role: 'target', text: ' file.ts'},
		],
		searchText: 'Read file.ts',
		error: false,
		expandable: false,
		details: '',
		duplicateActor: false,
		...overrides,
	};
}

const defaultCols: FeedColumnWidths = {
	toolW: 12,
	detailsW: 30,
	resultW: 8,
	gapW: 1,
	detailsResultGapW: 1,
};

function defaultParams(
	overrides: Partial<BuildFeedSurfaceParams> = {},
): BuildFeedSurfaceParams {
	return {
		feedHeaderRows: 1,
		feedContentRows: 5,
		feedViewportStart: 0,
		filteredEntries: [],
		feedCursor: 0,
		focusMode: 'feed',
		searchMatchSet: new Set<number>(),
		ascii: true,
		theme,
		innerWidth: 80,
		cols: defaultCols,
		...overrides,
	};
}

// ── Mock stdout for incremental painter ────────────────────────────

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

/**
 * Extract lines written by the incremental painter into a sparse map
 * of line index -> content. This lets us reconstruct what the terminal
 * would show after painting.
 */
function extractPaintedLines(
	buf: string,
	feedStartRow: number,
): Map<number, string> {
	const result = new Map<number, string>();
	const ESC = String.fromCharCode(0x1b);
	const regex = new RegExp(`${ESC}\\[(\\d+);1H${ESC}\\[2K([^${ESC}]*)`, 'g');
	let match: RegExpExecArray | null;
	while ((match = regex.exec(buf)) !== null) {
		const row = parseInt(match[1]!, 10);
		const content = match[2]!;
		const lineIdx = row - feedStartRow;
		result.set(lineIdx, content);
	}
	return result;
}

/**
 * Simulate what the terminal shows after painting from empty -> surface.
 * Returns an array of lines in the same order as allLines.
 */
function simulateIncrementalRender(
	surface: ReturnType<typeof buildFeedSurface>,
	feedStartRow: number,
): string[] {
	const stdout = mockStdout();
	paintFeedSurface([], surface.allLines, feedStartRow, stdout);

	const painted = extractPaintedLines(stdout.written.join(''), feedStartRow);
	const result: string[] = [];
	for (let i = 0; i < surface.allLines.length; i++) {
		result.push(painted.get(i) ?? '');
	}
	return result;
}

// ── Parity helper ──────────────────────────────────────────────────

/**
 * Assert that ink-full and incremental backends produce the same
 * visible (stripped) output for a given surface.
 */
function assertParity(params: BuildFeedSurfaceParams, feedStartRow = 1): void {
	const surface = buildFeedSurface(params);
	const inkFullLines = surface.allLines;
	const incrementalLines = simulateIncrementalRender(surface, feedStartRow);

	// Same number of lines
	expect(incrementalLines.length).toBe(inkFullLines.length);

	// Each line has identical content (including ANSI styling)
	for (let i = 0; i < inkFullLines.length; i++) {
		expect(incrementalLines[i]).toBe(inkFullLines[i]);
	}
}

// ── Scene: Empty feed ──────────────────────────────────────────────

describe('Parity: empty feed', () => {
	test('both backends produce identical output for empty feed', () => {
		assertParity(defaultParams({filteredEntries: [], feedContentRows: 5}));
	});

	test('empty-state message is visible in both backends', () => {
		const params = defaultParams({
			filteredEntries: [],
			feedContentRows: 5,
		});
		const surface = buildFeedSurface(params);
		const inkOutput = surface.allLines.join('\n');
		const incrementalLines = simulateIncrementalRender(surface, 1);
		const incOutput = incrementalLines.join('\n');

		expect(stripAnsi(inkOutput)).toContain(
			'Enter a prompt below to get started',
		);
		expect(stripAnsi(incOutput)).toContain(
			'Enter a prompt below to get started',
		);
	});

	test('blank fill lines have fixed width in both backends', () => {
		const params = defaultParams({
			filteredEntries: [],
			feedContentRows: 5,
			innerWidth: 60,
		});
		const surface = buildFeedSurface(params);
		const incrementalLines = simulateIncrementalRender(surface, 1);
		const expectedWidth = 60 + 2; // innerWidth + 2 border chars

		for (let i = 0; i < surface.allLines.length; i++) {
			expect(stripAnsi(surface.allLines[i]!).length).toBe(expectedWidth);
			expect(stripAnsi(incrementalLines[i]!).length).toBe(expectedWidth);
		}
	});
});

// ── Scene: Focused row in the middle of the viewport ───────────────

describe('Parity: focused row in the middle', () => {
	test('focused row produces identical output in both backends', () => {
		const entries = Array.from({length: 5}, (_, i) =>
			makeEntry({id: `e${i}`, toolColumn: `Tool${i}`, ts: FIXED_TS + i}),
		);
		assertParity(
			defaultParams({
				filteredEntries: entries,
				feedCursor: 2, // middle row
				focusMode: 'feed',
				feedContentRows: 7, // header + divider + 5 rows
			}),
		);
	});

	test('focus styling differs from unfocused in both backends', () => {
		const entries = Array.from({length: 3}, (_, i) =>
			makeEntry({id: `e${i}`, ts: FIXED_TS + i}),
		);
		const focusedSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedCursor: 1,
				focusMode: 'feed',
				feedContentRows: 5,
			}),
		);
		const unfocusedSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedCursor: 1,
				focusMode: 'chat',
				feedContentRows: 5,
			}),
		);

		// The focused row (body index 1) should differ
		expect(focusedSurface.bodyLines[1]).not.toBe(unfocusedSurface.bodyLines[1]);

		// Both should render identically via incremental path
		assertParity(
			defaultParams({
				filteredEntries: entries,
				feedCursor: 1,
				focusMode: 'feed',
				feedContentRows: 5,
			}),
		);
	});
});

// ── Scene: Search match highlighting ───────────────────────────────

describe('Parity: search match highlighting', () => {
	test('search-matched row produces identical output in both backends', () => {
		const entries = Array.from({length: 4}, (_, i) =>
			makeEntry({id: `e${i}`, ts: FIXED_TS + i}),
		);
		assertParity(
			defaultParams({
				filteredEntries: entries,
				searchMatchSet: new Set([1, 3]),
				focusMode: 'chat',
				feedContentRows: 6,
			}),
		);
	});

	test('matched rows differ from unmatched rows in both backends', () => {
		const entries = Array.from({length: 3}, (_, i) =>
			makeEntry({id: `e${i}`, ts: FIXED_TS + i}),
		);
		const matchedSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				searchMatchSet: new Set([1]),
				focusMode: 'chat',
				feedContentRows: 5,
			}),
		);
		const unmatchedSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				searchMatchSet: new Set(),
				focusMode: 'chat',
				feedContentRows: 5,
			}),
		);

		// Matched row differs
		expect(matchedSurface.bodyLines[1]).not.toBe(unmatchedSurface.bodyLines[1]);
		// Non-matched rows identical
		expect(matchedSurface.bodyLines[0]).toBe(unmatchedSurface.bodyLines[0]);
		expect(matchedSurface.bodyLines[2]).toBe(unmatchedSurface.bodyLines[2]);

		// Incremental path matches ink-full
		assertParity(
			defaultParams({
				filteredEntries: entries,
				searchMatchSet: new Set([1]),
				focusMode: 'chat',
				feedContentRows: 5,
			}),
		);
	});
});

// ── Scene: Mixed tool rows and plain agent rows ────────────────────

describe('Parity: mixed tool rows and plain agent rows', () => {
	test('tool-call and agent-message rows produce identical output', () => {
		const entries = [
			makeEntry({
				id: 'tool1',
				op: 'Tool Call',
				opTag: 'tool.call',
				toolColumn: 'Read',
				summary: 'Read config.ts',
				ts: FIXED_TS,
			}),
			makeEntry({
				id: 'agent1',
				op: 'Message',
				opTag: 'message',
				toolColumn: '',
				actor: 'AGENT',
				summary: 'Thinking about the problem...',
				ts: FIXED_TS + 1,
			}),
			makeEntry({
				id: 'tool2',
				op: 'Tool Call',
				opTag: 'tool.call',
				toolColumn: 'Bash',
				summary: 'npm test',
				ts: FIXED_TS + 2,
			}),
			makeEntry({
				id: 'agent2',
				op: 'Message',
				opTag: 'message',
				toolColumn: '',
				actor: 'SUBAGENT',
				actorId: 'agent:sub1',
				summary: 'Delegated task result',
				duplicateActor: true,
				ts: FIXED_TS + 3,
			}),
			makeEntry({
				id: 'tool3',
				op: 'Tool Call',
				opTag: 'tool.call',
				toolColumn: 'Write',
				summary: 'Write output.ts',
				error: true,
				ts: FIXED_TS + 4,
			}),
		];

		assertParity(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 7, // header + divider + 5 rows
			}),
		);
	});

	test('mixed rows have consistent fixed width', () => {
		const entries = [
			makeEntry({
				id: 'tool1',
				toolColumn: 'Read',
				summary: 'short',
				ts: FIXED_TS,
			}),
			makeEntry({
				id: 'agent1',
				toolColumn: '',
				summary:
					'A very long agent message that exceeds the column width limit',
				ts: FIXED_TS + 1,
			}),
		];
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				innerWidth: 60,
				feedContentRows: 4,
			}),
		);

		const expectedWidth = 60 + 2;
		for (const line of surface.allLines) {
			expect(stripAnsi(line).length).toBe(expectedWidth);
		}
	});
});

// ── Scene: Bottom-of-list blank fill ───────────────────────────────

describe('Parity: bottom-of-list blank fill', () => {
	test('blank fill lines are identical in both backends', () => {
		const entries = [
			makeEntry({id: 'e1', ts: FIXED_TS}),
			makeEntry({id: 'e2', ts: FIXED_TS + 1}),
		];
		const params = defaultParams({
			filteredEntries: entries,
			feedContentRows: 8, // header + divider + 6 visible, only 2 entries
		});

		assertParity(params);

		const surface = buildFeedSurface(params);
		// visibleContentRows = 8 - 1 (divider) = 7; 2 entries + 5 blank = 7
		expect(surface.bodyLines.length).toBe(7);

		// Blank fill lines should be border + spaces + border
		for (let i = 2; i < surface.bodyLines.length; i++) {
			const stripped = stripAnsi(surface.bodyLines[i]!);
			expect(stripped.slice(1, -1).trim()).toBe('');
		}
	});

	test('no stale entry content in blank fill region', () => {
		const entries = [makeEntry({id: 'e1', toolColumn: 'Grep', ts: FIXED_TS})];
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 6,
				innerWidth: 80,
			}),
		);

		// Only the first body line should contain tool content
		expect(stripAnsi(surface.bodyLines[0]!)).toContain('Grep');
		// Remaining lines should NOT contain any tool name
		for (let i = 1; i < surface.bodyLines.length; i++) {
			expect(stripAnsi(surface.bodyLines[i]!)).not.toContain('Grep');
		}
	});
});

// ── Scene: Resize from large to small and back ─────────────────────

describe('Parity: resize transitions', () => {
	test('shrink: no stale rows remain after reducing viewport', () => {
		const entries = Array.from({length: 6}, (_, i) =>
			makeEntry({id: `e${i}`, toolColumn: `T${i}`, ts: FIXED_TS + i}),
		);

		// Large viewport
		const largeSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 8, // header + divider + 6 visible
			}),
		);

		// Small viewport
		const smallSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 4, // header + divider + 2 visible
			}),
		);

		// Simulate incremental transition: large -> small
		const stdout = mockStdout();
		const result = paintFeedSurface(
			largeSurface.allLines,
			smallSurface.allLines,
			1,
			stdout,
		);

		// The painter should clear the trailing lines that no longer exist
		expect(result.linesCleared).toBe(
			largeSurface.allLines.length - smallSurface.allLines.length,
		);

		// The small surface itself should have no stale rows
		// feedContentRows=4 => header(1) + divider(1) + visibleContentRows(3) = 5
		expect(smallSurface.allLines.length).toBe(5);
		expect(smallSurface.lineToEntry.size).toBe(3);
	});

	test('grow: newly exposed lines are painted correctly', () => {
		const entries = Array.from({length: 6}, (_, i) =>
			makeEntry({id: `e${i}`, toolColumn: `T${i}`, ts: FIXED_TS + i}),
		);

		// Small viewport
		const smallSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 4,
			}),
		);

		// Large viewport
		const largeSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 8,
			}),
		);

		// Simulate incremental transition: small -> large
		const stdout = mockStdout();
		const result = paintFeedSurface(
			smallSurface.allLines,
			largeSurface.allLines,
			1,
			stdout,
		);

		// New lines should be painted, none cleared
		expect(result.linesCleared).toBe(0);
		expect(result.linesChanged).toBeGreaterThan(0);

		// Verify all newly exposed lines match the large surface
		const painted = extractPaintedLines(stdout.written.join(''), 1);
		for (const [idx, content] of painted) {
			expect(content).toBe(largeSurface.allLines[idx]);
		}
	});

	test('shrink then grow back produces identical output to original', () => {
		const entries = Array.from({length: 5}, (_, i) =>
			makeEntry({id: `e${i}`, toolColumn: `Tool${i}`, ts: FIXED_TS + i}),
		);

		const originalParams = defaultParams({
			filteredEntries: entries,
			feedContentRows: 7, // header + divider + 5 visible
			innerWidth: 60,
		});
		const originalSurface = buildFeedSurface(originalParams);
		const originalOutput = originalSurface.allLines.join('\n');

		// Shrink
		const shrunkSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 4,
				innerWidth: 60,
			}),
		);

		// Grow back to original size
		const restoredSurface = buildFeedSurface(originalParams);
		const restoredOutput = restoredSurface.allLines.join('\n');

		// Output should be identical
		expect(restoredOutput).toBe(originalOutput);

		// Incremental paint from shrunk -> restored should produce correct output
		const stdout = mockStdout();
		paintFeedSurface(
			shrunkSurface.allLines,
			restoredSurface.allLines,
			1,
			stdout,
		);
		const painted = extractPaintedLines(stdout.written.join(''), 1);

		// Every painted line should match the restored surface
		for (const [idx, content] of painted) {
			expect(content).toBe(restoredSurface.allLines[idx]);
		}
	});

	test('width change: all lines repainted with new width', () => {
		const entries = [
			makeEntry({id: 'e1', ts: FIXED_TS}),
			makeEntry({id: 'e2', ts: FIXED_TS + 1}),
		];

		const wideSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				innerWidth: 100,
				feedContentRows: 4,
			}),
		);

		const narrowSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				innerWidth: 40,
				feedContentRows: 4,
			}),
		);

		// All wide lines should be wider than narrow lines
		for (let i = 0; i < wideSurface.allLines.length; i++) {
			const wideW = stripAnsi(wideSurface.allLines[i]!).length;
			const narrowW = stripAnsi(narrowSurface.allLines[i]!).length;
			expect(wideW).toBeGreaterThan(narrowW);
		}

		// Width change should trigger repaint of all lines
		const stdout = mockStdout();
		const result = paintFeedSurface(
			wideSurface.allLines,
			narrowSurface.allLines,
			1,
			stdout,
		);
		expect(result.linesChanged).toBe(narrowSurface.allLines.length);
	});
});

// ── Cross-cutting: fixed-width stability ───────────────────────────

describe('Parity: fixed-width output stability', () => {
	test('all lines have consistent stripped width across scenes', () => {
		const innerWidth = 70;
		const expectedWidth = innerWidth + 2;

		const scenes: BuildFeedSurfaceParams[] = [
			// Empty feed
			defaultParams({
				filteredEntries: [],
				innerWidth,
				feedContentRows: 5,
			}),
			// Single entry
			defaultParams({
				filteredEntries: [makeEntry({ts: FIXED_TS})],
				innerWidth,
				feedContentRows: 5,
			}),
			// Multiple entries with focus
			defaultParams({
				filteredEntries: Array.from({length: 3}, (_, i) =>
					makeEntry({id: `e${i}`, ts: FIXED_TS + i}),
				),
				innerWidth,
				feedCursor: 1,
				focusMode: 'feed',
				feedContentRows: 5,
			}),
			// Entries with search match
			defaultParams({
				filteredEntries: Array.from({length: 3}, (_, i) =>
					makeEntry({id: `e${i}`, ts: FIXED_TS + i}),
				),
				innerWidth,
				searchMatchSet: new Set([0, 2]),
				focusMode: 'chat',
				feedContentRows: 5,
			}),
		];

		for (const params of scenes) {
			const surface = buildFeedSurface(params);
			for (const line of surface.allLines) {
				expect(stripAnsi(line).length).toBe(expectedWidth);
			}
		}
	});

	test('deterministic output with fixed timestamps', () => {
		const entries = Array.from({length: 3}, (_, i) =>
			makeEntry({id: `e${i}`, ts: FIXED_TS + i * 1000}),
		);
		const params = defaultParams({
			filteredEntries: entries,
			feedContentRows: 5,
		});

		const surface1 = buildFeedSurface(params);
		const surface2 = buildFeedSurface(params);

		expect(surface1.allLines).toEqual(surface2.allLines);
	});
});

// ── Incremental update parity ──────────────────────────────────────

describe('Parity: incremental update correctness', () => {
	test('focus move: painter writes exactly the changed rows', () => {
		const entries = Array.from({length: 4}, (_, i) =>
			makeEntry({id: `e${i}`, ts: FIXED_TS + i}),
		);

		const prevSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedCursor: 1,
				focusMode: 'feed',
				feedContentRows: 6,
			}),
		);

		const nextSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedCursor: 2,
				focusMode: 'feed',
				feedContentRows: 6,
			}),
		);

		const stdout = mockStdout();
		const result = paintFeedSurface(
			prevSurface.allLines,
			nextSurface.allLines,
			1,
			stdout,
		);

		// Only the old-focused and new-focused rows should change
		expect(result.linesChanged).toBe(2);
		expect(result.linesCleared).toBe(0);

		// Verify the painted content matches the next surface
		const painted = extractPaintedLines(stdout.written.join(''), 1);
		for (const [idx, content] of painted) {
			expect(content).toBe(nextSurface.allLines[idx]);
		}
	});

	test('scroll: viewport shift repaints body lines, not header', () => {
		const entries = Array.from({length: 10}, (_, i) =>
			makeEntry({id: `e${i}`, toolColumn: `T${i}`, ts: FIXED_TS + i}),
		);

		const prevSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedViewportStart: 0,
				feedContentRows: 5,
				focusMode: 'chat',
			}),
		);

		const nextSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedViewportStart: 3,
				feedContentRows: 5,
				focusMode: 'chat',
			}),
		);

		const stdout = mockStdout();
		const result = paintFeedSurface(
			prevSurface.allLines,
			nextSurface.allLines,
			1,
			stdout,
		);

		// Header and divider should be unchanged (they don't depend on viewport start)
		// Only body lines should change
		expect(result.linesChanged).toBeGreaterThan(0);
		expect(result.linesCleared).toBe(0);

		// Header lines are stable
		expect(prevSurface.headerLines).toEqual(nextSurface.headerLines);
	});

	test('add search match: only matched row changes', () => {
		const entries = Array.from({length: 3}, (_, i) =>
			makeEntry({id: `e${i}`, ts: FIXED_TS + i}),
		);

		const prevSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				searchMatchSet: new Set(),
				focusMode: 'chat',
				feedContentRows: 5,
			}),
		);

		const nextSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				searchMatchSet: new Set([1]),
				focusMode: 'chat',
				feedContentRows: 5,
			}),
		);

		const stdout = mockStdout();
		const result = paintFeedSurface(
			prevSurface.allLines,
			nextSurface.allLines,
			1,
			stdout,
		);

		// Only the newly matched row should change
		expect(result.linesChanged).toBe(1);
		expect(result.linesCleared).toBe(0);
	});
});
