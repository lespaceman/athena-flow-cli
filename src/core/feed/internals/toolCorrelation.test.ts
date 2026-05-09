import {describe, it, expect} from 'vitest';
import {createToolCorrelation} from './toolCorrelation';

describe('toolCorrelation', () => {
	describe('parent lookup', () => {
		it('returns undefined for an unrecorded tool_use_id', () => {
			const tc = createToolCorrelation();
			expect(tc.lookupParent('unknown')).toBeUndefined();
		});

		it('returns undefined when tool_use_id is undefined', () => {
			const tc = createToolCorrelation();
			expect(tc.lookupParent(undefined)).toBeUndefined();
		});

		it('returns the recorded event id after recordPre', () => {
			const tc = createToolCorrelation();
			tc.recordPre('use-1', 'evt-pre-1');
			expect(tc.lookupParent('use-1')).toBe('evt-pre-1');
		});

		it('keeps the parent index past forgetTool — late events still resolve', () => {
			const tc = createToolCorrelation();
			tc.recordPre('use-1', 'evt-pre-1');
			tc.forgetTool('use-1');
			expect(tc.lookupParent('use-1')).toBe('evt-pre-1');
		});

		it('drops the parent index on resetForNewRun', () => {
			const tc = createToolCorrelation();
			tc.recordPre('use-1', 'evt-pre-1');
			tc.resetForNewRun();
			expect(tc.lookupParent('use-1')).toBeUndefined();
		});
	});

	describe('streamed delta accumulation', () => {
		it('passes through chunks unchanged when there is no tool_use_id', () => {
			const tc = createToolCorrelation();
			expect(tc.appendDelta(undefined, 'hello')).toBe('hello');
		});

		it('accumulates chunks for the same tool_use_id', () => {
			const tc = createToolCorrelation();
			tc.appendDelta('use-1', 'one\n');
			expect(tc.appendDelta('use-1', 'two\n')).toBe('one\ntwo\n');
		});

		it('keeps independent buffers per tool_use_id', () => {
			const tc = createToolCorrelation();
			tc.appendDelta('use-a', 'A1');
			tc.appendDelta('use-b', 'B1');
			expect(tc.appendDelta('use-a', 'A2')).toBe('A1A2');
			expect(tc.appendDelta('use-b', 'B2')).toBe('B1B2');
		});

		it('truncates to the tail and prefixes a notice once the cap is exceeded', () => {
			const tc = createToolCorrelation();
			const big = 'x'.repeat(70_000);
			const out = tc.appendDelta('use-1', big);
			expect(
				out.startsWith('[streaming output truncated to recent content]\n'),
			).toBe(true);
			expect(out.length).toBeLessThanOrEqual(
				'[streaming output truncated to recent content]\n'.length + 64_000,
			);
		});

		it('keeps emitting the truncation notice on subsequent chunks once truncated', () => {
			const tc = createToolCorrelation();
			tc.appendDelta('use-1', 'x'.repeat(70_000));
			const next = tc.appendDelta('use-1', 'tail');
			expect(
				next.startsWith('[streaming output truncated to recent content]\n'),
			).toBe(true);
			expect(next.endsWith('tail')).toBe(true);
		});

		it('forgetTool releases the delta buffer — next chunk starts fresh', () => {
			const tc = createToolCorrelation();
			tc.appendDelta('use-1', 'old');
			tc.forgetTool('use-1');
			expect(tc.appendDelta('use-1', 'new')).toBe('new');
		});
	});
});
