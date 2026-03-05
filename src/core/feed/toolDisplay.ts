/**
 * Tool display resolver for the TOOL column in feed timeline.
 *
 * Three tiers of tool name resolution:
 * 1. Known core tools (Read, Write, Bash, etc.)
 * 2. Known MCP actions (navigate, click, find_elements, etc.)
 * 3. Generic fallback (humanize unknown tool names)
 *
 * Each tier extracts:
 * - toolColumn: display name for the TOOL column
 * - segments: typed spans for the DETAILS column
 * - outcome: right-aligned result text (optional)
 */

import {parseToolName} from '../../shared/utils/toolNameParser';
import {
	shortenPathStructured,
	compactText,
	compactCommandPaths,
} from '../../shared/utils/format';
import {isBashToolResponse} from '../../shared/utils/toolResponse';
import {
	type SummarySegment,
	stripMarkdownInline,
	firstSentence,
} from './timeline';
import {type FeedEvent} from './types';

// ── Types ───────────────────────────────────────────────

export type ToolDisplayResult = {
	toolColumn: string;
	segments: SummarySegment[];
	outcome?: string;
	outcomeZero?: boolean;
};

type OutcomeResult = {text: string; zero: boolean} | undefined;

type ToolDisplayConfig = {
	display: string;
	extractDetails: (input: unknown) => SummarySegment[];
	extractOutcome: (output: unknown) => OutcomeResult;
};

// ── Shared helpers ──────────────────────────────────────

function prop(obj: unknown, key: string): unknown {
	if (typeof obj === 'object' && obj !== null) {
		return (obj as Record<string, unknown>)[key];
	}
	return undefined;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 3) return text.slice(0, max);
	return text.slice(0, max - 1) + '…';
}

function extractDomain(url: unknown): string {
	if (typeof url !== 'string') return '';
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, '');
	} catch {
		return compactText(String(url), 40);
	}
}

function filePathSegments(input: unknown): SummarySegment[] {
	const path = prop(input, 'file_path') ?? prop(input, 'notebook_path') ?? '';
	if (typeof path !== 'string' || !path) return [];
	const {prefix, filename} = shortenPathStructured(path);
	if (prefix && filename) {
		return [
			{text: prefix, role: 'target'},
			{text: filename, role: 'filename'},
		];
	}
	return [{text: filename || path, role: 'filename'}];
}

function grepSegments(input: unknown): SummarySegment[] {
	const pattern = String(prop(input, 'pattern') ?? '');
	const glob = prop(input, 'glob');
	const parts = `"${pattern}"${glob ? ` ${String(glob)}` : ''}`;
	return [{text: parts, role: 'target'}];
}

function commandSegments(input: unknown): SummarySegment[] {
	const cmd = String(prop(input, 'command') ?? '');
	return [{text: compactText(compactCommandPaths(cmd), 50), role: 'target'}];
}

// ── Outcome helpers ─────────────────────────────────────

function countOutcome(output: unknown, label: string): OutcomeResult {
	// Array response
	if (Array.isArray(output)) {
		return {text: `${output.length} ${label}`, zero: output.length === 0};
	}
	// Object with known count fields
	if (typeof output === 'object' && output !== null) {
		// Glob: filenames[] or numFiles
		const filenames = prop(output, 'filenames');
		if (Array.isArray(filenames)) {
			return {
				text: `${filenames.length} ${label}`,
				zero: filenames.length === 0,
			};
		}
		const numFiles = prop(output, 'numFiles');
		if (typeof numFiles === 'number') {
			return {text: `${numFiles} ${label}`, zero: numFiles === 0};
		}
		// Grep: numMatches or count
		const numMatches = prop(output, 'numMatches');
		if (typeof numMatches === 'number') {
			return {text: `${numMatches} ${label}`, zero: numMatches === 0};
		}
		const count = prop(output, 'count');
		if (typeof count === 'number') {
			return {text: `${count} ${label}`, zero: count === 0};
		}
	}
	// String response (grep returns newline-delimited matches)
	if (typeof output === 'string') {
		const lines = output.split('\n').filter(Boolean).length;
		return {text: `${lines} ${label}`, zero: lines === 0};
	}
	return undefined;
}

