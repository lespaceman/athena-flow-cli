import {describe, it, expect} from 'vitest';
import {
	compactText,
	fit,
	formatClock,
	formatCount,
	formatSessionLabel,
	formatRunLabel,
	actorLabel,
	summarizeValue,
	summarizeToolInput,
	summarizeToolPrimaryInput,
	formatInputBuffer,
	renderInputLines,
	MAX_INPUT_ROWS,
	shortenPath,
	shortenPathStructured,
	computeInputRows,
	wrapText,
	cursorToVisualPosition,
	visualPositionToOffset,
} from './format';

describe('compactText', () => {
	it('returns clean text when under max', () => {
		expect(compactText('hello', 10)).toBe('hello');
	});

	it('collapses whitespace while preserving non-ASCII', () => {
		expect(compactText('a  b  c', 20)).toBe('a b c');
		expect(compactText('a  b\t\nc', 20)).toBe('a b c');
	});

	it('truncates with ellipsis', () => {
		expect(compactText('hello world', 8)).toBe('hello...');
	});

	it('returns empty for max <= 0', () => {
		expect(compactText('hello', 0)).toBe('');
		expect(compactText('hello', -1)).toBe('');
	});

	it('slices without ellipsis when max <= 3', () => {
		expect(compactText('hello', 3)).toBe('hel');
		expect(compactText('hello', 2)).toBe('he');
	});

	it('preserves non-ASCII content', () => {
		expect(compactText('café', 10)).toBe('café');
	});
});

describe('fit', () => {
	it('pads short text to width', () => {
		expect(fit('hi', 5)).toBe('hi   ');
	});

	it('truncates with ellipsis when too long', () => {
		expect(fit('hello world', 8)).toBe('hello...');
	});

	it('returns empty for width <= 0', () => {
		expect(fit('hello', 0)).toBe('');
	});

	it('slices without ellipsis when width <= 3', () => {
		expect(fit('hello', 3)).toBe('hel');
	});

	it('exact fit does not truncate', () => {
		expect(fit('abcde', 5)).toBe('abcde');
	});

	it('preserves Unicode characters instead of replacing with ?', () => {
		expect(fit('café', 10)).toBe('café      ');
		expect(fit('▸ expand', 10)).toBe('▸ expand  ');
	});

	it('handles wide characters (emoji) by visual width', () => {
		// 🚀 is 2 columns wide, so "🚀 go" = 5 visual cols
		expect(fit('🚀 go', 8)).toBe('🚀 go   ');
	});
});

describe('formatClock', () => {
	it('formats timestamp as HH:MM', () => {
		// Use a fixed UTC time and construct with local offset
		const d = new Date(2026, 0, 15, 9, 5, 3);
		expect(formatClock(d.getTime())).toBe('09:05');
	});

	it('formats midnight', () => {
		const d = new Date(2026, 0, 1, 0, 0, 0);
		expect(formatClock(d.getTime())).toBe('00:00');
	});
});

describe('formatCount', () => {
	it('returns -- for null', () => {
		expect(formatCount(null)).toBe('--');
	});

	it('formats numbers with locale', () => {
		expect(formatCount(0)).toBe('0');
		expect(formatCount(1234)).toBe('1,234');
	});
});

describe('formatSessionLabel', () => {
	it('returns S- for undefined', () => {
		expect(formatSessionLabel(undefined)).toBe('S-');
	});

	it('returns S- for empty string', () => {
		expect(formatSessionLabel('')).toBe('S-');
	});

	it('returns last 4 alphanumeric chars', () => {
		expect(formatSessionLabel('abc-1234-xyz9')).toBe('Sxyz9');
	});

	it('returns S- when no alphanumeric chars', () => {
		expect(formatSessionLabel('---')).toBe('S-');
	});
});

