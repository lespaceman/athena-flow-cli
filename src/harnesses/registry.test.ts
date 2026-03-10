import {describe, expect, it} from 'vitest';
import {
	listHarnessAdapters,
	listHarnessCapabilities,
	resolveHarnessAdapter,
} from './registry';

describe('harness registry', () => {
	it('resolves the concrete adapter for supported harnesses', () => {
		expect(resolveHarnessAdapter('claude-code').id).toBe('claude-code');
		expect(resolveHarnessAdapter('openai-codex').id).toBe('openai-codex');
	});

	it('falls back to the claude adapter for unknown harness ids', () => {
		expect(resolveHarnessAdapter('unknown-harness' as never).id).toBe(
			'claude-code',
		);
	});

	it('exposes harness capabilities from the adapter registry', () => {
		expect(listHarnessAdapters().map(adapter => adapter.id)).toEqual([
			'claude-code',
			'openai-codex',
			'opencode',
		]);
		expect(listHarnessCapabilities()).toEqual([
			expect.objectContaining({
				id: 'claude-code',
				label: 'Claude Code',
				enabled: true,
			}),
			expect.objectContaining({
				id: 'openai-codex',
				label: 'OpenAI Codex',
				enabled: true,
			}),
			expect.objectContaining({
				id: 'opencode',
				label: 'OpenCode (coming soon)',
				enabled: false,
			}),
		]);
	});
});