function exitCodeOutcome(output: unknown): OutcomeResult {
	if (isBashToolResponse(output)) {
		const code = prop(output, 'exitCode') ?? 0;
		const stderr = output.stderr.trim();
		const firstLine = stderr.split('\n')[0] ?? '';
		if (stderr && Number(code) !== 0) {
			return {text: `exit ${code} — ${truncate(firstLine, 30)}`, zero: false};
		}
		return {text: `exit ${code}`, zero: false};
	}
	return undefined;
}

function webSearchOutcome(output: unknown): OutcomeResult {
	const results = prop(output, 'results');
	if (Array.isArray(results)) {
		let count = 0;
		for (const entry of results) {
			const content = prop(entry, 'content');
			count += Array.isArray(content) ? content.length : 1;
		}
		return {text: `${count} results`, zero: count === 0};
	}
	return undefined;
}

function taskOutputOutcome(output: unknown): OutcomeResult {
	if (typeof output === 'string' && output.trim()) {
		return {text: truncate(output.trim(), 30), zero: false};
	}
	return undefined;
}

// ── MCP-specific extractors ─────────────────────────────

function eidExtractor(input: unknown): SummarySegment[] {
	const eid = String(prop(input, 'eid') ?? '');
	return eid ? [{text: `eid:${eid.slice(0, 6)}…`, role: 'target'}] : [];
}

function eidOrLabelExtractor(input: unknown): SummarySegment[] {
	const label = prop(input, 'label');
	if (typeof label === 'string' && label) {
		return [{text: `"${truncate(label, 20)}"`, role: 'target'}];
	}
	return eidExtractor(input);
}

function findDetailsExtractor(input: unknown): SummarySegment[] {
	const parts: string[] = [];
	const kind = prop(input, 'kind');
	if (kind) parts.push(String(kind));
	const label = prop(input, 'label');
	if (label) parts.push(`"${String(label)}"`);
	if (parts.length === 0) {
		const region = prop(input, 'region');
		if (region) parts.push(String(region));
	}
	return parts.length > 0
		? [{text: parts.join(' '), role: 'target'}]
		: [{text: 'elements', role: 'target'}];
}

function typeDetailsExtractor(input: unknown): SummarySegment[] {
	const text = String(prop(input, 'text') ?? '');
	const eid = prop(input, 'eid');
	const quoted = `"${truncate(text, 30)}"`;
	if (eid) {
		return [{text: `${quoted} → ${String(eid).slice(0, 5)}…`, role: 'target'}];
	}
	return [{text: quoted, role: 'target'}];
}

function scrollDetailsExtractor(input: unknown): SummarySegment[] {
	const dir = String(prop(input, 'direction') ?? '');
	const amount = prop(input, 'amount');
	const text = amount ? `${dir} ${amount}px` : dir;
	return text ? [{text, role: 'target'}] : [];
}

function tabRefExtractor(input: unknown): SummarySegment[] {
	const pageId = prop(input, 'page_id');
	return pageId
		? [{text: `page:${String(pageId).slice(0, 6)}`, role: 'target'}]
		: [];
}

// ── MCP outcome extractors ──────────────────────────────

function foundCountOutcome(output: unknown): OutcomeResult {
	if (Array.isArray(output)) {
		return {text: `${output.length} found`, zero: output.length === 0};
	}
	if (typeof output === 'object' && output !== null) {
		const elements = prop(output, 'elements') ?? prop(output, 'items');
		if (Array.isArray(elements)) {
			return {text: `${elements.length} found`, zero: elements.length === 0};
		}
	}
	return undefined;
}

function tabCountOutcome(output: unknown): OutcomeResult {
	if (Array.isArray(output)) {
		return {text: `${output.length} tabs`, zero: output.length === 0};
	}
	const pages = prop(output, 'pages');
	if (Array.isArray(pages)) {
		return {text: `${pages.length} tabs`, zero: pages.length === 0};
	}
	return undefined;
}

function formCountOutcome(output: unknown): OutcomeResult {
	const fields = prop(output, 'fields');
	if (Array.isArray(fields)) {
		return {text: `${fields.length} fields`, zero: fields.length === 0};
	}
	return undefined;
}

function pingOutcome(output: unknown): OutcomeResult {
	if (output) return {text: 'ok', zero: false};
	return undefined;
}

// ── Tier 1: Known core tools ────────────────────────────

