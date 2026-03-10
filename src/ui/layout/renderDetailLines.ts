import {type FeedEvent} from '../../core/feed/types';
import {extractToolOutput} from '../tooling/toolExtractors';
import {
	parseToolName,
	extractFriendlyServerName,
} from '../../shared/utils/toolNameParser';
import {resolveToolColumn} from '../../core/feed/toolDisplay';
import {highlight} from 'cli-highlight';
import chalk from 'chalk';
import {createMarkedInstance} from '../../shared/utils/markedFactory';
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';
import {formatClock} from '../../shared/utils/format';

export type DetailRenderResult = {
	lines: string[];
	showLineNumbers: boolean;
};

const MAX_HIGHLIGHT_SIZE = 50_000;
const DETAIL_TITLE_COLOR = '#c9d1d9';
const DETAIL_SUBJECT_COLOR = '#58a6ff';

function wrapAnsiLine(line: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [''];
	if (line.length === 0) return [''];
	if (stringWidth(line) <= maxWidth) return [line];

	const chunks: string[] = [];
	const visualWidth = stringWidth(line);
	for (let start = 0; start < visualWidth; start += maxWidth) {
		chunks.push(sliceAnsi(line, start, start + maxWidth));
	}
	return chunks.length > 0 ? chunks : [''];
}

function wrapAnsiLines(lines: string[], maxWidth: number): string[] {
	const wrapped: string[] = [];
	for (const line of lines) {
		wrapped.push(...wrapAnsiLine(line, maxWidth));
	}
	return wrapped;
}

export function renderMarkdownToLines(
	content: string,
	width: number,
): string[] {
	if (!content.trim()) return ['(empty)'];
	const m = createMarkedInstance(width);
	try {
		const result = m.parse(content);
		const rendered = typeof result === 'string' ? result.trimEnd() : content;
		return wrapAnsiLines(rendered.replace(/\n{3,}/g, '\n').split('\n'), width);
	} catch {
		return wrapAnsiLines(content.split('\n'), width);
	}
}

function highlightCode(
	content: string,
	width: number,
	language?: string,
): string[] {
	if (!content.trim()) return ['(empty)'];
	try {
		const highlighted =
			language && content.length <= MAX_HIGHLIGHT_SIZE
				? highlight(content, {language})
				: content;
		return wrapAnsiLines(highlighted.split('\n'), width);
	} catch {
		return wrapAnsiLines(content.split('\n'), width);
	}
}

function renderDiff(oldText: string, newText: string, width: number): string[] {
	const lines: string[] = [];
	for (const line of oldText.split('\n')) {
		lines.push(chalk.red(`- ${line}`));
	}
	for (const line of newText.split('\n')) {
		lines.push(chalk.green(`+ ${line}`));
	}
	return wrapAnsiLines(lines, width);
}

function renderList(
	items: {primary: string; secondary?: string}[],
	width: number,
): string[] {
	return wrapAnsiLines(
		items.map(item =>
			item.secondary
				? `  ${chalk.dim(item.secondary)}  ${item.primary}`
				: `  ${item.primary}`,
		),
		width,
	);
}

type ContentSection = {
	lines: string[];
	showLineNumbers: boolean;
};

const GUTTER = chalk.dim('⎿  ');
const GUTTER_PAD = '   ';
const GUTTER_WIDTH = 3;

/** Prefix content lines with ⎿ gutter on first line, align rest. */
function withGutter(lines: string[]): string[] {
	return lines.map((line, i) => (i === 0 ? GUTTER + line : GUTTER_PAD + line));
}

/** Content width after reserving space for the gutter prefix. */
function contentWidth(width: number): number {
	return Math.max(10, width - GUTTER_WIDTH);
}

/** Combine header + guttered content into a DetailRenderResult. */
function buildResult(
	header: string[],
	content: string[],
	showLineNumbers: boolean,
): DetailRenderResult {
	return {lines: [...header, ...withGutter(content)], showLineNumbers};
}

function renderToolResponseContent(
	event: Extract<
		FeedEvent,
		{kind: 'tool.delta'} | {kind: 'tool.post'} | {kind: 'tool.failure'}
	>,
	width: number,
): ContentSection {
	const {tool_name, tool_input} = event.data;

	if (event.kind === 'tool.failure') {
		const errorLines = wrapAnsiLines(event.data.error.split('\n'), width);
		return {lines: errorLines, showLineNumbers: false};
	}

	const output = extractToolOutput(
		tool_name,
		tool_input as Record<string, unknown>,
		event.kind === 'tool.delta' ? event.data.delta : event.data.tool_response,
	);

	switch (output.type) {
		case 'code':
			return {
				lines: highlightCode(output.content, width, output.language),
				showLineNumbers: true,
			};
		case 'diff':
			return {
				lines: renderDiff(output.oldText, output.newText, width),
				showLineNumbers: true,
			};
		case 'list':
			return {
				lines: renderList(output.items, width),
				showLineNumbers: false,
			};
		case 'text':
			return {
				lines: renderMarkdownToLines(output.content, width - 2),
				showLineNumbers: false,
			};
	}
}

