import {
	type RenderableOutput,
	type RawOutput,
	type ListItem,
	type DiffHunk,
	type DiffLine,
} from '../../shared/types/toolOutput';
import {
	formatToolResponse,
	isBashToolResponse,
} from '../../shared/utils/toolResponse';

const EXT_TO_LANGUAGE: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'typescript',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.json': 'json',
	'.py': 'python',
	'.rs': 'rust',
	'.go': 'go',
	'.sh': 'bash',
	'.bash': 'bash',
	'.zsh': 'bash',
	'.css': 'css',
	'.html': 'html',
	'.md': 'markdown',
	'.yaml': 'yaml',
	'.yml': 'yaml',
	'.toml': 'toml',
	'.sql': 'sql',
	'.rb': 'ruby',
	'.java': 'java',
	'.c': 'c',
	'.cpp': 'cpp',
	'.h': 'c',
};

function detectLanguage(filePath: unknown): string | undefined {
	if (typeof filePath !== 'string') return undefined;
	const dot = filePath.lastIndexOf('.');
	if (dot === -1) return undefined;
	return EXT_TO_LANGUAGE[filePath.slice(dot).toLowerCase()];
}

function isMarkdownRenderable(language: string | undefined): boolean {
	return language === undefined || language === 'markdown';
}

function prop(obj: unknown, key: string): unknown {
	if (typeof obj === 'object' && obj !== null) {
		return (obj as Record<string, unknown>)[key];
	}
	return undefined;
}

function extractTextContent(response: unknown): string {
	if (response == null) return '';
	if (typeof response === 'string') return response;

	if (Array.isArray(response)) {
		const parts: string[] = [];
		for (const block of response) {
			if (typeof block === 'string') {
				parts.push(block);
			} else if (typeof block === 'object' && block !== null) {
				const text = prop(block, 'text');
				if (typeof text === 'string') parts.push(text);
			}
		}
		if (parts.length > 0) return parts.join('\n').trim();
	}

	if (typeof response === 'object') {
		const text = prop(response, 'text');
		if (typeof text === 'string' && prop(response, 'type') === 'text') {
			return text.trim();
		}

		const content = prop(response, 'content');
		if (content != null) return extractTextContent(content);

		for (const key of ['result', 'message', 'output'] as const) {
			const val = prop(response, key);
			if (typeof val === 'string') return val;
		}
	}

	return formatToolResponse(response);
}

const DEFAULT_PREVIEW_LINES = 5;

function withPreview(output: RawOutput): RenderableOutput {
	let lines: string[];
	switch (output.type) {
		case 'code':
		case 'text':
			lines = output.content.split('\n');
			break;
		case 'diff':
			if (output.hunks?.length) {
				lines = output.hunks.flatMap(h =>
					h.lines
						.filter(l => l.type !== 'context')
						.map(l => (l.type === 'add' ? `+ ${l.content}` : `- ${l.content}`)),
				);
			} else {
				lines = output.newText.split('\n');
			}
			break;
		case 'list':
			lines = output.items.map(i => i.primary);
			break;
		default:
			lines = [];
	}
	return {
		...output,
		previewLines: lines.slice(0, DEFAULT_PREVIEW_LINES),
		totalLineCount: lines.length,
	};
}

type Extractor = (
	toolInput: Record<string, unknown>,
	toolResponse: unknown,
) => RawOutput;

function extractBash(
	_input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	if (isBashToolResponse(response)) {
		const out = response.stdout.trim();
		const err = response.stderr.trim();
		const content = err ? (out ? `${out}\n${err}` : err) : out;
		return {type: 'code', content, language: 'bash', maxLines: 10};
	}
	return {type: 'code', content: extractTextContent(response), maxLines: 10};
}

function extractFileContent(block: unknown): string | undefined {
	const fileContent = prop(prop(block, 'file'), 'content');
	if (typeof fileContent === 'string') return fileContent;
	const text = prop(block, 'text');
	if (typeof text === 'string') return text;
	return undefined;
}

function extractRead(
	input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	// PostToolUse shape: content-block array [{type:"text", file:{content, ...}}] or single object
	const blocks = Array.isArray(response) ? response : [response];
	let content: string | undefined;
	for (const block of blocks) {
		content = extractFileContent(block);
		if (content) break;
	}

	const language = detectLanguage(input['file_path']);
	const resolved = content ?? extractTextContent(response);

	if (isMarkdownRenderable(language)) {
		return {type: 'text', content: resolved, maxLines: 10};
	}

	return {type: 'code', content: resolved, language, maxLines: 10};
}