const KNOWN_TOOL_DISPLAY = new Map<string, ToolDisplayConfig>([
	// ── Core file tools ──
	[
		'Read',
		{
			display: 'Read',
			extractDetails: filePathSegments,
			extractOutcome: () => undefined,
		},
	],
	[
		'Write',
		{
			display: 'Write',
			extractDetails: filePathSegments,
			extractOutcome: () => undefined,
		},
	],
	[
		'Edit',
		{
			display: 'Edit',
			extractDetails: filePathSegments,
			extractOutcome: () => undefined,
		},
	],
	[
		'Glob',
		{
			display: 'Glob',
			extractDetails: input => [
				{text: String(prop(input, 'pattern') ?? ''), role: 'target'},
			],
			extractOutcome: output => countOutcome(output, 'files'),
		},
	],
	[
		'Grep',
		{
			display: 'Grep',
			extractDetails: grepSegments,
			extractOutcome: output => countOutcome(output, 'matches'),
		},
	],
	[
		'Bash',
		{
			display: 'Bash',
			extractDetails: commandSegments,
			extractOutcome: exitCodeOutcome,
		},
	],

	// ── Web tools ──
	[
		'WebFetch',
		{
			display: 'WebFetch',
			extractDetails: input => [
				{text: extractDomain(prop(input, 'url')), role: 'target'},
			],
			extractOutcome: () => undefined,
		},
	],
	[
		'WebSearch',
		{
			display: 'WebSearch',
			extractDetails: input => [
				{
					text: truncate(String(prop(input, 'query') ?? ''), 40),
					role: 'target',
				},
			],
			extractOutcome: webSearchOutcome,
		},
	],
	[
		'NotebookEdit',
		{
			display: 'Notebook',
			extractDetails: filePathSegments,
			extractOutcome: () => undefined,
		},
	],

	// ── Agent & task tools ──
	[
		'Task',
		{
			display: 'Task',
			extractDetails: input => [
				{
					text: truncate(String(prop(input, 'description') ?? ''), 50),
					role: 'plain',
				},
			],
			extractOutcome: output => {
				const agentType = prop(output, 'subagent_type');
				return agentType ? {text: String(agentType), zero: false} : undefined;
			},
		},
	],
	[
		'TaskOutput',
		{
			display: 'TaskOut',
			extractDetails: input => [
				{text: String(prop(input, 'task_id') ?? ''), role: 'target'},
			],
			extractOutcome: taskOutputOutcome,
		},
	],
	[
		'TaskStop',
		{
			display: 'TaskStop',
			extractDetails: input => [
				{text: String(prop(input, 'task_id') ?? ''), role: 'target'},
			],
			extractOutcome: () => ({text: 'stopped', zero: false}),
		},
	],
	[
		'TodoWrite',
		{
			display: 'TodoWrite',
			extractDetails: input => {
				const todos = prop(input, 'todos');
				const n = Array.isArray(todos) ? todos.length : 0;
				return [{text: `${n} items`, role: 'target'}];
			},
			extractOutcome: () => undefined,
		},
	],

	// ── Planning & interaction ──
	[
		'AskUserQuestion',
		{
			display: 'AskUser',
			extractDetails: input => {
				const questions = prop(input, 'questions');
				const n = Array.isArray(questions) ? questions.length : 0;
				return [{text: `${n} question${n !== 1 ? 's' : ''}`, role: 'target'}];
			},
			extractOutcome: () => undefined,
		},
	],
	[
		'EnterPlanMode',
		{
			display: 'PlanMode',
			extractDetails: () => [],
			extractOutcome: () => ({text: 'entered', zero: false}),
		},
	],
	[
		'ExitPlanMode',
		{
			display: 'PlanMode',
			extractDetails: () => [],
			extractOutcome: () => ({text: 'submitted', zero: false}),
		},
	],
	[
		'EnterWorktree',
		{
			display: 'Worktree',
			extractDetails: input => [
				{text: String(prop(input, 'branch') ?? ''), role: 'target'},
			],
			extractOutcome: () => ({text: 'created', zero: false}),
		},
	],
	[
		'Skill',
		{
			display: 'Skill',
			extractDetails: input => {
				const name = String(prop(input, 'skill') ?? '');
				const colonIdx = name.indexOf(':');
				const display = colonIdx >= 0 ? name.slice(colonIdx + 1) : name;
				return [{text: display.replace(/^\//, ''), role: 'target'}];
			},
			extractOutcome: () => undefined,
		},
	],
]);

// ── Tier 2: Known MCP actions ───────────────────────────

const MCP_VERB_DISPLAY = new Map<string, ToolDisplayConfig>([
	// ── Navigation ──
	[
		'navigate',
		{
			display: 'Navigate',
			extractDetails: i => [
				{text: extractDomain(prop(i, 'url')), role: 'target'},
			],
			extractOutcome: () => undefined,
		},
	],
	[
		'reload',
		{
			display: 'Reload',
			extractDetails: () => [],
			extractOutcome: () => undefined,
		},
	],
	[
		'go_back',
		{
			display: 'Back',
			extractDetails: () => [],
			extractOutcome: () => undefined,
		},
	],
	[
		'go_forward',
		{
			display: 'Forward',
			extractDetails: () => [],
			extractOutcome: () => undefined,
		},
	],

	// ── Element interaction ──
	[
		'find_elements',
		{
			display: 'Find',
			extractDetails: findDetailsExtractor,
			extractOutcome: foundCountOutcome,
		},
	],
	[
		'click',
		{
			display: 'Click',
			extractDetails: eidOrLabelExtractor,
			extractOutcome: () => undefined,
		},
	],
	[
		'type',
		{
			display: 'Type',
			extractDetails: typeDetailsExtractor,
			extractOutcome: () => undefined,
		},
	],
	[
		'press',
		{
			display: 'Press',
			extractDetails: i => [
				{text: String(prop(i, 'key') ?? ''), role: 'target'},
			],
			extractOutcome: () => undefined,
		},
	],
	[
		'select',
		{
			display: 'Select',
			extractDetails: i => [
				{text: String(prop(i, 'value') ?? ''), role: 'target'},
			],
			extractOutcome: () => undefined,
		},
	],
	[
		'hover',
		{
			display: 'Hover',
			extractDetails: eidOrLabelExtractor,
			extractOutcome: () => undefined,
		},
	],

	// ── Inspection ──
	[
		'get_element_details',
		{
			display: 'Inspect',
			extractDetails: eidExtractor,
			extractOutcome: () => undefined,
		},
	],
	[
		'take_screenshot',
		{
			display: 'Screenshot',
			extractDetails: () => [],
			extractOutcome: () => ({text: 'captured', zero: false}),
		},
	],
	[
		'capture_snapshot',
		{
			display: 'Snapshot',
			extractDetails: () => [],
			extractOutcome: () => undefined,
		},
	],
	[
		'get_form_understanding',
		{
			display: 'FormScan',
			extractDetails: () => [],
			extractOutcome: formCountOutcome,
		},
	],
	[
		'get_field_context',
		{
			display: 'FieldCtx',
			extractDetails: eidExtractor,
			extractOutcome: () => undefined,
		},
	],

	// ── Scroll ──
	[
		'scroll_page',
		{
			display: 'Scroll',
			extractDetails: scrollDetailsExtractor,
			extractOutcome: () => undefined,
		},
	],
	[
		'scroll_element_into_view',
		{
			display: 'ScrollTo',
			extractDetails: eidExtractor,
			extractOutcome: () => undefined,
		},
	],

	// ── Session ──
	[
		'close_session',
		{
			display: 'Close',
			extractDetails: () => [{text: 'session', role: 'target'}],
			extractOutcome: () => undefined,
		},
	],
	[
		'close_page',
		{
			display: 'ClosePage',
			extractDetails: tabRefExtractor,
			extractOutcome: () => undefined,
		},
	],
	[
		'list_pages',
		{
			display: 'ListPages',
			extractDetails: () => [],
			extractOutcome: tabCountOutcome,
		},
	],
	[
		'ping',
		{
			display: 'Ping',
			extractDetails: () => [],
			extractOutcome: pingOutcome,
		},
	],

	// ── Context7 ──
	[
		'resolve-library-id',
		{
			display: 'Resolve',
			extractDetails: i => [
				{
					text: truncate(String(prop(i, 'libraryName') ?? ''), 30),
					role: 'target',
				},
			],
			extractOutcome: () => undefined,
		},
	],
	[
		'query-docs',
		{
			display: 'QueryDocs',
			extractDetails: i => [
				{
					text: truncate(String(prop(i, 'query') ?? ''), 40),
					role: 'target',
				},
			],
			extractOutcome: () => undefined,
		},
	],
]);

// ── Tier 3: Generic fallback ────────────────────────────

export function humanizeToolName(raw: string): string {
	const display = raw
		.split(/[_-]/)
		.map(s => s.charAt(0).toUpperCase() + s.slice(1))
		.join('');
	return display.length > 14 ? display.slice(0, 13) + '…' : display;
}

const PRIORITY_KEYS = [
	'file_path',
	'path',
	'url',
	'query',
	'pattern',
	'text',
	'command',
	'selector',
	'name',
	'id',
	'description',
	'message',
	'content',
];

function compactValue(value: string): string {
	if (value.startsWith('http')) return extractDomain(value);
	if (value.includes('/')) return compactText(value, 40);
	return truncate(value, 50);
}

function genericDetails(input: unknown): SummarySegment[] {
	if (!input || typeof input !== 'object') return [];
	const obj = input as Record<string, unknown>;

	for (const key of PRIORITY_KEYS) {
		if (obj[key] && typeof obj[key] === 'string') {
			return [{text: compactValue(String(obj[key])), role: 'target'}];
		}
	}

	for (const [, value] of Object.entries(obj)) {
		if (typeof value === 'string' && value.length > 0) {
			return [{text: compactValue(value), role: 'target'}];
		}
	}

	const count = Object.keys(obj).length;
	return count > 0 ? [{text: `${count} params`, role: 'target'}] : [];
}

function genericOutcome(output: unknown): OutcomeResult {
	if (output === undefined || output === null) return undefined;
	if (typeof output === 'string') {
		const clean = output.trim().toLowerCase();
		if (['done', 'ok', 'success', ''].includes(clean)) return undefined;
		return {text: truncate(output.trim(), 30), zero: false};
	}
	if (Array.isArray(output)) {
		return {text: `${output.length} items`, zero: output.length === 0};
	}
	return undefined;
}

// ── Core resolver ───────────────────────────────────────

function buildResult(
	config: ToolDisplayConfig,
	input: unknown,
	output: unknown | undefined,
	error: string | undefined,
): ToolDisplayResult {
	const segments = config.extractDetails(input);

	if (error) {
		return {
			toolColumn: config.display,
			segments,
			outcome: truncate(error.split('\n')[0] ?? error, 50),
			outcomeZero: false,
		};
	}

	if (output === undefined) {
		// In-flight: no outcome yet
		return {toolColumn: config.display, segments};
	}

	const result = config.extractOutcome(output);
	return {
		toolColumn: config.display,
		segments,
		outcome: result?.text,
		outcomeZero: result?.zero ?? false,
	};
}

/**
 * Resolve tool display info for the TOOL column and DETAILS segments.
 *
 * Three-tier resolution:
 * 1. Known core tools (Read, Write, Bash, etc.)
 * 2. Known MCP actions (navigate, click, etc.)
 * 3. Generic fallback (humanize name, extract first string param)
 */
export function resolveToolDisplay(
	toolName: string,
	toolInput: unknown,
	toolOutput: unknown | undefined,
	error: string | undefined,
): ToolDisplayResult {
	const parsed = parseToolName(toolName);

	// Tier 1: Known core tool (displayName equals toolName for built-in)
	const knownConfig = KNOWN_TOOL_DISPLAY.get(parsed.displayName);
	if (knownConfig) {
		return buildResult(knownConfig, toolInput, toolOutput, error);
	}

	// Tier 2: Known MCP action
	if (parsed.isMcp && parsed.mcpAction) {
		const mcpConfig = MCP_VERB_DISPLAY.get(parsed.mcpAction);
		if (mcpConfig) {
			return buildResult(mcpConfig, toolInput, toolOutput, error);
		}
	}

	// Tier 3: Generic fallback
	const display =
		parsed.isMcp && parsed.mcpAction
			? humanizeToolName(parsed.mcpAction)
			: humanizeToolName(parsed.displayName);

	if (error) {
		return {
			toolColumn: display,
			segments: genericDetails(toolInput),
			outcome: truncate(error.split('\n')[0] ?? error, 40),
			outcomeZero: false,
		};
	}

	const fallbackOutcome = genericOutcome(toolOutput);
	return {
		toolColumn: display,
		segments: genericDetails(toolInput),
		outcome: fallbackOutcome?.text,
		outcomeZero: fallbackOutcome?.zero ?? false,
	};
}

// ── Non-tool event display ──────────────────────────────

/**
 * Resolve display info for non-tool events.
 * Returns toolColumn (agent type for subagents, empty for most)
 * and segments for the DETAILS column.
 */
export function resolveEventDisplay(event: FeedEvent): {
	toolColumn: string;
	segments: SummarySegment[];
} {
	switch (event.kind) {
		case 'subagent.start':
		case 'subagent.stop':
			return {
				toolColumn: event.data.agent_type,
				segments: event.data.description
					? [{text: truncate(event.data.description, 60), role: 'target'}]
					: [],
			};

		case 'agent.message':
			return {
				toolColumn: '',
				segments: [
					{
						text: truncate(
							firstSentence(stripMarkdownInline(event.data.message)),
							120,
						),
						role: 'plain',
					},
				],
			};

		case 'stop.request':
			return {
				toolColumn: '',
				segments: [
					{
						text: `stop_hook_active=${event.data.stop_hook_active}`,
						role: 'target',
					},
				],
			};

		case 'run.start':
			return {
				toolColumn: '',
				segments: [
					{
						text: event.data.trigger.prompt_preview || 'interactive',
						role: 'target',
					},
				],
			};

		case 'run.end':
			return {
				toolColumn: '',
				segments: [
					{
						text: `${event.data.status} — ${event.data.counters.tool_uses} tools, ${event.data.counters.tool_failures} failures`,
						role: 'plain',
					},
				],
			};

		case 'permission.request':
			return {
				toolColumn: resolveToolColumn(event.data.tool_name),
				segments: [{text: event.data.tool_name, role: 'target'}],
			};

		case 'user.prompt':
			return {
				toolColumn: '',
				segments: [{text: truncate(event.data.prompt, 80), role: 'plain'}],
			};

		case 'session.start':
			return {
				toolColumn: '',
				segments: [{text: event.data.source, role: 'target'}],
			};

		case 'session.end':
			return {
				toolColumn: '',
				segments: [{text: event.data.reason, role: 'target'}],
			};

		case 'setup':
		case 'tool.pre':
		case 'tool.post':
		case 'tool.failure':
		case 'permission.decision':
		case 'stop.decision':
		case 'notification':
		case 'compact.pre':
		case 'unknown.hook':
		case 'todo.add':
		case 'todo.update':
		case 'todo.done':
		case 'teammate.idle':
		case 'task.completed':
		case 'config.change':
			return {toolColumn: '', segments: []};
	}
}

// ── Convenience: extract just the tool column name ──────

/**
 * Quick resolver for just the toolColumn string from a tool name.
 *
 * Intentionally duplicates the three-tier lookup from resolveToolDisplay()
 * to avoid computing segments/outcomes in the hot feed loop. Phase 2 can
 * reassess if the full resolver replaces this.
 */
export function resolveToolColumn(toolName: string): string {
	const parsed = parseToolName(toolName);

	const known = KNOWN_TOOL_DISPLAY.get(parsed.displayName);
	if (known) return known.display;

	if (parsed.isMcp && parsed.mcpAction) {
		const mcp = MCP_VERB_DISPLAY.get(parsed.mcpAction);
		if (mcp) return mcp.display;
	}

	return parsed.isMcp && parsed.mcpAction
		? humanizeToolName(parsed.mcpAction)
		: humanizeToolName(parsed.displayName);
}

/**
 * Lightweight toolColumn extractor for non-tool FeedEvents.
 * Avoids allocating segments array — use resolveEventDisplay()
 * when you need segments too.
 */
export function resolveEventToolColumn(event: FeedEvent): string {
	switch (event.kind) {
		case 'subagent.start':
		case 'subagent.stop':
			return event.data.agent_type;
		case 'permission.request':
			return resolveToolColumn(event.data.tool_name);
		case 'setup':
		case 'session.start':
		case 'session.end':
		case 'run.start':
		case 'run.end':
		case 'user.prompt':
		case 'tool.pre':
		case 'tool.post':
		case 'tool.failure':
		case 'permission.decision':
		case 'stop.request':
		case 'stop.decision':
		case 'notification':
		case 'compact.pre':
		case 'unknown.hook':
		case 'todo.add':
		case 'todo.update':
		case 'todo.done':
		case 'agent.message':
		case 'teammate.idle':
		case 'task.completed':
		case 'config.change':
			return '';
	}
}
