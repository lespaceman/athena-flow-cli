import {describe, it, expect} from 'vitest';
import {renderHeaderLines} from './renderLines';
import stripAnsi from 'strip-ansi';
import type {HeaderModel} from './model';

const model: HeaderModel = {
	session_id: 'abc123',
	session_index: 2,
	session_total: 5,
	workflow: 'test-wf',
	harness: 'Claude Code',
	context: {used: 50000, max: 200000},
	total_tokens: null,
	run_count: 0,
	status: 'idle',
	tail_mode: false,
};

describe('renderHeaderLines', () => {
	it('renders context bar with progress characters (X1)', () => {
		const [line] = renderHeaderLines(model, 120, true);
		const plain = stripAnsi(line);
		expect(plain).toContain('ATHENA FLOW  │');
		// Should contain "Context" label and token counts, NOT plain "Ctx:"
		expect(plain).toContain('Context');
		expect(plain).toContain('50k / 200k');
		expect(plain).toContain('25%');
		expect(plain).not.toContain('Ctx:');
		expect(plain).toContain('S: abc123 (2/5)');
	});

	it('renders context bar without color when hasColor is false', () => {
		const [line] = renderHeaderLines(model, 120, false);
		// ASCII bar uses brackets
		expect(line).toContain('[');
		expect(line).toContain('50k / 200k');
	});

	it('right-aligns context section to the trailing edge', () => {
		const [line] = renderHeaderLines(model, 120, false);
		const contextIndex = line.indexOf('Context');
		const harnessIndex = line.indexOf('Harness: Claude Code');
		expect(contextIndex).toBeGreaterThan(harnessIndex);
		expect(line.trimEnd().endsWith('25%')).toBe(true);
	});

	it('drops divider before session token during compaction', () => {
		const [line] = renderHeaderLines(model, 92, false);
		const plain = stripAnsi(line);
		expect(plain).toContain('S: abc123 (2/5)');
		expect(plain).not.toContain('ATHENA FLOW  |  S: abc123 (2/5)');
	});

	it('omits token count when total_tokens is null', () => {
		const [line] = renderHeaderLines(model, 160, false);
		expect(line).not.toContain('Tokens:');
	});

	it('omits run count when run_count is 0', () => {
		const [line] = renderHeaderLines(model, 160, false);
		expect(line).not.toContain('Runs:');
	});

	it('displays token count when total_tokens is set', () => {
		const m: HeaderModel = {...model, total_tokens: 45200};
		const [line] = renderHeaderLines(m, 160, false);
		expect(line).toContain('Tokens: 45.2k');
	});

	it('displays run count when run_count > 0', () => {
		const m: HeaderModel = {...model, run_count: 3};
		const [line] = renderHeaderLines(m, 160, false);
		expect(line).toContain('Runs: 3');
	});

	it('displays both token count and run count together', () => {
		const m: HeaderModel = {...model, total_tokens: 1500, run_count: 7};
		const [line] = renderHeaderLines(m, 160, false);
		expect(line).toContain('Tokens: 1.5k');
		expect(line).toContain('Runs: 7');
	});
});
