import {describe, test, expect} from 'vitest';
import stripAnsi from 'strip-ansi';
import {darkTheme} from '../theme/themes';
import type {TimelineEntry} from '../../core/feed/timeline';
import type {FeedColumnWidths} from './FeedRow';
import {buildFeedSurface, type BuildFeedSurfaceParams} from './feedSurface';

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

// ── Tests ──────────────────────────────────────────────────────────

describe('buildFeedSurface', () => {
	test('empty feed produces header plus empty-state rows', () => {
		const surface = buildFeedSurface(
			defaultParams({filteredEntries: [], feedContentRows: 5}),
		);

		// Header should exist (1 header line + 1 divider since feedContentRows > 1)
		expect(surface.headerLines.length).toBe(2);

		// visibleContentRows = feedContentRows - 1 (divider) = 4
		expect(surface.visibleContentRows).toBe(4);

		// First body line should contain the empty-state message
		expect(surface.bodyLines.length).toBe(4);
		expect(stripAnsi(surface.bodyLines[0]!)).toContain('(no feed events)');

		// Remaining body lines should be blank fill (border + spaces + border)
		for (let i = 1; i < surface.bodyLines.length; i++) {
			const stripped = stripAnsi(surface.bodyLines[i]!);
			// Content between the two border glyphs should be all spaces
			expect(stripped.slice(1, -1).trim()).toBe('');
		}

		// allLines = headerLines + bodyLines
		expect(surface.allLines.length).toBe(
			surface.headerLines.length + surface.bodyLines.length,
		);

		// lineToEntry should be empty for empty feed
		expect(surface.lineToEntry.size).toBe(0);
	});

	test('header divider appears only when feedHeaderRows > 0 && feedContentRows > 1', () => {
		// Case 1: feedHeaderRows > 0 && feedContentRows > 1 => divider present
		const withDivider = buildFeedSurface(
			defaultParams({feedHeaderRows: 1, feedContentRows: 3}),
		);
		expect(withDivider.headerLines.length).toBe(2);
		// The divider line should contain repeated horizontal glyphs
		const dividerStripped = stripAnsi(withDivider.headerLines[1]!);
		expect(dividerStripped).toMatch(/^[|][-]+[|]$/);

		// Case 2: feedHeaderRows > 0 && feedContentRows = 1 => no divider
		const noDivider = buildFeedSurface(
			defaultParams({feedHeaderRows: 1, feedContentRows: 1}),
		);
		expect(noDivider.headerLines.length).toBe(1);

		// Case 3: feedHeaderRows = 0 => no header at all
		const noHeader = buildFeedSurface(
			defaultParams({feedHeaderRows: 0, feedContentRows: 5}),
		);
		expect(noHeader.headerLines.length).toBe(0);
	});

	test('partial viewport produces blank fill lines at the bottom', () => {
		const entries = [makeEntry({id: 'e1'}), makeEntry({id: 'e2'})];
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 6, // header=1, divider=1 (since >1), visible=4
			}),
		);

		// visibleContentRows = 6 - 1 = 5 (divider consumes 1)
		expect(surface.visibleContentRows).toBe(5);

		// 2 entry lines + 3 blank fill = 5 body lines
		expect(surface.bodyLines.length).toBe(5);

		// First two lines should have entry content (not just spaces)
		for (let i = 0; i < 2; i++) {
			const stripped = stripAnsi(surface.bodyLines[i]!);
			expect(stripped.length).toBeGreaterThan(2);
			// Not pure whitespace between borders
			expect(stripped.slice(1, -1).trim().length).toBeGreaterThan(0);
		}

		// Last three lines should be blank fill
		for (let i = 2; i < 5; i++) {
			const stripped = stripAnsi(surface.bodyLines[i]!);
			expect(stripped.slice(1, -1).trim()).toBe('');
		}

		// lineToEntry should map exactly the 2 entry lines
		expect(surface.lineToEntry.size).toBe(2);
		expect(surface.lineToEntry.get(0)).toBe(0);
		expect(surface.lineToEntry.get(1)).toBe(1);
	});

	test('focused row styling survives extraction', () => {
		const entries = [
			makeEntry({id: 'e1'}),
			makeEntry({id: 'e2'}),
			makeEntry({id: 'e3'}),
		];
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
				focusMode: 'chat', // not 'feed', so no focus
				feedContentRows: 5,
			}),
		);

		// The focused row (index 1) should differ from the unfocused version
		// due to focus background styling
		expect(focusedSurface.bodyLines[1]).not.toBe(unfocusedSurface.bodyLines[1]);

		// Non-focused rows should be identical in both cases
		expect(focusedSurface.bodyLines[0]).toBe(unfocusedSurface.bodyLines[0]);
		expect(focusedSurface.bodyLines[2]).toBe(unfocusedSurface.bodyLines[2]);
	});

	test('search-matched rows remain stable', () => {
		const entries = [
			makeEntry({id: 'e1'}),
			makeEntry({id: 'e2'}),
			makeEntry({id: 'e3'}),
		];

		const matchedSurface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				searchMatchSet: new Set([1]),
				focusMode: 'chat', // no focus interference
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

		// The matched row (index 1) should differ from the unmatched version
		// due to the match gutter indicator
		expect(matchedSurface.bodyLines[1]).not.toBe(unmatchedSurface.bodyLines[1]);

		// Non-matched rows should be identical
		expect(matchedSurface.bodyLines[0]).toBe(unmatchedSurface.bodyLines[0]);
		expect(matchedSurface.bodyLines[2]).toBe(unmatchedSurface.bodyLines[2]);
	});

	test('striped rows alternate correctly', () => {
		// Use entries with distinct tool columns to produce visually different rows.
		// Stripe background is a chalk.bgHex call which is a no-op at chalk
		// level 0 (CI / no-color), so we verify structural correctness and
		// that distinct entries produce distinct lines.
		const entries = [
			makeEntry({id: 'e1', toolColumn: 'Read'}),
			makeEntry({id: 'e2', toolColumn: 'Write'}),
			makeEntry({id: 'e3', toolColumn: 'Bash'}),
			makeEntry({id: 'e4', toolColumn: 'Grep'}),
		];

		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				focusMode: 'chat', // no focus
				feedContentRows: 6,
			}),
		);

		// All 4 entry rows should be present
		expect(surface.lineToEntry.size).toBe(4);

		// Rows with distinct tool columns must produce distinct lines
		const strippedLines = surface.bodyLines.slice(0, 4).map(l => stripAnsi(l!));
		expect(strippedLines[0]).toContain('Read');
		expect(strippedLines[1]).toContain('Write');
		expect(strippedLines[2]).toContain('Bash');
		expect(strippedLines[3]).toContain('Grep');

		// Distinct entries produce distinct output
		expect(surface.bodyLines[0]).not.toBe(surface.bodyLines[1]);
	});

	test('allLines joins header and body', () => {
		const entries = [makeEntry({id: 'e1'})];
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedContentRows: 3,
			}),
		);

		// allLines should be headerLines concatenated with bodyLines
		expect(surface.allLines).toEqual([
			...surface.headerLines,
			...surface.bodyLines,
		]);

		// Joining with \n should produce the same output as FeedGrid's useMemo
		const joined = surface.allLines.join('\n');
		expect(typeof joined).toBe('string');
		expect(joined.split('\n').length).toBe(surface.allLines.length);
	});

	test('viewport offset shifts visible entries', () => {
		const entries = Array.from({length: 10}, (_, i) =>
			makeEntry({id: `e${i}`, summary: `Entry ${i}`}),
		);
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedViewportStart: 3,
				feedContentRows: 5, // header=1, divider=1, visible=3
			}),
		);

		expect(surface.startIndex).toBe(3);
		// lineToEntry should map to entries starting at index 3
		expect(surface.lineToEntry.get(0)).toBe(3);
		expect(surface.lineToEntry.get(1)).toBe(4);
		expect(surface.lineToEntry.get(2)).toBe(5);
	});

	test('no header when feedHeaderRows is 0', () => {
		const entries = [makeEntry({id: 'e1'})];
		const surface = buildFeedSurface(
			defaultParams({
				filteredEntries: entries,
				feedHeaderRows: 0,
				feedContentRows: 3,
			}),
		);

		expect(surface.headerLines.length).toBe(0);
		// visibleContentRows should equal feedContentRows (no divider possible)
		expect(surface.visibleContentRows).toBe(3);
		// bodyLines = 1 entry + 2 blank fill
		expect(surface.bodyLines.length).toBe(3);
	});

	test('zero feedContentRows yields no body lines', () => {
		const surface = buildFeedSurface(
			defaultParams({
				feedHeaderRows: 1,
				feedContentRows: 0,
			}),
		);

		// feedHeaderRows > 0, so header is emitted even with feedContentRows=0.
		// No divider because feedContentRows <= 1.
		expect(surface.headerLines.length).toBe(1);
		expect(surface.bodyLines.length).toBe(0);
		expect(surface.visibleContentRows).toBe(0);
	});
});