// ─── Compact header system ────────────────────────────────────────

/** Display label for a tool: "Read", "Edit", "[context7] query-docs" */
function toolDisplayLabel(toolName: string): string {
	const parsed = parseToolName(toolName);
	const display = resolveToolColumn(toolName);
	if (parsed.isMcp && parsed.mcpServer) {
		const server = extractFriendlyServerName(parsed.mcpServer);
		return `${display} · ${server}`;
	}
	return display;
}

/** Read a string field from a tool input record, or return undefined. */
function str(input: Record<string, unknown>, key: string): string | undefined {
	return typeof input[key] === 'string' ? input[key] : undefined;
}

/**
 * Extract the essential input value for a tool (the "subject line").
 * This replaces the full JSON request -- just the one thing that matters.
 */
function extractToolSubject(
	toolName: string,
	toolInput: unknown,
): string | undefined {
	const input =
		typeof toolInput === 'object' && toolInput !== null
			? (toolInput as Record<string, unknown>)
			: {};
	const parsed = parseToolName(toolName);
	const name = parsed.displayName;

	switch (name) {
		case 'Read':
		case 'Write':
		case 'Edit':
			return str(input, 'file_path');
		case 'Bash': {
			const cmd = str(input, 'command');
			return cmd ? `$ ${cmd}` : undefined;
		}
		case 'Glob':
			return str(input, 'pattern');
		case 'Grep': {
			const parts: string[] = [];
			const pattern = str(input, 'pattern');
			const glob = str(input, 'glob');
			const path = str(input, 'path');
			if (pattern) parts.push(`"${pattern}"`);
			if (glob) parts.push(glob);
			if (path) parts.push(`in ${path}`);
			return parts.length > 0 ? parts.join('  ') : undefined;
		}
		case 'Skill':
			return str(input, 'skill');
		case 'WebFetch':
			return str(input, 'url');
		case 'WebSearch': {
			const query = str(input, 'query');
			return query ? `"${query}"` : undefined;
		}
		case 'Task':
			return str(input, 'description');
		case 'NotebookEdit':
			return str(input, 'notebook_path');
		default:
			return undefined;
	}
}

/** Compact label for any event type. Tool events use the tool name. */
function eventLabel(event: FeedEvent): string {
	switch (event.kind) {
		case 'tool.delta':
		case 'tool.pre':
		case 'tool.post':
		case 'tool.failure':
		case 'permission.request':
			return toolDisplayLabel(event.data.tool_name);
		case 'agent.message':
			return event.data.scope === 'subagent' ? 'Subagent' : 'Agent';
		case 'user.prompt':
			return 'User';
		case 'subagent.start':
		case 'subagent.stop':
			return `Subagent · ${event.data.agent_type}`;
		case 'run.start':
			return 'Run Start';
		case 'run.end':
			return `Run End · ${event.data.status}`;
		case 'session.start':
			return 'Session Start';
		case 'session.end':
			return 'Session End';
		case 'notification':
			return event.data.title || 'Notification';
		case 'permission.decision':
			return `Permission · ${event.data.decision_type}`;
		case 'stop.request':
			return 'Stop';
		case 'stop.decision':
			return `Stop · ${event.data.decision_type}`;
		case 'compact.pre':
			return 'Compaction';
		case 'setup':
			return 'Setup';
		case 'unknown.hook':
			return event.data.hook_event_name || 'Hook Event';
		case 'todo.add':
			return 'Todo Added';
		case 'todo.update':
			return 'Todo Updated';
		case 'todo.done':
			return 'Todo Completed';
		case 'teammate.idle':
			return 'Teammate Idle';
		case 'task.completed':
			return event.data.task_subject || 'Task Completed';
		case 'config.change':
			return 'Config Change';
		default:
			return 'Event';
	}
}

/**
 * Build a compact header line with subject inline.
 *
 *   Read(/path/to/file.ts) · 16:53
 *   Bash($ npm test) · FAILED · 16:53
 *   Agent · 16:53
 */
