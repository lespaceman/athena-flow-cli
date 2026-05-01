import {describe, expect, it} from 'vitest';
import {
	agentMarkdownToTelegramV2,
	escapeMarkdownV2,
	escapeMarkdownV2CodeBlock,
} from './markdown';

describe('escapeMarkdownV2', () => {
	it('escapes all reserved characters', () => {
		expect(escapeMarkdownV2('a_b*c[d](e)f~g`h>i#j+k-l=m|n{o}p.q!r\\s')).toBe(
			'a\\_b\\*c\\[d\\]\\(e\\)f\\~g\\`h\\>i\\#j\\+k\\-l\\=m\\|n\\{o\\}p\\.q\\!r\\\\s',
		);
	});

	it('leaves plain text untouched', () => {
		expect(escapeMarkdownV2('hello world 123')).toBe('hello world 123');
	});
});

describe('escapeMarkdownV2CodeBlock', () => {
	it('escapes backslashes and backticks only', () => {
		expect(escapeMarkdownV2CodeBlock('a\\b`c*d_e')).toBe('a\\\\b\\`c*d_e');
	});

	it('escapes triple-backticks per character', () => {
		expect(escapeMarkdownV2CodeBlock('```')).toBe('\\`\\`\\`');
	});
});

describe('agentMarkdownToTelegramV2', () => {
	// ── Bold ───────────────────────────────────────────────────────────
	it('converts double-asterisk bold to MarkdownV2 bold', () => {
		expect(agentMarkdownToTelegramV2('a **bold** word')).toBe('a *bold* word');
	});

	it('converts GFM double-underscore bold', () => {
		expect(agentMarkdownToTelegramV2('a __bold__ word')).toBe('a *bold* word');
	});

	it('does not treat snake_case underscores as bold', () => {
		expect(agentMarkdownToTelegramV2('my__var__name')).toBe(
			'my\\_\\_var\\_\\_name',
		);
	});

	// ── Italic ─────────────────────────────────────────────────────────
	it('renders italic via single asterisks (after bold is consumed)', () => {
		expect(agentMarkdownToTelegramV2('a *little* and a **lot**')).toBe(
			'a _little_ and a *lot*',
		);
	});

	it('renders italic via single underscores', () => {
		expect(agentMarkdownToTelegramV2('this is _italic_ text')).toBe(
			'this is _italic_ text',
		);
	});

	it('does not match underscores inside identifiers', () => {
		expect(agentMarkdownToTelegramV2('use snake_case_names')).toBe(
			'use snake\\_case\\_names',
		);
	});

	// ── Strikethrough ──────────────────────────────────────────────────
	it('renders strikethrough', () => {
		expect(agentMarkdownToTelegramV2('this is ~~old~~ news')).toBe(
			'this is ~old~ news',
		);
	});

	// ── Headings ───────────────────────────────────────────────────────
	it('converts headings to bold', () => {
		expect(agentMarkdownToTelegramV2('# Title\nbody')).toBe('*Title*\nbody');
		expect(agentMarkdownToTelegramV2('### Sub heading')).toBe('*Sub heading*');
	});

	it('renders headers as bold; list dashes as escaped literals', () => {
		const md = '# Update\n- item 1\n- item 2';
		expect(agentMarkdownToTelegramV2(md)).toBe(
			'*Update*\n\\- item 1\n\\- item 2',
		);
	});

	// ── Inline code ────────────────────────────────────────────────────
	it('preserves inline code spans verbatim, escaping inner backticks', () => {
		expect(agentMarkdownToTelegramV2('use `npm install` to set up')).toBe(
			'use `npm install` to set up',
		);
	});

	it('does not escape reserved chars inside inline code', () => {
		expect(agentMarkdownToTelegramV2('run `a.b-c` now.')).toBe(
			'run `a.b-c` now\\.',
		);
	});

	// ── Fenced code blocks ─────────────────────────────────────────────
	it('preserves fenced code blocks', () => {
		const md = 'before\n```\nconst x = 1.0;\n```\nafter';
		expect(agentMarkdownToTelegramV2(md)).toBe(
			'before\n```\nconst x = 1.0;\n```\nafter',
		);
	});

	it('preserves language hint in fenced code blocks', () => {
		const md = '```python\nprint("hello")\n```';
		expect(agentMarkdownToTelegramV2(md)).toBe(
			'```python\nprint("hello")\n```',
		);
	});

	it('preserves language hint with special chars (c++, c#)', () => {
		expect(agentMarkdownToTelegramV2('```c++\nint x;\n```')).toBe(
			'```c++\nint x;\n```',
		);
	});

	it('escapes backslashes inside fenced blocks', () => {
		expect(agentMarkdownToTelegramV2('```\na\\b\n```')).toBe(
			'```\na\\\\b\n```',
		);
	});

	// ── Links ──────────────────────────────────────────────────────────
	it('renders inline links with escaped url', () => {
		expect(
			agentMarkdownToTelegramV2(
				'see [docs](https://example.com/a.b) for more.',
			),
		).toBe('see [docs](https://example.com/a.b) for more\\.');
	});

	it('escapes backslashes inside link urls', () => {
		expect(agentMarkdownToTelegramV2('[x](https://e.com/a\\b)')).toBe(
			'[x](https://e.com/a\\\\b)',
		);
	});

	it('handles URLs with balanced parentheses (Wikipedia-style)', () => {
		const md = '[Wikipedia](https://en.wikipedia.org/wiki/Foo_(bar))';
		expect(agentMarkdownToTelegramV2(md)).toBe(
			'[Wikipedia](https://en.wikipedia.org/wiki/Foo_\\(bar\\))',
		);
	});

	// ── Blockquotes ────────────────────────────────────────────────────
	it('converts GFM blockquote lines to Telegram blockquotes', () => {
		expect(agentMarkdownToTelegramV2('> hello world')).toBe('>hello world');
	});

	it('preserves bold inside blockquotes', () => {
		expect(agentMarkdownToTelegramV2('> **important** note')).toBe(
			'>*important* note',
		);
	});

	it('handles multi-level blockquotes', () => {
		expect(agentMarkdownToTelegramV2('>> nested')).toBe('>>nested');
	});

	it('handles blockquote without trailing space', () => {
		expect(agentMarkdownToTelegramV2('>no space')).toBe('>no space');
	});

	it('escapes reserved chars inside blockquote content', () => {
		expect(agentMarkdownToTelegramV2('> cost is $5.00!')).toBe(
			'>cost is $5\\.00\\!',
		);
	});

	it('does not treat non-leading > as a blockquote', () => {
		expect(agentMarkdownToTelegramV2('value > 0')).toBe('value \\> 0');
	});

	// ── Horizontal rules ───────────────────────────────────────────────
	it('strips --- horizontal rules', () => {
		expect(agentMarkdownToTelegramV2('before\n---\nafter')).toBe(
			'before\nafter',
		);
	});

	it('strips *** horizontal rules', () => {
		expect(agentMarkdownToTelegramV2('before\n***\nafter')).toBe(
			'before\nafter',
		);
	});

	it('strips ___ horizontal rules', () => {
		expect(agentMarkdownToTelegramV2('before\n___\nafter')).toBe(
			'before\nafter',
		);
	});

	// ── Tables ─────────────────────────────────────────────────────────
	it('renders GFM tables as aligned monospace code blocks', () => {
		const md =
			'| pkg | status |\n| --- | --- |\n| core | ok |\n| ui | failed |';
		expect(agentMarkdownToTelegramV2(md)).toBe(
			'```\npkg  | status\n-----+-------\ncore | ok    \nui   | failed\n```',
		);
	});

	it('aligns columns to the widest cell per column', () => {
		const md = '| short | longer header |\n| --- | --- |\n| x | y |';
		expect(agentMarkdownToTelegramV2(md)).toBe(
			'```\nshort | longer header\n------+--------------\nx     | y            \n```',
		);
	});

	it('does not treat a single pipe-line without separator as a table', () => {
		expect(agentMarkdownToTelegramV2('value | other')).toBe('value \\| other');
	});

	it('still strips orphan separator rows outside a table', () => {
		expect(agentMarkdownToTelegramV2('text\n| --- | --- |\nmore')).toBe(
			'text\nmore',
		);
	});

	// ── Plain text & escaping ──────────────────────────────────────────
	it('escapes reserved characters in plain text', () => {
		expect(agentMarkdownToTelegramV2('hello. world!')).toBe(
			'hello\\. world\\!',
		);
	});

	it('returns empty string for empty input', () => {
		expect(agentMarkdownToTelegramV2('')).toBe('');
	});

	// ── Mixed formatting ───────────────────────────────────────────────
	it('mixes bold, code, and plain text', () => {
		const md = 'See **README** and run `make build` to compile.';
		expect(agentMarkdownToTelegramV2(md)).toBe(
			'See *README* and run `make build` to compile\\.',
		);
	});

	it('handles bold spanning across reserved chars', () => {
		expect(agentMarkdownToTelegramV2('**v1.2.3** released')).toBe(
			'*v1\\.2\\.3* released',
		);
	});

	it('combines link, bold, and code in one line', () => {
		const md = 'See **[Athena](https://athena.dev)** docs and run `npm test`.';
		const out = agentMarkdownToTelegramV2(md);
		expect(out).toContain('`npm test`');
		expect(out.endsWith('\\.')).toBe(true);
	});
});
