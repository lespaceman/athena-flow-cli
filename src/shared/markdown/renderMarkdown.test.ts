import {describe, expect, it} from 'vitest';
import stripAnsi from 'strip-ansi';
import {renderMarkdown} from './renderMarkdown';

describe('renderMarkdown', () => {
	it('renders nested list items instead of flattening them', () => {
		const rendered = renderMarkdown({
			content: '- parent\n  - child',
			width: 60,
			mode: 'tool-output',
		});
		const output = stripAnsi(rendered.text);

		expect(output).toContain('parent');
		expect(output).toContain('child');
		expect(output).toMatch(/parent[\s\S]*• child/);
	});

	it('renders task list checkbox state', () => {
		const rendered = renderMarkdown({
			content: '- [x] done\n- [ ] pending',
			width: 60,
			mode: 'tool-output',
		});
		const output = stripAnsi(rendered.text);

		expect(output).toContain('[x] done');
		expect(output).toContain('[ ] pending');
	});

	it('preserves loose list paragraph spacing', () => {
		const rendered = renderMarkdown({
			content: '- first paragraph\n\n  second paragraph',
			width: 60,
			mode: 'detail-view',
		});
		const output = stripAnsi(rendered.text);

		expect(output).toContain('first paragraph\n');
		expect(output).toMatch(/\n\s*\n {4}second paragraph/);
	});

	it('normalizes repeated blank lines to a single blank line', () => {
		const rendered = renderMarkdown({
			content: '# Heading\n\n\nBody',
			width: 60,
			mode: 'inline-feed',
		});
		const output = stripAnsi(rendered.text);

		expect(output).toContain('Heading\n\nBody');
		expect(output).not.toContain('Heading\n\n\nBody');
	});

	it('does not leak colon placeholders in list items with code spans', () => {
		const rendered = renderMarkdown({
			content:
				'- Read `playwright.config.ts` to learn `baseURL: "https://myapp.com"`, `testDir: "../../utils/tests"`',
			width: 120,
			mode: 'tool-output',
		});
		const output = stripAnsi(rendered.text);

		expect(output).not.toContain('*#COLON|*');
		expect(output).toContain('baseURL:');
		expect(output).toContain('testDir:');
	});

	it('keeps narrow tables and wraps cell content', () => {
		const rendered = renderMarkdown({
			content: [
				'| TC-ID | Description | Priority |',
				'| --- | --- | --- |',
				'| TC-MAP-001 | Camera markers visible on map after page load | Critical |',
			].join('\n'),
			width: 36,
			mode: 'tool-output',
		});
		const output = stripAnsi(rendered.text);

		expect(output).toContain('┌');
		expect(output).toContain('│');
		expect(output).toContain('Description');
		expect(output).toContain('Camera markers v');
		expect(output).toContain('isible on map af');
		expect(output).toContain('ter page load');
		expect(output).not.toContain('…');
	});
});