function buildCompactHeader(
	event: FeedEvent,
	width: number,
	options?: {subject?: string; failed?: boolean},
): string[] {
	const label = eventLabel(event);
	const time = formatClock(event.ts);

	let title = chalk.bold.hex(DETAIL_TITLE_COLOR)(label);
	if (options?.subject) {
		title +=
			chalk.dim('(') +
			chalk.hex(DETAIL_SUBJECT_COLOR)(options.subject) +
			chalk.dim(')');
	}

	const parts = [title];
	if (options?.failed) parts.push(chalk.red('FAILED'));
	parts.push(chalk.dim(time));

	return wrapAnsiLines([parts.join(chalk.dim(' · '))], width);
}

type ToolEvent = Extract<
	FeedEvent,
	| {kind: 'tool.pre'}
	| {kind: 'tool.delta'}
	| {kind: 'tool.post'}
	| {kind: 'tool.failure'}
	| {kind: 'permission.request'}
>;

/** Build header + tool response content for a resolved tool event. */
function renderToolResult(
	event: ToolEvent,
	responseEvent: Extract<
		FeedEvent,
		{kind: 'tool.delta'} | {kind: 'tool.post'} | {kind: 'tool.failure'}
	>,
	width: number,
	cw: number,
): DetailRenderResult {
	const subject = extractToolSubject(
		event.data.tool_name,
		event.data.tool_input,
	);
	const failed = responseEvent.kind === 'tool.failure';
	const header = buildCompactHeader(event, width, {subject, failed});
	const response = renderToolResponseContent(responseEvent, cw);
	return buildResult(header, response.lines, response.showLineNumbers);
}

// ─── Main render function ─────────────────────────────────────────

export function renderDetailLines(
	event: FeedEvent,
	width: number,
	pairedPostEvent?: FeedEvent,
): DetailRenderResult {
	const cw = contentWidth(width);
	switch (event.kind) {
		case 'agent.message': {
			const header = buildCompactHeader(event, width);
			const content = renderMarkdownToLines(event.data.message, cw);
			return buildResult(header, content, false);
		}

		case 'user.prompt': {
			const header = buildCompactHeader(event, width);
			const content = renderMarkdownToLines(event.data.prompt, cw);
			return buildResult(header, content, false);
		}

		case 'tool.post':
		case 'tool.delta':
		case 'tool.failure':
			return renderToolResult(event, event, width, cw);

		case 'tool.pre':
		case 'permission.request': {
			if (
				pairedPostEvent &&
				(pairedPostEvent.kind === 'tool.delta' ||
					pairedPostEvent.kind === 'tool.post' ||
					pairedPostEvent.kind === 'tool.failure')
			) {
				return renderToolResult(event, pairedPostEvent, width, cw);
			}

			const subject = extractToolSubject(
				event.data.tool_name,
				event.data.tool_input,
			);
			const header = buildCompactHeader(event, width, {subject});
			const json = JSON.stringify(event.data.tool_input, null, 2);
			const requestLines = highlightCode(json, cw, 'json');
			return buildResult(header, requestLines, true);
		}

		case 'subagent.start': {
			const prompt = event.data.description?.trim();
			const header = buildCompactHeader(event, width);
			const content = prompt
				? renderMarkdownToLines(prompt, cw)
				: ['(no subagent prompt captured)'];
			return buildResult(header, content, false);
		}

		case 'subagent.stop': {
			const header = buildCompactHeader(event, width);
			const prompt = event.data.description?.trim();
			const response = event.data.last_assistant_message?.trim();
			let content: string[];

			if (prompt && response) {
				const promptLines = renderMarkdownToLines(prompt, cw);
				const responseLines = renderMarkdownToLines(response, cw);
				content = [...promptLines, '', ...responseLines];
			} else if (response) {
				content = renderMarkdownToLines(response, cw);
			} else if (prompt) {
				content = renderMarkdownToLines(prompt, cw);
			} else {
				const json = JSON.stringify(event.data, null, 2);
				content = highlightCode(json, cw, 'json');
			}
			return buildResult(header, content, !prompt && !response);
		}

		case 'notification': {
			const header = buildCompactHeader(event, width);
			const content = renderMarkdownToLines(event.data.message, cw);
			return buildResult(header, content, false);
		}

		case 'session.start':
		case 'session.end':
		case 'run.start':
		case 'run.end':
		case 'permission.decision':
		case 'stop.request':
		case 'stop.decision':
		case 'compact.pre':
		case 'setup':
		case 'unknown.hook':
		case 'todo.add':
		case 'todo.update':
		case 'todo.done':
		case 'teammate.idle':
		case 'task.completed':
		case 'config.change': {
			const header = buildCompactHeader(event, width);
			const json = JSON.stringify(event.raw ?? event.data, null, 2);
			const content = highlightCode(json, cw, 'json');
			return buildResult(header, content, true);
		}
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}
