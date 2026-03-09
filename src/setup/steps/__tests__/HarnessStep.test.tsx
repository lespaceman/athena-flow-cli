import React from 'react';
import {render} from 'ink-testing-library';
import {describe, it, expect, vi} from 'vitest';
import HarnessStep from '../HarnessStep';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

vi.mock('../../../harnesses/registry', () => ({
	listHarnessCapabilities: vi.fn(() => [
		{
			id: 'claude-code',
			label: 'Claude Code',
			enabled: true,
			verify: () => ({
				ok: true,
				summary: 'Claude Code v2.5.0 detected',
				checks: [
					{
						label: 'Claude binary',
						status: 'pass',
						message: '/usr/local/bin/claude',
					},
					{
						label: 'Smoke prompt',
						status: 'pass',
						message: 'Claude replied: ATHENA_SETUP_OK',
					},
					{
						label: 'Hook forwarder',
						status: 'pass',
						message: '/usr/local/bin/athena-hook-forwarder',
					},
				],
			}),
		},
		{
			id: 'openai-codex',
			label: 'OpenAI Codex (coming soon)',
			enabled: false,
		},
		{
			id: 'opencode',
			label: 'OpenCode (coming soon)',
			enabled: false,
		},
	]),
}));

describe('HarnessStep', () => {
	it('renders numbered harness options', () => {
		const {lastFrame} = render(
			<HarnessStep onComplete={() => {}} onError={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain('1. Claude Code');
		expect(frame).toContain('2. OpenAI Codex (coming soon)');
		expect(frame).toContain('3. OpenCode (coming soon)');
	});

	it('calls onComplete with harness and version after selection', async () => {
		let result = '';
		const {stdin} = render(
			<HarnessStep
				onComplete={v => {
					result = v;
				}}
				onError={() => {}}
			/>,
		);
		stdin.write('\r'); // Select Claude Code
		// Wait for async verification
		await vi.waitFor(() => {
			expect(result).toBe('claude-code');
		});
	});

	it('renders detailed verification checks after selection', async () => {
		const {stdin, lastFrame} = render(
			<HarnessStep onComplete={() => {}} onError={() => {}} />,
		);

		stdin.write('\r');

		await vi.waitFor(() => {
			const frame = lastFrame()!;
			expect(frame).toContain('Claude Code v2.5.0 detected');
			expect(frame).toContain('Claude binary: /usr/local/bin/claude');
			expect(frame).toContain('Smoke prompt: Claude replied: ATHENA_SETUP_OK');
			expect(frame).toContain(
				'Hook forwarder: /usr/local/bin/athena-hook-forwarder',
			);
		});
	});

	it('keeps disabled options non-selectable', async () => {
		let result = '';
		const {stdin} = render(
			<HarnessStep
				onComplete={v => {
					result = v;
				}}
				onError={() => {}}
			/>,
		);
		stdin.write('\u001B[B'); // attempt move to OpenAI Codex (disabled)
		await delay(30);
		stdin.write('\u001B[B'); // attempt move to OpenCode (disabled)
		await delay(30);
		stdin.write('\r');
		await vi.waitFor(() => {
			expect(result).toBe('claude-code');
		});
	});
});