describe('formatRunLabel', () => {
	it('returns R- for undefined', () => {
		expect(formatRunLabel(undefined)).toBe('R-');
	});

	it('returns direct match for R+digits', () => {
		expect(formatRunLabel('R1')).toBe('R1');
		expect(formatRunLabel('r42')).toBe('R42');
	});

	it('returns last 4 alphanumeric for other IDs', () => {
		expect(formatRunLabel('run-abc-1234')).toBe('R1234');
	});

	it('returns R- for empty string', () => {
		expect(formatRunLabel('')).toBe('R-');
	});
});

describe('actorLabel', () => {
	it('maps known actors', () => {
		expect(actorLabel('user')).toBe('USER');
		expect(actorLabel('agent:root')).toBe('AGENT');
		expect(actorLabel('system')).toBe('SYSTEM');
	});

	it('formats subagent as SUB-AGENT', () => {
		expect(actorLabel('subagent:abc')).toBe('SUB-AGENT');
		expect(actorLabel('subagent:very-long-name-here')).toBe('SUB-AGENT');
	});

	it('uppercases and truncates unknown actors', () => {
		expect(actorLabel('custom')).toBe('CUSTOM');
	});
});

describe('summarizeValue', () => {
	it('wraps strings in quotes and truncates', () => {
		expect(summarizeValue('hello')).toBe('"hello"');
	});

	it('returns numbers as string', () => {
		expect(summarizeValue(42)).toBe('42');
	});

	it('returns booleans as string', () => {
		expect(summarizeValue(true)).toBe('true');
	});

	it('returns null/undefined as string', () => {
		expect(summarizeValue(null)).toBe('null');
		expect(summarizeValue(undefined)).toBe('undefined');
	});

	it('summarizes arrays with length', () => {
		expect(summarizeValue([1, 2, 3])).toBe('[3]');
	});

	it('summarizes objects as {...}', () => {
		expect(summarizeValue({a: 1})).toBe('{...}');
	});
});

describe('summarizeToolInput', () => {
	it('shows all entries when 2 or fewer', () => {
		expect(summarizeToolInput({a: 1, b: 2})).toBe('a=1 b=2');
	});

	it('appends +N for entries beyond 2', () => {
		expect(summarizeToolInput({a: 1, b: 2, c: 3, d: 4})).toBe('a=1 b=2 +2');
	});

	it('appends +1 for exactly 3 entries', () => {
		expect(summarizeToolInput({a: 1, b: 2, c: 3})).toBe('a=1 b=2 +1');
	});

	it('returns empty string for empty input', () => {
		expect(summarizeToolInput({})).toBe('');
	});

	it('handles single key', () => {
		expect(summarizeToolInput({cmd: 'ls'})).toBe('cmd="ls"');
	});
});

