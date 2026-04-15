import {describe, expect, it} from 'vitest';
import {renderMarkdown} from '../../shared/utils/markedFactory';

describe('renderMarkdown', () => {
	it('renders bold text with ANSI formatting', () => {
		const lines = renderMarkdown('Hello **world**', 40);
		const joined = lines.join('\n');
		// Should not contain raw ** markers
		expect(joined).not.toContain('**');
		// Should contain the word "world"
		expect(joined).toContain('world');
	});

	it('renders inline code without raw backticks', () => {
		const lines = renderMarkdown('Use `npm install`', 40);
		const joined = lines.join('\n');
		expect(joined).not.toContain('`');
		expect(joined).toContain('npm install');
	});

	it('renders headers without # prefix', () => {
		const lines = renderMarkdown('# Title\nBody text', 40);
		const joined = lines.join('\n');
		expect(joined).not.toMatch(/^#/m);
		expect(joined).toContain('Title');
		expect(joined).toContain('Body text');
	});

	it('renders tables without raw pipe characters as delimiters', () => {
		const md = '| Name | Value |\n|------|-------|\n| foo  | bar   |';
		const lines = renderMarkdown(md, 60);
		const joined = lines.join('\n');
		expect(joined).toContain('foo');
		expect(joined).toContain('bar');
	});

	it('returns single empty-string line for empty input', () => {
		expect(renderMarkdown('', 40)).toEqual(['']);
	});

	it('handles plain text without markdown gracefully', () => {
		const lines = renderMarkdown('Just plain text', 40);
		expect(lines.join('\n')).toContain('Just plain text');
	});
});
