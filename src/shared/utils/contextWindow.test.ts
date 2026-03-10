import {describe, expect, it} from 'vitest';
import {inferCodexContextWindow} from './contextWindow';

describe('inferCodexContextWindow', () => {
	it('maps codex-mini models to 200k', () => {
		expect(inferCodexContextWindow('codex-mini-latest')).toBe(200_000);
	});

	it('maps Codex GPT-5 family models to 400k', () => {
		expect(inferCodexContextWindow('gpt-5-codex')).toBe(400_000);
		expect(inferCodexContextWindow('gpt-5.3-codex')).toBe(400_000);
	});

	it('returns null for unknown models', () => {
		expect(inferCodexContextWindow('gpt-4.1')).toBeNull();
		expect(inferCodexContextWindow(null)).toBeNull();
	});
});
