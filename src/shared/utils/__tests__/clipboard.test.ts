import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {copyToClipboard} from '../clipboard';

describe('copyToClipboard', () => {
	let writeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
	});
	afterEach(() => {
		writeSpy.mockRestore();
	});

	it('writes OSC 52 sequence with base64-encoded content', () => {
		copyToClipboard('hello world');
		const expected = Buffer.from('hello world').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});

	it('handles empty string', () => {
		copyToClipboard('');
		const expected = Buffer.from('').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});

	it('handles multi-line content', () => {
		copyToClipboard('line1\nline2\nline3');
		const expected = Buffer.from('line1\nline2\nline3').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});

	it('handles unicode content', () => {
		copyToClipboard('hello 🌍');
		const expected = Buffer.from('hello 🌍').toString('base64');
		expect(writeSpy).toHaveBeenCalledWith(`\x1B]52;c;${expected}\x07`);
	});
});