describe('summarizeToolPrimaryInput', () => {
	it('shortens Read file_path to last 2 segments', () => {
		expect(
			summarizeToolPrimaryInput('Read', {
				file_path: '/home/user/project/source/app.tsx',
			}),
		).toBe('…/source/app.tsx');
	});

	it('shortens Write file_path to last 2 segments', () => {
		expect(
			summarizeToolPrimaryInput('Write', {
				file_path: '/home/user/project/source/foo.ts',
				content: '...',
			}),
		).toBe('…/source/foo.ts');
	});

	it('shortens Edit file_path to last 2 segments', () => {
		expect(
			summarizeToolPrimaryInput('Edit', {
				file_path: '/a/b/bar.ts',
				old_string: 'x',
				new_string: 'y',
			}),
		).toBe('…/b/bar.ts');
	});

	it('extracts Bash command', () => {
		expect(summarizeToolPrimaryInput('Bash', {command: 'npm test'})).toBe(
			'npm test',
		);
	});

	it('compacts paths in Bash commands', () => {
		const input = {
			command: 'ls /home/nadeemm/Projects/ai-projects/deep/nested',
		};
		const result = summarizeToolPrimaryInput('Bash', input);
		expect(result).toContain('…/');
		expect(result).not.toContain('/home/nadeemm');
	});

	it('truncates long Bash commands to configured width', () => {
		const longCmd = 'a'.repeat(140);
		const result = summarizeToolPrimaryInput('Bash', {command: longCmd});
		expect(result.length).toBeLessThanOrEqual(99);
	});

	it('extracts Glob pattern', () => {
		expect(summarizeToolPrimaryInput('Glob', {pattern: '**/*.test.ts'})).toBe(
			'**/*.test.ts',
		);
	});

	it('extracts Grep pattern with glob', () => {
		expect(
			summarizeToolPrimaryInput('Grep', {pattern: 'TODO', glob: '*.ts'}),
		).toBe('"TODO" *.ts');
	});

	it('extracts Grep pattern without glob', () => {
		expect(summarizeToolPrimaryInput('Grep', {pattern: 'TODO'})).toBe('"TODO"');
	});

	it('extracts Task description as primary input', () => {
		expect(
			summarizeToolPrimaryInput('Task', {
				subagent_type: 'general-purpose',
				description: 'Write tests',
				prompt: '...',
			}),
		).toBe('Write tests');
	});

	it('extracts WebSearch query quoted', () => {
		expect(summarizeToolPrimaryInput('WebSearch', {query: 'react hooks'})).toBe(
			'"react hooks"',
		);
	});

	it('extracts WebFetch url', () => {
		expect(
			summarizeToolPrimaryInput('WebFetch', {
				url: 'https://example.com/api/v1/data',
			}),
		).toBe('https://example.com/api/v1/data');
	});

	it('falls back to key=value for unknown tools', () => {
		expect(summarizeToolPrimaryInput('UnknownTool', {a: 1, b: 'hi'})).toBe(
			'a=1 b="hi"',
		);
	});

	it('returns empty string for empty input', () => {
		expect(summarizeToolPrimaryInput('Read', {})).toBe('');
	});

	it('summarizeToolPrimaryInput returns question count for AskUserQuestion', () => {
		const input = {questions: [{question: 'Pick one?', options: ['a', 'b']}]};
		expect(summarizeToolPrimaryInput('AskUserQuestion', input)).toBe(
			'1 question',
		);

		const multi = {questions: [{question: 'Q1'}, {question: 'Q2'}]};
		expect(summarizeToolPrimaryInput('AskUserQuestion', multi)).toBe(
			'2 questions',
		);
	});
});

describe('shortenPath', () => {
	it('prefixes with …/ when segments are dropped', () => {
		expect(
			shortenPath('/home/user/projects/athena/source/feed/timeline.ts'),
		).toBe('…/feed/timeline.ts');
	});
	it('leaves short paths unchanged', () => {
		expect(shortenPath('feed/timeline.ts')).toBe('feed/timeline.ts');
	});
	it('leaves single segment unchanged', () => {
		expect(shortenPath('timeline.ts')).toBe('timeline.ts');
	});
	it('strips absolute prefix even for 2-segment paths', () => {
		expect(shortenPath('/home/file.ts')).toBe('home/file.ts');
	});
});

describe('shortenPathStructured', () => {
	it('returns prefix and filename for long paths', () => {
		const result = shortenPathStructured(
			'/home/user/projects/athena/source/feed/timeline.ts',
		);
		expect(result.prefix).toBe('…/feed/');
		expect(result.filename).toBe('timeline.ts');
	});

	it('returns empty prefix for single-segment paths', () => {
		const result = shortenPathStructured('timeline.ts');
		expect(result.prefix).toBe('');
		expect(result.filename).toBe('timeline.ts');
	});

	it('returns prefix and filename for 2-segment paths', () => {
		const result = shortenPathStructured('/home/file.ts');
		expect(result.prefix).toBe('home/');
		expect(result.filename).toBe('file.ts');
	});

	it('handles 3-segment paths with …/ prefix', () => {
		const result = shortenPathStructured('/a/b/c.ts');
		expect(result.prefix).toBe('…/b/');
		expect(result.filename).toBe('c.ts');
	});
});

