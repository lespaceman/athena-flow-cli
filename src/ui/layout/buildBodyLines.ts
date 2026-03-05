import {type RunSummary} from '../../core/feed/timeline';
import {
	type TodoPanelItem,
	type TodoGlyphColors,
	todoGlyphs,
} from '../../core/feed/todoPanel';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import {compactText, fitAnsi, formatRunLabel} from '../../shared/utils/format';
import {type Theme} from '../theme/types';

export type TodoViewState = {
	actualTodoRows: number;
	todoPanel: {
		todoScroll: number;
		todoCursor: number;
		visibleTodoItems: TodoPanelItem[];
	};
	focusMode: string;
	ascii: boolean;
	colors?: TodoGlyphColors;
	appMode: 'idle' | 'working' | 'permission' | 'question';
	doneCount: number;
	totalCount: number;
	spinnerFrame: string;
};

export type RunOverlayState = {
	actualRunOverlayRows: number;
	runSummaries: RunSummary[];
	runFilter: string;
};

export type BuildBodyLinesOptions = {
	innerWidth: number;
	todo: TodoViewState;
	runOverlay: RunOverlayState;
	theme: Theme;
};

export function buildBodyLines({
	innerWidth,
	todo,
	runOverlay,
	theme,
}: BuildBodyLinesOptions): string[] {
	const bodyLines: string[] = [];

	const {actualTodoRows, todoPanel: tp, focusMode: todoFocus} = todo;
	const {actualRunOverlayRows, runSummaries, runFilter} = runOverlay;

	if (actualTodoRows > 0) {
		const {
			todoScroll: tScroll,
			todoCursor: tCursor,
			visibleTodoItems: items,
		} = tp;
		const g = todoGlyphs(todo.ascii, todo.colors);

		const isWorking = todo.appMode === 'working';
		const idleGlyph = todo.ascii ? '*' : '\u25CF';
		const rawLeadGlyph = isWorking ? todo.spinnerFrame : idleGlyph;
		const leadColor = isWorking ? theme.status.warning : theme.status.success;
		const leadGlyph = chalk.hex(leadColor)(rawLeadGlyph);
		const statusWord = isWorking ? 'WORKING' : 'IDLE';
		const statusColor = isWorking ? todo.colors?.doing : theme.status.success;
		const coloredStatus = statusColor
			? chalk.hex(statusColor)(statusWord)
			: statusWord;
		const stats =
			todo.totalCount > 0
				? `  ${chalk.hex(theme.text)(`${todo.doneCount}/${todo.totalCount}`)} ${chalk.hex(theme.textMuted)('tasks done')}`
				: '';
		bodyLines.push(
			fitAnsi(`${leadGlyph} ${coloredStatus}${stats}`, innerWidth),
		);

		// For ultra-small layouts, render only what fits in the assigned rows.
		if (actualTodoRows > 1) {
			const itemSlots = Math.max(0, actualTodoRows - 2); // minus header and divider
			const totalItems = items.length;
			const hasScrollUp = tScroll > 0;

			// Two-pass affordance calculation: deduct scroll-up first,
			// then check scroll-down against the reduced slot count.
			let renderSlots = itemSlots;
			if (hasScrollUp) renderSlots--;
			const hasScrollDown = tScroll + renderSlots < totalItems;
			if (hasScrollDown) renderSlots--;
			renderSlots = Math.max(0, renderSlots);
			let showScrollUp = hasScrollUp;
			let showScrollDown = hasScrollDown;

			// Never emit more content rows than `itemSlots`.
			while (
				(showScrollUp ? 1 : 0) + (showScrollDown ? 1 : 0) + renderSlots >
				itemSlots
			) {
				if (renderSlots > 0) {
					renderSlots--;
					continue;
				}
				if (showScrollDown) {
					showScrollDown = false;
					continue;
				}
				if (showScrollUp) {
					showScrollUp = false;
					continue;
				}
				break;
			}

			if (showScrollUp) {
				const aboveCount = tScroll;
				bodyLines.push(
					fitAnsi(`${g.scrollUp}  +${aboveCount} more`, innerWidth),
				);
			}

			for (let i = 0; i < renderSlots; i++) {
				const item = items[tScroll + i];
				const isFocused = todoFocus === 'todo' && tCursor === tScroll + i;
				const caret = isFocused ? g.caret : ' ';
				const row = g.styledRow(item);

				const glyphStr = row.glyph;
				const suffixStr = row.suffix;
				const elapsedStr = item.elapsed ? row.elapsed(item.elapsed) : '';

				// Layout: [caret] [glyph]  [text...] [suffix] [elapsed]
				const fixedWidth = 4; // caret + space + glyph + 2 spaces
				const suffixWidth = suffixStr ? stripAnsi(suffixStr).length + 1 : 0;
				const elapsedWidth = elapsedStr ? stripAnsi(elapsedStr).length + 1 : 0;
				const maxTitleWidth = Math.max(
					1,
					innerWidth - fixedWidth - suffixWidth - elapsedWidth,
				);
				const title = row.text(fitAnsi(item.text, maxTitleWidth).trimEnd());

				let line = `${caret} ${glyphStr}  ${title}`;
				if (suffixStr) line += ` ${suffixStr}`;
				if (elapsedStr) {
					const currentLen = stripAnsi(line).length;
					const pad = Math.max(
						1,
						innerWidth - currentLen - stripAnsi(elapsedStr).length,
					);
					line += ' '.repeat(pad) + elapsedStr;
				}
				bodyLines.push(fitAnsi(line, innerWidth));
			}

			if (showScrollDown) {
				const moreCount = totalItems - (tScroll + renderSlots);
				bodyLines.push(
					fitAnsi(`${g.scrollDown}  +${moreCount} more`, innerWidth),
				);
			}

			// Divider line (subtle, close to frame border tone)
			const divider = chalk
				.hex(theme.border)
				.dim(g.dividerChar.repeat(innerWidth));
			bodyLines.push(fitAnsi(divider, innerWidth));
		}
	}

	if (actualRunOverlayRows > 0) {
		bodyLines.push(fitAnsi('[RUNS]', innerWidth));
		const listRows = actualRunOverlayRows - 1;
		const start = Math.max(0, runSummaries.length - listRows);
		for (let i = 0; i < actualRunOverlayRows - 1; i++) {
			const summary = runSummaries[start + i];
			const active =
				runFilter !== 'all' && runFilter === summary.runId ? '*' : ' ';
			const line = `${active} ${formatRunLabel(summary.runId)} ${summary.status.padEnd(9, ' ')} ${compactText(summary.title, 48)}`;
			bodyLines.push(fitAnsi(line, innerWidth));
		}
	}

	// Feed rows are rendered by <FeedGrid> in app.tsx — not included here.

	return bodyLines;
}
