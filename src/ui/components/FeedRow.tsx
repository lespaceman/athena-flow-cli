import {performance} from 'node:perf_hooks';
import React from 'react';
import {Box, Text} from 'ink';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import {type TimelineEntry} from '../../core/feed/timeline';
import {type Theme} from '../theme/types';
import {parseToolName} from '../../shared/utils/toolNameParser';
import {
	formatGutter,
	formatTime,
	formatEvent,
	formatActor,
	formatTool,
	type ToolPillCategory,
	resolveToolPillCategoryForLabel,
	formatResult,
	formatDetails,
} from '../../core/feed/cellFormatters';
import {fitAnsi, spaces} from '../../shared/utils/format';
import {logVisibleRowFormat} from '../../shared/utils/perf';

type FeedColumnWidths = {
	toolW: number;
	detailsW: number;
	resultW: number;
	gapW: number;
	detailsResultGapW: number;
	timeEventGapW: number;
};

type Props = {
	entry: TimelineEntry;
	cols: FeedColumnWidths;
	focused: boolean;
	expanded: boolean;
	matched: boolean;
	isDuplicateActor: boolean;
	ascii: boolean;
	theme: Theme;
};

type FeedRowLineProps = Props & {
	innerWidth: number;
};

const ROW_LINE_CACHE_MAX_VARIANTS = 16;
const ROW_LINE_CACHE_MAX_ENTRIES = 2_000;
const rowLineCache = new Map<
	string,
	{signature: string; variants: Map<string, string>}
>();
const detailSummaryCache = new WeakMap<
	TimelineEntry,
	{segments: TimelineEntry['summarySegments']; summary: string}
>();
const themeIdCache = new WeakMap<Theme, number>();
let nextThemeId = 1;

const BUILTIN_SUBAGENT_LABELS: Record<string, string> = {
	explore: 'Explore',
	plan: 'Plan',
	'general-purpose': 'General Purpose',
	bash: 'Bash',
};

function normalizeSubagentType(type: string): string {
	return type
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, '-');
}

function canonicalSubagentLabel(type: string): string {
	return BUILTIN_SUBAGENT_LABELS[normalizeSubagentType(type)] ?? type;
}

function defaultEventPillLabel(opTag: string): string | undefined {
	switch (opTag) {
		case 'agent.msg':
		case 'msg.agent':
			return 'Agent';
		case 'msg.user':
		case 'prompt':
			return 'User';
		default:
			return undefined;
	}
}

function getThemeId(theme: Theme): number {
	const cached = themeIdCache.get(theme);
	if (cached !== undefined) return cached;
	const id = nextThemeId++;
	themeIdCache.set(theme, id);
	return id;
}

function getLineCache(entry: TimelineEntry): Map<string, string> {
	const signature = [
		entry.ts,
		entry.op,
		entry.opTag,
		entry.actor,
		entry.actorId,
		entry.toolColumn,
		entry.summary,
		entry.summaryOutcome ?? '',
		entry.summaryOutcomeZero ? 1 : 0,
		entry.error ? 1 : 0,
		entry.expandable ? 1 : 0,
	].join('\u001F');

	const cached = rowLineCache.get(entry.id);
	if (cached && cached.signature === signature) {
		// Promote recently-used rows so oldest entries can be evicted first.
		rowLineCache.delete(entry.id);
		rowLineCache.set(entry.id, cached);
		return cached.variants;
	}

	const created = {signature, variants: new Map<string, string>()};
	rowLineCache.set(entry.id, created);
	if (rowLineCache.size > ROW_LINE_CACHE_MAX_ENTRIES) {
		const oldestEntryId = rowLineCache.keys().next().value;
		if (oldestEntryId !== undefined) {
			rowLineCache.delete(oldestEntryId);
		}
	}
	return created.variants;
}