describe('MCP browser input extractors', () => {
	it('navigate extracts domain from url', () => {
		expect(
			summarizeToolPrimaryInput('mcp__plugin_x_agent-web-interface__navigate', {
				url: 'https://www.google.com/search?q=test',
			}),
		).toBe('google.com');
	});
	it('find_elements shows kind and label', () => {
		expect(
			summarizeToolPrimaryInput(
				'mcp__plugin_x_agent-web-interface__find_elements',
				{kind: 'button', label: 'Feeling Lucky'},
			),
		).toBe('button "Feeling Lucky"');
	});
	it('find_elements falls back to region when no kind/label', () => {
		expect(
			summarizeToolPrimaryInput(
				'mcp__plugin_x_agent-web-interface__find_elements',
				{region: 'nav'},
			),
		).toBe('nav');
	});
	it('find_elements returns "elements" when totally empty', () => {
		expect(
			summarizeToolPrimaryInput(
				'mcp__plugin_x_agent-web-interface__find_elements',
				{limit: 10},
			),
		).toBe('elements');
	});
	it('get_element_details truncates eid', () => {
		expect(
			summarizeToolPrimaryInput(
				'mcp__plugin_x_agent-web-interface__get_element_details',
				{eid: 'd8765a92edef'},
			),
		).toBe('eid:d8765a…');
	});
	it('close_session returns "session"', () => {
		expect(
			summarizeToolPrimaryInput(
				'mcp__plugin_x_agent-web-interface__close_session',
				{},
			),
		).toBe('session');
	});
	it('click truncates eid', () => {
		expect(
			summarizeToolPrimaryInput('mcp__plugin_x_agent-web-interface__click', {
				eid: '264ddc58e08d',
			}),
		).toBe('eid:264ddc…');
	});
	it('type shows text and eid', () => {
		expect(
			summarizeToolPrimaryInput('mcp__plugin_x_agent-web-interface__type', {
				text: 'hello world',
				eid: 'abc123',
			}),
		).toBe('"hello world" → abc12…');
	});
});

describe('Skill prefix stripping', () => {
	it('strips plugin prefix from Skill input', () => {
		const result = summarizeToolPrimaryInput('Skill', {
			skill: 'e2e-test-builder:add-e2e-tests',
		});
		expect(result).toBe('add-e2e-tests');
		expect(result).not.toContain('e2e-test-builder');
	});

	it('keeps Skill input without plugin prefix unchanged', () => {
		const result = summarizeToolPrimaryInput('Skill', {
			skill: 'commit',
		});
		expect(result).toBe('commit');
	});
});

describe('Task description reorder', () => {
	it('Task shows description as primary input, not [type] prefix', () => {
		const result = summarizeToolPrimaryInput('Task', {
			subagent_type: 'general-purpose',
			description: 'Write Playwright tests',
		});
		expect(result).toBe('Write Playwright tests');
		expect(result).not.toContain('[general-purpose]');
	});
});

describe('formatInputBuffer', () => {
	it('returns empty for width <= 0', () => {
		expect(formatInputBuffer('hi', 0, 0, true, 'type...')).toBe('');
	});

	it('shows placeholder when empty without cursor', () => {
		expect(formatInputBuffer('', 0, 20, false, 'type...')).toBe(
			'type...             ',
		);
	});

	it('shows cursor + placeholder when empty with cursor', () => {
		// '|type...' is 8 chars, fit pads to 20
		expect(formatInputBuffer('', 0, 20, true, 'type...')).toBe(
			'|type...            ',
		);
	});

	it('shows value without cursor', () => {
		expect(formatInputBuffer('hello', 5, 20, false, '')).toBe(
			'hello               ',
		);
	});

	it('inserts cursor pipe at offset', () => {
		expect(formatInputBuffer('hello', 3, 20, true, '')).toBe(
			'hel|lo              ',
		);
	});

	it('scrolls for long text with cursor', () => {
		const long = 'a'.repeat(50);
		const result = formatInputBuffer(long, 25, 20, true, '');
		expect(result.length).toBe(20);
		expect(result).toContain('|');
	});
});

