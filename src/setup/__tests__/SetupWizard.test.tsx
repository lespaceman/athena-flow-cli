import React from 'react';
import {render} from 'ink-testing-library';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {act} from '@testing-library/react';
import SetupWizard from '../SetupWizard';
import {ThemeProvider} from '../../ui/theme/index';
import {darkTheme} from '../../ui/theme/index';
import {writeGlobalConfig} from '../../infra/plugins/config';

vi.mock('../../harnesses/claude/system/detectVersion', () => ({
	detectClaudeVersion: vi.fn(() => '2.5.0'),
}));
vi.mock('../../infra/plugins/config', () => ({
	writeGlobalConfig: vi.fn(),
	readGlobalConfig: vi.fn(() => ({
		plugins: [],
		additionalDirectories: [],
	})),
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * Navigate through both wizard steps using act() to flush React state
 * and fake timers to deterministically fire the 500ms auto-advance timer.
 */
function walkAllSteps(stdin: {write: (data: string) => void}) {
	// Step 1: select Dark theme
	act(() => stdin.write('\r'));
	// Fire the 500ms auto-advance timer to move to step 2
	act(() => vi.advanceTimersByTime(500));

	// Step 2: skip harness
	act(() => stdin.write('s'));
	act(() => vi.advanceTimersByTime(500));
}

describe('SetupWizard', {timeout: 15_000}, () => {
	it('renders the first step (theme selection)', () => {
		const {lastFrame} = render(
			<ThemeProvider value={darkTheme}>
				<SetupWizard onComplete={() => {}} />
			</ThemeProvider>,
		);
		expect(lastFrame()!).toContain('Dark');
		expect(lastFrame()!).toContain('Light');
		expect(lastFrame()!).toContain('ATHENA SETUP');
		expect(lastFrame()!).toContain('move');
	});

	it('completes setup and persists config', () => {
		const onComplete = vi.fn();
		const {stdin} = render(
			<ThemeProvider value={darkTheme}>
				<SetupWizard onComplete={onComplete} />
			</ThemeProvider>,
		);

		walkAllSteps(stdin);

		expect(writeGlobalConfig).toHaveBeenCalledWith({
			setupComplete: true,
			theme: 'dark',
			harness: undefined,
		});
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('shows save error and retries when user presses r', () => {
		const writeMock = vi.mocked(writeGlobalConfig);
		writeMock
			.mockImplementationOnce(() => {
				throw new Error('disk full');
			})
			.mockImplementationOnce(() => {});

		const onComplete = vi.fn();
		const {stdin, lastFrame} = render(
			<ThemeProvider value={darkTheme}>
				<SetupWizard onComplete={onComplete} />
			</ThemeProvider>,
		);

		walkAllSteps(stdin);

		expect(lastFrame()!).toContain('Failed to write setup config');
		expect(onComplete).not.toHaveBeenCalled();

		act(() => stdin.write('r'));

		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(writeMock).toHaveBeenCalledTimes(2);
	});

	it('supports skip and back keyboard shortcuts', () => {
		const {stdin, lastFrame} = render(
			<ThemeProvider value={darkTheme}>
				<SetupWizard onComplete={() => {}} />
			</ThemeProvider>,
		);

		act(() => stdin.write('s')); // Skip theme step
		act(() => vi.advanceTimersByTime(500));
		expect(lastFrame()!).toContain('Select harness');

		act(() => stdin.write('\u001B')); // Esc back
		act(() => vi.advanceTimersByTime(0)); // flush ink's pending escape
		expect(lastFrame()!).toContain('Choose your display theme');
	});

	it('shows completed step summary lines above active step', () => {
		const {stdin, lastFrame} = render(
			<ThemeProvider value={darkTheme}>
				<SetupWizard onComplete={() => {}} />
			</ThemeProvider>,
		);

		// Complete theme step and advance
		act(() => stdin.write('\r'));
		act(() => vi.advanceTimersByTime(500));

		const frame = lastFrame()!;
		expect(frame).toContain('✓ Theme · dark');
		expect(frame).toContain('Select harness');
	});
});
