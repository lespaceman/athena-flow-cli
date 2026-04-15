import {Marked, type Tokens} from 'marked';
import {markedTerminal} from 'marked-terminal';
import chalk from 'chalk';
import Table from 'cli-table3';
import {urlLink} from './hyperlink';

/**
 * Shared markedTerminal options used by both MarkdownText (component)
 * and renderDetailLines (detail view).
 */
function baseTerminalOptions(width: number): Record<string, unknown> {
	return {
		width,
		reflowText: true,
		tab: 2,
		showSectionPrefix: false,
		unescape: true,
		emoji: true,
		paragraph: chalk.reset,
		strong: chalk.bold,
		em: chalk.italic,
		del: chalk.dim.strikethrough,
		heading: chalk.bold,
		firstHeading: chalk.bold.underline,
		codespan: chalk.yellow,
		code: chalk.gray,
		blockquote: chalk.gray.italic,
		link: chalk.cyan,
		href: chalk.cyan.underline,
		hr: chalk.dim,
		listitem: chalk.reset,
		table: chalk.reset,
	};
}

const TABLE_CHARS = {
	top: '\u2500',
	'top-mid': '\u252C',
	'top-left': '\u250C',
	'top-right': '\u2510',
	bottom: '\u2500',
	'bottom-mid': '\u2534',
	'bottom-left': '\u2514',
	'bottom-right': '\u2518',
	left: '\u2502',
	'left-mid': '\u251C',
	mid: '\u2500',
	'mid-mid': '\u253C',
	right: '\u2502',
	'right-mid': '\u2524',
	middle: '\u2502',
};

function computeColWidths(
	token: Tokens.Table,
	terminalWidth: number,
): number[] {
	const colCount = token.header.length;
	const overhead = colCount + 1 + 2 * colCount;
	const available = Math.max(terminalWidth - overhead, colCount * 4);

	const stripMd = (s: string) => s.replace(/\*\*|__|~~|`/g, '');
	const maxLens = token.header.map(h => stripMd(h.text).length);
	for (const row of token.rows) {
		for (let i = 0; i < row.length; i++) {
			maxLens[i] = Math.max(maxLens[i] ?? 0, stripMd(row[i]!.text).length);
		}
	}

	const totalContent = maxLens.reduce((a, b) => a + b, 0) || 1;

	return maxLens.map(len =>
		Math.max(4, Math.floor((len / totalContent) * available)),
	);
}

/**
 * Table renderer using cli-table3 for proper box-drawing table output.
 */
function tableRenderer(m: Marked, width: number) {
	return {
		table(token: Tokens.Table): string {
			const colWidths = computeColWidths(token, width);
			const renderInline = (text: string): string => {
				const result = m.parseInline(text);
				return typeof result === 'string' ? result : text;
			};
			const head = token.header.map(cell => renderInline(cell.text));

			const table = new Table({
				head,
				colWidths,
				wordWrap: true,
				wrapOnWordBoundary: true,
				style: {
					head: [],
					border: [],
					'padding-left': 1,
					'padding-right': 1,
				},
				chars: TABLE_CHARS,
			});

			for (const row of token.rows) {
				table.push(row.map(cell => renderInline(cell.text)));
			}

			return chalk.reset(table.toString()) + '\n';
		},
	};
}

/**
 * Custom list renderer that uses parseInline for proper inline formatting
 * (bold, italic, code) inside list items.
 */
function listRenderer(m: Marked) {
	return {
		list(token: Tokens.List): string {
			let body = '';
			for (let i = 0; i < token.items.length; i++) {
				const item = token.items[i]!;
				const bullet = token.ordered ? `${i + 1}. ` : '  \u2022 ';
				const inlined = m.parseInline(item.text);
				const text =
					typeof inlined === 'string'
						? inlined.replace(/\*#COLON\|\*/g, ':')
						: item.text;
				body += bullet + text + '\n';
			}
			return body;
		},
	};
}

/**
 * Create a Marked instance with terminal rendering, custom list formatting,
 * cli-table3 table rendering, and optional extra renderer overrides.
 */
export function createMarkedInstance(
	width: number,
	extraRenderer?: Record<string, unknown>,
): Marked {
	const m = new Marked();
	m.use(
		markedTerminal(baseTerminalOptions(width)) as Parameters<typeof m.use>[0],
	);
	m.use({
		renderer: {
			...listRenderer(m),
			...tableRenderer(m, width),
			link({href, text}: Tokens.Link): string {
				const displayText = typeof text === 'string' ? text : href;
				return chalk.cyan(urlLink(href, displayText));
			},
			...extraRenderer,
		},
	});
	return m;
}

const markedInstances = new Map<number, Marked>();

function getCachedMarkedInstance(width: number): Marked {
	let instance = markedInstances.get(width);
	if (!instance) {
		instance = createMarkedInstance(width);
		markedInstances.set(width, instance);
	}
	return instance;
}

/**
 * Render markdown to ANSI-formatted terminal lines at the given width.
 * Caches Marked instances per width and render results per (text, width).
 */
export function renderMarkdown(text: string, width: number): string[] {
	if (!text) return [''];
	const cacheKey = `${width}\0${text}`;
	const cached = renderCache.get(cacheKey);
	if (cached) return cached;
	const marked = getCachedMarkedInstance(width);
	let lines: string[];
	try {
		const result = marked.parse(text);
		if (typeof result !== 'string') {
			lines = text.split('\n');
		} else {
			lines = result
				.trimEnd()
				.replace(/\n{3,}/g, '\n\n')
				.split('\n');
		}
	} catch {
		lines = text.split('\n');
	}
	renderCache.set(cacheKey, lines);
	return lines;
}

const renderCache = new Map<string, string[]>();

/** Clear the render cache (e.g. on terminal resize when widths change). */
export function clearRenderCache(): void {
	renderCache.clear();
}