describe('renderInputLines', () => {
	it('renders block cursor on empty input', () => {
		const lines = renderInputLines('', 0, 40, true, 'placeholder');
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('\x1b[7m');
		expect(lines[0]).toContain('\x1b[27m');
	});

	it('shows placeholder without cursor when not active', () => {
		const lines = renderInputLines('', 0, 40, false, 'placeholder');
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('placeholder');
		expect(lines[0]).not.toContain('\x1b[7m');
	});

	it('renders single line for short text', () => {
		const lines = renderInputLines('hello', 5, 40, true, '');
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('\x1b[7m');
	});

	it('wraps long text to multiple lines', () => {
		const text = 'a'.repeat(100);
		const lines = renderInputLines(text, 50, 40, true, '');
		expect(lines.length).toBe(3); // 100 chars / 40 width = 3 lines
	});

	it('caps at MAX_INPUT_ROWS', () => {
		const text = 'a'.repeat(300);
		const lines = renderInputLines(text, 150, 40, true, '');
		expect(lines.length).toBeLessThanOrEqual(MAX_INPUT_ROWS);
	});

	it('hides cursor when showCursor is false', () => {
		const lines = renderInputLines('hello', 3, 40, false, '');
		expect(lines[0]).not.toContain('\x1b[7m');
	});

	it('renders cursor at correct position', () => {
		const lines = renderInputLines('abc', 1, 40, true, '');
		// Cursor should be on 'b' (index 1)
		expect(lines[0]).toContain('\x1b[7mb\x1b[27m');
	});

	it('wraps on explicit newlines', () => {
		const lines = renderInputLines('line1\nline2', 3, 40, true, '');
		expect(lines.length).toBe(2);
	});

	it('returns empty string for width <= 0', () => {
		const lines = renderInputLines('hello', 0, 0, true, '');
		expect(lines).toEqual(['']);
	});
});

describe('wrapText', () => {
	it('wraps long text at width boundary', () => {
		expect(wrapText('abcdefghij', 5)).toEqual(['abcde', 'fghij']);
	});

	it('splits on explicit newlines', () => {
		expect(wrapText('abc\ndef', 10)).toEqual(['abc', 'def']);
	});

	it('handles empty segments from consecutive newlines', () => {
		expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
	});

	it('returns original text in array when width <= 0', () => {
		expect(wrapText('hello', 0)).toEqual(['hello']);
	});
});

describe('computeInputRows', () => {
	it('returns 1 for empty string', () => {
		expect(computeInputRows('', 20)).toBe(1);
	});

	it('returns 1 for short text', () => {
		expect(computeInputRows('hello', 20)).toBe(1);
	});

	it('returns 2 for text that wraps once', () => {
		expect(computeInputRows('abcdefghij', 5)).toBe(2);
	});

	it('returns correct count for text with newlines', () => {
		expect(computeInputRows('a\nb\nc', 20)).toBe(3);
	});

	it('caps at MAX_INPUT_ROWS', () => {
		const longText = Array(20).fill('line').join('\n');
		expect(computeInputRows(longText, 20)).toBe(MAX_INPUT_ROWS);
	});

	it('returns 1 when width <= 0', () => {
		expect(computeInputRows('hello', 0)).toBe(1);
	});
});

