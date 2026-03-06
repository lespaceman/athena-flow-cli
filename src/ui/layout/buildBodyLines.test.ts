import {describe, expect, it} from 'vitest';
import {buildBodyLines, buildTodoHeaderLine} from './buildBodyLines';
import {opCategory} from '../../core/feed/timeline';
import {type TodoPanelItem} from '../../core/feed/todoPanel';
import {darkTheme} from '../theme/themes';
import stripAnsi from 'strip-ansi';

describe('opCategory', () => {
	it('extracts prefix before first dot', () => {
		expect(opCategory('tool.call')).toBe('tool');
		expect(opCategory('tool.ok')).toBe('tool');
		expect(opCategory('perm.req')).toBe('perm');
		expect(opCategory('sub.start')).toBe('sub');
		expect(opCategory('agent.msg')).toBe('agent');
		expect(opCategory('run.start')).toBe('run');
	});

	it('returns full op when no dot', () => {
		expect(opCategory('prompt')).toBe('prompt');
		expect(opCategory('notify')).toBe('notify');
	});
});

/** Create a minimal TodoPanelItem for testing. */
function makeTodoItem(
	id: string,
	status: 'pending' | 'in_progress' | 'done' = 'pending',
): TodoPanelItem {
	return {id, text: `task-${id}`, status};
}

const defaultTheme = darkTheme;

function buildTodoOnly(
	items: TodoPanelItem[],
	actualTodoRows: number,
	tScroll: number,
): string[] {
	return buildBodyLines({
		innerWidth: 80,
		todo: {
			actualTodoRows,
			todoPanel: {
				todoScroll: tScroll,
				todoCursor: tScroll,
				visibleTodoItems: items,
			},
			focusMode: 'todo',
			ascii: true,
			appMode: 'idle',
			doneCount: 0,
			totalCount: items.length,
			spinnerFrame: '*',
		},
		runOverlay: {
			actualRunOverlayRows: 0,
			runSummaries: [],
			runFilter: 'all',
		},
		theme: defaultTheme,
	});
}

describe('buildBodyLines — Bug #6: todo hasScrollDown with scroll-up affordance', () => {
	it('shows scroll-down indicator when items are hidden due to scroll-up affordance', () => {
		const items = Array.from({length: 4}, (_, i) => makeTodoItem(String(i)));

		const result = buildTodoOnly(items, 5, 1);
		const allText = result.map(l => stripAnsi(l)).join('\n');

		expect(allText).toMatch(/\+\d+ more/);
	});
});

describe('buildBodyLines — tiny todo panel row budget', () => {
	it('never emits more lines than actualTodoRows when panel is very small', () => {
		const items = Array.from({length: 6}, (_, i) => makeTodoItem(String(i)));
		const result = buildTodoOnly(items, 3, 2);
		expect(result).toHaveLength(3);
	});

	it('renders only the status header when only one todo row is available', () => {
		const items = Array.from({length: 3}, (_, i) => makeTodoItem(String(i)));
		const result = buildTodoOnly(items, 1, 0);
		expect(result).toHaveLength(1);
	});
});

describe('buildBodyLines — stable overflow affordance rows', () => {
	it('keeps a stable line budget when overflow exists at the top of the list', () => {
		const items = Array.from({length: 8}, (_, i) => makeTodoItem(String(i)));
		const result = buildTodoOnly(items, 6, 0);
		const plain = result.map(line => stripAnsi(line));

		expect(result).toHaveLength(6);
		expect(plain[1]?.trim()).toBe('');
		expect(plain[4]).toMatch(/\+\d+ more/);
	});

	it('keeps the same row count when scrolling into the middle of an overflowing list', () => {
		const items = Array.from({length: 8}, (_, i) => makeTodoItem(String(i)));
		const top = buildTodoOnly(items, 6, 0).map(line => stripAnsi(line));
		const middle = buildTodoOnly(items, 6, 2).map(line => stripAnsi(line));

		expect(top).toHaveLength(middle.length);
		expect(top[1]?.trim()).toBe('');
		expect(middle[1]).toMatch(/\+\d+ more/);
		expect(top[4]).toMatch(/\+\d+ more/);
		expect(middle[4]).toMatch(/\+\d+ more/);
	});
});