function trimVerbPrefix(entry: TimelineEntry): {
	segments: TimelineEntry['summarySegments'];
	summary: string;
} {
	const cached = detailSummaryCache.get(entry);
	if (cached) return cached;

	let verbLen = 0;
	const segments: TimelineEntry['summarySegments'] = [];
	for (const segment of entry.summarySegments) {
		if (segment.role === 'verb') {
			verbLen += segment.text.length;
			continue;
		}
		segments.push(segment);
	}
	if (segments.length > 0) {
		const first = segments[0]!;
		const trimmed = first.text.trimStart();
		if (trimmed !== first.text) {
			segments[0] = {...first, text: trimmed};
		}
	}

	const result = {
		segments,
		summary: entry.summary.slice(verbLen).trimStart(),
	};
	detailSummaryCache.set(entry, result);
	return result;
}

function buildLineCacheKey({
	entry,
	cols,
	focused,
	expanded,
	matched,
	isDuplicateActor,
	ascii,
	theme,
	innerWidth,
}: FeedRowLineProps): string {
	return [
		innerWidth,
		cols.toolW,
		cols.detailsW,
		cols.resultW,
		cols.gapW,
		cols.detailsResultGapW,
		cols.timeEventGapW,
		focused ? 1 : 0,
		expanded ? 1 : 0,
		matched ? 1 : 0,
		isDuplicateActor ? 1 : 0,
		ascii ? 1 : 0,
		entry.expandable ? 1 : 0,
		entry.error ? 1 : 0,
		getThemeId(theme),
	].join('|');
}

/** Optionally apply a single color override to a preformatted cell. */
function cell(content: string, overrideColor?: string): string {
	if (!overrideColor) return content;
	return chalk.hex(overrideColor)(stripAnsi(content));
}

function lineParts({
	entry,
	cols,
	focused,
	expanded: _expanded,
	matched,
	isDuplicateActor,
	ascii,
	theme,
}: Props): {
	gutter: string;
	time: string;
	event: string;
	actor: string;
	tool: string;
	detail: string;
	result: string;
} {
	const isUserBorder = entry.opTag === 'prompt' || entry.opTag === 'msg.user';
	const rowTextOverrideColor = focused ? theme.text : undefined;
	const eventOverrideColor = (() => {
		if (!focused) return undefined;
		if (entry.opTag === 'tool.ok') return theme.status.success;
		if (entry.opTag === 'tool.fail') return theme.status.error;
		return theme.text;
	})();
	const isToolRow =
		entry.opTag.startsWith('tool.') || entry.opTag === 'perm.req';
	const isSubagentRow =
		entry.opTag === 'sub.start' || entry.opTag === 'sub.stop';
	const syntheticLabel =
		entry.toolColumn.length === 0
			? defaultEventPillLabel(entry.opTag)
			: undefined;
	const toolText = isSubagentRow
		? canonicalSubagentLabel(entry.toolColumn)
		: entry.toolColumn || syntheticLabel || '';
	const hasSyntheticPill = syntheticLabel !== undefined;
	const toolCategory: ToolPillCategory = (() => {
		if (isSubagentRow) {
			return 'subagent';
		}
		if (!isToolRow || !entry.feedEvent) return 'neutral';
		if (
			entry.feedEvent.kind === 'tool.pre' ||
			entry.feedEvent.kind === 'tool.post' ||
			entry.feedEvent.kind === 'tool.failure' ||
			entry.feedEvent.kind === 'permission.request'
		) {
			const parsed = parseToolName(entry.feedEvent.data.tool_name);
			const label = entry.toolColumn || parsed.displayName;
			return resolveToolPillCategoryForLabel(label);
		}
		return resolveToolPillCategoryForLabel(toolText);
	})();

	const gutter = formatGutter({
		focused,
		matched,
		isUserBorder,
		ascii,
		theme,
	});
	const time = cell(formatTime(entry.ts, 5, theme), rowTextOverrideColor);
	const event = cell(
		formatEvent(entry.op, 12, theme, entry.opTag),
		eventOverrideColor,
	);
	const actor = formatActor(
		entry.actor,
		isDuplicateActor,
		10,
		theme,
		entry.actorId,
	);
	const tool = cell(
		formatTool(toolText, cols.toolW, theme, {
			pill: isToolRow || isSubagentRow || hasSyntheticPill,
			category: toolCategory,
			subagentType: isSubagentRow ? entry.toolColumn : undefined,
			ascii,
		}),
		rowTextOverrideColor,
	);

	const detailSummaryInfo = trimVerbPrefix(entry);

	const detail = cell(
		formatDetails({
			segments: detailSummaryInfo.segments,
			summary: detailSummaryInfo.summary,
			mode: 'full',
			contentWidth: cols.detailsW,
			theme,
			opTag: entry.opTag,
			isError: entry.error,
		}),
		focused ? theme.text : theme.textMuted,
	);
	const result = cell(
		formatResult(
			entry.summaryOutcome,
			entry.summaryOutcomeZero,
			cols.resultW,
			theme,
		),
		rowTextOverrideColor,
	);
	return {
		gutter,
		time,
		event,
		actor,
		tool,
		detail,
		result,
	};
}

