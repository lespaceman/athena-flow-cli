/**
 * Markdown helpers for the Telegram channel.
 *
 * Two distinct escaping rules apply, both fixed by the Bot API spec:
 *   - General text: `_*[]()~`>#+-=|{}.!\` must each be backslash-escaped.
 *   - Inside fenced/inline code: only `\` and `` ` `` need escaping.
 *
 * `agentMarkdownToTelegramV2` converts the loose CommonMark/GFM markdown
 * agents typically emit into MarkdownV2 so it renders in Telegram. It
 * handles bold (**…** and __…__), italic, strikethrough, inline code,
 * fenced code blocks (with language hint), links, headings (as bold),
 * blockquotes (> …), horizontal rules (stripped), and GFM table separators
 * (stripped — Telegram has no native table support). Reserved characters in
 * the remaining plain text are escaped so the parser always succeeds.
 */

export function escapeMarkdownV2(text: string): string {
	return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

export function escapeMarkdownV2CodeBlock(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

// ── Tokeniser regexes ────────────────────────────────────────────────

/** Captures optional language hint (group 1) and body (group 2). */
const FENCED_RE = /```([a-zA-Z0-9+\-#.]*)\s*\n([^]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;

// ── Inline-formatting regexes ────────────────────────────────────────

const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
/** GFM table separator rows — no Telegram equivalent; strip entirely. */
const TABLE_SEPARATOR_RE =
	/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/;
/** Horizontal rules (---  ***  ___) — strip entirely. */
const HR_LINE_RE = /^[ \t]*([*\-_])(\s*\1){2,}\s*$/;
/** CommonMark inline link — supports one level of balanced parens in URL. */
const LINK_RE = /\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/g;
/** GFM double-asterisk bold. */
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;
/** GFM double-underscore bold (identical semantics to **…**). */
const GFM_BOLD_UNDER_RE = /(^|[^\w\\])__([^_\n]+?)__(?=$|[^\w])/g;
const STRIKE_RE = /~~([^~\n]+?)~~/g;
const ITALIC_UNDERSCORE_RE = /(^|[^\w\\])_([^_\n]+?)_(?=$|[^\w])/g;
const ITALIC_STAR_RE = /(^|[^*\w\\])\*([^*\n]+?)\*(?=$|[^*\w])/g;
/** GFM/CommonMark blockquote lines (> …). */
const BLOCKQUOTE_LINE_RE = /^(>{1,5}) ?(.*)/;

// ── Stash: protect already-rendered spans from the final escape pass ─

const STASH_OPEN = '\x01';
const STASH_CLOSE = '\x02';
// eslint-disable-next-line no-control-regex -- placeholder envelope uses U+0001 / U+0002
const STASH_REF_RE = /\x01(\d+)\x02/g;

// ── Segment types ────────────────────────────────────────────────────

type Segment =
	| {kind: 'text'; value: string}
	| {kind: 'inline-code'; value: string}
	| {kind: 'block-code'; lang: string; value: string};

// ── Tokeniser ────────────────────────────────────────────────────────

function tokenize(input: string): Segment[] {
	const segments: Segment[] = [];
	let cursor = 0;
	for (const match of input.matchAll(FENCED_RE)) {
		const idx = match.index;
		if (idx > cursor) {
			segments.push({kind: 'text', value: input.slice(cursor, idx)});
		}
		segments.push({kind: 'block-code', lang: match[1]!, value: match[2]!});
		cursor = idx + match[0].length;
	}
	if (cursor < input.length) {
		segments.push({kind: 'text', value: input.slice(cursor)});
	}

	const result: Segment[] = [];
	for (const seg of segments) {
		if (seg.kind !== 'text') {
			result.push(seg);
			continue;
		}
		let last = 0;
		for (const match of seg.value.matchAll(INLINE_CODE_RE)) {
			const idx = match.index;
			if (idx > last) {
				result.push({kind: 'text', value: seg.value.slice(last, idx)});
			}
			result.push({kind: 'inline-code', value: match[1]!});
			last = idx + match[0].length;
		}
		if (last < seg.value.length) {
			result.push({kind: 'text', value: seg.value.slice(last)});
		}
	}
	return result;
}

// ── Block-level helpers ──────────────────────────────────────────────

function trimFenceBody(value: string): string {
	return value.replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
}

function dropTableSeparators(text: string): string {
	return text
		.split('\n')
		.filter(line => !TABLE_SEPARATOR_RE.test(line))
		.join('\n');
}

/** A line that contains a `|` and is non-empty. */
function isTableRowLine(line: string): boolean {
	return line.includes('|') && line.trim().length > 0;
}

function parseTableRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\||\|$/g, '');
	return trimmed.split('|').map(c => c.trim());
}

function renderTableAsCodeBlock(rawLines: string[]): string {
	const rows = rawLines
		.filter(l => !TABLE_SEPARATOR_RE.test(l))
		.map(parseTableRow);
	if (rows.length === 0) return '';
	const cols = Math.max(...rows.map(r => r.length));
	const widths = new Array<number>(cols).fill(0);
	for (const row of rows) {
		while (row.length < cols) row.push('');
		for (let c = 0; c < cols; c++) {
			widths[c] = Math.max(widths[c]!, row[c]!.length);
		}
	}
	const formatRow = (row: string[]): string =>
		row.map((cell, c) => cell.padEnd(widths[c]!)).join(' | ');
	const separator = widths.map(w => '-'.repeat(w)).join('-+-');
	const lines = [
		formatRow(rows[0]!),
		separator,
		...rows.slice(1).map(formatRow),
	];
	const body = lines.join('\n');
	return '```\n' + escapeMarkdownV2CodeBlock(body) + '\n```';
}

/**
 * Detect contiguous GFM table blocks (≥2 row-like lines containing a
 * separator row) and stash each as a pre-rendered MarkdownV2 fenced code
 * block so column alignment survives Telegram's variable-width font.
 */
function formatTables(text: string, ref: (rendered: string) => string): string {
	const lines = text.split('\n');
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (!isTableRowLine(lines[i]!)) {
			out.push(lines[i]!);
			i++;
			continue;
		}
		const start = i;
		while (i < lines.length && isTableRowLine(lines[i]!)) i++;
		const block = lines.slice(start, i);
		const hasSeparator = block.some(l => TABLE_SEPARATOR_RE.test(l));
		if (hasSeparator && block.length >= 2) {
			out.push(ref(renderTableAsCodeBlock(block)));
		} else {
			out.push(...block);
		}
	}
	return out.join('\n');
}

function dropHorizontalRules(text: string): string {
	return text
		.split('\n')
		.filter(line => !HR_LINE_RE.test(line))
		.join('\n');
}

// ── Inline-formatting pass ───────────────────────────────────────────

/**
 * Apply all span-level formatting to `s`, stashing rendered spans behind
 * placeholders so the trailing `escapeMarkdownV2` call cannot double-escape
 * them. Returns the escaped string with unresolved stash refs.
 */
function applyInlineFormats(s: string, ref: (r: string) => string): string {
	s = s.replace(LINK_RE, (_, txt: string, url: string) => {
		const escapedText = escapeMarkdownV2(txt);
		const escapedUrl = url.replace(/\\/g, '\\\\').replace(/[()]/g, '\\$&');
		return ref(`[${escapedText}](${escapedUrl})`);
	});
	s = s.replace(
		GFM_BOLD_UNDER_RE,
		(_, lead: string, inner: string) =>
			`${lead}${ref(`*${escapeMarkdownV2(inner)}*`)}`,
	);
	s = s.replace(BOLD_RE, (_, inner: string) =>
		ref(`*${escapeMarkdownV2(inner)}*`),
	);
	s = s.replace(STRIKE_RE, (_, inner: string) =>
		ref(`~${escapeMarkdownV2(inner)}~`),
	);
	s = s.replace(
		ITALIC_UNDERSCORE_RE,
		(_, lead: string, inner: string) =>
			`${lead}${ref(`_${escapeMarkdownV2(inner)}_`)}`,
	);
	s = s.replace(
		ITALIC_STAR_RE,
		(_, lead: string, inner: string) =>
			`${lead}${ref(`_${escapeMarkdownV2(inner)}_`)}`,
	);
	return escapeMarkdownV2(s);
}

/**
 * Process a plain-text segment into MarkdownV2. Headings become bold;
 * blockquote lines get `>` prefixes protected from the escape pass;
 * table separators and horizontal rules are stripped.
 */
function renderTextSegment(text: string): string {
	const stash: string[] = [];
	const ref = (rendered: string): string => {
		const id = stash.length;
		stash.push(rendered);
		return `${STASH_OPEN}${id}${STASH_CLOSE}`;
	};

	let s = formatTables(text, ref);
	s = dropTableSeparators(s);
	s = dropHorizontalRules(s);
	// Convert headings to **…** so BOLD_RE picks them up in the inline pass.
	s = s.replace(HEADING_RE, '**$1**');

	// Stash blockquote lines before the inline pass so the `>` prefix is not
	// backslash-escaped. Apply full inline formatting to the inner content and
	// resolve its stash refs immediately so the outer pass sees a leaf entry.
	s = s
		.split('\n')
		.map(line => {
			const bq = BLOCKQUOTE_LINE_RE.exec(line);
			if (!bq) return line;
			const levels = bq[1]!;
			const content = bq[2]!;
			const formatted = applyInlineFormats(content, ref);
			const resolved = formatted.replace(
				STASH_REF_RE,
				(_, id: string) => stash[Number(id)]!,
			);
			return ref(`${levels}${resolved}`);
		})
		.join('\n');

	s = applyInlineFormats(s, ref);
	s = s.replace(STASH_REF_RE, (_, id: string) => stash[Number(id)]!);
	return s;
}

// ── Public API ───────────────────────────────────────────────────────

export function agentMarkdownToTelegramV2(input: string): string {
	const segments = tokenize(input);
	const out: string[] = [];
	for (const seg of segments) {
		if (seg.kind === 'block-code') {
			const body = escapeMarkdownV2CodeBlock(trimFenceBody(seg.value));
			out.push(`\`\`\`${seg.lang}\n${body}\n\`\`\``);
		} else if (seg.kind === 'inline-code') {
			out.push('`' + escapeMarkdownV2CodeBlock(seg.value) + '`');
		} else {
			out.push(renderTextSegment(seg.value));
		}
	}
	return out.join('');
}