describe('buildTodoHeaderLine', () => {
	it('shows IDLE with dot glyph when not working', () => {
		const line = buildTodoHeaderLine(
			80,
			{
				ascii: true,
				appMode: 'idle',
				spinnerFrame: '',
				doneCount: 2,
				totalCount: 5,
			},
			defaultTheme,
		);
		const plain = stripAnsi(line);
		expect(plain).toContain('IDLE');
		expect(plain).toContain('2/5');
	});

	it('shows WORKING with spinner glyph when working', () => {
		const line = buildTodoHeaderLine(
			80,
			{
				ascii: false,
				appMode: 'working',
				spinnerFrame: '\u280B',
				colors: {
					doing: '#facc15',
					done: '#888',
					failed: '#f00',
					blocked: '#facc15',
					text: '#fff',
					textMuted: '#888',
					default: '#888',
				},
				doneCount: 1,
				totalCount: 3,
			},
			defaultTheme,
		);
		const plain = stripAnsi(line);
		expect(plain).toContain('WORKING');
		expect(plain).toContain('\u280B');
	});
});

describe('buildBodyLines — stale todoScroll exceeding items length', () => {
	it('does not crash when tScroll + renderSlots exceeds items array bounds', () => {
		// Reproduces the crash: todoScroll is stale (e.g. 3) but items shrunk to 2.
		// buildBodyLines must not access items[3+] which would be undefined.
		const items = Array.from({length: 2}, (_, i) => makeTodoItem(String(i)));
		// tScroll=3 is beyond items.length — simulates stale scroll state
		expect(() => buildTodoOnly(items, 6, 3)).not.toThrow();
	});

	it('does not crash when tScroll equals items length', () => {
		const items = Array.from({length: 3}, (_, i) => makeTodoItem(String(i)));
		expect(() => buildTodoOnly(items, 5, 3)).not.toThrow();
	});

	it('does not crash when visibleTodoItems contains sparse undefined entries', () => {
		const items = [
			makeTodoItem('0'),
			undefined,
			makeTodoItem('2'),
		] as unknown as TodoPanelItem[];
		expect(() => buildTodoOnly(items, 6, 0)).not.toThrow();
	});

	it('does not crash when a todo item is missing status', () => {
		const items = [
			{
				id: 'broken',
				text: 'task-broken',
				priority: 'P1',
			},
		] as unknown as TodoPanelItem[];
		expect(() => buildTodoOnly(items, 4, 0)).not.toThrow();
	});
});

describe('buildBodyLines — stale runSummaries with over-allocated rows', () => {
	it('does not crash when actualRunOverlayRows exceeds runSummaries length', () => {
		// Simulates: layout allocated 4 overlay rows but runSummaries is empty
		expect(() =>
			buildBodyLines({
				innerWidth: 80,
				todo: {
					actualTodoRows: 0,
					todoPanel: {todoScroll: 0, todoCursor: 0, visibleTodoItems: []},
					focusMode: 'feed',
					ascii: true,
					appMode: 'idle',
					doneCount: 0,
					totalCount: 0,
					spinnerFrame: '*',
				},
				runOverlay: {
					actualRunOverlayRows: 4,
					runSummaries: [
						{
							runId: 'r1',
							status: 'done',
							title: 'Test run',
							startedAt: Date.now(),
							events: 0,
						},
					],
					runFilter: 'all',
				},
				theme: defaultTheme,
			}),
		).not.toThrow();
	});
});

describe('buildBodyLines — skipHeader', () => {
	it('omits header line when skipHeader is true', () => {
		const items = Array.from({length: 3}, (_, i) => makeTodoItem(String(i)));
		const result = buildBodyLines({
			innerWidth: 80,
			todo: {
				actualTodoRows: 5,
				todoPanel: {todoScroll: 0, todoCursor: 0, visibleTodoItems: items},
				focusMode: 'todo',
				ascii: true,
				appMode: 'idle',
				doneCount: 0,
				totalCount: 3,
				spinnerFrame: '*',
				skipHeader: true,
			},
			runOverlay: {actualRunOverlayRows: 0, runSummaries: [], runFilter: 'all'},
			theme: defaultTheme,
		});
		// Without skipHeader, first line would be the "* IDLE ..." header.
		// With skipHeader, first line should be an item row.
		const firstPlain = stripAnsi(result[0] ?? '');
		expect(firstPlain).not.toContain('IDLE');
	});

	it('includes header line when skipHeader is false/undefined', () => {
		const items = Array.from({length: 3}, (_, i) => makeTodoItem(String(i)));
		const result = buildBodyLines({
			innerWidth: 80,
			todo: {
				actualTodoRows: 5,
				todoPanel: {todoScroll: 0, todoCursor: 0, visibleTodoItems: items},
				focusMode: 'todo',
				ascii: true,
				appMode: 'idle',
				doneCount: 0,
				totalCount: 3,
				spinnerFrame: '*',
			},
			runOverlay: {actualRunOverlayRows: 0, runSummaries: [], runFilter: 'all'},
			theme: defaultTheme,
		});
		const firstPlain = stripAnsi(result[0] ?? '');
		expect(firstPlain).toContain('IDLE');
	});
});
