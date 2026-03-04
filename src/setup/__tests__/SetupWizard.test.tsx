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
vi.mock('../../core/workflows/index', () => ({
	installWorkflow: vi.fn(() => 'e2e-test-builder'),
	resolveWorkflow: vi.fn(() => ({
		name: 'e2e-test-builder',
		plugins: ['e2e-test-builder@lespaceman/athena-workflow-marketplace'],
	})),
	installWorkflowPlugins: vi.fn(() => ['/resolved/plugin/dir']),
}));
vi.mock('../../infra/plugins/config', () => ({
	writeGlobalConfig: vi.fn(),
}));
vi.mock('../../infra/plugins/mcpOptions', () => ({
	collectMcpServersWithOptions: vi.fn(() => []),
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * Navigate through all four wizard steps using act() to flush React state
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

	// Step 3: arrow down to "None - configure later", then select
	act(() => stdin.write('\u001B[B'));
	act(() => stdin.write('\r'));
	act(() => vi.advanceTimersByTime(500));

	// Step 4: MCP options — auto-skips when collectMcpServersWithOptions returns []
	// The useEffect auto-calls onComplete({}) which triggers markSuccess
	act(() => vi.advanceTimersByTime(500));
}

describe('SetupWizard', () => {
	it('renders the first step (theme selection)', () => {
		const {lastFrame} = render(
			<ThemeProvider value={darkTheme}>
				<SetupWizard onComplete={() => {}} />
			</ThemeProvider>,
		);
		expect(lastFrame()!).toContain('Dark');
		expect(lastFrame()!).toContain('Light');
		expect(lastFrame()!).toContain('Up/Down move');
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
			workflow: undefined,
			mcpServerOptions: {},
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
		expect(lastFrame()!).toContain('Choose your display theme');
	});

	it('shows 4 steps in progress bar', () => {
		const {lastFrame} = render(
			<ThemeProvider value={darkTheme}>
				<SetupWizard onComplete={() => {}} />
			</ThemeProvider>,
		);
		expect(lastFrame()!).toContain('Step 1 of 4');
	});

	it('shows MCP options step when workflow has servers with options', async () => {
		const {collectMcpServersWithOptions} =
			await import('../../infra/plugins/mcpOptions');
		vi.mocked(collectMcpServersWithOptions).mockReturnValue([
			{
				serverName: 'agent-web-interface',
				options: [
					{label: 'Visible browser', args: []},
					{label: 'Headless browser', args: ['--headless']},
				],
			},
		]);

		const onComplete = vi.fn();
		const {stdin, lastFrame} = render(
			<ThemeProvider value={darkTheme}>
				<SetupWizard onComplete={onComplete} />
			</ThemeProvider>,
		);

		// Step 1: select Dark theme
		act(() => stdin.write('\r'));
		act(() => vi.advanceTimersByTime(500));

		// Step 2: skip harness
		act(() => stdin.write('s'));
		act(() => vi.advanceTimersByTime(500));

		// Step 3: select e2e-test-builder (first option)
		act(() => stdin.write('\r'));
		// Wait for setTimeout(fn, 0) in WorkflowStep to fire
		act(() => vi.advanceTimersByTime(0));
		// Auto-advance after success
		act(() => vi.advanceTimersByTime(500));

		// Step 4: MCP options should be showing
		const frame = lastFrame()!;
		expect(frame).toContain('Configure MCP servers');
		expect(frame).toContain('agent-web-interface');
	});
});
