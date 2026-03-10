import {describe, it, expect} from 'vitest';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import {renderContextBar, formatTokenCount} from './contextBar';

describe('formatTokenCount', () => {
	it('formats thousands as k', () => {
		expect(formatTokenCount(67000)).toBe('67k');
		expect(formatTokenCount(200000)).toBe('200k');
		expect(formatTokenCount(1500)).toBe('1.5k');
	});

	it('returns placeholder for null', () => {
		expect(formatTokenCount(null)).toBe('--');
	});

	it('formats sub-1000 as-is', () => {
		expect(formatTokenCount(500)).toBe('500');
	});
});

describe('renderContextBar', () => {
	it('renders filled bar proportionally', () => {
		const result = renderContextBar(100000, 200000, 24, false);
		expect(result).toContain('Context');
		expect(result).toContain('100k / 200k');
		expect(result).toContain('50%');
	});

	it('renders empty bar when used is null', () => {
		const result = renderContextBar(null, 200000, 24, false);
		expect(result).toContain('Context --');
	});

	it('renders color bar with ANSI codes', () => {
		const prev = chalk.level;
		chalk.level = 1;
		try {
			const result = renderContextBar(50000, 200000, 30, true);
			expect(result).not.toBe(stripAnsi(result));
		} finally {
			chalk.level = prev;
		}
	});

	it('NO_COLOR uses brackets and equals/dashes', () => {
		const result = renderContextBar(100000, 200000, 30, false);
		expect(result).toContain('[');
		expect(result).toContain(']');
	});

	it('clamps to 100% when used > max', () => {
		const result = renderContextBar(250000, 200000, 30, false);
		expect(result).toContain('250k / 200k');
		expect(result).toContain('125%');
	});

	it('renders an empty bar when max is non-positive', () => {
		const result = renderContextBar(1000, 0, 30, false);
		expect(result).toContain('Context --');
		expect(result).not.toContain('=');
	});
});
