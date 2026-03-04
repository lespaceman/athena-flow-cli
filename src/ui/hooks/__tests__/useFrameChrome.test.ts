/** @vitest-environment jsdom */
import {describe, it, expect, vi} from 'vitest';
import {renderHook} from '@testing-library/react';

vi.mock('../../layout/buildFrameLines', () => ({
	buildFrameLines: (ctx: Record<string, unknown>) => ({
		footerHelp: ctx.focusMode === 'feed' ? 'some help' : null,
		inputLines: [],
	}),
}));

import {useFrameChrome, type UseFrameChromeOptions} from '../useFrameChrome';

function makeOptions(
	overrides: Partial<UseFrameChromeOptions> = {},
): UseFrameChromeOptions {
	return {
		innerWidth: 40,
		focusMode: 'feed',
		inputMode: 'normal',
		searchQuery: '',
		searchMatches: [],
		searchMatchPos: 0,
		isHarnessRunning: false,
		dialogActive: false,
		dialogType: 'idle',
		hintsForced: null,
		ascii: false,
		accentColor: '#00ff00',
		runSummaries: [],
		staticHighWaterMark: 0,
		...overrides,
	};
}

describe('useFrameChrome', () => {
	describe('lastRunStatus', () => {
		it('returns null when harness is running', () => {
			const {result} = renderHook(() =>
				useFrameChrome(
					makeOptions({
						isHarnessRunning: true,
						runSummaries: [
							{
								runId: 'r1',
								title: 'Run 1',
								status: 'SUCCEEDED',
								startedAt: 0,
							},
						],
					}),
				),
			);
			expect(result.current.lastRunStatus).toBeNull();
		});

		it('returns "completed" for SUCCEEDED', () => {
			const {result} = renderHook(() =>
				useFrameChrome(
					makeOptions({
						runSummaries: [
							{
								runId: 'r1',
								title: 'Run 1',
								status: 'SUCCEEDED',
								startedAt: 0,
							},
						],
					}),
				),
			);
			expect(result.current.lastRunStatus).toBe('completed');
		});

		it('returns "failed" for FAILED', () => {
			const {result} = renderHook(() =>
				useFrameChrome(
					makeOptions({
						runSummaries: [
							{
								runId: 'r1',
								title: 'Run 1',
								status: 'FAILED',
								startedAt: 0,
							},
						],
					}),
				),
			);
			expect(result.current.lastRunStatus).toBe('failed');
		});

		it('returns "aborted" for CANCELLED', () => {
			const {result} = renderHook(() =>
				useFrameChrome(
					makeOptions({
						runSummaries: [
							{
								runId: 'r1',
								title: 'Run 1',
								status: 'CANCELLED',
								startedAt: 0,
							},
						],
					}),
				),
			);
			expect(result.current.lastRunStatus).toBe('aborted');
		});

		it('returns null when no runs exist', () => {
			const {result} = renderHook(() =>
				useFrameChrome(makeOptions({runSummaries: []})),
			);
			expect(result.current.lastRunStatus).toBeNull();
		});
	});

	describe('borders', () => {
		it('produces unicode borders by default', () => {
			const {result} = renderHook(() =>
				useFrameChrome(makeOptions({innerWidth: 5, ascii: false})),
			);
			expect(result.current.topBorder).toBe('┌─────┐');
			expect(result.current.bottomBorder).toBe('└─────┘');
			expect(result.current.sectionBorder).toBe('├─────┤');
		});

		it('produces ascii borders when ascii=true', () => {
			const {result} = renderHook(() =>
				useFrameChrome(makeOptions({innerWidth: 5, ascii: true})),
			);
			expect(result.current.topBorder).toBe('+-----+');
			expect(result.current.bottomBorder).toBe('+-----+');
			expect(result.current.sectionBorder).toBe('+-----+');
		});
	});

	describe('frameLine', () => {
		it('wraps content with vertical borders', () => {
			const {result} = renderHook(() =>
				useFrameChrome(makeOptions({innerWidth: 10, ascii: false})),
			);
			// frameLine pads/truncates content to innerWidth using fitAnsi
			const line = result.current.frameLine('hello');
			expect(line.startsWith('│')).toBe(true);
			expect(line.endsWith('│')).toBe(true);
		});

		it('wraps content with ascii borders when ascii=true', () => {
			const {result} = renderHook(() =>
				useFrameChrome(makeOptions({innerWidth: 10, ascii: true})),
			);
			const line = result.current.frameLine('hello');
			expect(line.startsWith('|')).toBe(true);
			expect(line.endsWith('|')).toBe(true);
		});
	});

	describe('footerRows', () => {
		it('returns 2 when footerHelp is present', () => {
			// Our mock returns footerHelp when focusMode === 'feed'
			const {result} = renderHook(() =>
				useFrameChrome(makeOptions({focusMode: 'feed'})),
			);
			expect(result.current.footerRows).toBe(2);
		});

		it('returns 1 when footerHelp is null', () => {
			// Our mock returns null when focusMode !== 'feed'
			const {result} = renderHook(() =>
				useFrameChrome(makeOptions({focusMode: 'input'})),
			);
			expect(result.current.footerRows).toBe(1);
		});
	});

	describe('visibleSearchMatches', () => {
		it('filters matches below staticHighWaterMark', () => {
			const {result} = renderHook(() =>
				useFrameChrome(
					makeOptions({
						searchMatches: [0, 3, 5, 8, 10],
						staticHighWaterMark: 5,
					}),
				),
			);
			expect(result.current.visibleSearchMatches).toEqual([5, 8, 10]);
		});

		it('returns all matches when staticHighWaterMark is 0', () => {
			const {result} = renderHook(() =>
				useFrameChrome(
					makeOptions({
						searchMatches: [0, 3, 5],
						staticHighWaterMark: 0,
					}),
				),
			);
			expect(result.current.visibleSearchMatches).toEqual([0, 3, 5]);
		});
	});
});
