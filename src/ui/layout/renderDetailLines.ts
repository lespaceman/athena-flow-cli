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
import {actorLabel, formatClock} from '../../shared/utils/format';

export type DetailRenderResult = {
	lines: string[];
	showLineNumbers: boolean;
};

const MAX_HIGHLIGHT_SIZE = 50_000;
const DETAIL_TITLE_COLOR = '#c9d1d9';
const DETAIL_META_COLOR = '#8b949e';
const REQUEST_HIDDEN_WHEN_RESPONSE_TOOLS = new Set([
	'Write',
	'Edit',
	'NotebookEdit',
]);

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

type ToolSection = {
	lines: string[];
	showLineNumbers: boolean;
};

function sectionDivider(width: number): string {
	return chalk.hex(DETAIL_META_COLOR)(
		'─'.repeat(Math.min(40, Math.max(8, width - 2))),
	);
}

function renderToolRequestSection(
	toolInput: unknown,
	width: number,
): ToolSection {
	const json = JSON.stringify(toolInput, null, 2);
	return {lines: highlightCode(json, width, 'json'), showLineNumbers: true};
}

function shouldShowToolRequestSection(
	toolName: string,
	hasResponse: boolean,
): boolean {
	if (!hasResponse) return true;
	const parsed = parseToolName(toolName);
	return !REQUEST_HIDDEN_WHEN_RESPONSE_TOOLS.has(parsed.displayName);
}