export function formatFeedRowLine({
	innerWidth,
	...props
}: FeedRowLineProps): string {
	const startedAt = performance.now();
	try {
		const cachedLines = getLineCache(props.entry);
		const cacheKey = buildLineCacheKey({...props, innerWidth});
		const cached = cachedLines.get(cacheKey);
		if (cached !== undefined) return cached;

		const parts = lineParts(props);
		const {
			cols: {gapW, timeEventGapW, detailsResultGapW, resultW},
		} = props;

		let line =
			parts.gutter +
			parts.time +
			spaces(timeEventGapW) +
			parts.event +
			spaces(gapW) +
			parts.actor +
			spaces(gapW) +
			parts.tool +
			spaces(gapW) +
			parts.detail;

		if (resultW > 0) {
			line += spaces(detailsResultGapW) + parts.result;
		}

		const formatted = fitAnsi(line, innerWidth);
		const focusedFormatted = props.focused
			? fitAnsi(chalk.bgHex('#1b2a3f')(formatted), innerWidth)
			: formatted;
		cachedLines.set(cacheKey, focusedFormatted);
		if (cachedLines.size > ROW_LINE_CACHE_MAX_VARIANTS) {
			const oldestKey = cachedLines.keys().next().value;
			if (oldestKey !== undefined) {
				cachedLines.delete(oldestKey);
			}
		}
		return focusedFormatted;
	} finally {
		logVisibleRowFormat(performance.now() - startedAt);
	}
}

function FeedRowImpl({
	entry,
	cols,
	focused,
	expanded,
	matched,
	isDuplicateActor,
	ascii,
	theme,
}: Props) {
	const parts = lineParts({
		entry,
		cols,
		focused,
		expanded,
		matched,
		isDuplicateActor,
		ascii,
		theme,
	});

	return (
		<>
			<Box width={1} flexShrink={0}>
				<Text wrap="truncate-end">{parts.gutter}</Text>
			</Box>
			<Box width={5} flexShrink={0}>
				<Text wrap="truncate-end">{parts.time}</Text>
			</Box>
			<Box width={cols.timeEventGapW} flexShrink={0} />
			<Box width={12} flexShrink={0}>
				<Text wrap="truncate-end">{parts.event}</Text>
			</Box>
			<Box width={cols.gapW} flexShrink={0} />
			<Box width={10} flexShrink={0}>
				<Text wrap="truncate-end">{parts.actor}</Text>
			</Box>
			<Box width={cols.gapW} flexShrink={0} />
			<Box width={cols.toolW} flexShrink={0}>
				<Text wrap="truncate-end">{parts.tool}</Text>
			</Box>
			<Box width={cols.gapW} flexShrink={0} />
			<Box width={cols.detailsW} flexShrink={0}>
				<Text wrap="truncate-end">{parts.detail}</Text>
			</Box>
			{cols.resultW > 0 && (
				<>
					<Box width={cols.detailsResultGapW} flexShrink={0} />
					<Box width={cols.resultW} flexShrink={0}>
						<Text wrap="truncate-end">{parts.result}</Text>
					</Box>
				</>
			)}
			<Box flexGrow={1} flexShrink={1} />
		</>
	);
}

export const FeedRow = React.memo(FeedRowImpl);

export type {FeedColumnWidths};
