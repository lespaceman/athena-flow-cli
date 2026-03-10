import chalk from 'chalk';
import {progressGlyphs} from '../glyphs/index';

export function formatTokenCount(value: number | null): string {
	if (value === null) return '--';
	if (value < 1000) return String(value);
	const k = value / 1000;
	if (Number.isInteger(k)) return `${k}k`;
	return `${parseFloat(k.toFixed(1))}k`;
}

export type ContextBarPalette = {
	label: string;
	numbers: string;
	percent: string;
	track: string;
	low: string;
	medium: string;
	high: string;
};

const DEFAULT_PALETTE: ContextBarPalette = {
	label: '#484f58',
	numbers: '#6e7681',
	percent: '#484f58',
	track: '#1e2a38',
	low: '#3fb950',
	medium: '#fbbf24',
	high: '#f97316',
};

const MIN_BAR_WIDTH = 7;
const MEDIUM_THRESHOLD = 0.6;
const HIGH_THRESHOLD = 0.8;

export function renderContextBar(
	used: number | null,
	max: number | null,
	width: number,
	hasColor: boolean,
	palette?: Partial<ContextBarPalette>,
): string {
	const colors = {...DEFAULT_PALETTE, ...palette};
	const usedStr = formatTokenCount(used);
	const maxStr = formatTokenCount(max);
	const hasValidContextWindow = used !== null && max !== null && max > 0;
	const rawPct = hasValidContextWindow
		? Math.round((Math.max(0, used) / max) * 100)
		: null;
	const pct = rawPct === null ? null : Math.max(0, Math.min(999, rawPct));
	const label = 'Context';
	const pctText = pct !== null ? ` · ${pct}%` : '';

	if (!hasValidContextWindow) {
		if (hasColor) {
			const labelStyled = chalk.hex(colors.label)(label);
			const countsStyled = chalk.hex(colors.numbers)(' --');
			return `${labelStyled}${countsStyled}`;
		}
		return `${label} --`;
	}

	const bracketOverhead = hasColor ? 0 : 2;
	const countText = `${usedStr} / ${maxStr}`;
	const numbersWidth = 1 + countText.length + pctText.length;
	const barWidth = Math.max(
		MIN_BAR_WIDTH,
		width - label.length - 1 - numbersWidth - bracketOverhead,
	);

	const ratio = max > 0 ? Math.min(1, Math.max(0, used / max)) : 0;
	const filled = Math.round(ratio * barWidth);
	const empty = barWidth - filled;

	let bar: string;
	if (hasColor) {
		const pg = progressGlyphs(false);
		const filledStr = pg.filled.repeat(filled);
		const emptyStr = pg.track.repeat(empty);
		const fillColor =
			ratio > HIGH_THRESHOLD
				? colors.high
				: ratio > MEDIUM_THRESHOLD
					? colors.medium
					: colors.low;
		bar = chalk.hex(fillColor)(filledStr) + chalk.hex(colors.track)(emptyStr);
	} else {
		const pg = progressGlyphs(true);
		const filledStr = pg.filled.repeat(filled);
		const emptyStr = pg.empty.repeat(empty);
		bar = `[${filledStr}${emptyStr}]`;
	}

	if (hasColor) {
		const labelStyled = chalk.hex(colors.label)(label);
		const countsStyled = chalk.hex(colors.numbers)(` ${countText}`);
		const pctStyled = pctText ? chalk.hex(colors.percent)(pctText) : '';
		return `${labelStyled} ${bar}${countsStyled}${pctStyled}`;
	}
	return `${label} ${bar} ${countText}${pctText}`;
}
