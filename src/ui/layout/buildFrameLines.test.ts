import {describe, it, expect} from 'vitest';
import {buildFrameLines, type FrameContext} from './buildFrameLines';

const baseCtx: FrameContext = {
	innerWidth: 80,
	focusMode: 'input',
	inputMode: 'normal',
	searchQuery: '',
	searchMatches: [],
	searchMatchPos: 0,
	isClaudeRunning: false,
	inputValue: '',
	cursorOffset: 0,
	dialogActive: false,
	dialogType: '',
	lastRunStatus: null,
};

describe('buildFrameLines contextual prompt', () => {
	it('shows default prompt when no run has completed', () => {
		const {inputLines} = buildFrameLines(baseCtx);
		const line = inputLines.join('');
		expect(line).toContain('Type a prompt or /command');
	});

	it('shows contextual prompt after completed run (X2)', () => {
		const {inputLines} = buildFrameLines({
			...baseCtx,
			lastRunStatus: 'completed',
		});
		const line = inputLines.join('');
		expect(line).toContain('Run complete');
	});

	it('shows contextual prompt after failed run (X2)', () => {
		const {inputLines} = buildFrameLines({...baseCtx, lastRunStatus: 'failed'});
		const line = inputLines.join('');
		expect(line).toContain('Run failed');
	});

	it('shows Esc Back hint in input mode when idle', () => {
		const {footerHelp} = buildFrameLines(baseCtx);
		expect(footerHelp).toContain('Back');
		expect(footerHelp).not.toContain('Interrupt');
	});

	it('shows Esc Back hint in input mode while running', () => {
		const {footerHelp} = buildFrameLines({...baseCtx, isClaudeRunning: true});
		expect(footerHelp).toContain('Back');
		expect(footerHelp).not.toContain('Interrupt');
	});

	it('shows double-escape interrupt hint in running feed mode', () => {
		const {footerHelp} = buildFrameLines({
			...baseCtx,
			focusMode: 'feed',
			isClaudeRunning: true,
		});
		expect(footerHelp?.toLowerCase()).toContain('esc esc');
		expect(footerHelp).toContain('Interrupt');
	});

	it('shows yank hint in feed mode', () => {
		const {footerHelp} = buildFrameLines({
			...baseCtx,
			focusMode: 'feed',
		});
		expect(footerHelp).toContain('Yank');
	});
});