describe('cursorToVisualPosition', () => {
	it('maps simple single-line text', () => {
		const result = cursorToVisualPosition('hello', 3, 20);
		expect(result).toEqual({line: 0, col: 3, totalLines: 1});
	});

	it('maps wrapped text to correct visual line', () => {
		// "abcdefghij" at width 5 → ["abcde", "fghij"]
		// offset 7 → line 1, col 2
		const result = cursorToVisualPosition('abcdefghij', 7, 5);
		expect(result).toEqual({line: 1, col: 2, totalLines: 2});
	});

	it('maps cursor at wrap boundary to next line start', () => {
		// "abcdefghij" at width 5, offset 5 → line 1, col 0
		const result = cursorToVisualPosition('abcdefghij', 5, 5);
		expect(result).toEqual({line: 1, col: 0, totalLines: 2});
	});

	it('maps cursor at end of exactly-full line to same line', () => {
		// "abcde" at width 5, offset 5 → line 0, col 5 (cursor at end)
		const result = cursorToVisualPosition('abcde', 5, 5);
		expect(result).toEqual({line: 0, col: 5, totalLines: 1});
	});

	it('accounts for \\n characters in offset mapping', () => {
		// "abc\ndef" → segments ["abc", "def"]
		// offset 0 = 'a' → line 0, col 0
		expect(cursorToVisualPosition('abc\ndef', 0, 20)).toEqual({
			line: 0,
			col: 0,
			totalLines: 2,
		});
		// offset 3 = end of "abc" → line 0, col 3
		expect(cursorToVisualPosition('abc\ndef', 3, 20)).toEqual({
			line: 0,
			col: 3,
			totalLines: 2,
		});
		// offset 4 = 'd' (first char of line 2) → line 1, col 0
		expect(cursorToVisualPosition('abc\ndef', 4, 20)).toEqual({
			line: 1,
			col: 0,
			totalLines: 2,
		});
		// offset 6 = 'f' → line 1, col 2
		expect(cursorToVisualPosition('abc\ndef', 6, 20)).toEqual({
			line: 1,
			col: 2,
			totalLines: 2,
		});
	});

	it('handles multiple newlines', () => {
		// "a\nb\nc" → 3 visual lines
		expect(cursorToVisualPosition('a\nb\nc', 2, 20)).toEqual({
			line: 1,
			col: 0,
			totalLines: 3,
		});
		expect(cursorToVisualPosition('a\nb\nc', 4, 20)).toEqual({
			line: 2,
			col: 0,
			totalLines: 3,
		});
	});

	it('handles empty segments from consecutive newlines', () => {
		// "a\n\nb" → segments ["a", "", "b"] → 3 visual lines
		expect(cursorToVisualPosition('a\n\nb', 2, 20)).toEqual({
			line: 1,
			col: 0,
			totalLines: 3,
		});
		expect(cursorToVisualPosition('a\n\nb', 3, 20)).toEqual({
			line: 2,
			col: 0,
			totalLines: 3,
		});
	});
});

describe('visualPositionToOffset', () => {
	it('maps simple position back to offset', () => {
		expect(visualPositionToOffset('hello', 0, 3, 20)).toBe(3);
	});

	it('maps wrapped line position back to offset', () => {
		// "abcdefghij" at width 5 → ["abcde", "fghij"]
		// line 1, col 2 → offset 7
		expect(visualPositionToOffset('abcdefghij', 1, 2, 5)).toBe(7);
	});

	it('accounts for \\n in reverse mapping', () => {
		// "abc\ndef" → line 1, col 0 → offset 4 (skipping \\n at offset 3)
		expect(visualPositionToOffset('abc\ndef', 1, 0, 20)).toBe(4);
		// line 1, col 2 → offset 6
		expect(visualPositionToOffset('abc\ndef', 1, 2, 20)).toBe(6);
	});

	it('clamps column to line length', () => {
		// "abcdefgh" at width 5 → ["abcde", "fgh"]
		// line 1, col 10 → should clamp to offset 8 (end of "fgh")
		expect(visualPositionToOffset('abcdefgh', 1, 10, 5)).toBe(8);
	});

	it('roundtrips with cursorToVisualPosition', () => {
		const text = 'hello\nworld\nfoo';
		for (let offset = 0; offset <= text.length; offset++) {
			const {line, col} = cursorToVisualPosition(text, offset, 20);
			const back = visualPositionToOffset(text, line, col, 20);
			expect(back).toBe(offset);
		}
	});
});
