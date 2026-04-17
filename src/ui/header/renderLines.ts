import chalk from 'chalk';
import stringWidth from 'string-width';
import type {Theme} from '../theme/types';
import {darkTheme} from '../theme/themes';
import type {HeaderModel} from './model';
import {
	formatTokenCount,
	renderContextBar,
	type ContextBarPalette,
} from './contextBar';
import {formatModelName} from '../../shared/utils/formatters';

export function truncateSessionId(id: string, maxWidth: number): string {
	if (id.length <= maxWidth) return id;
	if (maxWidth >= 12) {
		const tail = id.slice(-6);
		return id.slice(0, maxWidth - 7) + '\u2026' + tail;
	}
	const alphanumeric = id.replace(/[^a-zA-Z0-9]/g, '').slice(-4);
	return 'S' + (alphanumeric || '\u2013');
}

export function renderHeaderLines(
	model: HeaderModel,
	width: number,
	hasColor: boolean,
	theme?: Theme,
): [string] {
	const SEP = '  ';
	const MIN_GAP = 2;
	const palette = resolveHeaderPalette(theme);
	const style = (text: string, color: string, bold = false): string => {
		if (!hasColor) return text;
		const painter = chalk.hex(color);
		return bold ? painter.bold(text) : painter(text);
	};
	const athena = style('ATHENA FLOW', palette.brand, true);
	const divider = style('\u2502', palette.divider);

	// Context bar (visual progress)
	const ctxBarWidth = Math.max(24, Math.min(32, Math.floor(width * 0.24)));
	const ctxText = renderContextBar(
		model.context.used,
		model.context.max,
		ctxBarWidth,
		hasColor,
		palette.context,
	);

	// Truncated session ID
	const sid = truncateSessionId(model.session_id, 8);
	const sidLabel = style('S: ', palette.label);
	const sidValue = style(sid, palette.value);
	const sidScope =
		model.session_total > 0
			? ` (${model.session_index ?? model.session_total}/${model.session_total})`
			: '';
	const sidText = `${sidLabel}${sidValue}${style(sidScope, palette.label)}`;
	const wfText = `${style('Workflow: ', palette.label)}${style(model.workflow, palette.value)}`;
	const harnessText = `${style('Harness: ', palette.label)}${style(model.harness, palette.value)}`;
	const modelText = `${style('Model: ', palette.label)}${style(formatModelName(model.model_name), palette.value)}`;

	type Token = {text: string; priority: number};
	const leftTokens: Token[] = [
		{text: athena, priority: 100},
		{text: divider, priority: 5},
		{text: sidText, priority: 90},
		{text: wfText, priority: 70},
		{text: harnessText, priority: 60},
		{text: modelText, priority: 65},
		// Token count (e.g., "Tokens: 45.2k")
		...(model.total_tokens !== null
			? [
					{
						text: `${style('Tokens: ', palette.label)}${style(formatTokenCount(model.total_tokens), palette.value)}`,
						priority: 40,
					},
				]
			: []),
		// Run count (e.g., "Runs: 3")
		...(model.run_count > 0
			? [
					{
						text: `${style('Runs: ', palette.label)}${style(String(model.run_count), palette.value)}`,
						priority: 50,
					},
				]
			: []),
	];

	const buildLine = (ts: Token[]): string => {
		return ts.map(t => t.text).join(SEP);
	};

	const currentLeft = [...leftTokens];
	const totalTarget = Math.max(1, width - 1);

	while (
		currentLeft.length > 1 &&
		stringWidth(buildLine(currentLeft)) + MIN_GAP + stringWidth(ctxText) >
			totalTarget
	) {
		let minIdx = 1;
		let minPri = currentLeft[1]!.priority;
		for (let i = 2; i < currentLeft.length; i++) {
			if (currentLeft[i]!.priority < minPri) {
				minPri = currentLeft[i]!.priority;
				minIdx = i;
			}
		}
		currentLeft.splice(minIdx, 1);
	}

	const left = buildLine(currentLeft);
	const usedWidth = stringWidth(left) + stringWidth(ctxText);
	const gapWidth = Math.max(MIN_GAP, totalTarget - usedWidth);
	const line = `${left}${' '.repeat(gapWidth)}${ctxText}`;
	const lineWidth = stringWidth(line);
	const padded =
		lineWidth < totalTarget ? line + ' '.repeat(totalTarget - lineWidth) : line;
	return [padded];
}

type HeaderPalette = {
	brand: string;
	divider: string;
	label: string;
	value: string;
	context: Partial<ContextBarPalette>;
};

function resolveHeaderPalette(theme?: Theme): HeaderPalette {
	const t = theme ?? darkTheme;
	return {
		brand: t.text,
		divider: t.textMuted,
		label: t.textMuted,
		value: t.status.neutral,
		context: {
			label: t.textMuted,
			numbers: t.status.neutral,
			percent: t.textMuted,
			track: t.contextBar.track,
			low: t.contextBar.low,
			medium: t.contextBar.medium,
			high: t.contextBar.high,
		},
	};
}
