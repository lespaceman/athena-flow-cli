import chalk from 'chalk';
import {type TodoItem} from './todo';
import {
	todoGlyphSet as getTodoGlyphSet,
	getGlyphs,
} from '../../ui/glyphs/index';

export type TodoPanelStatus = 'open' | 'doing' | 'blocked' | 'done' | 'failed';

export type TodoPanelItem = {
	id: string;
	text: string;
	priority: 'P0' | 'P1' | 'P2';
	status: TodoPanelStatus;
	linkedEventId?: string;
	owner?: string;
	localOnly?: boolean;
	elapsed?: string;
};

export function toTodoStatus(status: TodoItem['status']): TodoPanelStatus {
	switch (status) {
		case 'in_progress':
			return 'doing';
		case 'completed':
			return 'done';
		case 'failed':
			return 'failed';
		case 'pending':
			return 'open';
	}
}

export type StyledRow = {
	glyph: string;
	text: (raw: string) => string;
	suffix: string;
	elapsed: (raw: string) => string;
};

export type TodoGlyphs = {
	statusGlyph: (status: TodoPanelStatus) => string;
	styledRow: (item: TodoPanelItem) => StyledRow;
	caret: string;
	dividerChar: string;
	scrollUp: string;
	scrollDown: string;
};

export type TodoGlyphColors = {
	doing: string;
	done: string;
	failed: string;
	blocked: string;
	text: string;
	textMuted: string;
	default: string;
};

function colorForStatus(
	status: TodoPanelStatus,
	colors: TodoGlyphColors,
): string {
	switch (status) {
		case 'doing':
			return colors.doing;
		case 'done':
			return colors.done;
		case 'failed':
			return colors.failed;
		case 'blocked':
			return colors.blocked;
		case 'open':
			return colors.default;
	}
}

export function todoGlyphs(
	ascii = false,
	colors?: TodoGlyphColors,
): TodoGlyphs {
	const table = getTodoGlyphSet(ascii);
	const identity = (raw: string) => raw;
	const empty = () => '';
	return {
		statusGlyph(status: TodoPanelStatus): string {
			const raw = table[status];
			if (!colors) return raw;
			return chalk.hex(colorForStatus(status, colors))(raw);
		},
		styledRow(item: TodoPanelItem): StyledRow {
			if (!colors) {
				return {
					glyph: table[item.status],
					text: identity,
					suffix: '',
					elapsed: identity,
				};
			}
			switch (item.status) {
				case 'done':
					return {
						glyph: chalk.dim(chalk.hex(colors.done)(table.done)),
						text: (raw: string) => chalk.dim(chalk.hex(colors.textMuted)(raw)),
						suffix: '',
						elapsed: (raw: string) =>
							chalk.dim(chalk.hex(colors.textMuted)(raw)),
					};
				case 'doing':
					return {
						glyph: chalk.hex(colors.doing)(table.doing),
						text: (raw: string) => chalk.hex(colors.text)(raw),
						suffix: chalk.hex(colors.doing)('\u2190 active'),
						elapsed: (raw: string) => chalk.hex(colors.doing)(raw),
					};
				case 'failed':
					return {
						glyph: chalk.hex(colors.failed)(table.failed),
						text: (raw: string) => chalk.hex(colors.text)(raw),
						suffix: chalk.hex(colors.failed)('\u2190 failed'),
						elapsed: (raw: string) =>
							chalk.dim(chalk.hex(colors.textMuted)(raw)),
					};
				case 'blocked':
					return {
						glyph: chalk.hex(colors.blocked)(table.blocked),
						text: (raw: string) => chalk.dim(chalk.hex(colors.blocked)(raw)),
						suffix: chalk.hex(colors.blocked)('\u2190 blocked'),
						elapsed: empty,
					};
				case 'open':
					return {
						glyph: chalk.hex(colors.textMuted)(table.open),
						text: (raw: string) => chalk.hex(colors.textMuted)(raw),
						suffix: '',
						elapsed: empty,
					};
			}
		},
		caret: table.caret,
		dividerChar: getGlyphs(ascii)['general.divider'],
		scrollUp: table.scrollUp,
		scrollDown: table.scrollDown,
	};
}
