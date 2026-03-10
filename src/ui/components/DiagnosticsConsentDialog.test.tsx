import React from 'react';
import {describe, it, expect, vi} from 'vitest';
import {render} from 'ink-testing-library';
import DiagnosticsConsentDialog from './DiagnosticsConsentDialog';

describe('DiagnosticsConsentDialog', () => {
	it('renders the consent copy and choices', () => {
		const {lastFrame} = render(
			<DiagnosticsConsentDialog
				harnessLabel="Claude Code"
				onDecision={vi.fn()}
			/>,
		);

		const frame = lastFrame() ?? '';
		expect(frame).toContain('Send anonymous Claude Code startup diagnostics?');
		expect(frame).toContain('Send once');
		expect(frame).toContain('Always send anonymous diagnostics');
		expect(frame).toContain('Do not send');
		expect(frame).toContain('Does not include prompts, stderr, file paths');
	});

	it('selects send once by default on Enter', () => {
		const onDecision = vi.fn();
		const {stdin} = render(
			<DiagnosticsConsentDialog
				harnessLabel="Claude Code"
				onDecision={onDecision}
			/>,
		);

		stdin.write('\r');
		expect(onDecision).toHaveBeenCalledWith('send-once');
	});

	it('declines on Escape', async () => {
		const onDecision = vi.fn();
		const {stdin} = render(
			<DiagnosticsConsentDialog
				harnessLabel="Claude Code"
				onDecision={onDecision}
			/>,
		);

		stdin.write('\x1B');
		await new Promise(resolve => setImmediate(resolve));
		expect(onDecision).toHaveBeenCalledWith('do-not-send');
	});
});