function renderToolResponseSection(
	event: Extract<FeedEvent, {kind: 'tool.post'} | {kind: 'tool.failure'}>,
	width: number,
): ToolSection {
	const {tool_name, tool_input} = event.data;

	// tool.failure has error string instead of tool_response
	if (event.kind === 'tool.failure') {
		const errorLines = wrapAnsiLines(event.data.error.split('\n'), width);
		return {
			lines: [chalk.red('FAILED'), '', ...errorLines],
			showLineNumbers: false,
		};
	}

	const output = extractToolOutput(
		tool_name,
		tool_input as Record<string, unknown>,
		event.data.tool_response,
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

type DetailSection = {
	title: string;
	lines: string[];
	showLineNumbers: boolean;
};

function detailKindLabel(
	event: FeedEvent,
	pairedPostEvent?: FeedEvent,
): string {
	if (event.kind === 'tool.pre' && pairedPostEvent) {
		if (pairedPostEvent.kind === 'tool.failure') return 'Tool Failure';
		if (pairedPostEvent.kind === 'tool.post') return 'Tool Result';
	}
	switch (event.kind) {
		case 'agent.message':
			return event.data.scope === 'subagent'
				? 'Subagent Response'
				: 'Agent Response';
		case 'user.prompt':
			return 'User Prompt';
		case 'tool.pre':
			return 'Tool Call';
		case 'tool.post':
			return 'Tool Result';
		case 'tool.failure':
			return 'Tool Failure';
		case 'permission.request':
			return 'Permission Request';
		case 'permission.decision':
			return 'Permission Decision';
		case 'subagent.start':
			return 'Subagent Start';
		case 'subagent.stop':
			return 'Subagent Stop';
		case 'run.start':
			return 'Run Start';
		case 'run.end':
			return 'Run End';
		case 'stop.request':
			return 'Stop Request';
		case 'stop.decision':
			return 'Stop Decision';
		case 'session.start':
			return 'Session Start';
		case 'session.end':
			return 'Session End';
		case 'notification':
			return 'Notification';
		case 'compact.pre':
			return 'Compaction';
		case 'setup':
			return 'Setup';
		case 'unknown.hook':
			return 'Hook Event';
		case 'todo.add':
			return 'Todo Added';
		case 'todo.update':
			return 'Todo Updated';
		case 'todo.done':
			return 'Todo Completed';
		case 'teammate.idle':
			return 'Teammate Idle';
		case 'task.completed':
			return 'Task Completed';
		case 'config.change':
			return 'Config Change';
		default:
			return 'Event';
	}
}

function toolSubject(toolName: string): string {
	const parsed = parseToolName(toolName);
	const display = resolveToolColumn(toolName);
	if (parsed.isMcp && parsed.mcpServer) {
		const server = extractFriendlyServerName(parsed.mcpServer);
		return `[${server}] ${display}`;
	}
	return display;
}

function detailSubject(event: FeedEvent): string | undefined {
	switch (event.kind) {
		case 'tool.pre':
		case 'tool.post':
		case 'tool.failure':
		case 'permission.request':
			return toolSubject(event.data.tool_name);
		case 'subagent.start':
		case 'subagent.stop':
			return event.data.agent_type;
		case 'run.start':
			return event.data.trigger.prompt_preview?.trim() || undefined;
		case 'run.end':
			return event.data.status;
		case 'permission.decision':
			return event.data.decision_type;
		case 'stop.decision':
			return event.data.decision_type;
		case 'notification':
			return event.data.notification_type || event.data.title;
		case 'unknown.hook':
			return event.data.hook_event_name;
		case 'todo.add':
		case 'todo.update':
		case 'todo.done':
			return event.data.todo_id;
		case 'task.completed':
			return event.data.task_subject;
		case 'config.change':
		case 'session.start':
			return event.data.source;
		case 'session.end':
			return event.data.reason;
		case 'agent.message':
			return event.data.scope === 'subagent' ? event.actor_id : undefined;
		case 'user.prompt':
		case 'stop.request':
		case 'compact.pre':
		case 'setup':
		case 'teammate.idle':
			return undefined;
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

function actorHeaderValue(actorId: string | undefined): string {
	if (!actorId) return 'UNKNOWN';
	return actorLabel(actorId).replace(/-/g, ' ');
}

function toolUseId(event: FeedEvent): string | undefined {
	switch (event.kind) {
		case 'tool.pre':
		case 'tool.post':
		case 'tool.failure':
		case 'permission.request':
			return event.data.tool_use_id;
		case 'session.start':
		case 'session.end':
		case 'run.start':
		case 'run.end':
		case 'user.prompt':
		case 'permission.decision':
		case 'stop.request':
		case 'stop.decision':
		case 'subagent.start':
		case 'subagent.stop':
		case 'notification':
		case 'compact.pre':
		case 'setup':
		case 'unknown.hook':
		case 'todo.add':
		case 'todo.update':
		case 'todo.done':
		case 'agent.message':
		case 'teammate.idle':
		case 'task.completed':
		case 'config.change':
			return undefined;
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

function headerMetaLines(
	event: FeedEvent,
	pairedPostEvent?: FeedEvent,
): string[] {
	const meta: Array<[label: string, value: string | undefined]> = [
		['Time', formatClock(event.ts)],
		['Actor', actorHeaderValue(event.actor_id)],
		['Session ID', event.session_id],
		['Run ID', event.run_id],
		['Event ID', event.event_id],
		[
			'Tool Use ID',
			toolUseId(event) ??
				(pairedPostEvent ? toolUseId(pairedPostEvent) : undefined),
		],
	];

	if (event.kind === 'subagent.start' || event.kind === 'subagent.stop') {
		meta.push(['Subagent ID', event.data.agent_id]);
	}
	if (event.cause?.hook_request_id) {
		meta.push(['Hook Request ID', event.cause.hook_request_id]);
	}
	if (event.cause?.parent_event_id) {
		meta.push(['Parent Event ID', event.cause.parent_event_id]);
	}
	if (event.cause?.tool_use_id) {
		meta.push(['Cause Tool Use ID', event.cause.tool_use_id]);
	}

	const lines: string[] = [];
	for (const [label, value] of meta) {
		if (!value) continue;
		lines.push(`${label}: ${value}`);
	}
	return lines;
}

function buildDetailHeader(
	event: FeedEvent,
	width: number,
	pairedPostEvent?: FeedEvent,
): string[] {
	const subject = detailSubject(event);
	const title = subject
		? `${detailKindLabel(event, pairedPostEvent)} · ${subject}`
		: detailKindLabel(event, pairedPostEvent);
	const lines: string[] = [];
	lines.push(
		...wrapAnsiLines([chalk.bold.hex(DETAIL_TITLE_COLOR)(title)], width),
	);
	for (const metaLine of headerMetaLines(event, pairedPostEvent)) {
		lines.push(
			...wrapAnsiLines([chalk.hex(DETAIL_META_COLOR)(metaLine)], width),
		);
	}
	lines.push(sectionDivider(width));
	return lines;
}

function composeDetailView(
	event: FeedEvent,
	width: number,
	sections: DetailSection[],
	pairedPostEvent?: FeedEvent,
): DetailRenderResult {
	const visibleSections = sections.filter(section => section.lines.length > 0);
	const lines = buildDetailHeader(event, width, pairedPostEvent);
	if (visibleSections.length > 0) {
		lines.push('');
	}
	for (let i = 0; i < visibleSections.length; i++) {
		const section = visibleSections[i]!;
		lines.push(chalk.bold.hex(DETAIL_META_COLOR)(section.title));
		lines.push(...section.lines);
		if (i < visibleSections.length - 1) {
			lines.push('', sectionDivider(width), '');
		}
	}
	return {
		lines,
		showLineNumbers:
			visibleSections.length === 1 &&
			visibleSections[0]!.title === 'Payload' &&
			visibleSections[0]!.showLineNumbers,
	};
}

function renderToolPost(
	event: Extract<FeedEvent, {kind: 'tool.post'} | {kind: 'tool.failure'}>,
	width: number,
): DetailRenderResult {
	const request = shouldShowToolRequestSection(event.data.tool_name, true)
		? renderToolRequestSection(event.data.tool_input, width)
		: undefined;
	const response = renderToolResponseSection(event, width);
	const sections: DetailSection[] = [];
	if (request) {
		sections.push({
			title: 'Request',
			lines: request.lines,
			showLineNumbers: request.showLineNumbers,
		});
	}
	sections.push({
		title: event.kind === 'tool.failure' ? 'Failure' : 'Response',
		lines: response.lines,
		showLineNumbers: response.showLineNumbers,
	});
	return composeDetailView(event, width, sections);
}

function renderToolPre(
	event: Extract<FeedEvent, {kind: 'tool.pre'} | {kind: 'permission.request'}>,
	width: number,
): DetailRenderResult {
	const request = renderToolRequestSection(event.data.tool_input, width);
	return composeDetailView(event, width, [
		{
			title: 'Request',
			lines: request.lines,
			showLineNumbers: request.showLineNumbers,
		},
	]);
}

export function renderDetailLines(
	event: FeedEvent,
	width: number,
	pairedPostEvent?: FeedEvent,
): DetailRenderResult {
	switch (event.kind) {
		case 'agent.message':
			return composeDetailView(event, width, [
				{
					title: 'Message',
					lines: renderMarkdownToLines(event.data.message, width),
					showLineNumbers: false,
				},
			]);

		case 'user.prompt':
			return composeDetailView(event, width, [
				{
					title: 'Request',
					lines: renderMarkdownToLines(event.data.prompt, width),
					showLineNumbers: false,
				},
			]);

		case 'tool.post':
		case 'tool.failure':
			return renderToolPost(event, width);

		case 'tool.pre':
		case 'permission.request': {
			const preResult = renderToolPre(event, width);
			if (
				pairedPostEvent &&
				(pairedPostEvent.kind === 'tool.post' ||
					pairedPostEvent.kind === 'tool.failure')
			) {
				const response = renderToolResponseSection(pairedPostEvent, width);
				const request = shouldShowToolRequestSection(event.data.tool_name, true)
					? renderToolRequestSection(event.data.tool_input, width)
					: undefined;
				const sections: DetailSection[] = [];
				if (request) {
					sections.push({
						title: 'Request',
						lines: request.lines,
						showLineNumbers: request.showLineNumbers,
					});
				}
				sections.push({
					title:
						pairedPostEvent.kind === 'tool.failure' ? 'Failure' : 'Response',
					lines: response.lines,
					showLineNumbers: response.showLineNumbers,
				});
				return composeDetailView(event, width, sections, pairedPostEvent);
			}
			return preResult;
		}

		case 'subagent.start': {
			const prompt = event.data.description?.trim();
			return composeDetailView(event, width, [
				{
					title: 'Prompt',
					lines: prompt
						? renderMarkdownToLines(prompt, width)
						: ['(no subagent prompt captured)'],
					showLineNumbers: false,
				},
			]);
		}

		case 'subagent.stop': {
			const sections: DetailSection[] = [];
			const prompt = event.data.description?.trim();
			const response = event.data.last_assistant_message?.trim();
			if (prompt) {
				sections.push({
					title: 'Prompt',
					lines: renderMarkdownToLines(prompt, width),
					showLineNumbers: false,
				});
			}
			if (response) {
				sections.push({
					title: 'Response',
					lines: renderMarkdownToLines(response, width),
					showLineNumbers: false,
				});
			}
			if (sections.length === 0) {
				const fallback = JSON.stringify(event.data, null, 2);
				sections.push({
					title: 'Payload',
					lines: highlightCode(fallback, width, 'json'),
					showLineNumbers: true,
				});
			}
			return composeDetailView(event, width, sections);
		}

		case 'notification':
			return composeDetailView(event, width, [
				{
					title: 'Message',
					lines: renderMarkdownToLines(event.data.message, width),
					showLineNumbers: false,
				},
			]);

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
			const json = JSON.stringify(event.raw ?? event.data, null, 2);
			return composeDetailView(event, width, [
				{
					title: 'Payload',
					lines: highlightCode(json, width, 'json'),
					showLineNumbers: true,
				},
			]);
		}
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}