function parseDiffLine(raw: string): DiffLine {
	const prefix = raw[0];
	const content = raw.slice(1);
	if (prefix === '-') return {type: 'remove', content};
	if (prefix === '+') return {type: 'add', content};
	return {type: 'context', content};
}

function parseStructuredPatch(response: unknown): DiffHunk[] | undefined {
	const patch = prop(response, 'structuredPatch');
	if (!patch) return undefined;
	const rawHunks = prop(patch, 'hunks');
	if (!Array.isArray(rawHunks)) return undefined;

	return rawHunks.map(h => {
		const oldStart = typeof h.oldStart === 'number' ? h.oldStart : 1;
		const newStart = typeof h.newStart === 'number' ? h.newStart : 1;
		const rawLines: string[] = Array.isArray(h.lines) ? h.lines : [];

		let oldLine = oldStart;
		let newLine = newStart;
		const lines: DiffLine[] = rawLines.map(raw => {
			const line = parseDiffLine(raw);
			if (line.type === 'context') {
				line.oldLineNo = oldLine++;
				line.newLineNo = newLine++;
			} else if (line.type === 'remove') {
				line.oldLineNo = oldLine++;
			} else {
				line.newLineNo = newLine++;
			}
			return line;
		});

		const header =
			typeof h.header === 'string'
				? h.header
				: `@@ -${oldStart},${rawLines.length} +${newStart},${rawLines.length} @@`;
		return {header, oldStart, newStart, lines};
	});
}

function extractEdit(
	input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	const oldText =
		typeof input['old_string'] === 'string' ? input['old_string'] : '';
	const newText =
		typeof input['new_string'] === 'string' ? input['new_string'] : '';
	const filePath =
		typeof input['file_path'] === 'string' ? input['file_path'] : undefined;
	const hunks = parseStructuredPatch(response);
	return {type: 'diff', oldText, newText, hunks, filePath, maxLines: 20};
}

function extractWrite(
	input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	// Plain string response (e.g. "File created successfully") — show as-is
	if (typeof response === 'string') {
		return {type: 'text', content: response};
	}

	const content = typeof input['content'] === 'string' ? input['content'] : '';
	const filePath = String(
		prop(response, 'filePath') ?? input['file_path'] ?? '',
	);

	if (!content) {
		return {type: 'text', content: `Wrote ${filePath}`};
	}

	const language = detectLanguage(input['file_path']);
	if (isMarkdownRenderable(language)) {
		return {type: 'text', content, maxLines: 10};
	}
	return {type: 'code', content, language, maxLines: 10};
}

function extractGrep(
	_input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	const text = extractTextContent(response);
	const lines = text.split('\n').filter(Boolean);

	const items: ListItem[] = lines.map(line => {
		const match = /^(.+?):(\d+):(.+)$/.exec(line);
		if (match) {
			return {
				primary: match[3]!.trim(),
				secondary: `${match[1]}:${match[2]}`,
			};
		}
		return {primary: line};
	});

	return {type: 'list', items, maxItems: 10, groupBy: 'secondary'};
}

function extractGlob(
	_input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	const filenames = prop(response, 'filenames');
	if (Array.isArray(filenames)) {
		const items: ListItem[] = filenames
			.filter((f): f is string => typeof f === 'string')
			.map(f => ({primary: f}));
		return {type: 'list', items, maxItems: 10, displayMode: 'tree'};
	}
	const text = extractTextContent(response);
	const items: ListItem[] = text
		.split('\n')
		.filter(Boolean)
		.map(line => ({primary: line}));
	return {type: 'list', items, maxItems: 10};
}

function extractWebFetch(
	_input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	const result = prop(response, 'result');
	const content =
		typeof result === 'string' ? result : extractTextContent(response);
	return {type: 'text', content, maxLines: 10};
}

function formatSearchLink(item: unknown): string | null {
	const title = prop(item, 'title');
	if (typeof title !== 'string') return null;
	const url = prop(item, 'url');
	return typeof url === 'string' ? `- [${title}](${url})` : `- ${title}`;
}

