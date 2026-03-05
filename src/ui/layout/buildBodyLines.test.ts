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

describe('buildTodoHeaderLine', () => {
	it('shows IDLE with dot glyph when not working', () => {
		const line = buildTodoHeaderLine(80, {
			ascii: true,
			appMode: 'idle',
			spinnerFrame: '',
			doneCount: 2,
			totalCount: 5,
		}, defaultTheme);
		const plain = stripAnsi(line);
		expect(plain).toContain('IDLE');
		expect(plain).toContain('2/5');
	});

	it('shows WORKING with spinner glyph when working', () => {
		const line = buildTodoHeaderLine(80, {
			ascii: false,
			appMode: 'working',
			spinnerFrame: '\u280B',
			colors: {doing: '#facc15', done: '#888', failed: '#f00', blocked: '#facc15', text: '#fff', textMuted: '#888', default: '#888'},
			doneCount: 1,
			totalCount: 3,
		}, defaultTheme);
		const plain = stripAnsi(line);
		expect(plain).toContain('WORKING');
		expect(plain).toContain('\u280B');
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
