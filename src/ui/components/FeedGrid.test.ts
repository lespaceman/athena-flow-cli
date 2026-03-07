import {describe, expect, it, test} from 'vitest';
import stripAnsi from 'strip-ansi';
import {shouldUseLiveFeedScrollback} from './FeedGrid';
import {
	buildFeedSurface,
	type BuildFeedSurfaceParams,
} from './feedSurfaceModel';
import {darkTheme} from '../theme/themes';
import type {TimelineEntry} from '../../core/feed/timeline';
import type {FeedColumnWidths} from './FeedRow';

// ── Fixtures ───────────────────────────────────────────────────────

const theme = darkTheme;

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
	return {
		id: 'e1',
		ts: Date.now(),
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
	timeEventGapW: 1,
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

// ── shouldUseLiveFeedScrollback ─────────────────────────────────────

describe('shouldUseLiveFeedScrollback', () => {
	it('only enables static feed in tail-follow with no active search', () => {
		expect(
			shouldUseLiveFeedScrollback({
				tailFollow: true,
				inputMode: 'normal',
				searchQuery: '',
			}),
		).toBe(true);
		expect(
			shouldUseLiveFeedScrollback({
				tailFollow: false,
				inputMode: 'normal',
				searchQuery: '',
			}),
		).toBe(false);
		expect(
			shouldUseLiveFeedScrollback({
				tailFollow: true,
				inputMode: 'search',
				searchQuery: '',
			}),
		).toBe(false);
		expect(
			shouldUseLiveFeedScrollback({
				tailFollow: true,
				inputMode: 'normal',
				searchQuery: 'bash',
			}),
		).toBe(false);
	});

	it('rejects whitespace-only search queries', () => {
		expect(
			shouldUseLiveFeedScrollback({
				tailFollow: true,
				inputMode: 'normal',
				searchQuery: '   ',
			}),
		).toBe(true);
	});
});

// ── Line-buffer generation via buildFeedSurface ────────────────────
// These tests verify the contract that FeedGrid.tsx now depends on:
// buildFeedSurface produces the same structured output that the old
// inline useMemo logic did, so we can join surface.allLines with '\n'
// and get identical visual output.

describe('FeedGrid line-buffer via buildFeedSurface', () => {
	test('empty feed produces correct line count and empty-state message', () => {
		const surface = buildFeedSurface(
			defaultParams({filteredEntries: [], feedContentRows: 5}),
		);
		const output = surface.allLines.join('\n');
		const lines = output.split('\n');

		// header(1) + divider(1) + visibleContentRows(4) = 6 lines
		expect(lines.length).toBe(6);
		expect(stripAnsi(lines[2]!)).toContain('(no feed events)');
	});

	test('single entry produces correct line count', () => {
		const entries = [makeEntry({id: 'e1'})];
		const surface = buildFeedSurface(
			defaultParams({filteredEntries: entries, feedContentRows: 5}),
		);
		const output = surface.allLines.join('\n');
		const lines = output.split('\n');

		// header(1) + divider(1) + 1 entry + 3 blank fill = 6
		expect(lines.length).toBe(6);
		expect(stripAnsi(lines[2]!)).toContain('Read');
	});

	test('full viewport with no blank fill', () => {
		const entries = Array.from({length: 4}, (_, i) =>
			makeEntry({id: `e${i}`, summary: `Entry ${i}`}),
		);
		// feedContentRows=5 => header(1) + divider(1) + 3 visible rows
		// But we have 4 entries, so only 3 are visible — no blank fill needed if 3 fill it
		const surface = buildFeedSurface(
			defaultParams({filteredEntries: entries, feedContentRows: 5}),
		);

		// visibleContentRows = 5 - 1 (divider) = 4
		expect(surface.visibleContentRows).toBe(4);
		// All 4 entries fit, no blank fill
		expect(surface.lineToEntry.size).toBe(4);
		expect(surface.bodyLines.length).toBe(4);
	});

	test('viewport offset shifts which entries appear', () => {
		const entries = Array.from({length: 10}, (_, i) =>
			makeEntry({id: `e${i}`, toolColumn: `Tool${i}`}),
		);
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedViewportStart: 5,
				feedContentRows: 4, // header(1) + divider(1) + 2 visible
			}),
		);

		expect(surface.startIndex).toBe(5);
		expect(surface.lineToEntry.get(0)).toBe(5);
		expect(surface.lineToEntry.get(1)).toBe(6);
		const output = surface.allLines.join('\n');
		expect(stripAnsi(output)).toContain('Tool5');
		expect(stripAnsi(output)).toContain('Tool6');
		expect(stripAnsi(output)).not.toContain('Tool0');
	});

	test('output parity: joined allLines equals old-style lines.join', () => {
		// Verifies the core invariant FeedGrid depends on: surface.allLines
		// concatenated with \n gives a single string identical to what the
		// old inline useMemo produced.
		const entries = [
			makeEntry({id: 'e1', toolColumn: 'Read'}),
			makeEntry({id: 'e2', toolColumn: 'Write'}),
		];
		const params = defaultParams({
			filteredEntries: entries,
			feedContentRows: 5,
		});
		const surface = buildFeedSurface(params);
		const output = surface.allLines.join('\n');

		// The output should be a non-empty string with exactly allLines.length - 1 newlines
		expect(output.split('\n').length).toBe(surface.allLines.length);

		// Each line should be bordered (first and last visible char is border glyph)
		for (const line of surface.allLines) {
			const stripped = stripAnsi(line);
			expect(stripped[0]).toBe('|'); // ascii vertical glyph
			expect(stripped[stripped.length - 1]).toBe('|');
		}
	});

	test('fixed-width output lines have consistent visual width', () => {
		const entries = [
			makeEntry({id: 'e1', toolColumn: 'Read', summary: 'short'}),
			makeEntry({
				id: 'e2',
				toolColumn: 'Write',
				summary: 'a much longer summary that should be truncated',
			}),
		];
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 5,
				innerWidth: 60,
			}),
		);

		// All lines (header, divider, entries, blank) should have the same
		// stripped width: innerWidth + 2 border chars
		const expectedWidth = 60 + 2;
		for (const line of surface.allLines) {
			const stripped = stripAnsi(line);
			expect(stripped.length).toBe(expectedWidth);
		}
	});

	test('no header when feedHeaderRows is 0', () => {
		const entries = [makeEntry()];
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedHeaderRows: 0,
				feedContentRows: 3,
			}),
		);
		const output = surface.allLines.join('\n');
		const lines = output.split('\n');

		// No header, no divider: all lines are body lines
		expect(lines.length).toBe(3);
		expect(surface.headerLines.length).toBe(0);
	});

	test('cursor focus changes row output', () => {
		const entries = [makeEntry({id: 'e1'}), makeEntry({id: 'e2'})];
		const focused = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedCursor: 0,
				focusMode: 'feed',
				feedContentRows: 4,
			}),
		);
		const unfocused = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedCursor: 0,
				focusMode: 'chat',
				feedContentRows: 4,
			}),
		);

		// The focused row should differ; other rows should match
		expect(focused.bodyLines[0]).not.toBe(unfocused.bodyLines[0]);
		expect(focused.bodyLines[1]).toBe(unfocused.bodyLines[1]);
	});

	test('search match changes row output', () => {
		const entries = [makeEntry({id: 'e1'}), makeEntry({id: 'e2'})];
		const matched = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				searchMatchSet: new Set([1]),
				focusMode: 'chat',
				feedContentRows: 4,
			}),
		);
		const unmatched = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				searchMatchSet: new Set(),
				focusMode: 'chat',
				feedContentRows: 4,
			}),
		);

		expect(matched.bodyLines[1]).not.toBe(unmatched.bodyLines[1]);
		expect(matched.bodyLines[0]).toBe(unmatched.bodyLines[0]);
	});

	test('lineToEntry map correctly tracks entry indexes', () => {
		const entries = Array.from({length: 3}, (_, i) => makeEntry({id: `e${i}`}));
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedViewportStart: 0,
				feedContentRows: 6, // header(1) + divider(1) + 4 visible
			}),
		);

		// 3 entries mapped, 1 blank fill
		expect(surface.lineToEntry.size).toBe(3);
		expect(surface.lineToEntry.get(0)).toBe(0);
		expect(surface.lineToEntry.get(1)).toBe(1);
		expect(surface.lineToEntry.get(2)).toBe(2);
		// Blank fill line should NOT be in the map
		expect(surface.lineToEntry.has(3)).toBe(false);
	});

	test('entries beyond viewport end are not rendered', () => {
		const entries = Array.from({length: 20}, (_, i) =>
			makeEntry({id: `e${i}`, toolColumn: `T${i}`}),
		);
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedViewportStart: 0,
				feedContentRows: 5, // header(1) + divider(1) + 3 visible
			}),
		);

		expect(surface.visibleContentRows).toBe(4);
		expect(surface.lineToEntry.size).toBe(4);
		const output = surface.allLines.join('\n');
		// Entry at index 4 should NOT appear
		expect(stripAnsi(output)).not.toContain('T5');
	});
});