function extractWebSearch(
	_input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	// PostToolUse shape: {query, results: [{tool_use_id, content: [{title, url}...]}], durationSeconds}
	const results = prop(response, 'results');
	if (Array.isArray(results)) {
		const links: string[] = [];
		for (const entry of results) {
			const content = prop(entry, 'content');
			// Nested: results[].content[] has the actual search items
			const items = Array.isArray(content) ? content : [entry];
			for (const item of items) {
				const link = formatSearchLink(item);
				if (link) links.push(link);
			}
		}
		if (links.length > 0) {
			return {type: 'text', content: links.join('\n'), maxLines: 10};
		}
	}
	return {type: 'text', content: extractTextContent(response), maxLines: 10};
}

function extractNotebookEdit(
	input: Record<string, unknown>,
	_response: unknown,
): RawOutput {
	const path =
		typeof input['notebook_path'] === 'string' ? input['notebook_path'] : '';
	const mode =
		typeof input['edit_mode'] === 'string' ? input['edit_mode'] : 'replace';
	const source =
		typeof input['new_source'] === 'string' ? input['new_source'] : '';
	if (!source) return {type: 'text', content: `${mode} cell in ${path}`};
	return {
		type: 'code',
		content: source,
		language: detectLanguage(path),
		maxLines: 10,
	};
}

function extractTask(
	input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	const text = extractTextContent(response);
	if (text) return {type: 'text', content: text, maxLines: 10};
	const desc =
		typeof input['description'] === 'string' ? input['description'] : '';
	return {type: 'text', content: desc || 'Task completed', maxLines: 10};
}

function extractSkill(
	input: Record<string, unknown>,
	response: unknown,
): RawOutput {
	const skill = typeof input['skill'] === 'string' ? input['skill'] : '';
	if (typeof response === 'string') {
		return {type: 'text', content: response, maxLines: 20};
	}

	if (typeof response === 'object' && response !== null) {
		const items: ListItem[] = [];
		const success = prop(response, 'success');
		const commandName = prop(response, 'commandName');
		const message = prop(response, 'message');
		const allowedTools = prop(response, 'allowedTools');

		if (skill) items.push({secondary: 'skill', primary: skill});
		if (typeof commandName === 'string' && commandName.trim()) {
			items.push({secondary: 'command', primary: commandName.trim()});
		}
		if (typeof success === 'boolean') {
			items.push({
				secondary: 'status',
				primary: success ? 'success' : 'failed',
			});
		}
		if (Array.isArray(allowedTools)) {
			const tools = allowedTools.filter(
				(t): t is string => typeof t === 'string' && t.trim().length > 0,
			);
			const maxTools = 24;
			for (const tool of tools.slice(0, maxTools)) {
				items.push({secondary: 'allowed', primary: tool});
			}
			if (tools.length > maxTools) {
				items.push({
					secondary: 'allowed',
					primary: `+${tools.length - maxTools} more`,
				});
			}
		}
		if (typeof message === 'string' && message.trim()) {
			items.push({secondary: 'message', primary: message.trim()});
		}

		if (items.length > 0) {
			return {type: 'list', items, maxItems: 30, groupBy: 'secondary'};
		}
	}

	const text = extractTextContent(response);
	if (text) return {type: 'text', content: text, maxLines: 20};
	return {
		type: 'text',
		content: skill ? `Skill: ${skill}` : 'Skill executed',
		maxLines: 20,
	};
}

const EXTRACTORS: Record<string, Extractor> = {
	Bash: extractBash,
	Read: extractRead,
	Edit: extractEdit,
	Write: extractWrite,
	Grep: extractGrep,
	Glob: extractGlob,
	WebFetch: extractWebFetch,
	WebSearch: extractWebSearch,
	NotebookEdit: extractNotebookEdit,
	Task: extractTask,
	Skill: extractSkill,
};

export function extractToolOutput(
	toolName: string,
	toolInput: Record<string, unknown>,
	toolResponse: unknown,
): RenderableOutput {
	const extractor = EXTRACTORS[toolName];
	try {
		return withPreview(extractor(toolInput, toolResponse));
	} catch {
		// fall through to generic text
	}
	return withPreview({
		type: 'text',
		content: extractTextContent(toolResponse),
		maxLines: 20,
	});
}

export {detectLanguage};
